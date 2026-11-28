import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    test: {
        environment: "node",
        // 多个用例会真实拉起 PowerShell / Worker / DuckDB 进程，5s 默认超时与过高并发会让
        // 限流、竞速类时序用例抖动；这里显式放宽超时并限制并发。
        testTimeout: 20_000,
        minWorkers: 1,
        maxWorkers: 4,
    },
});