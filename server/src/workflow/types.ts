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
    | 'cancelled';

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
}

export interface WorkflowStepInfo {
    path: string;
    name: string;
    status: WorkflowRunStatus;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
}

export interface WorkflowRunInfo {
    runId: string;
    workflowName: string;
    workflowPath?: string;
    userId: string;
    root: string;
    status: WorkflowRunStatus;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    steps: WorkflowStepInfo[];
    worker?: { workerId: string; pid?: number };
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    error?: string;
    waitingApproval?: { stepPath: string; prompt?: string };
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
    /** true 时同步等待 run 终态（受 timeoutSeconds 限制） */
    wait?: boolean;
    timeoutSeconds?: number;
}

export interface WorkflowRunStartResult {
    ok: boolean;
    runId?: string;
    status?: WorkflowRunStatus;
    position?: number;
    error?: string;
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
