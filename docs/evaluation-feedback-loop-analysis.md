# 评估→修复闭环断裂：根因分析与优化方案

## 一、问题描述

**现象**：评估Agent 对主Agent 产出完成审查后，给出 P0/P1/P2 问题清单和「需要主Agent继续迭代」结论，但下一轮主Agent **没有按评估报告修复已有文件**，而是将用户原始指令当作全新任务重新执行（如重新搜索、重新生成）。

**复现路径**（见 Session Transcript 2026/7/4）：
1. 用户：「帮我探索一篇高质量的技术文章（JDK8零侵入观测）」
2. 主Agent：创建 `java-agent-articles-report.md`（含 6 篇推荐文章）
3. 评估Agent：发现 4 个问题（P0×1: 链接失效, P1×2: try-finally不实+维度虚高, P2×1: 代码简化），结论「需要主Agent继续迭代」
4. **第二轮主Agent：没有修复 `java-agent-articles-report.md`，而是重新搜索文章**

---

## 二、核心链路追踪

```
AgentChatComponent.handleChat()
  └─ while(true)
       ├─ AgentTurnEngine.runTurns()  ← 第1轮：主Agent创建报告
       ├─ TodoService.getTodos()       ← 全部终态 → 触发评估
       ├─ EvaluationAgentService.runEvaluation()
       │    └─ 评估Agent 独立运行（evaluator-agent.json 提示词）
       │         └─ 返回 { decision: "continue_main_agent", finalReply: "完整评估报告" }
       │
       ├─ 【关键】decision === "continue_main_agent"
       │    ├─ TodoService.clearAllTodos()           ← 清空 TODO
       │    ├─ activeHistory = prepareMessages([])   ← 重置历史
       │    └─ activeHistory.push({                  ← 注入评估反馈（system 消息）
       │         role: "system",
       │         content: "评估Agent已完成本轮评估..." + finalReply
       │       })
       │    └─ continue  ← 回到 while(true) 顶部
       │
       └─ AgentTurnEngine.runTurns()  ← 第2轮：主Agent应修复，实际重新探索
```

**评估反馈注入后的 activeHistory 结构**：
```
[
  { role: "system", content: "<完整系统提示词 ~15K tokens，含 context_continuity_contract>" },
  { role: "user",   content: "**当前用户意图**: 我需要对jdk8运行的程序进行零侵入观测..." },
  { role: "system", content: "评估Agent已完成本轮评估...评估结论正文如下：\n# 评估Agent的评估报告\n\n## 一、目标回顾\n..." }
]
```

---

## 三、根因分析（按严重程度排序）

### 🔴 P0 — 冲突信号：pinnedUserMessage 与评估报告指令矛盾

**问题**：`prepareMessages` 始终将用户原始指令（`firstUserIntent`）作为 **pinned user message** 注入。第二轮时，Agent 同时收到两个冲突信号：

| 信号 | 内容 | 优先级（模型视角） |
|------|------|-------------------|
| 🅐 pinnedUserMessage | 「帮我**探索**一篇高质量技术文章」 | **高**（user 消息，直接指令） |
| 🅑 评估系统消息 | 「请根据评估报告**修复**已有文件」 | 中（system 消息） |

模型训练数据中 user 消息权重远高于 system 消息，Agent 天然倾向于执行 🅐（探索）而非 🅑（修复）。

**代码位置**：`AgentChatComponent.ts` 第 189-193 行
```typescript
const prepareMessages = async (msgs: any[]) => {
    const systemPrompt = await agentService.buildSystemPrompt(...);
    return MessagePreparationService.buildMessages({
        systemPrompt,
        pinnedUserMessage: firstUserIntent,  // ← 始终用原始指令
        incomingMessages: msgs,
    });
};
```

第二轮调用 `prepareMessages([])` 时，`firstUserIntent` 仍是「帮我探索一篇…」，与修复指令冲突。

---

### 🔴 P1 — `context_continuity_contract` 触发不可靠

**问题**：契约要求 Agent **自主判断**上下文中同时存在「用户原始指令 + 评估报告」，然后切换为修复模式。这依赖模型的元认知能力——扫描整个上下文、识别模式、自我切换行为模式。对当前 LLM 而言，这种跨消息的模式匹配不可靠。

**契约原文**（`main-agent.json`）：
> "当本轮上下文中同时出现用户原始任务指令与评估Agent的评估报告（一级标题为「# 评估Agent的评估报告」）时，适用以下铁律：(1) 评估报告的存在 = 任务已被执行过至少一轮的铁证..."

**失效原因**：
1. 评估报告被包装在 system 消息中（非 user 消息），模型关注度降低
2. 系统提示词 ~15K tokens，此契约埋藏较深（在 PPT/SVG 等大量契约之后）
3. 模型可能在处理完 pinned user message 后已经形成「执行原始任务」的意图，不会回头重新评估上下文

---

### 🟡 P1 — 系统提示词膨胀导致关键契约注意力稀释

**问题**：`main-agent.json` 包含 **30+ 个 operation_guidelines 契约**，从 PPT 绘制、SVG 渲染、端口保护、临时文件治理到分布式事务一致性。`context_continuity_contract` 和 `iterative_repair_in_place_contract` 被淹没在这些领域专用契约中。

**量化**：
- 系统提示词总长度：约 **15,000 tokens**
- `context_continuity_contract` 在提示词中的位置：约在 **40% 处**（被大量 PPT 契约前置）
- 契约数量统计：
  - PPT/SVG 相关：11 个
  - 通用代码/文档：6 个
  - 评估反馈处理：2 个（`context_continuity_contract` + `iterative_repair_in_place_contract`）
  - 端口/安全：3 个
  - 其他：8+ 个

---

### 🟡 P2 — 缺少显式的迭代状态标记

**问题**：第二轮主Agent 没有任何显式标记告知「你处于迭代修复模式」。它必须通过解读评估报告内容来推断自己应该修复而非探索。而 `planning_first` 契约要求「任何业务操作前必须先创建 TODO」— Agent 看到空 TODO 后，按 `planning_first` 创建了原始任务（探索文章）的 TODO。

**期望**：第二轮应有类似 `【迭代修复模式 — 第 2 轮】` 的显式状态标记，让 Agent 无需推理即可知道自己处于修复阶段。

---

### 🟢 P2 — `prepareMessages([])` 导致评估报告可能被后续压缩

**问题**：虽然 `prepareMessages([])` 后 push 的评估系统消息在首轮修复时存在，但当 AgentTurnEngine 内部多次调用 `prepareMessages(activeHistory)` 时：
- `MessagePreparationService.buildMessages` 会按 maxBytes 阈值裁剪历史
- 评估报告作为 system 消息虽然被保留（因为 content ≠ systemPrompt），但可能在极端情况下被裁剪
- `HistoryOptimizerService.optimizeHistory` 在 `handleChat` 入口调用，但不在循环内重复调用（不会主动删除评估消息）

此风险较低，但缺少防护。

---

## 四、优化方案

### 方案 1（最小改动，快速见效）：迭代时替换 pinnedUserMessage

**改动文件**：`server/src/services/AgentChatComponent.ts`（约 345-370 行）

**核心思路**：当 `decision === "continue_main_agent"` 时，不调用 `prepareMessages([])`（它仍用原始 `firstUserIntent`），而是构造专用的修复指令作为 user 消息。

```typescript
// 替代: activeHistory = await prepareMessages([]);
// 改为:
const systemPrompt = await agentService.buildSystemPrompt(userId, finalLocale, 'main-agent.json', root, requestId);
activeHistory = [
    { role: "system", content: systemPrompt },
    { 
        role: "user", 
        content: `【迭代修复模式 — 评估Agent 发现问题，请立即修复】

原始用户需求：${firstUserIntent}

评估Agent 已完成审查并发现以下问题，请逐项在原文件上修复：
${evaluationResult.finalReply}

修复规则：
1. 必须先读取目标文件，再在原文件上做最小必要修改
2. 禁止新建 V2/V3/修正版等平行文件
3. 禁止重新执行原始用户需求（该需求已执行过一轮）
4. 按 P0 → P1 → P2 → P3 优先级逐项修复
5. 修复完成后输出文件变更清单`
    },
];
```

**优点**：
- 消除 pinnedUserMessage 与修复指令的冲突
- 修复指令变为 user 消息，模型关注度最高
- 改动量小（约 20 行）

---

### 方案 2（中等改动，增强可靠性）：引入迭代状态追踪器

**新增文件**：`server/src/services/IterationTracker.ts`

**核心思路**：在 `AgentService` 中维护迭代状态，追踪每轮评估的未解决问题。

```typescript
interface IterationState {
    round: number;                          // 当前迭代轮次
    pendingIssues: {                        // 未解决问题
        level: 'P0' | 'P1' | 'P2' | 'P3';
        description: string;
        filePath: string;
        fixAction: string;
    }[];
    targetFiles: string[];                  // 需要修复的文件列表
    lastEvaluationReport: string;           // 最近一次评估报告
}
```

**改动**：`AgentChatComponent.ts` 在评估完成后：
1. 解析评估报告中的「可直接修复清单」
2. 存入 `IterationTracker`
3. 注入结构化修复指令到 activeHistory
4. 下一轮完成后比对修复状态

---

### 方案 3（较大改动，根本解决）：系统提示词分层 + 条件注入

**核心思路**：
1. 将系统提示词拆分为「核心层」（始终注入）和「领域层」（条件注入）
2. 将 `context_continuity_contract` 提升到核心层的最前面
3. PPT/SVG/分布式事务等契约仅当检测到相关任务时才注入
4. 迭代修复模式下额外注入强化版的修复指令

```typescript
// 核心层（始终注入，约 3K tokens）
const corePrompt = `
你是 DeepSeek IDE 的全能 AI 助手...

【最高优先级】上下文连续性铁律：
当本轮对话中同时出现以下两者时，你处于迭代修复模式：
  (a) 用户原始任务指令
  (b) 评估Agent的评估报告（标题为「# 评估Agent的评估报告」）
此时你必须：直接按评估报告的「可直接修复清单」在原文件上逐项修复，严禁重新执行原始任务。

【次高优先级】原文件修复原则：...
`;

// 领域层（条件注入）
const domainPrompt = detectTaskType(userInstruction) === 'ppt' 
    ? pptContracts 
    : detectTaskType(userInstruction) === 'svg'
        ? svgContracts
        : '';
```

---

## 五、推荐实施路径

| 阶段 | 方案 | 改动量 | 预期效果 | 风险 |
|------|------|--------|---------|------|
| **即时修复** | 方案 1 | ~20 行 | 消除冲突信号，80% 场景修复 | 低 |
| **短期** | 方案 2 | ~150 行 | 结构化追踪，95% 场景修复 | 中 |
| **中期** | 方案 3 | ~500 行 | 根本解决，同时优化 token 消耗 | 中高 |

建议先实施方案 1，验证效果后再逐步推进方案 2 和 3。

---

## 六、补充发现

### 6.1 评估报告格式问题

评估Agent 的 `report_contract` 要求一级标题为 `# 评估Agent的评估报告`，但 `context_continuity_contract` 中的匹配模式是 `「# 评估Agent的评估报告」`（含中文书名号）。虽然书名号 `「」` 大概率是引用标记而非字面匹配，但格式不一致增加了匹配失败风险。

### 6.2 缺少修复验证闭环

当前流程：主Agent → 评估Agent → 主Agent（修复）→ 评估Agent → ...
缺少：修复后轻量验证（快速检查 P0/P1 问题是否已修复）→ 决定是否需要完整重评估。

如果主Agent 声称修复了问题但实际没有（虚假修复），评估Agent 需要重新全量评估。引入轻量「修复验证」步骤可以减少不必要的全量评估。

### 6.3 HistoryOptimizerService 潜在风险

`HistoryOptimizerService.optimizeHistory` 在 `filtered.length > 4` 时只保留最近 4 条 user/assistant 消息。如果评估反馈作为 system 消息被过滤掉（虽然 `buildMessages` 中 system 消息被保留，但 `optimizeHistory` 中 system 消息不在过滤范围内），可能导致评估上下文丢失。当前代码路径不经过此风险点，但未来改动需注意。
