/**
 * Workflow 公共类型。
 *
 * 该文件不依赖 Electron/Fastify，可同时被 server、Electron 主进程、
 * utilityProcess Worker 与测试引用。
 */

export type WorkflowRunStatus =
    | 'queued'
    | 'running'
    | 'waiting_approval'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export type WorkflowValidationSeverity = 'error' | 'warning';

export interface WorkflowInputDefinition {
    name: string;
    type?: string;
    description?: string;
    required?: boolean;
    default?: unknown;
}

export interface WorkflowSummary {
    /** document.name（缺失时回退文件名） */
    name: string;
    /** 工作区相对路径，如 .workflow/feature-delivery.yaml */
    path: string;
    title?: string;
    summary?: string;
    version?: string;
    namespace?: string;
    inputs: WorkflowInputDefinition[];
    stepCount: number;
}

export interface WorkflowValidationIssue {
    /** 近似 JSON Pointer，如 /document/name、/do/0 */
    path: string;
    message: string;
    severity: WorkflowValidationSeverity;
}

export interface WorkflowValidationResult {
    ok: boolean;
    issues: WorkflowValidationIssue[];
    validator: 'builtin';
}

export interface WorkflowDetail {
    summary: WorkflowSummary;
    yaml: string;
    validation: WorkflowValidationResult;
    graph?: { mermaid: string; truncated: boolean };
}

/** 已解析、可直接交给 WorkflowRunner 的定义 */
export interface WorkflowDefinition {
    summary: WorkflowSummary;
    /** 原始 YAML document 节点 */
    document: Record<string, unknown>;
    /** document.do：顶层任务数组 */
    steps: Record<string, any>[];
    yaml: string;
    validation: WorkflowValidationResult;
}

/** 执行器真正需要的最小定义；Worker IPC 只传这个，避免重复传 YAML。 */
export type WorkflowExecutableDefinition = Pick<WorkflowDefinition, 'summary' | 'steps'>;

export type WorkflowStepStatus =
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'waiting_approval'
    | 'cancelled';

export interface WorkflowUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface WorkflowStepInfo {
    /** JSON Pointer 风格路径，如 /do/0/plan */
    path: string;
    /** 步骤名（do 项的 key） */
    name: string;
    status: WorkflowStepStatus;
    attempts: number;
    startedAt?: number;
    finishedAt?: number;
    /** 完整输出（受 maxStepOutputChars 截断），供后续步骤表达式使用 */
    output?: unknown;
    /** 面向 UI 的输出预览 */
    outputPreview?: string;
    /** 持久化时输出被脱敏或截断，不能作为嵌套恢复的精确输入。 */
    replayOutputUnavailable?: boolean;
    error?: string;
    usage?: WorkflowUsage;
}

export interface WorkflowApprovalState {
    stepPath: string;
    message?: string;
    risk?: string;
    requestedAt: number;
}

export interface WorkflowCheckpoint {
    /** 恢复时从该顶层步骤开始 */
    nextStepIndex: number;
    /** set 步骤写入的上下文 */
    context: Record<string, unknown>;
    completedPaths: string[];
    /** 嵌套审批恢复时重建当前顶层容器，并跳过已完成的叶子步骤。 */
    replayFromStep?: boolean;
    /** 检查点包含无法精确恢复的数据时，禁止继续而不是静默改变语义。 */
    resumeError?: string;
    /** 本次暂停涉及的子工作流定义版本。 */
    definitionHashes?: Record<string, string>;
}

export interface WorkflowRunInfo {
    schemaVersion: 1;
    runId: string;
    workflow: {
        name: string;
        title?: string;
        version?: string;
        namespace?: string;
        path: string;
    };
    /** 兼容字段：等价于 workflow.name */
    workflowName: string;
    /** 兼容字段：等价于 workflow.path */
    workflowPath?: string;
    workflowDefinitionHash?: string;
    userId: string;
    root: string;
    status: WorkflowRunStatus;
    inputs: Record<string, unknown>;
    /** 输入未原样持久化时，重启后恢复必须重新提供输入。 */
    resumeInputsRequired?: boolean;
    trigger?: { type: 'interval' | 'file'; id: string };
    execution?: {
        provider?: string;
        model?: string;
        reasoningEffort?: 'default' | 'low' | 'high' | 'max';
        locale?: string;
        concurrencyGroup?: string;
    };
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    currentTask?: string;
    steps: WorkflowStepInfo[];
    checkpoint?: WorkflowCheckpoint;
    approval?: WorkflowApprovalState;
    usage?: WorkflowUsage;
    error?: string;
    /** 队列位置（queued 时） */
    position?: number;
    /** in-process 引擎用 workerId='in-process'；多 Worker 时填真实 worker */
    worker?: { workerId: string; pid?: number };
    /** 事件序号（持久化用） */
    lastSeq?: number;
    /** includeEvents=true 时附带最近事件 */
    events?: WorkflowEvent[];
}

export interface WorkflowEvent {
    runId: string;
    /** 单调递增序号，便于 renderer 去重/排序 */
    seq: number;
    type: string;
    timestamp: number;
    [key: string]: unknown;
}

export interface WorkflowWorkerStats {
    workerId: string;
    pid?: number;
    runId?: string;
    memMB?: number;
    cpu?: number;
}

export interface WorkflowRuntimeStats {
    active: number;
    queued: number;
    workers: WorkflowWorkerStats[];
}

export interface WorkflowRunRequest {
    userId: string;
    root: string;
    name: string;
    /** 解析后的工作区相对路径（由 IPC 层补全） */
    path?: string;
    inputs?: Record<string, unknown>;
    provider?: string;
    model?: string;
    reasoningEffort?: 'default' | 'low' | 'high' | 'max';
    locale?: string;
    /** true 时同步等待 run 终态（受 timeoutSeconds 限制） */
    wait?: boolean;
    timeoutSeconds?: number;
    concurrencyGroup?: string;
    /** 仅由本地自动触发器填充，用于运行来源追踪。 */
    trigger?: { type: 'interval' | 'file'; id: string };
}

export interface WorkflowRunStartResult {
    ok: boolean;
    runId?: string;
    status?: WorkflowRunStatus;
    position?: number;
    error?: string;
    issues?: WorkflowValidationIssue[];
    run?: WorkflowRunInfo;
}

export interface WorkflowRunLookup {
    userId: string;
    root: string;
    runId: string;
    includeEvents?: boolean;
}

export interface WorkflowRunQuery {
    userId?: string;
    root?: string;
    status?: WorkflowRunStatus;
}

export interface WorkflowRunCancelRequest {
    userId: string;
    root: string;
    runId: string;
}

export interface WorkflowRunResumeRequest extends WorkflowRunCancelRequest {
    decision?: unknown;
    /** 原始输入未保存在磁盘时，允许调用方重新提供。 */
    inputs?: Record<string, unknown>;
}

/**
 * Workflow 执行引擎端口。
 * Phase 1 为 InProcessWorkflowEngine；Phase 1.5 为 ProcessWorkerWorkflowEngine。
 */
export interface WorkflowEngine {
    setEventBus?(bus: WorkflowEventBus): void;
    startRun(request: WorkflowRunRequest): Promise<WorkflowRunStartResult>;
    getRun(query: WorkflowRunLookup): Promise<WorkflowRunInfo | null>;
    listRuns?(query: WorkflowRunQuery): Promise<WorkflowRunInfo[]>;
    cancelRun(request: WorkflowRunCancelRequest): Promise<boolean>;
    resumeRun(request: WorkflowRunResumeRequest): Promise<boolean>;
    cancelUserRuns?(userId: string, root?: string): Promise<void>;
    getStats(): WorkflowRuntimeStats;
    shutdown(): Promise<void>;
}

export interface WorkflowEventBus {
    publish(event: WorkflowEvent): void;
}

export const NULL_WORKFLOW_EVENT_BUS: WorkflowEventBus = {
    publish: () => {},
};
