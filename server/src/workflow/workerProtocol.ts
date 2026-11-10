/**
 * 主进程 <-> utilityProcess Workflow Worker 协议。
 *
 * 该文件不依赖 Electron，主进程、Worker、测试共用；
 * 消息必须可 JSON 序列化，单条消息建议控制在 1MB 以内。
 */
import type {
    WorkflowApprovalState,
    WorkflowCheckpoint,
    WorkflowExecutableDefinition,
    WorkflowRunInfo,
    WorkflowRunStatus,
    WorkflowStepInfo,
    WorkflowUsage,
} from '@/workflow/types.js';

export const WORKFLOW_WORKER_PROTOCOL_VERSION = 1;

export type WorkflowWorkerReasoningEffort = 'default' | 'low' | 'high' | 'max';

export interface WorkflowWorkerRunConfig {
    runId: string;
    traceId: string;
    userId: string;
    root: string;
    workflowName: string;
    provider?: string;
    model?: string;
    reasoningEffort?: WorkflowWorkerReasoningEffort;
    locale?: string;
    /** Worker 心跳间隔；主进程按 3 倍超时判断失联 */
    heartbeatIntervalMs: number;
}

export interface WorkflowWorkerRunStartMessage {
    type: 'run.start';
    config: WorkflowWorkerRunConfig;
    definition: WorkflowExecutableDefinition;
    inputs: Record<string, unknown>;
    steps: WorkflowStepInfo[];
    startIndex?: number;
    initialContext?: Record<string, unknown>;
}

export interface WorkflowWorkerInitMessage {
    type: 'worker.init';
    protocolVersion: typeof WORKFLOW_WORKER_PROTOCOL_VERSION;
    workerId: string;
}

export interface WorkflowWorkerCancelMessage {
    type: 'run.cancel';
    runId: string;
    reason?: string;
}

export interface WorkflowWorkerAckMessage {
    type: 'run.ack';
    runId: string;
}

export interface WorkflowWorkerPingMessage {
    type: 'ping';
    seq: number;
}

export interface WorkflowWorkerPermitMessage {
    type: 'run.permit';
    runId: string;
    requestId: string;
    kind: 'agent' | 'evaluator';
    provider?: string;
    model?: string;
}

export interface WorkflowWorkerPermitReleaseMessage {
    type: 'run.permit.release';
    runId: string;
    requestId: string;
}

export interface WorkflowWorkerPermitGrantedMessage {
    type: 'run.permit.granted';
    requestId: string;
}

export type MainToWorkerMessage =
    | WorkflowWorkerInitMessage
    | WorkflowWorkerRunStartMessage
    | WorkflowWorkerCancelMessage
    | WorkflowWorkerAckMessage
    | WorkflowWorkerPingMessage
    | WorkflowWorkerPermitGrantedMessage;

export interface WorkflowWorkerReadyMessage {
    type: 'worker.ready';
    workerId: string;
    pid: number;
    protocolVersion: typeof WORKFLOW_WORKER_PROTOCOL_VERSION;
}

export interface WorkflowWorkerErrorMessage {
    type: 'worker.error';
    workerId: string;
    message: string;
}

export interface WorkflowWorkerEventMessage {
    type: 'run.event';
    runId: string;
    eventType: string;
    data: Record<string, unknown>;
}

/** Worker 只能更新 currentTask；状态由主进程独占写入。 */
export interface WorkflowWorkerStatePatch {
    currentTask?: string;
}

export interface WorkflowWorkerPatchMessage {
    type: 'run.patch';
    runId: string;
    patch: WorkflowWorkerStatePatch;
}

export interface WorkflowWorkerStepMessage {
    type: 'run.step';
    runId: string;
    step: WorkflowStepInfo;
}

export interface WorkflowWorkerUsageMessage {
    type: 'run.usage';
    runId: string;
    usage: WorkflowUsage;
}

export interface WorkflowWorkerCheckpointMessage {
    type: 'run.checkpoint';
    runId: string;
    checkpoint: WorkflowCheckpoint;
}

export interface WorkflowWorkerResultMessage {
    type: 'run.result';
    runId: string;
    status: Extract<WorkflowRunStatus, 'succeeded' | 'failed' | 'waiting_approval' | 'cancelled'>;
    error?: string;
    timedOut?: boolean;
    approval?: WorkflowApprovalState;
    checkpoint?: WorkflowCheckpoint;
    usage?: WorkflowUsage;
}

export interface WorkflowWorkerHeartbeatMessage {
    type: 'run.heartbeat';
    runId: string;
    memMB?: number;
    cpu?: number;
    currentTask?: string;
}

export interface WorkflowWorkerLogMessage {
    type: 'log';
    level: 'info' | 'warn' | 'error';
    message: string;
}

export interface WorkflowWorkerPongMessage {
    type: 'pong';
    seq: number;
}

export type WorkerToMainMessage =
    | WorkflowWorkerReadyMessage
    | WorkflowWorkerErrorMessage
    | WorkflowWorkerEventMessage
    | WorkflowWorkerPatchMessage
    | WorkflowWorkerStepMessage
    | WorkflowWorkerUsageMessage
    | WorkflowWorkerCheckpointMessage
    | WorkflowWorkerResultMessage
    | WorkflowWorkerHeartbeatMessage
    | WorkflowWorkerPermitMessage
    | WorkflowWorkerPermitReleaseMessage
    | WorkflowWorkerLogMessage
    | WorkflowWorkerPongMessage;

export interface WorkflowWorkerMetrics {
    memMB?: number;
    cpu?: number;
}

export interface WorkflowWorkerSpawnRequest {
    workerId: string;
    runId: string;
    heapMB: number;
    env?: NodeJS.ProcessEnv;
}

/** 可注入的 Worker 传输端口，便于在没有 Electron 的环境测试调度器。 */
export interface WorkflowWorkerHandle {
    readonly workerId: string;
    pid?: number;
    postMessage(message: MainToWorkerMessage): void;
    kill(): void;
    onMessage(listener: (message: WorkerToMainMessage) => void): () => void;
    onExit(listener: (code: number | null) => void): () => void;
    getMetrics?(): WorkflowWorkerMetrics;
    /** Worker stderr 尾部，用于崩溃诊断（不含 API Key 等敏感信息） */
    getLogTail?(): string;
}

export interface WorkflowWorkerSpawner {
    spawn(request: WorkflowWorkerSpawnRequest): WorkflowWorkerHandle;
    shutdown?(): Promise<void> | void;
}

const RESULT_STATUSES = new Set(['succeeded', 'failed', 'waiting_approval', 'cancelled']);

export function isMainToWorkerMessage(value: unknown): value is MainToWorkerMessage {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    if (type === 'worker.init') {
        return (value as WorkflowWorkerInitMessage).protocolVersion === WORKFLOW_WORKER_PROTOCOL_VERSION;
    }
    if (type === 'run.start') {
        const message = value as WorkflowWorkerRunStartMessage;
        return Boolean(message.config?.runId)
            && typeof message.config.root === 'string'
            && typeof message.config.workflowName === 'string'
            && Array.isArray(message.definition?.steps)
            && Array.isArray(message.steps)
            && Boolean(message.inputs && typeof message.inputs === 'object');
    }
    if (type === 'run.cancel') return typeof (value as WorkflowWorkerCancelMessage).runId === 'string';
    if (type === 'run.ack') return typeof (value as WorkflowWorkerAckMessage).runId === 'string';
    if (type === 'run.permit.granted') return typeof (value as WorkflowWorkerPermitGrantedMessage).requestId === 'string';
    if (type === 'ping') return Number.isFinite((value as WorkflowWorkerPingMessage).seq);
    return false;
}

export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    if (type === 'worker.ready') {
        return (value as WorkflowWorkerReadyMessage).protocolVersion === WORKFLOW_WORKER_PROTOCOL_VERSION;
    }
    if (type === 'worker.error' || type === 'log') return true;
    if (type === 'pong') return Number.isFinite((value as WorkflowWorkerPongMessage).seq);
    if (type === 'run.event') {
        return typeof (value as WorkflowWorkerEventMessage).runId === 'string'
            && typeof (value as WorkflowWorkerEventMessage).eventType === 'string';
    }
    if (type === 'run.patch') return typeof (value as WorkflowWorkerPatchMessage).runId === 'string';
    if (type === 'run.step') {
        const message = value as WorkflowWorkerStepMessage;
        return typeof message.runId === 'string'
            && Boolean(message.step)
            && typeof message.step.path === 'string'
            && typeof message.step.status === 'string';
    }
    if (type === 'run.usage') return typeof (value as WorkflowWorkerUsageMessage).runId === 'string';
    if (type === 'run.checkpoint') return typeof (value as WorkflowWorkerCheckpointMessage).runId === 'string';
    if (type === 'run.result') {
        const message = value as WorkflowWorkerResultMessage;
        return typeof message.runId === 'string' && RESULT_STATUSES.has(message.status);
    }
    if (type === 'run.heartbeat') return typeof (value as WorkflowWorkerHeartbeatMessage).runId === 'string';
    if (type === 'run.permit') {
        const message = value as WorkflowWorkerPermitMessage;
        return typeof message.runId === 'string'
            && typeof message.requestId === 'string'
            && (message.kind === 'agent' || message.kind === 'evaluator');
    }
    if (type === 'run.permit.release') {
        const message = value as WorkflowWorkerPermitReleaseMessage;
        return typeof message.runId === 'string' && typeof message.requestId === 'string';
    }
    return false;
}
