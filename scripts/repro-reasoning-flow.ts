/**
 * 复现脚本：模拟第二次对话的完整消息流转，
 * 校验每个发往 API 的请求中，携带 tool_calls 的 assistant 消息是否完整回传 reasoning_content。
 */
import { MessagePreparationService } from "../server/src/services/MessagePreparationService.js";
import { HistoryOptimizerService } from "../server/src/services/HistoryOptimizerService.js";
import { extractReasoningText, hasReasoningField } from "../server/src/utils/ReasoningUtils.js";

// ── 模拟 DeepSeek 思考模式流式响应（每轮：reasoning → tool_calls） ──
function mockStreamResponse(round: number, withToolCalls: boolean, reasoning: string): any[] {
    const chunks: any[] = [];
    for (const piece of [reasoning.slice(0, 10), reasoning.slice(10)]) {
        if (!piece) continue;
        chunks.push({ choices: [{ delta: { reasoning_content: piece } }] });
    }
    if (withToolCalls) {
        chunks.push({
            choices: [{
                delta: {
                    tool_calls: [{ index: 0, id: `call-${round}`, type: "function", function: { name: "list_files", arguments: "{}" } }],
                },
            }],
        });
    } else {
        chunks.push({ choices: [{ delta: { content: `final-answer-${round}` } }] });
    }
    chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
    return chunks;
}

// ── 复刻 AgentTurnEngine 的请求循环（仅消息流转，不含真实 API） ──
async function simulateSecondConversation() {
    // 1. 第一次对话持久化的历史（commit 1db7122 之后：最终回答保留 reasoning_content）
    const storedHistory = [
        { role: "user", content: "再帮我打包一下zip文件" },
        { role: "assistant", content: "已重新打包 v1.3.0.zip", reasoning_content: "第一次对话的最终推理链" },
    ];

    // 2. 第二次对话的用户指令
    const secondInstruct = "删除 .7z 压缩包";

    // 3. optimizeHistory（与 AgentChatComponent 一致）
    const { messages: optimizedMessages } = await HistoryOptimizerService.getInstance().optimizeHistory(
        [...storedHistory], "test-user", "D:/test-root"
    );
    console.log("[optimizedMessages]", JSON.stringify(optimizedMessages, null, 2));

    // 4. prepareMessages（与 AgentChatComponent 一致）
    const prepareMessages = async (msgs: any[]) =>
        MessagePreparationService.buildMessages({
            systemPrompt: "SYSTEM_PROMPT",
            pinnedUserMessage: secondInstruct,
            incomingMessages: msgs,
        });

    let activeHistory = await prepareMessages(optimizedMessages);
    console.log("[request-1]", JSON.stringify(activeHistory, null, 2));

    let violations: string[] = [];
    const checkRequest = (label: string, messages: any[]) => {
        for (const m of messages) {
            if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                const rc = hasReasoningField(m) ? extractReasoningText(m) : "";
                if (!rc) {
                    violations.push(`${label}: assistant(tool_calls) 的 reasoning_content 为空 → 会触发 DeepSeek 400`);
                }
            }
        }
    };

    let round = 0;
    const maxRounds = 3;
    let lastAssistantReasoning = "";
    while (round < maxRounds) {
        round++;
        // 模拟模型第 round 轮响应
        const withToolCalls = round < 3;
        // 第 2 轮故意模拟「续接工具轮时模型未输出推理」的真实场景
        const reasoning = round === 2 ? "" : `第${round}轮的推理内容 reasoning-${round}`;
        const chunks = mockStreamResponse(round, withToolCalls, reasoning);

        // 复刻 AgentTurnEngine 的收集逻辑
        let fullReasoning = "";
        let fullContent = "";
        let toolCalls: any[] = [];
        for (const chunk of chunks) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;
            const rd = extractReasoningText(delta);
            if (rd) fullReasoning += rd;
            if (delta.content) fullContent += delta.content;
            if (delta.tool_calls) {
                delta.tool_calls.forEach((tc: any) => {
                    if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id, function: { name: "", arguments: "" } };
                    if (tc.id) toolCalls[tc.index].id = tc.id;
                    if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
                    if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                });
            }
        }
        if (fullReasoning && fullReasoning.trim()) lastAssistantReasoning = fullReasoning.trim();

        const assistantMsg: any = { role: "assistant", content: fullContent };
        if (fullReasoning) assistantMsg.reasoning_content = fullReasoning;

        if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map((tc) => ({
                id: tc.id, type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
            if (!assistantMsg.reasoning_content) {
                assistantMsg.reasoning_content = lastAssistantReasoning;
            }
            if (!Object.prototype.hasOwnProperty.call(assistantMsg, "reasoning_content")) {
                assistantMsg.reasoning_content = "";
            }
            activeHistory.push(assistantMsg);
            for (const tc of assistantMsg.tool_calls) {
                activeHistory.push({ role: "tool", tool_call_id: tc.id, content: "tool-result" });
            }
            activeHistory = await prepareMessages(activeHistory);
            checkRequest(`request-${round + 1}`, activeHistory);
            console.log(`[request-${round + 1}]`, JSON.stringify(activeHistory, null, 2));
        } else {
            console.log("[final-assistant]", JSON.stringify(assistantMsg, null, 2));
            break;
        }
    }

    console.log("\n=== 校验结果 ===");
    if (violations.length > 0) {
        console.log("发现问题:");
        violations.forEach((v) => console.log("  ✗", v));
    } else {
        console.log("✓ 所有请求中 assistant(tool_calls) 均携带完整 reasoning_content");
    }
}

simulateSecondConversation().catch((e) => {
    console.error(e);
    process.exit(1);
});
