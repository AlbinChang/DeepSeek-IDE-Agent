/**
 * Workflow utilityProcess Worker 入口。
 *
 * 只运行 WorkflowRunner；不启动 Fastify/UI，也不 import electron。
 * 主进程通过 process.parentPort 与这里通信。
 */
import { WorkflowWorkerHost } from '@/workflow/WorkerHost.js';
import {
    isMainToWorkerMessage,
    type WorkerToMainMessage,
} from '@/workflow/workerProtocol.js';

interface ParentPortLike {
    postMessage(message: unknown): void;
    on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

function send(message: WorkerToMainMessage): void {
    parentPort?.postMessage(message);
}

const host = new WorkflowWorkerHost({
    workerId: process.env.WORKFLOW_WORKER_ID || `worker-${process.pid}`,
    pid: process.pid,
    send,
});

if (!parentPort) {
    console.error('[WorkflowWorker] process.parentPort is unavailable; this entry must run under Electron utilityProcess.');
    process.exit(2);
}

parentPort.on('message', (event) => {
    if (!isMainToWorkerMessage(event.data)) {
        console.warn('[WorkflowWorker] Ignoring invalid message from main process');
        return;
    }
    host.handleMessage(event.data);
});

host.announceReady();

process.on('uncaughtException', (error) => {
    console.error('[WorkflowWorker] uncaughtException:', error);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[WorkflowWorker] unhandledRejection:', reason);
    process.exit(1);
});
