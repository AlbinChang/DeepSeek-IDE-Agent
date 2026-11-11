import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "@/services/AgentService.js";
import { AgentTurnEngine } from "@/services/AgentTurnEngine.js";
import { LLMRequestJournal } from "@/services/LLMRequestJournal.js";
import { TelemetryService } from "@/services/TelemetryService.js";
import { TodoService } from "@/services/TodoService.js";

describe("AgentTurnEngine request recovery", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-turn-recovery-"));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
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
            { type: "function", function: { name: "file_write", parameters: {} } },
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
                                        name: "file_write",
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

    it("does not retry a successful model response when usage validation fails", async () => {
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
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
});
