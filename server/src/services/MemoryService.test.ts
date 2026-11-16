import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryService } from "./MemoryService.js";

const TEST_ROOT = path.join(os.tmpdir(), `memory-service-test-${Date.now()}`);

describe("MemoryService — user_instructs.json 20 条硬上限", () => {
    afterAll(() => {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    it("recordUserInstruction 连续记录 25 条后文件最多保留 20 条（最新在前）", async () => {
        const root = path.join(TEST_ROOT, "ws-a");
        for (let i = 1; i <= 25; i++) {
            await MemoryService.recordUserInstruction(root, `指令-${i}`);
        }
        const records = await MemoryService.getInstructions(root);
        expect(records).toHaveLength(20);
        // 时间倒序：最新指令在首位
        expect(records[0].instruction).toBe("指令-25");
        expect(records[19].instruction).toBe("指令-6");
    });

    it("getInstructions 读取历史存量超限文件时同样裁剪到 20 条", async () => {
        const root = path.join(TEST_ROOT, "ws-b");
        fs.mkdirSync(path.join(root, ".memory"), { recursive: true });
        const legacy = Array.from({ length: 50 }, (_, i) => ({
            timestamp: i,
            date: "2026-01-01",
            instruction: `历史指令-${i}`,
        }));
        fs.writeFileSync(
            path.join(root, ".memory", "user_instructs.json"),
            JSON.stringify(legacy),
            "utf8"
        );

        const records = await MemoryService.getInstructions(root);
        expect(records).toHaveLength(20);
        // 保留时间倒序排列中的前 20 条
        expect(records[0].instruction).toBe("历史指令-0");
        expect(records[19].instruction).toBe("历史指令-19");
    });

    it(".memory 目录不存在时也能正常记录第一条指令", async () => {
        const root = path.join(TEST_ROOT, "ws-c");
        await MemoryService.recordUserInstruction(root, "第一条指令");
        const records = await MemoryService.getInstructions(root);
        expect(records).toHaveLength(1);
        expect(records[0].instruction).toBe("第一条指令");
    });

    it("ensureMemoryFiles 播种空数组，保证文件存在", async () => {
        const root = path.join(TEST_ROOT, "ws-d");
        await MemoryService.ensureMemoryFiles(root);
        const raw = fs.readFileSync(path.join(root, ".memory", "user_instructs.json"), "utf8");
        expect(JSON.parse(raw)).toEqual([]);
    });
});

describe("MemoryService — 对话计数器与主Agent回复记忆", () => {
    afterAll(() => {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    const readJsonFile = (root: string, name: string) =>
        JSON.parse(fs.readFileSync(path.join(root, ".memory", name), "utf8"));

    it("每次新对话 dialogIndex 从 1 递增，并落盘到指令记录与计数器文件", async () => {
        const root = path.join(TEST_ROOT, "reply-a");

        const first = await MemoryService.recordUserInstruction(root, "第一轮");
        const second = await MemoryService.recordUserInstruction(root, "第二轮");

        expect([first, second]).toEqual([1, 2]);
        const records = await MemoryService.getInstructions(root);
        expect(records.map((record) => record.dialogIndex)).toEqual([2, 1]);
        expect(readJsonFile(root, "dialog_counter.json").lastDialogIndex).toBe(2);
    });

    it("一次对话内多轮最终回复按 1.1 / 1.2 … 编号", async () => {
        const root = path.join(TEST_ROOT, "reply-b");
        const dialogIndex = await MemoryService.recordUserInstruction(root, "多轮任务");

        const first = await MemoryService.recordMainAgentReply(root, dialogIndex, "第一份最终回复");
        const second = await MemoryService.recordMainAgentReply(root, dialogIndex, "第二份最终回复");

        expect(first?.id).toBe("1.1");
        expect(second?.id).toBe("1.2");
        const replies = await MemoryService.getMainAgentReplies(root);
        expect(replies.map((record) => record.id)).toEqual(["1.2", "1.1"]);
        expect(await MemoryService.getMainAgentReplyById(root, "1.1")).toMatchObject({
            dialogIndex: 1,
            replyIndex: 1,
            reply: "第一份最终回复",
            instruction: "多轮任务",
        });
    });

    it("空回复不写入记忆，也不占用回复序号", async () => {
        const root = path.join(TEST_ROOT, "reply-c");
        const dialogIndex = await MemoryService.recordUserInstruction(root, "空回复");

        expect(await MemoryService.recordMainAgentReply(root, dialogIndex, "   ")).toBeNull();
        expect(await MemoryService.getMainAgentReplies(root)).toEqual([]);

        const record = await MemoryService.recordMainAgentReply(root, dialogIndex, "有效回复");
        expect(record?.id).toBe("1.1");
    });

    it("恢复同一对话（resume）不递增计数器，也不新增指令记录", async () => {
        const root = path.join(TEST_ROOT, "reply-d");
        await MemoryService.recordUserInstruction(root, "原始对话");

        const resumed = await MemoryService.recordUserInstruction(root, "原始对话", { resume: true });

        expect(resumed).toBe(1);
        expect(readJsonFile(root, "dialog_counter.json").lastDialogIndex).toBe(1);
        expect(await MemoryService.getInstructions(root)).toHaveLength(1);
    });

    it("旧文件缺少 dialogIndex 时按时间顺序补齐，新对话从 n+1 继续", async () => {
        const root = path.join(TEST_ROOT, "reply-e");
        fs.mkdirSync(path.join(root, ".memory"), { recursive: true });
        // 旧格式：时间倒序、无 dialogIndex
        fs.writeFileSync(
            path.join(root, ".memory", "user_instructs.json"),
            JSON.stringify([
                { timestamp: 3, date: "2026-01-03", instruction: "最新" },
                { timestamp: 2, date: "2026-01-02", instruction: "中间" },
                { timestamp: 1, date: "2026-01-01", instruction: "最旧" },
            ]),
            "utf8"
        );

        const migrated = await MemoryService.getInstructions(root);
        expect(migrated.map((record) => record.dialogIndex)).toEqual([3, 2, 1]);

        const nextDialogIndex = await MemoryService.recordUserInstruction(root, "新对话");
        expect(nextDialogIndex).toBe(4);
    });

    it("回复保留范围与 user_instructs 的 dialogIndex 严格一一对应（11…16 场景）", async () => {
        const root = path.join(TEST_ROOT, "reply-f");
        fs.mkdirSync(path.join(root, ".memory"), { recursive: true });

        // 用户对话只保留最近 6 次：11,12,…,16
        const retainedDialogs = [16, 15, 14, 13, 12, 11];
        fs.writeFileSync(
            path.join(root, ".memory", "user_instructs.json"),
            JSON.stringify(retainedDialogs.map((dialogIndex) => ({
                timestamp: dialogIndex,
                date: "2026-01-01",
                instruction: `对话-${dialogIndex}`,
                dialogIndex,
            }))),
            "utf8"
        );
        fs.writeFileSync(
            path.join(root, ".memory", "dialog_counter.json"),
            JSON.stringify({ lastDialogIndex: 16 }),
            "utf8"
        );
        // 回复文件里残留着已被淘汰的第 10 次对话
        fs.writeFileSync(
            path.join(root, ".memory", "user_instructs_reply.json"),
            JSON.stringify([
                { id: "10.1", dialogIndex: 10, replyIndex: 1, reply: "已淘汰对话" },
                ...retainedDialogs.map((dialogIndex) => ({
                    id: `${dialogIndex}.1`,
                    dialogIndex,
                    replyIndex: 1,
                    reply: `对话-${dialogIndex}-回复`,
                })),
            ]),
            "utf8"
        );

        const written = await MemoryService.recordMainAgentReply(root, 16, "第16次对话的第2份回复");

        expect(written?.id).toBe("16.2");
        const replies = await MemoryService.getMainAgentReplies(root);
        expect(new Set(replies.map((record) => record.dialogIndex))).toEqual(new Set(retainedDialogs));
        expect(replies.some((record) => record.dialogIndex === 10)).toBe(false);
        expect(replies.map((record) => record.id)).toContain("16.2");
    });

    it("已被淘汰的对话不再接收新回复", async () => {
        const root = path.join(TEST_ROOT, "reply-g");
        const dialogIndex = await MemoryService.recordUserInstruction(root, "唯一对话");

        expect(await MemoryService.recordMainAgentReply(root, dialogIndex + 5, "越界回复")).toBeNull();
        expect(await MemoryService.getMainAgentReplies(root)).toEqual([]);
    });

    it("超长回复截断并标记 truncated，同时保留原始字符数", async () => {
        const root = path.join(TEST_ROOT, "reply-h");
        const dialogIndex = await MemoryService.recordUserInstruction(root, "超长回复");

        const record = await MemoryService.recordMainAgentReply(root, dialogIndex, "长".repeat(25_000));

        expect(record?.truncated).toBe(true);
        expect(record?.replyChars).toBe(25_000);
        expect(record?.reply.length ?? 0).toBeLessThan(25_000);
    });
});
