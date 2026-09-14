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
