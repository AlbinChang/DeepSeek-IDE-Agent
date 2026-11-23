import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMResponseLog, LLM_RESPONSE_DIR_NAME } from "@/services/LLMResponseLog.js";

describe("LLMResponseLog", () => {
    let root: string;
    let directory: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-response-log-"));
        directory = path.join(root, LLM_RESPONSE_DIR_NAME);
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it("writes metadata on the first line and the response result on the second", async () => {
        const log = new LLMResponseLog();
        log.record({
            root,
            metadata: { model: "deepseek-chat", attempt: 1, success: true },
            result: { content: "hello\nworld", tool_calls: [] },
        });
        log.record({
            root,
            metadata: { model: "deepseek-chat", attempt: 2, success: false },
            result: { error: "429" },
        });
        await log.flush();

        const files = (await fs.readdir(directory)).sort();
        expect(files).toEqual(["response-1.json", "response-2.json"]);

        const raw = await fs.readFile(path.join(directory, "response-1.json"), "utf8");
        const lines = raw.split("\n").filter((line) => line.length > 0);
        expect(lines).toHaveLength(2);

        const metadata = JSON.parse(lines[0]);
        expect(metadata).toMatchObject({
            counter: 1,
            file: "response-1.json",
            model: "deepseek-chat",
            attempt: 1,
            success: true,
        });
        // 结果里的换行必须被转义在单行 JSON 内，保证「两行文件」的约定
        expect(JSON.parse(lines[1])).toEqual({ content: "hello\nworld", tool_calls: [] });
    });

    it("continues the counter from existing files after a restart", async () => {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "response-41.json"), "{}\n{}\n", "utf8");

        const log = new LLMResponseLog();
        log.record({ root, metadata: { source: "restarted" }, result: { content: "ok" } });
        await log.flush();

        expect(await fs.readdir(directory)).toContain("response-42.json");
    });

    it("keeps only the 100 most recent responses while the counter keeps increasing", async () => {
        const log = new LLMResponseLog();
        for (let index = 0; index < 105; index++) {
            log.record({ root, metadata: { index }, result: { content: `reply-${index}` } });
        }
        await log.flush();

        const files = await fs.readdir(directory);
        expect(files).toHaveLength(100);
        expect(files).toContain("response-6.json");
        expect(files).toContain("response-105.json");
        expect(files).not.toContain("response-5.json");
    });

    it("keeps counters unique when several writers race in the same workspace", async () => {
        await fs.mkdir(directory, { recursive: true });
        const first = new LLMResponseLog();
        const second = new LLMResponseLog();

        for (let index = 0; index < 5; index++) {
            first.record({ root, metadata: { writer: 1, index }, result: {} });
            second.record({ root, metadata: { writer: 2, index }, result: {} });
        }
        await Promise.all([first.flush(), second.flush()]);

        const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
        expect(files).toHaveLength(10);
        expect(new Set(files).size).toBe(10);
    });
});
