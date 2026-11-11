import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';
import { samePath } from '@/workflow/engineUtils.js';
import { isValidRunId } from '@/workflow/WorkflowRunStore.js';
import type { WorkflowService } from '@/workflow/WorkflowService.js';
import type {
    WorkflowEvent,
    WorkflowRunInfo,
    WorkflowRunRequest,
    WorkflowRunStatus,
} from '@/workflow/types.js';

interface Scope {
    userId: string;
    root: string;
}

interface ScopeInput {
    userId?: unknown;
    root?: unknown;
}

interface RunParams {
    runId: string;
}

interface DefinitionParams {
    name: string;
}

export interface WorkflowHttpOptions {
    enabled: boolean;
    token?: string;
    heartbeatIntervalMs?: number;
}

class WorkflowHttpError extends Error {
    constructor(public readonly statusCode: number, message: string) {
        super(message);
    }
}

const STATUSES = new Set<WorkflowRunStatus>([
    'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const EFFORTS = new Set(['default', 'low', 'high', 'max']);
const MAX_PENDING_EVENTS = 500;

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new WorkflowHttpError(400, 'Request must be an object');
    }
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new WorkflowHttpError(400, `${name} is required`);
    }
    return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new WorkflowHttpError(400, `${name} must be a string`);
    return value.trim() || undefined;
}

function resolveScope(input: ScopeInput, workspaces: WorkspaceRegistry): Scope {
    const userId = requiredString(input.userId, 'userId');
    const root = workspaces.get(userId);
    if (!root) throw new WorkflowHttpError(412, 'Workspace not initialized');
    const requestedRoot = optionalString(input.root, 'root');
    if (requestedRoot && !samePath(root, requestedRoot)) {
        throw new WorkflowHttpError(403, 'Workspace root mismatch');
    }
    return { userId, root };
}

function checkRunId(runId: string): void {
    if (!isValidRunId(runId)) throw new WorkflowHttpError(400, 'Invalid workflow runId');
}

async function getAuthorizedRun(
    service: WorkflowService,
    scope: Scope,
    runId: string,
    includeEvents = false,
): Promise<WorkflowRunInfo> {
    checkRunId(runId);
    const run = await service.getRun({ ...scope, runId, includeEvents });
    if (!run || run.userId !== scope.userId || !samePath(run.root, scope.root)) {
        throw new WorkflowHttpError(404, 'Workflow run not found');
    }
    return run;
}

function authorizationMatches(header: string | undefined, expectedHash: Buffer): boolean {
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const received = createHash('sha256').update(match[1], 'utf8').digest();
    return timingSafeEqual(received, expectedHash);
}

function startErrorStatus(error: string | undefined): number {
    if (error === 'WORKFLOW_QUEUE_FULL') return 429;
    if (error === 'WORKFLOW_DISABLED' || error === 'WORKFLOW_ENGINE_UNAVAILABLE'
        || error === 'WORKFLOW_ENGINE_CLOSED') return 503;
    if (error?.startsWith('Workflow not found:')) return 404;
    return 400;
}

function parseLastEventId(request: FastifyRequest): number | undefined {
    const header = request.headers['last-event-id'];
    if (header === undefined || header === '') return undefined;
    if (typeof header !== 'string' || !/^\d+$/.test(header)) {
        throw new WorkflowHttpError(400, 'Invalid Last-Event-ID');
    }
    const seq = Number(header);
    if (!Number.isSafeInteger(seq)) throw new WorkflowHttpError(400, 'Invalid Last-Event-ID');
    return seq;
}

/**
 * 独立服务的可选工作流 API。必须显式启用并设置独立 Bearer token；
 * 工作区根路径始终从 WorkspaceRegistry 获取，不信任调用方提供的路径。
 */
export async function registerWorkflowHttpRoutes(
    server: FastifyInstance,
    service: WorkflowService,
    workspaces: WorkspaceRegistry,
    options: WorkflowHttpOptions,
): Promise<void> {
    if (!options.enabled) return;
    const token = options.token?.trim();
    if (!token) throw new Error('WORKFLOW_HTTP_API_TOKEN is required when the workflow HTTP API is enabled');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest();
    const heartbeatIntervalMs = Math.max(1000, options.heartbeatIntervalMs ?? 15_000);
    const activeStreams = new Set<() => void>();

    await server.register(async (routes) => {
        routes.addHook('preClose', async () => {
            for (const close of activeStreams) close();
        });
        routes.addHook('onRequest', async (request, reply) => {
            if (!authorizationMatches(request.headers.authorization, tokenHash)) {
                reply.header('WWW-Authenticate', 'Bearer');
                return reply.code(401).send({ success: false, error: 'Unauthorized' });
            }
        });

        routes.setErrorHandler((error, request, reply) => {
            if (error instanceof WorkflowHttpError) {
                return reply.code(error.statusCode).send({ success: false, error: error.message });
            }
            request.log.error({ err: error }, 'Workflow HTTP request failed');
            return reply.code(500).send({ success: false, error: 'Workflow request failed' });
        });

        routes.get<{ Querystring: ScopeInput }>('/api/workflows', async (request) => {
            const scope = resolveScope(request.query, workspaces);
            return { success: true, workflows: await service.list(scope.root) };
        });

        routes.get<{ Params: DefinitionParams; Querystring: ScopeInput }>(
            '/api/workflows/definitions/:name',
            async (request) => {
                const scope = resolveScope(request.query, workspaces);
                const workflow = await service.get(scope.root, requiredString(request.params.name, 'name'));
                if (!workflow) throw new WorkflowHttpError(404, 'Workflow not found');
                return { success: true, workflow };
            },
        );

        routes.post('/api/workflows/validate', async (request) => {
            const body = asRecord(request.body);
            const scope = resolveScope(body, workspaces);
            return { success: true, validation: await service.validate(scope.root, optionalString(body.name, 'name')) };
        });

        routes.post('/api/workflows/runs', async (request, reply) => {
            const body = asRecord(request.body);
            const scope = resolveScope(body, workspaces);
            const inputs = body.inputs === undefined ? undefined : asRecord(body.inputs);
            const effort = optionalString(body.reasoningEffort, 'reasoningEffort');
            if (effort && !EFFORTS.has(effort)) throw new WorkflowHttpError(400, 'Invalid reasoningEffort');
            if (body.wait !== undefined && typeof body.wait !== 'boolean') {
                throw new WorkflowHttpError(400, 'wait must be a boolean');
            }
            if (body.timeoutSeconds !== undefined && (
                typeof body.timeoutSeconds !== 'number'
                || !Number.isFinite(body.timeoutSeconds)
                || body.timeoutSeconds <= 0
            )) {
                throw new WorkflowHttpError(400, 'timeoutSeconds must be positive');
            }
            const runRequest: WorkflowRunRequest = {
                ...scope,
                name: requiredString(body.name, 'name'),
                inputs,
                provider: optionalString(body.provider, 'provider'),
                model: optionalString(body.model, 'model'),
                reasoningEffort: effort as WorkflowRunRequest['reasoningEffort'],
                locale: optionalString(body.locale, 'locale'),
                concurrencyGroup: optionalString(body.concurrencyGroup, 'concurrencyGroup'),
                wait: body.wait === true,
                timeoutSeconds: body.timeoutSeconds as number | undefined,
            };
            const result = await service.run(runRequest);
            if (!result.ok) return reply.code(startErrorStatus(result.error)).send({ success: false, ...result });
            return reply.code(202).send({ success: true, ...result });
        });

        routes.get<{ Querystring: ScopeInput & { status?: unknown } }>('/api/workflows/runs', async (request) => {
            const scope = resolveScope(request.query, workspaces);
            const status = optionalString(request.query.status, 'status');
            if (status && !STATUSES.has(status as WorkflowRunStatus)) {
                throw new WorkflowHttpError(400, 'Invalid workflow status');
            }
            const runs = await service.listRuns({ ...scope, status: status as WorkflowRunStatus | undefined });
            return {
                success: true,
                runs: runs.filter((run) => run.userId === scope.userId && samePath(run.root, scope.root)),
            };
        });

        routes.get<{ Params: RunParams; Querystring: ScopeInput & { includeEvents?: unknown } }>(
            '/api/workflows/runs/:runId',
            async (request) => {
                const scope = resolveScope(request.query, workspaces);
                const includeEvents = request.query.includeEvents === 'true';
                return { success: true, run: await getAuthorizedRun(service, scope, request.params.runId, includeEvents) };
            },
        );

        routes.post<{ Params: RunParams }>('/api/workflows/runs/:runId/cancel', async (request) => {
            const body = asRecord(request.body);
            const scope = resolveScope(body, workspaces);
            await getAuthorizedRun(service, scope, request.params.runId);
            if (!await service.cancel({ ...scope, runId: request.params.runId })) {
                throw new WorkflowHttpError(409, 'Workflow cannot be cancelled in its current state');
            }
            return { success: true, cancelled: true };
        });

        routes.post<{ Params: RunParams }>('/api/workflows/runs/:runId/resume', async (request) => {
            const body = asRecord(request.body);
            const scope = resolveScope(body, workspaces);
            await getAuthorizedRun(service, scope, request.params.runId);
            const inputs = body.inputs === undefined ? undefined : asRecord(body.inputs);
            const resumed = await service.resume({ ...scope, runId: request.params.runId, decision: body.decision, inputs });
            if (!resumed) {
                const current = await getAuthorizedRun(service, scope, request.params.runId);
                throw new WorkflowHttpError(409, current.error || 'Workflow cannot be resumed in its current state');
            }
            return { success: true, resumed: true };
        });

        routes.get<{ Params: RunParams; Querystring: ScopeInput }>(
            '/api/workflows/runs/:runId/events',
            async (request, reply) => {
                const scope = resolveScope(request.query, workspaces);
                const runId = request.params.runId;
                checkRunId(runId);
                const lastEventId = parseLastEventId(request);
                const buffered: WorkflowEvent[] = [];
                let live = false;
                let overflowed = false;
                let closed = false;
                let lastSent = lastEventId ?? 0;
                let unsubscribeWorkspace: (() => void) | undefined;
                let heartbeat: ReturnType<typeof setInterval> | undefined;
                let unsubscribe = () => {};

                const close = () => {
                    if (closed) return;
                    closed = true;
                    unsubscribe();
                    unsubscribeWorkspace?.();
                    if (heartbeat) clearInterval(heartbeat);
                    activeStreams.delete(close);
                    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
                };
                const write = (value: string) => {
                    if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
                    if (!reply.raw.write(value)) close();
                };
                const send = (event: WorkflowEvent) => {
                    if (event.seq <= lastSent) return;
                    write(`id: ${event.seq}\nevent: workflow\ndata: ${JSON.stringify(event)}\n\n`);
                    lastSent = event.seq;
                };
                unsubscribe = service.subscribe((event) => {
                    if (event.runId !== runId) return;
                    if (live) send(event);
                    else if (buffered.length < MAX_PENDING_EVENTS) buffered.push(event);
                    else overflowed = true;
                });
                reply.raw.once('close', close);
                request.raw.once('aborted', close);

                let run: WorkflowRunInfo;
                try {
                    run = await getAuthorizedRun(service, scope, runId, true);
                } catch (error) {
                    unsubscribe();
                    reply.raw.removeListener('close', close);
                    request.raw.removeListener('aborted', close);
                    throw error;
                }
                if (closed) return reply;

                reply.hijack();
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                activeStreams.add(close);
                unsubscribeWorkspace = workspaces.onWorkspaceChange((event) => {
                    if (event.userId === scope.userId && samePath(event.previousRoot, scope.root)) close();
                });
                const currentRoot = workspaces.get(scope.userId);
                if (!currentRoot || !samePath(currentRoot, scope.root)) {
                    close();
                    return reply;
                }
                write('retry: 3000\n\n');
                const events = (run.events ?? []).sort((left, right) => left.seq - right.seq);
                const latestAvailable = Math.max(
                    run.lastSeq ?? 0,
                    events[events.length - 1]?.seq ?? 0,
                    ...buffered.map((event) => event.seq),
                );
                const futureCursor = lastEventId !== undefined && lastEventId > latestAvailable;
                if (overflowed || (lastEventId !== undefined && (
                    futureCursor || (events.length > 0 && events[0].seq > lastEventId + 1)
                    || (events.length === 0 && (run.lastSeq ?? 0) > lastEventId)
                ))) {
                    write('event: reset\ndata: {"reason":"event_history_gap"}\n\n');
                    if (futureCursor) lastSent = 0;
                }
                for (const event of events) send(event);
                live = true;
                buffered.sort((left, right) => left.seq - right.seq);
                for (const event of buffered) send(event);
                if (!closed) {
                    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatIntervalMs);
                    heartbeat.unref?.();
                }
                return reply;
            },
        );
    });
}
