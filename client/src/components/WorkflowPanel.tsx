import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    CircleStop,
    Loader2,
    Network,
    Play,
    RefreshCw,
    RotateCcw,
    Workflow as WorkflowIcon,
    XCircle,
} from 'lucide-react';

import { USER_ID } from '@/config';
import { useAgentContext } from '@/providers/AgentContext';
import {
    workflowBridge,
    type WorkflowDetail,
    type WorkflowRunInfo,
    type WorkflowRunStatus,
    type WorkflowSummary,
} from '@/services/electron-bridge';

const Mermaid = lazy(() => import('@/components/Mermaid').then((module) => ({ default: module.Mermaid })));

const STATUS_STYLE: Record<WorkflowRunStatus, string> = {
    queued: 'text-white/50 border-white/15 bg-white/[0.03]',
    running: 'text-white border-white/30 bg-white/[0.08]',
    waiting_approval: 'text-amber-300 border-amber-300/30 bg-amber-300/[0.06]',
    succeeded: 'text-emerald-300 border-emerald-300/25 bg-emerald-300/[0.05]',
    failed: 'text-red-300 border-red-300/25 bg-red-300/[0.05]',
    cancelled: 'text-white/40 border-white/10 bg-white/[0.02]',
    interrupted: 'text-orange-300 border-orange-300/25 bg-orange-300/[0.05]',
};

function formatTime(timestamp?: number): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function statusLabel(status: WorkflowRunStatus): string {
    return {
        queued: '排队',
        running: '运行中',
        waiting_approval: '待审批',
        succeeded: '成功',
        failed: '失败',
        cancelled: '已取消',
        interrupted: '已中断',
    }[status];
}

function coerceInput(type: string | undefined, raw: string): unknown {
    if (type === 'number' || type === 'integer') {
        const value = Number(raw);
        return Number.isFinite(value) ? value : raw;
    }
    if (type === 'boolean') return raw === 'true';
    return raw;
}

export const WorkflowPanel: React.FC = () => {
    const { workspaceRoot } = useAgentContext();
    const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
    const [runs, setRuns] = useState<WorkflowRunInfo[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [detail, setDetail] = useState<WorkflowDetail | null>(null);
    const [inputs, setInputs] = useState<Record<string, string>>({});
    const [expandedRun, setExpandedRun] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [graphOpen, setGraphOpen] = useState(false);
    const [resumeInputs, setResumeInputs] = useState<Record<string, string>>({});
    const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const selectionVersion = useRef(0);

    const selected = useMemo(
        () => workflows.find((workflow) => workflow.path === selectedPath) || null,
        [workflows, selectedPath],
    );

    const loadRuns = useCallback(async () => {
        if (!workspaceRoot) return;
        try {
            const result = await workflowBridge.listRuns({ userId: USER_ID, root: workspaceRoot });
            if (result.success) {
                setRuns(result.runs || []);
            } else {
                setError(result.error || '加载运行记录失败');
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [workspaceRoot]);

    const refresh = useCallback(async () => {
        if (!workspaceRoot) {
            setWorkflows([]);
            setRuns([]);
            setSelectedPath(null);
            setDetail(null);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const [list, runList] = await Promise.all([
                workflowBridge.list({ userId: USER_ID, root: workspaceRoot }),
                workflowBridge.listRuns({ userId: USER_ID, root: workspaceRoot }),
            ]);
            if (list.success) setWorkflows(list.workflows || []);
            else setError(list.error || '加载工作流失败');
            if (runList.success) setRuns(runList.runs || []);
            else setError(runList.error || '加载运行记录失败');
        } catch (caught: any) {
            setError(caught?.message || String(caught));
        } finally {
            setLoading(false);
        }
    }, [workspaceRoot]);

    useEffect(() => {
        selectionVersion.current++;
        setSelectedPath(null);
        setDetail(null);
        setInputs({});
        setResumeInputs({});
        setGraphOpen(false);
        setExpandedRun(null);
    }, [workspaceRoot]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!workspaceRoot) return;
        return workflowBridge.onEvent(() => {
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
            refreshTimer.current = setTimeout(() => {
                void loadRuns();
            }, 250);
        });
    }, [workspaceRoot, loadRuns]);

    useEffect(() => () => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
    }, []);

    useEffect(() => {
        if (!graphOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setGraphOpen(false);
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [graphOpen]);

    const selectWorkflow = useCallback(async (workflow: WorkflowSummary) => {
        if (!workspaceRoot) return;
        const version = ++selectionVersion.current;
        setSelectedPath(workflow.path);
        setDetail(null);
        setGraphOpen(false);
        setError(null);
        try {
            const result = await workflowBridge.get({ userId: USER_ID, root: workspaceRoot, name: workflow.path });
            if (version !== selectionVersion.current) return;
            if (result.success && result.workflow) {
                setDetail(result.workflow);
                const nextInputs: Record<string, string> = {};
                for (const input of result.workflow.summary.inputs) {
                    const defaultValue = input.default;
                    nextInputs[input.name] = defaultValue === undefined || defaultValue === null
                        ? ''
                        : String(defaultValue);
                }
                setInputs(nextInputs);
            } else {
                setError(result.error || '读取工作流详情失败');
            }
        } catch (caught) {
            if (version === selectionVersion.current) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        }
    }, [workspaceRoot]);

    const runSelected = useCallback(async () => {
        if (!workspaceRoot || !selected) return;
        const requiredMissing = (detail?.summary.inputs || [])
            .filter((input) => input.required && !inputs[input.name]?.trim());
        if (requiredMissing.length > 0) {
            setError(`缺少必填输入: ${requiredMissing.map((input) => input.name).join(', ')}`);
            return;
        }
        setBusy('run');
        setError(null);
        try {
            const payload: Record<string, unknown> = {};
            for (const input of detail?.summary.inputs || []) {
                const value = inputs[input.name];
                if (value === undefined || value === '') continue;
                payload[input.name] = coerceInput(input.type, value);
            }
            const result = await workflowBridge.run({
                userId: USER_ID,
                root: workspaceRoot,
                name: selected.path,
                inputs: payload,
            });
            if (!result.success) {
                setError(result.error || '启动工作流失败');
                return;
            }
            await loadRuns();
            if (result.runId) setExpandedRun(result.runId);
        } catch (caught: any) {
            setError(caught?.message || String(caught));
        } finally {
            setBusy(null);
        }
    }, [workspaceRoot, selected, detail, inputs, loadRuns]);

    const runAction = useCallback(async (run: WorkflowRunInfo, action: 'cancel' | 'approve' | 'reject' | 'resume') => {
        if (!workspaceRoot) return;
        let replacementInputs: Record<string, unknown> | undefined;
        const rawInputs = resumeInputs[run.runId]?.trim();
        if (rawInputs && action !== 'cancel' && action !== 'reject') {
            try {
                const parsed: unknown = JSON.parse(rawInputs);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('重新提供的输入必须是 JSON 对象');
                }
                replacementInputs = parsed as Record<string, unknown>;
            } catch (caught) {
                setError(caught instanceof Error ? caught.message : '输入 JSON 无效');
                return;
            }
        }
        setBusy(`${action}:${run.runId}`);
        setError(null);
        try {
            if (action === 'cancel') {
                const result = await workflowBridge.cancel({ userId: USER_ID, root: workspaceRoot, runId: run.runId });
                if (!result.success || !result.cancelled) {
                    setError(result.error || '当前运行无法取消');
                    await loadRuns();
                    return;
                }
            } else if (action === 'resume') {
                const result = await workflowBridge.resume({
                    userId: USER_ID, root: workspaceRoot, runId: run.runId, inputs: replacementInputs,
                });
                if (!result.success || !result.resumed) {
                    setError(result.error || '当前运行无法恢复');
                    await loadRuns();
                    return;
                }
            } else {
                const result = await workflowBridge.resume({
                    userId: USER_ID,
                    root: workspaceRoot,
                    runId: run.runId,
                    decision: action,
                    inputs: replacementInputs,
                });
                if (!result.success || !result.resumed) {
                    setError(result.error || '审批未被接受');
                    await loadRuns();
                    return;
                }
            }
            if (rawInputs) {
                setResumeInputs((previous) => {
                    const next = { ...previous };
                    delete next[run.runId];
                    return next;
                });
            }
            await loadRuns();
        } catch (caught: any) {
            setError(caught?.message || String(caught));
        } finally {
            setBusy(null);
        }
    }, [workspaceRoot, loadRuns, resumeInputs]);

    if (!workspaceRoot) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-white/30">
                <WorkflowIcon size={28} className="opacity-40" />
                <div className="text-[9px] font-bold uppercase tracking-[0.25em]">请先打开工作区</div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col min-h-0 text-white/80 select-none" data-testid="workflow-panel">
            <div className="flex items-center gap-1 px-2 h-[26px] border-b border-white/10 bg-black/30 shrink-0">
                <WorkflowIcon size={11} className="text-white/60" />
                <span className="text-[8px] font-black uppercase tracking-[0.18em] text-white/60">工作流</span>
                <span className="ml-1 text-[7px] font-mono text-white/30">{workflows.length}</span>
                <div className="ml-auto flex items-center gap-1">
                    <button
                        onClick={() => void refresh()}
                        disabled={loading}
                        className="p-1 rounded-sm hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-30"
                        title="刷新工作流"
                    >
                        <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {error && (
                <div className="flex items-start gap-1.5 px-2 py-1.5 text-[8px] leading-relaxed text-red-300 bg-red-500/[0.06] border-b border-red-500/20">
                    <AlertCircle size={10} className="mt-[1px] shrink-0" />
                    <span className="break-all">{error}</span>
                    <button onClick={() => setError(null)} className="ml-auto text-white/40 hover:text-white">
                        <XCircle size={10} />
                    </button>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
                <div className="px-2 py-1.5 border-b border-white/5">
                    <div className="text-[7px] font-black uppercase tracking-[0.2em] text-white/35 mb-1">可用工作流</div>
                    {workflows.length === 0 ? (
                        <div className="text-[8px] text-white/30 py-2">工作区 `.workflow/` 下没有工作流</div>
                    ) : (
                        <div className="flex flex-col gap-[1px]">
                            {workflows.map((workflow) => (
                                <button
                                    key={workflow.path}
                                    onClick={() => void selectWorkflow(workflow)}
                                    className={`w-full text-left px-1.5 py-1 rounded-sm flex items-center gap-1.5 transition-colors ${
                                        selectedPath === workflow.path ? 'bg-white/[0.08] text-white' : 'hover:bg-white/[0.04] text-white/60'
                                    }`}
                                    title={workflow.path}
                                >
                                    <span className="w-1 h-1 rounded-full bg-white/30 shrink-0" />
                                    <span className="text-[8px] font-medium truncate">{workflow.title || workflow.name}</span>
                                    <span className="ml-auto text-[7px] font-mono text-white/25 shrink-0">{workflow.stepCount} 步</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {selected && (
                    <div className="px-2 py-1.5 border-b border-white/5 bg-white/[0.01]">
                        <div className="flex items-center gap-1 mb-1">
                            <span className="text-[8px] font-bold text-white truncate">{selected.title || selected.name}</span>
                            <span className="text-[7px] font-mono text-white/25 truncate">{selected.path}</span>
                        </div>
                        {detail?.graph && (
                            <button
                                type="button"
                                onClick={() => setGraphOpen(true)}
                                className="mb-1.5 flex items-center gap-1 text-[8px] text-white/55 hover:text-white"
                                data-testid="workflow-open-graph"
                            >
                                <Network size={10} /> 查看流程图
                            </button>
                        )}
                        {detail?.validation.issues.length ? (
                            <div className="text-[7px] text-red-300/80 leading-relaxed mb-1">
                                {detail.validation.issues.slice(0, 3).map((issue, index) => (
                                    <div key={`${issue.path}-${index}`}>{issue.path} {issue.message}</div>
                                ))}
                            </div>
                        ) : null}
                        {(detail?.summary.inputs.length || 0) > 0 && (
                            <div className="flex flex-col gap-1 mb-1.5">
                                {detail!.summary.inputs.map((input) => (
                                    <label key={input.name} className="flex items-center gap-1.5">
                                        <span className="text-[7px] text-white/45 w-[72px] shrink-0 truncate" title={input.description}>
                                            {input.name}{input.required ? ' *' : ''}
                                        </span>
                                        {input.type === 'boolean' ? (
                                            <select
                                                value={inputs[input.name] || ''}
                                                onChange={(event) => setInputs((prev) => ({ ...prev, [input.name]: event.target.value }))}
                                                className="flex-1 min-w-0 h-[18px] bg-black border border-white/15 rounded-sm px-1 text-[8px] text-white outline-none focus:border-white/40"
                                            >
                                                <option value="">默认</option>
                                                <option value="true">true</option>
                                                <option value="false">false</option>
                                            </select>
                                        ) : (
                                            <input
                                                value={inputs[input.name] || ''}
                                                onChange={(event) => setInputs((prev) => ({ ...prev, [input.name]: event.target.value }))}
                                                placeholder={input.default !== undefined ? String(input.default) : input.type || 'string'}
                                                className="flex-1 min-w-0 h-[18px] bg-black border border-white/15 rounded-sm px-1 text-[8px] text-white outline-none focus:border-white/40 placeholder:text-white/20"
                                            />
                                        )}
                                    </label>
                                ))}
                            </div>
                        )}
                        <button
                            onClick={() => void runSelected()}
                            disabled={busy === 'run' || !detail?.validation.ok}
                            className="w-full h-[20px] flex items-center justify-center gap-1.5 rounded-sm border border-white/20 bg-white/[0.06] hover:bg-white/[0.12] text-[8px] font-bold uppercase tracking-[0.15em] text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            {busy === 'run' ? <Loader2 size={9} className="animate-spin" /> : <Play size={9} />}
                            运行
                        </button>
                    </div>
                )}

                <div className="px-2 py-1.5">
                    <div className="flex items-center gap-1 mb-1">
                        <span className="text-[7px] font-black uppercase tracking-[0.2em] text-white/35">运行记录</span>
                        <span className="text-[7px] font-mono text-white/25">{runs.length}</span>
                    </div>
                    {runs.length === 0 ? (
                        <div className="text-[8px] text-white/25 py-2">暂无运行记录</div>
                    ) : (
                        <div className="flex flex-col gap-1">
                            {runs.map((run) => {
                                const expanded = expandedRun === run.runId;
                                const actionKey = (action: string) => `${action}:${run.runId}`;
                                return (
                                    <div key={run.runId} className="border border-white/[0.07] rounded-sm bg-white/[0.015]">
                                        <button
                                            onClick={() => setExpandedRun(expanded ? null : run.runId)}
                                            className="w-full text-left px-1.5 py-1 flex items-center gap-1.5"
                                        >
                                            {expanded ? <ChevronDown size={9} className="text-white/35" /> : <ChevronRight size={9} className="text-white/35" />}
                                            <span className="text-[8px] font-medium text-white/80 truncate">{run.workflowName || run.workflow?.name}</span>
                                            {run.trigger && (
                                                <span className="text-[7px] text-sky-300/80" title={run.trigger.id}>
                                                    {run.trigger.type === 'interval' ? '定时触发' : '文件触发'}
                                                </span>
                                            )}
                                            <span className={`ml-auto text-[7px] font-mono px-1 py-[1px] rounded-sm border ${STATUS_STYLE[run.status]}`}>
                                                {statusLabel(run.status)}
                                            </span>
                                            <span className="text-[7px] font-mono text-white/25">{formatTime(run.createdAt)}</span>
                                        </button>

                                        {expanded && (
                                            <div className="px-1.5 pb-1.5 flex flex-col gap-1">
                                                <div className="text-[7px] font-mono text-white/30 break-all">{run.runId}</div>
                                                {run.approval?.message && (
                                                    <div className="text-[7px] text-amber-300/80 break-all">审批: {run.approval.message}</div>
                                                )}
                                                {run.error && <div className="text-[7px] text-red-300/80 break-all">{run.error}</div>}
                                                {run.resumeInputsRequired
                                                    && (run.status === 'waiting_approval' || run.status === 'interrupted') && (
                                                    <details className="text-[8px] text-white/50">
                                                        <summary className="cursor-pointer hover:text-white">重新提供脱敏输入</summary>
                                                        <p className="my-1 leading-relaxed">仅在重启后需要；请输入完整 JSON 对象，敏感值不会写入运行记录。</p>
                                                        <textarea
                                                            aria-label="重新提供工作流输入"
                                                            value={resumeInputs[run.runId] ?? ''}
                                                            onChange={(event) => setResumeInputs((previous) => ({
                                                                ...previous,
                                                                [run.runId]: event.target.value,
                                                            }))}
                                                            className="w-full min-h-[48px] bg-black border border-white/15 rounded-sm p-1 text-[8px] text-white outline-none focus:border-white/40"
                                                            placeholder='{"token":"..."}'
                                                        />
                                                    </details>
                                                )}
                                                {run.usage && (
                                                    <div className="text-[7px] font-mono text-white/30">
                                                        tokens: {run.usage.totalTokens} (in {run.usage.inputTokens} / out {run.usage.outputTokens})
                                                    </div>
                                                )}
                                                <div className="flex flex-col gap-[1px]">
                                                    {run.steps.map((step) => (
                                                        <div key={step.path} className="flex items-center gap-1 text-[7px] font-mono">
                                                            <span className={`w-1 h-1 rounded-full shrink-0 ${
                                                                step.status === 'succeeded' ? 'bg-emerald-400/70'
                                                                    : step.status === 'failed' ? 'bg-red-400/70'
                                                                        : step.status === 'waiting_approval' ? 'bg-amber-300/70'
                                                                            : step.status === 'running' ? 'bg-white animate-pulse'
                                                                                : 'bg-white/20'
                                                            }`} />
                                                            <span className="truncate text-white/50">{step.path}</span>
                                                            <span className="ml-auto text-white/25">{step.status}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    {(run.status === 'queued' || run.status === 'running') && (
                                                        <button
                                                            onClick={() => void runAction(run, 'cancel')}
                                                            disabled={busy === actionKey('cancel')}
                                                            className="h-[17px] px-1.5 flex items-center gap-1 rounded-sm border border-white/15 hover:bg-white/10 text-[7px] text-white/70"
                                                        >
                                                            <CircleStop size={8} /> 取消
                                                        </button>
                                                    )}
                                                    {run.status === 'waiting_approval' && (
                                                        <>
                                                            <button
                                                                onClick={() => void runAction(run, 'approve')}
                                                                disabled={busy === actionKey('approve')}
                                                                className="h-[17px] px-1.5 flex items-center gap-1 rounded-sm border border-emerald-300/30 text-emerald-300 hover:bg-emerald-300/10 text-[7px]"
                                                            >
                                                                <CheckCircle2 size={8} /> 批准
                                                            </button>
                                                            <button
                                                                onClick={() => void runAction(run, 'reject')}
                                                                disabled={busy === actionKey('reject')}
                                                                className="h-[17px] px-1.5 flex items-center gap-1 rounded-sm border border-red-300/30 text-red-300 hover:bg-red-300/10 text-[7px]"
                                                            >
                                                                <XCircle size={8} /> 拒绝
                                                            </button>
                                                        </>
                                                    )}
                                                    {run.status === 'interrupted' && (
                                                        <button
                                                            onClick={() => void runAction(run, 'resume')}
                                                            disabled={busy === actionKey('resume')}
                                                            className="h-[17px] px-1.5 flex items-center gap-1 rounded-sm border border-orange-300/30 text-orange-300 hover:bg-orange-300/10 text-[7px]"
                                                        >
                                                            <RotateCcw size={8} /> 恢复
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
            {graphOpen && detail?.graph && createPortal(
                <div
                    className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-6"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="workflow-graph-title"
                >
                    <div className="flex h-[min(80vh,760px)] w-[min(90vw,1100px)] flex-col border border-white/20 bg-[#080808] shadow-2xl">
                        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
                            <Network size={16} className="text-white/70" />
                            <div className="min-w-0">
                                <h2 id="workflow-graph-title" className="truncate text-xs font-bold tracking-wider text-white">
                                    {detail.summary.title || detail.summary.name}
                                </h2>
                                <p className="mt-1 text-[10px] text-white/40">
                                    静态结构预览{detail.graph.truncated ? ' · 图已截断（最多 200 个节点）' : ''}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setGraphOpen(false)}
                                className="ml-auto p-2 text-white/50 hover:bg-white/10 hover:text-white"
                                aria-label="关闭流程图"
                            >
                                <XCircle size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="workflow-graph">
                            <Suspense fallback={<div className="p-8 text-center text-xs text-white/40">正在加载流程图…</div>}>
                                <Mermaid chart={detail.graph.mermaid} />
                            </Suspense>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};
