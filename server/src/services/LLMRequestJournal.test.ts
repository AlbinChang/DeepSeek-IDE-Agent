import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculateCrc32, LLMRequestJournal } from "./LLMRequestJournal.js";

describe("LLMRequestJournal", () => {
    let root: string;
    let journal: LLMRequestJournal;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-request-journal-"));
        journal = new LLMRequestJournal();
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    const recordOptions = (overrides: Record<string, unknown> = {}) => ({
        root,
        userId: "test-user",
        modelId: "test-model",
        providerId: "test-provider",
        agentStage: "主Agent" as const,
        traceId: "trace-1",
        recoveryContext: { userInstruction: "Continue the task" },
        payload: {
            model: "test-model",
            messages: [{ role: "user", content: "Continue the task" }],
            stream: true,
        },
        ...overrides,
    });

    it("calculates the standard CRC-32 checksum", () => {
        expect(calculateCrc32("123456789")).toBe("cbf43926");
        expect(calculateCrc32("请求上下文😀")).toBe(calculateCrc32(Buffer.from("请求上下文😀", "utf8")));
        const boundaryText = `${"a".repeat(64 * 1024 - 1)}😀`;
        expect(calculateCrc32(boundaryText)).toBe(calculateCrc32(Buffer.from(boundaryText, "utf8")));
    });

    it("numbers requests from zero, stores CRC metadata, and keeps only the latest 50", async () => {
        const records = await Promise.all(
            Array.from({ length: 52 }, (_, index) => journal.recordRequest(recordOptions({
                traceId: `trace-${index}`,
                timestamp: index,
            }))),
        );

        expect(records.map((record) => record.requestIndex)).toEqual(
            Array.from({ length: 52 }, (_, index) => index),
        );

        const directory = path.join(root, ".llm-request");
        const requestFiles = (await fs.readdir(directory))
            .filter((file) => /^request-\d+\.json$/.test(file))
            .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
        expect(requestFiles).toHaveLength(50);
        expect(requestFiles[0]).toBe("request-2.json");
        expect(requestFiles[49]).toBe("request-51.json");

        const content = await fs.readFile(path.join(directory, "request-51.json"), "utf8");
        const separator = content.indexOf("\n");
        const metadata = JSON.parse(content.slice(0, separator));
        const rawPayload = content.slice(separator + 1);
        expect(metadata).toMatchObject({
            requestIndex: 51,
            userId: "test-user",
            modelId: "test-model",
            agentStage: "主Agent",
            timestamp: 51,
        });
        expect(metadata.crc32).toBe(calculateCrc32(rawPayload));
        expect(JSON.parse(rawPayload)).toEqual(recordOptions().payload);
    });

    it("writes large Unicode request bodies without breaking UTF-8 chunk boundaries", async () => {
        const chunkSize = 64 * 1024;
        const emptyPayload = {
            model: "test-model",
            messages: [{ role: "user", content: "" }],
            stream: true,
        };
        const contentStart = JSON.stringify(emptyPayload).indexOf('""') + 1;
        const payload = {
            ...emptyPayload,
            messages: [{
                role: "user",
                content: `${"a".repeat(chunkSize - 1 - contentStart)}😀`,
            }],
        };
        const rawPayload = JSON.stringify(payload);
        expect(rawPayload.indexOf("😀")).toBe(chunkSize - 1);

        const metadata = await journal.recordRequest(recordOptions({ payload }));
        const contents = await fs.readFile(
            path.join(root, ".llm-request", `request-${metadata.requestIndex}.json`),
            "utf8",
        );
        const separator = contents.indexOf("\n");
        const savedRawPayload = contents.slice(separator + 1);
        expect(JSON.parse(savedRawPayload)).toEqual(payload);
        expect(calculateCrc32(savedRawPayload)).toBe(JSON.parse(contents.slice(0, separator)).crc32);
    });

    it("falls back to the newest older request whose CRC is valid", async () => {
        await journal.recordRequest(recordOptions({ timestamp: 1 }));
        await journal.recordRequest(recordOptions({ timestamp: 2 }));

        const latestPath = path.join(root, ".llm-request", "request-1.json");
        const latest = await fs.readFile(latestPath, "utf8");
        const separator = latest.indexOf("\n");
        await fs.writeFile(latestPath, `${latest.slice(0, separator + 1)}{"broken":true}`, "utf8");

        const recovered = await journal.getPendingRecovery(root, "test-user");
        expect(recovered?.requestIndex).toBe(0);
    });

    it("restores the next index from request filenames after a crash restart", async () => {
        await journal.recordRequest(recordOptions({ traceId: "previous-trace" }));

        const restartedJournal = new LLMRequestJournal();
        expect((await restartedJournal.getPendingRecovery(root, "test-user"))?.requestIndex).toBe(0);
        expect((await restartedJournal.recordRequest(recordOptions({ traceId: "next-trace" }))).requestIndex).toBe(1);
    });

    it("does not restore requests after a normal shutdown and prevents stale recovery", async () => {
        await journal.recordRequest(recordOptions());
        await journal.markNormalShutdown();

        const restartedJournal = new LLMRequestJournal();
        expect(await restartedJournal.getPendingRecovery(root, "test-user")).toBeNull();
        await expect(fs.access(path.join(root, ".llm-request", "stop-normal.flag"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(restartedJournal.readPendingRequest(root, "test-user", 0)).rejects.toThrow("no longer recoverable");

        expect((await restartedJournal.recordRequest(recordOptions({ traceId: "new-trace" }))).requestIndex).toBe(1);
    });

    it("discards every pending request belonging to the interrupted trace", async () => {
        await journal.recordRequest(recordOptions({ timestamp: 1 }));
        await journal.recordRequest(recordOptions({ timestamp: 2 }));
        await journal.recordRequest(recordOptions({ traceId: "other-trace", timestamp: 3 }));

        await journal.discardRecovery(root, "test-user", 1);

        expect((await journal.getPendingRecovery(root, "test-user"))?.requestIndex).toBe(2);
        await expect(journal.readPendingRequest(root, "test-user", 0)).rejects.toThrow("no longer recoverable");
        await expect(journal.readPendingRequest(root, "test-user", 1)).rejects.toThrow("no longer recoverable");
    });

    it("does not resurrect an older interrupted trace after a newer trace completes", async () => {
        await journal.recordRequest(recordOptions({ traceId: "older-trace", timestamp: 1 }));
        await journal.recordRequest(recordOptions({ traceId: "newer-trace", timestamp: 2 }));

        await journal.completeTrace(root, "test-user", "newer-trace");

        expect(await journal.getPendingRecovery(root, "test-user")).toBeNull();
    });
});
