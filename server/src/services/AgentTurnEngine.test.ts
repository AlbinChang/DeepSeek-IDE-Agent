import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "@/services/AgentService.js";
import { AgentTurnEngine } from "@/services/AgentTurnEngine.js";
import { LLMRequestJournal } from "@/services/LLMRequestJournal.js";
import { LLMResponseLog } from "@/services/LLMResponseLog.js";
import { TelemetryService } from "@/services/TelemetryService.js";
import { TodoService } from "@/services/TodoService.js";
import { config as globalConfig } from "@/config/index.js";

describe("AgentTurnEngine request recovery", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-turn-recovery-"));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        // 等待异步响应日志写完，避免删除临时目录时与其竞态
        await LLMResponseLog.getInstance().flush();
        await fs.rm(root, { recursive: true, force: true });
    });

    it("replays the exact saved request and persists it again before calling the model", async () => {
        const journal = new LLMRequestJournal();
        const savedPayload = {
            model: "recovery-model",
            messages: [
                { role: "system", content: "saved system prompt" },
                { role: "user", content: "finish the task" },
            ],
            tools: [{ type: "function", function: { name: "finish_task", parameters: {} } }],
            stream: true,
            stream_options: { include_usage: true },
            reasoning_effort: "high",
        };
        await journal.recordRequest({
            root,
            userId: "recovery-user",
            modelId: "recovery-model",
            providerId: "saved-provider",
            agentStage: "主Agent",
            traceId: "recovery-trace",
            recoveryContext: {
                userInstruction: "finish the task",
                pinnedUserMessage: "finish the task",
            },
            payload: savedPayload,
        });
        const recoveryRecord = await journal.readPendingRequest(root, "recovery-user", 0);

        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const create = vi.fn(async (payload: Record<string, any>) => {
            expect(payload).toEqual(savedPayload);
            const requestFile = await fs.readFile(path.join(root, ".llm-request", "request-1.json"), "utf8");
            const separator = requestFile.indexOf("\n");
            expect(JSON.parse(requestFile.slice(separator + 1))).toEqual(savedPayload);
            return (async function* () {
                yield { choices: [{ delta: { content: "任务已继续完成" } }] };
            })();
        });
        const agentService = {
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "recovery-model",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "recovery-user",
            currentTraceId: "recovery-trace",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "finish the task" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            provider: { id: "saved-provider" },
            agentStage: "主Agent",
            recoveryContext: {
                userInstruction: "finish the task",
                pinnedUserMessage: "finish the task",
            },
            resumeRequest: recoveryRecord,
        });

        expect(create).toHaveBeenCalledTimes(1);
        expect(result.finalAssistantContent).toBe("任务已继续完成");
        expect(agentService.updateSessionHistory).toHaveBeenCalledOnce();
    });

    it("continues the restored tool-call loop with the saved context", async () => {
        const journal = new LLMRequestJournal();
        const savedPayload = {
            model: "recovery-model",
            messages: [
                { role: "system", content: "saved system prompt" },
                { role: "user", content: "finish the task" },
            ],
            tools: [{
                type: "function",
                function: { name: "do_work", parameters: { type: "object", properties: {} } },
            }],
            stream: true,
            stream_options: { include_usage: true },
        };
        await journal.recordRequest({
            root,
            userId: "recovery-user",
            modelId: "recovery-model",
            providerId: "saved-provider",
            agentStage: "主Agent",
            traceId: "recovery-trace",
            recoveryContext: {
                userInstruction: "finish the task",
                pinnedUserMessage: "finish the task",
            },
            payload: savedPayload,
        });
        const recoveryRecord = await journal.readPendingRequest(root, "recovery-user", 0);

        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const executeTool = vi.fn().mockResolvedValue("tool result");
        const create = vi.fn()
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                expect(payload).toEqual(savedPayload);
                await fs.access(path.join(root, ".llm-request", "request-1.json"));
                return (async function* () {
                    yield {
                        choices: [{
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    id: "call-1",
                                    type: "function",
                                    function: { name: "do_work", arguments: "{}" },
                                }],
                            },
                        }],
                    };
                })();
            })
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                expect(payload.messages).toContainEqual({
                    role: "tool",
                    tool_call_id: "call-1",
                    content: "tool result",
                });
                await fs.access(path.join(root, ".llm-request", "request-2.json"));
                return (async function* () {
                    yield { choices: [{ delta: { content: "任务已继续完成" } }] };
                })();
            });
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "recovery-model",
            activeHistory: [],
            toolsMetadata: savedPayload.tools,
            thinkingOptions: {},
            agentService,
            root,
            userId: "recovery-user",
            currentTraceId: "recovery-trace",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "finish the task" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            provider: { id: "saved-provider" },
            agentStage: "主Agent",
            resumeRequest: recoveryRecord,
        });

        expect(create).toHaveBeenCalledTimes(2);
        expect(executeTool).toHaveBeenCalledWith(
            "recovery-user",
            "do_work",
            {},
            "recovery-trace",
            expect.objectContaining({ workspaceRoot: root }),
        );
        expect(result.finalAssistantContent).toBe("任务已继续完成");
    });

    it("filters the tool schema and rejects disallowed tool calls", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const executeTool = vi.fn().mockResolvedValue("tool result");
        const toolsMetadata = [
            { type: "function", function: { name: "read_file", parameters: {} } },
            { type: "function", function: { name: "write_file", parameters: {} } },
        ];
        const create = vi.fn()
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                expect(payload.tools.map((tool: any) => tool.function.name)).toEqual(["read_file"]);
                return (async function* () {
                    yield {
                        choices: [{
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    id: "call-blocked",
                                    type: "function",
                                    function: {
                                        name: "write_file",
                                        arguments: JSON.stringify({ path: "a.txt", content: "x" }),
                                    },
                                }],
                            },
                        }],
                    };
                })();
            })
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                expect(payload.messages).toContainEqual(expect.objectContaining({
                    role: "tool",
                    tool_call_id: "call-blocked",
                    content: expect.stringContaining("not allowed"),
                }));
                return (async function* () {
                    yield { choices: [{ delta: { content: "done" } }] };
                })();
            });
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata,
            thinkingOptions: {},
            agentService,
            root,
            userId: "workflow-user",
            currentTraceId: "trace-allowlist",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "finish the task" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            allowedToolNames: new Set(["read_file"]),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(executeTool).not.toHaveBeenCalled();
        expect(result.finalAssistantContent).toBe("done");
    });

    it("requests a final answer after reaching maxTurns", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const executeTool = vi.fn().mockResolvedValue("tool result");
        const payloads: Record<string, any>[] = [];
        const create = vi.fn().mockImplementation(async (payload: Record<string, any>) => {
            payloads.push(payload);
            if (payloads.length <= 2) {
                return (async function* () {
                    yield {
                        choices: [{
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    id: `call-${payloads.length}`,
                                    type: "function",
                                    function: { name: "do_work", arguments: "{}" },
                                }],
                            },
                        }],
                    };
                })();
            }
            return (async function* () {
                yield { choices: [{ delta: { content: "final answer" } }] };
            })();
        });
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [{ type: "function", function: { name: "do_work", parameters: {} } }],
            thinkingOptions: {},
            agentService,
            root,
            userId: "workflow-user",
            currentTraceId: "trace-maxturns",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "finish the task" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            maxTurns: 2,
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(create).toHaveBeenCalledTimes(3);
        expect(executeTool).toHaveBeenCalledTimes(2);
        expect(payloads[2].tools.map((tool: any) => tool.function.name)).toEqual(["do_work"]);
        expect(payloads[2].tool_choice).toBe("none");
        expect(result.finalAssistantContent).toBe("final answer");
    });

    it("clears the retry stage once the retried stream starts producing tokens", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const create = vi.fn()
                .mockImplementationOnce(async () => {
                    throw Object.assign(new Error("429 rate limited"), { status: 429 });
                })
                .mockImplementationOnce(async () => (async function* () {
                    yield { choices: [{ delta: { content: "recovered" } }] };
                })());
            const beforeApiRequest = vi.fn().mockResolvedValue(undefined);
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "retry-user",
                currentTraceId: "trace-retry",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "finish the task" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
                beforeApiRequest,
            });

            const retryIndex = emitted.findIndex(
                (chunk) => chunk.type === "stage" && String(chunk.content).includes("正在自动进行第 1 次自动重试"),
            );
            const clearIndex = emitted.findIndex(
                (chunk, index) => index > retryIndex && chunk.type === "stage" && chunk.content === "",
            );
            expect(retryIndex).toBeGreaterThanOrEqual(0);
            expect(clearIndex).toBeGreaterThan(retryIndex);
            expect(result.finalAssistantContent).toBe("recovered");
            expect(beforeApiRequest).toHaveBeenCalledTimes(2);
            expect(create).toHaveBeenCalledTimes(2);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("连续 429 超过阈值后提前压缩上下文，并用压缩后的历史继续请求", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const compactedHistory = [
                { role: "system", content: "compacted-system" },
                { role: "user", content: "finish the task" },
            ];
            const prepareMessages = vi.fn(async (messages: any[], options?: { forceCompact?: boolean }) => {
                return options?.forceCompact ? compactedHistory : messages;
            });
            const create = vi.fn()
                .mockImplementationOnce(async () => {
                    throw Object.assign(new Error("429 rate limited"), { status: 429 });
                })
                .mockImplementationOnce(async () => {
                    throw Object.assign(new Error("429 rate limited"), { status: 429 });
                })
                .mockImplementationOnce(async () => {
                    throw Object.assign(new Error("429 rate limited"), { status: 429 });
                })
                .mockImplementationOnce(async () => {
                    throw Object.assign(new Error("429 rate limited"), { status: 429 });
                })
                .mockImplementationOnce(async () => (async function* () {
                    yield { choices: [{ delta: { content: "recovered" } }] };
                })());

            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [
                    { role: "system", content: "original-system" },
                    { role: "user", content: "finish the task" },
                    { role: "assistant", content: "x".repeat(200_000) },
                ],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "rate-limit-user",
                currentTraceId: "trace-rate-limit",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "finish the task" },
                prepareMessages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(5);
            expect(prepareMessages).toHaveBeenCalledWith(expect.any(Array), { forceCompact: true });
            expect(prepareMessages.mock.calls.filter((call) => call[1]?.forceCompact)).toHaveLength(1);
            expect(emitted.some((chunk) => chunk.type === "notice" && chunk.code === "RATE_LIMIT_CONTEXT_COMPACTED")).toBe(true);
            // 压缩后的请求必须使用重建后的历史（而不是继续发送原始超长上下文）
            const lastPayload = create.mock.calls[4][0] as any;
            expect(lastPayload.messages).toEqual(compactedHistory);
            expect(result.finalAssistantContent).toBe("recovered");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("429 重试超过限流预算后如实失败，不会无限重试", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const rateLimitError = Object.assign(new Error("429 rate limited"), { status: 429 });
            const create = vi.fn().mockRejectedValue(rateLimitError);
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            await expect(AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [
                    { role: "system", content: "system" },
                    { role: "user", content: "finish the task" },
                ],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "rate-limit-budget-user",
                currentTraceId: "trace-rate-limit-budget",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "finish the task" },
                prepareMessages: async (messages) => messages,
                emit: vi.fn(),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            })).rejects.toBe(rateLimitError);

            expect(create).toHaveBeenCalledTimes(globalConfig.agent.apiRateLimitRetryLimit + 1);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("连续 503 服务过载超过阈值后同样提前压缩上下文，避免无限重试", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const compactedHistory = [
                { role: "system", content: "compacted-system" },
                { role: "user", content: "finish the task" },
            ];
            const prepareMessages = vi.fn(async (messages: any[], options?: { forceCompact?: boolean }) => {
                return options?.forceCompact ? compactedHistory : messages;
            });
            const busyError = () => Object.assign(new Error("503 Service is too busy"), { status: 503 });
            const create = vi.fn()
                .mockImplementationOnce(async () => { throw busyError(); })
                .mockImplementationOnce(async () => { throw busyError(); })
                .mockImplementationOnce(async () => { throw busyError(); })
                .mockImplementationOnce(async () => { throw busyError(); })
                .mockImplementationOnce(async () => (async function* () {
                    yield { choices: [{ delta: { content: "recovered" } }] };
                })());

            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [
                    { role: "system", content: "original-system" },
                    { role: "user", content: "finish the task" },
                    { role: "assistant", content: "x".repeat(200_000) },
                ],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "service-busy-user",
                currentTraceId: "trace-service-busy",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "finish the task" },
                prepareMessages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(5);
            expect(prepareMessages.mock.calls.filter((call) => call[1]?.forceCompact)).toHaveLength(1);
            expect(emitted.some((chunk) => chunk.type === "notice" && chunk.code === "RATE_LIMIT_CONTEXT_COMPACTED")).toBe(true);
            // 压缩后的请求必须使用重建后的历史
            expect((create.mock.calls[4][0] as any).messages).toEqual(compactedHistory);
            expect(result.finalAssistantContent).toBe("recovered");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("连续重试超过墙钟预算后停止自动重试并如实报错", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        const nowSpy = vi.spyOn(Date, "now");
        let clock = Date.now();
        nowSpy.mockImplementation(() => (clock += 30_000));
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const busyError = Object.assign(new Error("503 Service is too busy"), { status: 503 });
            const create = vi.fn().mockRejectedValue(busyError);
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            await expect(AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [
                    { role: "system", content: "system" },
                    { role: "user", content: "finish the task" },
                ],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "service-busy-budget-user",
                currentTraceId: "trace-service-busy-budget",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "finish the task" },
                prepareMessages: async (messages) => messages,
                emit: vi.fn(),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            })).rejects.toThrow("已停止自动重试");

            // 次数预算（默认 100）远未耗尽就被墙钟预算拦住
            expect(create.mock.calls.length).toBeGreaterThan(1);
            expect(create.mock.calls.length).toBeLessThan(globalConfig.agent.apiServiceBusyRetryLimit + 1);
        } finally {
            nowSpy.mockRestore();
            setTimeoutSpy.mockRestore();
        }
    });

    it("把每次模型请求（含重试）的返回结果写入 .llm_response", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const create = vi.fn()
                .mockImplementationOnce(async () => {
                    throw Object.assign(new Error("429 rate limited"), { status: 429 });
                })
                .mockImplementationOnce(async () => (async function* () {
                    yield { model: "test-model", choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] };
                    yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
                })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "response-log-user",
                currentTraceId: "trace-response-log",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "finish the task" },
                prepareMessages: async (messages) => messages,
                emit: vi.fn(),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            await LLMResponseLog.getInstance().flush();
            const directory = path.join(root, ".llm_response");
            const files = (await fs.readdir(directory))
                .sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0));
            expect(files.length).toBe(2);

            const firstLines = (await fs.readFile(path.join(directory, files[0]), "utf8"))
                .split("\n").filter((line) => line.length > 0);
            expect(firstLines).toHaveLength(2);
            const firstMetadata = JSON.parse(firstLines[0]);
            expect(firstMetadata.success).toBe(false);
            expect(firstMetadata.error.status).toBe(429);
            expect(firstMetadata.retry).toMatchObject({ willRetry: true, category: "rate_limited" });
            expect(JSON.parse(firstLines[1]).content).toBe("");

            const secondLines = (await fs.readFile(path.join(directory, files[1]), "utf8"))
                .split("\n").filter((line) => line.length > 0);
            const secondMetadata = JSON.parse(secondLines[0]);
            expect(secondMetadata.success).toBe(true);
            expect(secondMetadata.request.attempt).toBe(2);
            expect(secondMetadata.servedModels).toEqual(["test-model"]);
            expect(JSON.parse(secondLines[1])).toMatchObject({ content: "recovered", finishReason: "stop" });
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("does not retry a successful model response when usage validation fails", async () => {        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const create = vi.fn().mockImplementation(async () => (async function* () {
            yield { choices: [{ delta: { content: "output" } }] };
        })());
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;
        await expect(AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "budget-user",
            currentTraceId: "trace-budget",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "test" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
            afterApiRequest: (usage) => {
                if (!usage) throw new Error("usage missing");
            },
        })).rejects.toThrow("usage missing");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("skips telemetry writes and forwards usage to the sink", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const recordRequest = vi.spyOn(TelemetryService, "recordRequest").mockImplementation(() => {});
        const telemetrySink = vi.fn();
        const create = vi.fn()
            .mockImplementationOnce(async () => (async function* () {
                yield {
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: "call-usage",
                                type: "function",
                                function: { name: "do_work", arguments: "{}" },
                            }],
                        },
                    }],
                    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
                };
            })())
            .mockImplementationOnce(async () => (async function* () {
                yield {
                    choices: [{ delta: { content: "ok" } }],
                    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
                };
            })());
        const agentService = {
            toolManager: { executeTool: vi.fn().mockResolvedValue("tool result") },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [{ type: "function", function: { name: "do_work", parameters: {} } }],
            thinkingOptions: {},
            agentService,
            root,
            userId: "workflow-user",
            currentTraceId: "trace-telemetry",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "finish the task" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
            telemetrySink,
        });

        expect(recordRequest).not.toHaveBeenCalled();
        expect(telemetrySink).toHaveBeenNthCalledWith(
            1,
            { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            "test-model",
        );
        expect(telemetrySink).toHaveBeenNthCalledWith(
            2,
            { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
            "test-model",
        );
        expect(result.finalAssistantContent).toBe("ok");
    });

    it("retries once without showing control-token leakage, then returns clean content", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const create = vi.fn()
                .mockImplementationOnce(async () => (async function* () {
                    yield {
                        model: "ernie-4.5-300b-a47b",
                        choices: [{ delta: { content: "<|begin_of_sentence|>####下列判色丑 插件Combine" } }],
                    };
                })())
                .mockImplementationOnce(async () => (async function* () {
                    yield { model: "test-model", choices: [{ delta: { content: "正常回答" } }] };
                })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(2);
            expect(result.finalAssistantContent).toBe("正常回答");
            const streamedText = emitted
                .filter((chunk) => chunk.type === "text")
                .map((chunk) => String(chunk.content))
                .join("");
            expect(streamedText).not.toContain("begin_of_sentence");
            expect(streamedText).toContain("正常回答");
            expect(agentService.updateSessionHistory).not.toHaveBeenCalled();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("discards a response whose tool-call arguments leak control tokens and retries without executing the tool", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const executeTool = vi.fn().mockResolvedValue("should not run");
            const create = vi.fn()
                .mockImplementationOnce(async () => (async function* () {
                    // 控制标记被拆到两个 delta 中，验证增量重叠窗口仍能命中
                    yield {
                        model: "test-model",
                        choices: [{
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    id: "call-1",
                                    type: "function",
                                    function: { name: "read_file", arguments: '{"path":"</begin_of_sentence' },
                                }],
                            },
                        }],
                    };
                    yield {
                        model: "test-model",
                        choices: [{
                            delta: {
                                tool_calls: [{ index: 0, function: { arguments: ' />ehoy3 documnt field"}' } }],
                            },
                        }],
                    };
                })())
                .mockImplementationOnce(async () => (async function* () {
                    yield { model: "test-model", choices: [{ delta: { content: "正常回答" } }] };
                })());
            const agentService = {
                toolManager: { executeTool },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [{ type: "function", function: { name: "read_file", parameters: {} } }],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-arguments",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(2);
            expect(executeTool).not.toHaveBeenCalled();
            expect(result.finalAssistantContent).toBe("正常回答");
            const streamedText = emitted
                .filter((chunk) => chunk.type === "text")
                .map((chunk) => String(chunk.content))
                .join("");
            expect(streamedText).not.toContain("begin_of_sentence");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("discards control-token garbage that arrives as reasoning before emitting it", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const create = vi.fn()
                .mockImplementationOnce(async () => (async function* () {
                    yield {
                        model: "test-model",
                        choices: [{ delta: { reasoning_content: "<｜begin▁of▁sentence｜>异常推理内容" } }],
                    };
                })())
                .mockImplementationOnce(async () => (async function* () {
                    yield { model: "test-model", choices: [{ delta: { content: "正常回答" } }] };
                })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-reasoning",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(2);
            expect(result.finalAssistantContent).toBe("正常回答");
            const streamed = emitted
                .filter((chunk) => chunk.type === "reasoning" || chunk.type === "text")
                .map((chunk) => String(chunk.content))
                .join("");
            expect(streamed).not.toContain("of▁sentence");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("skips executing a tool whose arguments are not valid JSON", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const emitted: any[] = [];
        const executeTool = vi.fn().mockResolvedValue("ok");
        const create = vi.fn()
            .mockImplementationOnce(async () => (async function* () {
                yield {
                    model: "test-model",
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: "call-1",
                                type: "function",
                                function: { name: "read_file", arguments: '{"path": "src/index.ts"' },
                            }],
                        },
                    }],
                };
            })())
            .mockImplementationOnce(async () => (async function* () {
                yield { model: "test-model", choices: [{ delta: { content: "参数错误，已跳过执行" } }] };
            })());
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [{ type: "function", function: { name: "read_file", parameters: {} } }],
            thinkingOptions: {},
            agentService,
            root,
            userId: "guard-user",
            currentTraceId: "trace-guard-json",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "检查代码" },
            prepareMessages: async (messages) => messages,
            emit: (chunk) => emitted.push(chunk),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(create).toHaveBeenCalledTimes(2);
        expect(executeTool).not.toHaveBeenCalled();
        expect(result.finalAssistantContent).toBe("参数错误，已跳过执行");
        expect(emitted.some((chunk) => chunk.type === "annotation"
            && chunk.method === "tool/error"
            && chunk.params?.toolCallId === "call-1")).toBe(true);
    });

    it("fails the turn instead of persisting control-token garbage", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        const originalCorruptionLimit = globalConfig.agent.modelCorruptionRetries;
        globalConfig.agent.modelCorruptionRetries = 3;
        vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            const garbage = {
                // 与请求模型一致，确保本用例只验证“控制标记泄漏”处理路径，不与模型替换重试互相干扰
                model: "deepseek-v4-flash",
                system_fingerprint: "fp-proxy-1",
                choices: [{ delta: { content: "<|begin_of_sentence|>####异常输出<|end_of_sentence|>" } }],
            };
            const create = vi.fn(async () => (async function* () {
                yield garbage;
            })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            await expect(AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "deepseek-v4-flash",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-fail",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
                provider: { id: "proxy", name: "proxy", type: "openai-compatible", modelId: "deepseek-v4-flash", apiKey: "x", baseURL: "https://gateway.example.com/v1" },
            })).rejects.toMatchObject({ code: "MODEL_OUTPUT_CORRUPTED" });

            expect(create).toHaveBeenCalledTimes(8);
            expect(emitted.some((chunk) => chunk.type === "text" && String(chunk.content).includes("begin_of_sentence")))
                .toBe(false);
            expect(agentService.updateSessionHistory).not.toHaveBeenCalled();
        } finally {
            globalConfig.agent.modelCorruptionRetries = originalCorruptionLimit;
            setTimeoutSpy.mockRestore();
        }
    });

    it("retries duplicated control tokens appearing mid-answer and returns the clean answer", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        try {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const create = vi.fn()
                .mockImplementationOnce(async () => (async function* () {
                    yield { choices: [{ delta: { content: "先给出结论。" } }] };
                    yield { choices: [{ delta: { content: "另外 <|end_of_sentence|> 与 <|end_of_sentence|> 重复出现" } }] };
                })())
                .mockImplementationOnce(async () => (async function* () {
                    yield { choices: [{ delta: { content: "正常的最终结论。" } }] };
                })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-body",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: vi.fn(),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(2);
            expect(result.finalAssistantContent).toBe("正常的最终结论。");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("injects a corrective directive when abnormal output survives the retry budget", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
        const originalCorruptionLimit = globalConfig.agent.modelCorruptionRetries;
        globalConfig.agent.modelCorruptionRetries = 3;
        try {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
            const emitted: any[] = [];
            let call = 0;
            const create = vi.fn(async (payload: any) => {
                call += 1;
                if (call <= 4) {
                    return (async function* () {
                        yield { choices: [{ delta: { content: "<|begin_of_sentence|>####异常输出" } }] };
                    })();
                }
                return (async function* () {
                    yield { choices: [{ delta: { content: "注入纠正指令后的正常回答。" } }] };
                })();
            });
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-recovery",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(5);
            expect(result.finalAssistantContent).toBe("注入纠正指令后的正常回答。");
            expect(emitted.some((chunk) => chunk.type === "notice" && chunk.code === "MODEL_OUTPUT_CORRUPTED"))
                .toBe(true);
            const recoveryMessages = create.mock.calls[4][0].messages as any[];
            expect(recoveryMessages.some((message) => String(message.content || "").includes("异常控制标记")))
                .toBe(true);
        } finally {
            globalConfig.agent.modelCorruptionRetries = originalCorruptionLimit;
            setTimeoutSpy.mockRestore();
        }
    });

    it("keeps answers that merely quote a control token inside code spans", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const create = vi.fn(async () => (async function* () {
            yield { choices: [{ delta: { content: '"`<|begin_of_sentence|>` 是 ERNIE 的 BOS 标记。"' } }] };
        })());
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "guard-user",
            currentTraceId: "trace-guard-quote",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "解释特殊 token" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(result.finalAssistantContent).toContain("begin_of_sentence");
    });

    it("accepts an abbreviated served model id without substitution retry or warning", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const emitted: any[] = [];
        const create = vi.fn(async () => (async function* () {
            yield {
                model: "dsv4",
                choices: [{ delta: { content: "这是来自 dsv4 的干净回答，长度足够确认前缀。" } }],
            };
        })());
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "deepseek-v4-flash",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "alias-user",
            currentTraceId: "trace-alias",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "检查代码" },
            prepareMessages: async (messages) => messages,
            emit: (chunk) => emitted.push(chunk),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(create).toHaveBeenCalledTimes(1);
        expect(emitted.some((chunk) => chunk.type === "notice")).toBe(false);
        expect(result.finalAssistantContent).toContain("干净回答");
    });

    it("discards the substituted reply and retries until the requested model is served", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const emitted: any[] = [];
        let call = 0;
        const create = vi.fn(async () => {
            call += 1;
            if (call === 1) {
                return (async function* () {
                    yield {
                        model: "ernie-4.5-300b-a47b",
                        system_fingerprint: "fp-proxy-9",
                        choices: [{ delta: { content: "被替换模型的回复不该出现在最终结果里。" } }],
                    };
                })();
            }
            return (async function* () {
                yield {
                    model: "deepseek-v4-flash",
                    choices: [{ delta: { content: "这是来自请求模型的干净回答，长度足够确认前缀。" } }],
                };
            })();
        });
        const updateSessionHistory = vi.fn();
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory,
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "deepseek-v4-flash",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "notice-user",
            currentTraceId: "trace-notice-retry",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "检查代码" },
            prepareMessages: async (messages) => messages,
            emit: (chunk) => emitted.push(chunk),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
            provider: { id: "proxy", name: "proxy", type: "openai-compatible", modelId: "deepseek-v4-flash", apiKey: "x", baseURL: "https://gateway.example.com/v1" },
        });

        expect(create).toHaveBeenCalledTimes(2);
        expect(result.finalAssistantContent).toContain("干净回答");
        expect(result.finalAssistantContent).not.toContain("被替换模型");
        const streamedText = emitted.filter((chunk) => chunk.type === "text").map((chunk) => chunk.content).join("");
        expect(streamedText).not.toContain("被替换模型");

        const notices = emitted.filter((chunk) => chunk.type === "notice");
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
            code: "MODEL_SUBSTITUTION",
            level: "warning",
            params: {
                requestedModel: "deepseek-v4-flash",
                servedModels: ["ernie-4.5-300b-a47b"],
                retries: 1,
                resolved: true,
            },
        });
        expect(notices[0].content).toContain("已丢弃该次回复并重试");
    });

    it("keeps only the last reply when substitution persists beyond the retry budget", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const originalLimit = globalConfig.agent.modelSubstitutionRetries;
        globalConfig.agent.modelSubstitutionRetries = 2;
        try {
            const emitted: any[] = [];
            const create = vi.fn(async () => (async function* () {
                yield {
                    model: "ernie-4.5-300b-a47b",
                    system_fingerprint: "fp-proxy-9",
                    choices: [{ delta: { content: "这是一个正常长度的回答，用于验证提示逻辑。" } }],
                };
            })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "deepseek-v4-flash",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "notice-user",
                currentTraceId: "trace-notice",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
                provider: { id: "proxy", name: "proxy", type: "openai-compatible", modelId: "deepseek-v4-flash", apiKey: "x", baseURL: "https://gateway.example.com/v1" },
            });

            // 两次重试预算用尽后接受最后一次回复，避免用户拿不到答案
            expect(create).toHaveBeenCalledTimes(3);
            const notices = emitted.filter((chunk) => chunk.type === "notice");
            expect(notices).toHaveLength(1);
            expect(notices[0]).toMatchObject({
                code: "MODEL_SUBSTITUTION",
                level: "warning",
                params: {
                    requestedModel: "deepseek-v4-flash",
                    servedModels: ["ernie-4.5-300b-a47b"],
                    systemFingerprint: "fp-proxy-9",
                    baseUrlHost: "gateway.example.com",
                    retries: 2,
                    resolved: false,
                },
            });
            expect(notices[0].content).toContain("ernie-4.5-300b-a47b");
            expect(notices[0].content).toContain("重试 2 次仍不一致");
            expect(result.finalAssistantContent).toContain("正常长度");
        } finally {
            globalConfig.agent.modelSubstitutionRetries = originalLimit;
        }
    });

    it("does not discard the reply when substitution retries are disabled", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const originalLimit = globalConfig.agent.modelSubstitutionRetries;
        globalConfig.agent.modelSubstitutionRetries = 0;
        try {
            const emitted: any[] = [];
            const create = vi.fn(async () => (async function* () {
                yield { model: "ernie-4.5-300b-a47b", choices: [{ delta: { content: "直接接受该回复，长度足够确认前缀。" } }] };
            })());
            const agentService = {
                toolManager: { executeTool: vi.fn() },
                updateSessionHistory: vi.fn(),
            } as unknown as AgentService;

            const result = await AgentTurnEngine.runTurns({
                client: { chat: { completions: { create } } },
                finalModelId: "deepseek-v4-flash",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "notice-user",
                currentTraceId: "trace-notice-off",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(create).toHaveBeenCalledTimes(1);
            expect(result.finalAssistantContent).toContain("直接接受");
            const notices = emitted.filter((chunk) => chunk.type === "notice");
            expect(notices).toHaveLength(1);
            expect(notices[0].params).toMatchObject({ retries: 0, resolved: false });
        } finally {
            globalConfig.agent.modelSubstitutionRetries = originalLimit;
        }
    });

    it("does not emit substitution notices when the served model matches", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const emitted: any[] = [];
        const create = vi.fn(async () => (async function* () {
            yield { model: "deepseek-chat-0324", choices: [{ delta: { content: "正常回答内容足够长以确认前缀。" } }] };
        })());
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "deepseek-chat",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "notice-user",
            currentTraceId: "trace-notice-ok",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "检查代码" },
            prepareMessages: async (messages) => messages,
            emit: (chunk) => emitted.push(chunk),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(emitted.some((chunk) => chunk.type === "notice")).toBe(false);
    });

    it("detects control-token leakage over a real SSE stream, retries, and never persists it", async () => {
        const { createServer } = await import("node:http");
        const OpenAI = (await import("openai")).default;
        let connections = 0;
        const server = createServer((_request, response) => {
            connections += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            const chunk = (content: string, model: string) => `data: ${JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 0,
                model,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`;
            if (connections === 1) {
                response.write(chunk("<|begin_of_sentence|>####下列判色丑 插件Combine<|end_of_sentence|>", "deepseek-v4-flash"));
            } else {
                response.write(chunk("重试后返回的干净回答，长度足够确认前缀。", "deepseek-v4-flash"));
            }
            response.end("data: [DONE]\n\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const client = new OpenAI({ apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;
        const emitted: any[] = [];
        try {
            const result = await AgentTurnEngine.runTurns({
                client,
                finalModelId: "deepseek-v4-flash",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-sse",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
                provider: { id: "proxy", name: "proxy", type: "openai-compatible", modelId: "deepseek-v4-flash", apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1` },
            });

            expect(connections).toBe(2);
            expect(result.finalAssistantContent).toContain("干净回答");
            expect(agentService.updateSessionHistory).not.toHaveBeenCalled();
            expect(emitted.some((chunk) => chunk.type === "text" && String(chunk.content).includes("begin_of_sentence")))
                .toBe(false);
        } finally {
            vi.restoreAllMocks();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("discards a real SSE stream whose tool-call arguments leak control tokens", async () => {
        const { createServer } = await import("node:http");
        const OpenAI = (await import("openai")).default;
        let connections = 0;
        const server = createServer((_request, response) => {
            connections += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            const send = (payload: any) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
            if (connections === 1) {
                send({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: "call-1",
                                type: "function",
                                function: {
                                    name: "read_file",
                                    arguments: '{"path":"</begin_of_sentence />ehoy3 documnt field"}',
                                },
                            }],
                        },
                        finish_reason: null,
                    }],
                });
            } else {
                send({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [{ index: 0, delta: { content: "正常回答" }, finish_reason: null }],
                });
            }
            response.end("data: [DONE]\n\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const client = new OpenAI({ apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const executeTool = vi.fn().mockResolvedValue("should not run");
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;
        try {
            const result = await AgentTurnEngine.runTurns({
                client,
                finalModelId: "test-model",
                activeHistory: [],
                toolsMetadata: [{ type: "function", function: { name: "read_file", parameters: {} } }],
                thinkingOptions: {},
                agentService,
                root,
                userId: "guard-user",
                currentTraceId: "trace-guard-sse-args",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "读取文件" },
                prepareMessages: async (messages) => messages,
                emit: vi.fn(),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
            });

            expect(connections).toBe(2);
            expect(executeTool).not.toHaveBeenCalled();
            expect(result.finalAssistantContent).toBe("正常回答");
        } finally {
            vi.restoreAllMocks();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("discards a substituted SSE stream and re-requests until the requested model answers", async () => {
        const { createServer } = await import("node:http");
        const OpenAI = (await import("openai")).default;
        let connections = 0;
        const server = createServer((_request, response) => {
            connections += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            const chunk = (content: string, model: string) => `data: ${JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 0,
                model,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`;
            if (connections === 1) {
                response.write(chunk("被替换模型的回复不该出现在最终结果里。", "ernie-4.5-300b-a47b"));
            } else {
                response.write(chunk("这是请求模型返回的干净回答，长度足够确认前缀。", "deepseek-v4-flash"));
            }
            response.end("data: [DONE]\n\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const client = new OpenAI({ apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;
        const emitted: any[] = [];
        try {
            const result = await AgentTurnEngine.runTurns({
                client,
                finalModelId: "deepseek-v4-flash",
                activeHistory: [],
                toolsMetadata: [],
                thinkingOptions: {},
                agentService,
                root,
                userId: "substitution-user",
                currentTraceId: "trace-substitution-sse",
                optimizedMessages: [],
                lastUserMsgRecord: { role: "user", content: "检查代码" },
                prepareMessages: async (messages) => messages,
                emit: (chunk) => emitted.push(chunk),
                startTimeStamp: Date.now(),
                skipJournal: true,
                skipPersist: true,
                skipTelemetry: true,
                provider: { id: "proxy", name: "proxy", type: "openai-compatible", modelId: "deepseek-v4-flash", apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1` },
            });

            expect(connections).toBe(2);
            expect(result.finalAssistantContent).toContain("干净回答");
            expect(result.finalAssistantContent).not.toContain("被替换模型");
            expect(emitted.some((chunk) => chunk.type === "text" && String(chunk.content).includes("被替换模型")))
                .toBe(false);
            const notices = emitted.filter((chunk) => chunk.type === "notice");
            expect(notices).toHaveLength(1);
            expect(notices[0].params).toMatchObject({ retries: 1, resolved: true });
        } finally {
            vi.restoreAllMocks();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("captures finish_reason from the terminal chunk and warns on truncated output", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const create = vi.fn(async () => (async function* () {
            yield { choices: [{ delta: { content: "只输出了报告开头" } }] };
            // finish_reason 只出现在最后一个 delta 为空的 chunk 上
            yield { choices: [{ delta: {}, finish_reason: "length" }] };
        })());
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;
        const emitted: any[] = [];

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [],
            thinkingOptions: {},
            agentService,
            root,
            userId: "truncation-user",
            currentTraceId: "trace-truncation",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "生成评估报告" },
            prepareMessages: async (messages) => messages,
            emit: (chunk) => emitted.push(chunk),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(result.finishReason).toBe("length");
        expect(result.finalAssistantContent).toBe("只输出了报告开头");
        expect(emitted.some((chunk) => chunk.type === "notice" && chunk.code === "MODEL_OUTPUT_TRUNCATED"))
            .toBe(true);
    });

    it("forceFinalAnswer requests tool_choice=none from the first turn", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const payloads: any[] = [];
        const create = vi.fn(async (payload: Record<string, any>) => {
            payloads.push(payload);
            return (async function* () {
                yield {
                    choices: [{
                        delta: { content: "完整报告正文，已按要求直接输出。" },
                        finish_reason: "stop",
                    }],
                };
            })();
        });
        const agentService = {
            toolManager: { executeTool: vi.fn() },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        const result = await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [{ type: "function", function: { name: "do_work", parameters: {} } }],
            thinkingOptions: {},
            agentService,
            root,
            userId: "force-final-user",
            currentTraceId: "trace-force-final",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "重写评估报告" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            forceFinalAnswer: true,
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(payloads).toHaveLength(1);
        expect(payloads[0].tool_choice).toBe("none");
        expect(result.finishReason).toBe("stop");
        expect(result.finalAssistantContent).toContain("完整报告正文");
    });

    it("工具参数不是合法 JSON 时，回放的 arguments 收敛为 {}，避免严格网关 400", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const payloads: any[] = [];
        const executeTool = vi.fn();
        const create = vi.fn()
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                payloads.push(payload);
                return (async function* () {
                    yield {
                        choices: [{
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    id: "call-truncated",
                                    type: "function",
                                    function: {
                                        name: "insert_in_file",
                                        // 输出被截断：JSON 未闭合
                                        arguments: '{"path":"Demo.java","startLine":2,"newText":"class A {',
                                    },
                                }],
                            },
                        }],
                    };
                })();
            })
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                payloads.push(payload);
                return (async function* () {
                    yield { choices: [{ delta: { content: "完成" } }] };
                })();
            });
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [{ type: "function", function: { name: "insert_in_file", parameters: {} } }],
            thinkingOptions: {},
            agentService,
            root,
            userId: "truncated-args-user",
            currentTraceId: "trace-truncated-args",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "补充测试" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(create).toHaveBeenCalledTimes(2);
        expect(executeTool).not.toHaveBeenCalled();

        const second = payloads[1];
        const assistant = second.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
        expect(assistant.tool_calls[0].function.arguments).toBe("{}");
        expect(() => JSON.parse(assistant.tool_calls[0].function.arguments)).not.toThrow();

        const toolMessage = second.messages.find((m: any) => m.role === "tool");
        expect(toolMessage.content).toContain("工具参数不是合法 JSON");
    });

    it("请求前修复孤立代理码元，避免 400 请求格式不合法（insert_in_file 回显场景）", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const loneHigh = "\uD83D";
        const payloads: any[] = [];
        // insert_in_file 的 contextSnapshot 会回显文件内容；UTF-16 解码/截断
        // 可能产生孤立代理码元，直接回传会导致下一次请求 400。
        const executeTool = vi.fn().mockResolvedValue(`1: line ${loneHigh}`);
        const create = vi.fn()
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                payloads.push(payload);
                return (async function* () {
                    yield {
                        choices: [{
                            delta: {
                                content: `准备插入 ${loneHigh}`,
                                reasoning_content: `推理 ${loneHigh}`,
                                tool_calls: [{
                                    index: 0,
                                    id: "call-insert",
                                    type: "function",
                                    function: {
                                        name: "insert_in_file",
                                        // 模型流式输出可能直接携带孤立代理码元（非 \uXXXX 转义）
                                        arguments: `{"path":"a.java","startLine":1,"newText":"class A { // ${loneHigh}"}`,
                                    },
                                }],
                            },
                        }],
                    };
                })();
            })
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                payloads.push(payload);
                return (async function* () {
                    yield { choices: [{ delta: { content: "完成" } }] };
                })();
            });
        const agentService = {
            toolManager: { executeTool },
            updateSessionHistory: vi.fn(),
        } as unknown as AgentService;

        await AgentTurnEngine.runTurns({
            client: { chat: { completions: { create } } },
            finalModelId: "test-model",
            activeHistory: [],
            toolsMetadata: [{ type: "function", function: { name: "insert_in_file", parameters: {} } }],
            thinkingOptions: {},
            agentService,
            root,
            userId: "unicode-user",
            currentTraceId: "trace-unicode",
            optimizedMessages: [],
            lastUserMsgRecord: { role: "user", content: "补充测试" },
            prepareMessages: async (messages) => messages,
            emit: vi.fn(),
            startTimeStamp: Date.now(),
            skipJournal: true,
            skipPersist: true,
            skipTelemetry: true,
        });

        expect(create).toHaveBeenCalledTimes(2);
        expect(payloads).toHaveLength(2);

        const second = payloads[1];
        // JSON.stringify 只会把孤立代理码元转义为 \udXXX；合法代理对保持原字符。
        expect(JSON.stringify(second)).not.toMatch(/\\u[dD][89abAB][0-9a-fA-F]{2}/);

        const toolMessage = second.messages.find((m: any) => m.role === "tool");
        expect(toolMessage.content).toBe("1: line \uFFFD");

        const assistant = second.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
        expect(assistant.content).toBe("准备插入 \uFFFD");
        expect(assistant.reasoning_content).toBe("推理 \uFFFD");
        expect(assistant.tool_calls[0].function.arguments).not.toContain(loneHigh);
        expect(assistant.tool_calls[0].function.arguments).toContain("\uFFFD");
    });
});
