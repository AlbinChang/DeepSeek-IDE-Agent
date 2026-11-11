import type { WorkflowApprovalState } from '@/workflow/types.js';

export type WorkflowErrorType =
    | 'timeout'
    | 'cancelled'
    | 'validation'
    | 'step'
    | 'budget'
    | 'persistence'
    | 'unsupported';

export class WorkflowError extends Error {
    constructor(
        message: string,
        public readonly type: WorkflowErrorType = 'step',
        public readonly stepPath?: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'WorkflowError';
    }
}

export class WorkflowCancelledError extends WorkflowError {
    constructor(message = 'Workflow run cancelled', stepPath?: string) {
        super(message, 'cancelled', stepPath);
        this.name = 'WorkflowCancelledError';
    }
}

export class WorkflowTimeoutError extends WorkflowError {
    constructor(message: string, stepPath?: string) {
        super(message, 'timeout', stepPath);
        this.name = 'WorkflowTimeoutError';
    }
}

export class WorkflowBudgetExceededError extends WorkflowError {
    constructor(message: string, stepPath?: string) {
        super(message, 'budget', stepPath);
        this.name = 'WorkflowBudgetExceededError';
    }
}

export class WorkflowUnsupportedError extends WorkflowError {
    constructor(message: string, stepPath?: string) {
        super(message, 'unsupported', stepPath);
        this.name = 'WorkflowUnsupportedError';
    }
}

export class WorkflowPersistenceError extends WorkflowError {
    constructor(message: string, cause: unknown) {
        super(message, 'persistence', undefined, cause);
        this.name = 'WorkflowPersistenceError';
    }
}

/** 审批暂停信号：runner 用它把控制权交回引擎，而不是当作失败 */
export class WorkflowApprovalPause extends Error {
    constructor(
        public readonly approval: WorkflowApprovalState,
        public readonly topLevelIndex: number,
        public readonly replayFromStep = false,
        public readonly resumeContext?: Record<string, unknown>,
        public readonly definitionHashes?: Record<string, string>,
    ) {
        super(`Workflow waiting for approval at ${approval.stepPath}`);
        this.name = 'WorkflowApprovalPause';
    }
}
