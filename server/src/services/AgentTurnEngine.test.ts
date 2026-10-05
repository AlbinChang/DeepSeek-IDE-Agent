import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "@/services/AgentService.js";
import { AgentTurnEngine } from "@/services/AgentTurnEngine.js";
import { LLMRequestJournal } from "@/services/LLMRequestJournal.js";
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
            { workspaceRoot: root },
        );
        expect(result.finalAssistantContent).toBe("任务已继续完成");
    });
});
