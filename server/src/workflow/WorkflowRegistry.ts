import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

import { PathUtils } from '@/utils/PathUtils.js';
import type {
    WorkflowDefinition,
    WorkflowDetail,
    WorkflowInputDefinition,
    WorkflowSummary,
    WorkflowValidationIssue,
    WorkflowValidationResult,
} from '@/workflow/types.js';

const WORKFLOW_DIRECTORY = '.workflow';
const WORKFLOW_EXTENSIONS = new Set(['.yaml', '.yml']);
const MAX_WORKFLOW_FILE_BYTES = 256 * 1024;
const MAX_SCAN_DEPTH = 3;

interface ParsedDocumentResult {
    summary: WorkflowSummary;
    issues: WorkflowValidationIssue[];
}

/**
 * 只读的 `.workflow` 目录注册表。
 *
 * 当前使用内置轻量校验（YAML + document/do 结构），不引入执行期依赖；
 * 后续可替换为 `@serverlessworkflow/sdk` 校验，保持相同返回结构即可。
 */
export class WorkflowRegistry {
    constructor(private readonly root: string) {}

    public get directory(): string {
        return path.join(this.root, WORKFLOW_DIRECTORY);
    }

    public async list(): Promise<WorkflowSummary[]> {
        const files = await this.scanFiles(this.directory, 0);
        const summaries: WorkflowSummary[] = [];
        for (const file of files) {
            const relativePath = PathUtils.getRelativePath(file, this.root);
            const fallbackName = path.basename(file, path.extname(file));
            try {
                const raw = await this.readWorkflowFile(file);
                const parsed = this.parseDocument(raw, fallbackName);
                summaries.push({ ...parsed.summary, path: relativePath });
            } catch (error: any) {
                summaries.push({
                    name: fallbackName,
                    path: relativePath,
                    title: fallbackName,
                    summary: `无法读取：${error?.message || String(error)}`,
                    inputs: [],
                    stepCount: 0,
                });
            }
        }
        return summaries;
    }

    public async get(target: string): Promise<WorkflowDetail | null> {
        const filePath = await this.resolveFilePath(target);
        if (!filePath) return null;

        const relativePath = PathUtils.getRelativePath(filePath, this.root);
        const fallbackName = path.basename(filePath, path.extname(filePath));
        const raw = await this.readWorkflowFile(filePath);
        const parsed = this.parseDocument(raw, fallbackName);
        const issues = parsed.issues;
        return {
            summary: { ...parsed.summary, path: relativePath },
            yaml: raw,
            validation: {
                ok: issues.every((issue) => issue.severity !== 'error'),
                issues,
                validator: 'builtin',
            },
        };
    }

    /**
     * 读取并解析为可执行定义；解析失败时 validation.ok=false，steps 为空。
     */
    public async loadDefinition(target: string): Promise<WorkflowDefinition | null> {
        const detail = await this.get(target);
        if (!detail) return null;

        let data: any;
        try {
            data = yaml.load(detail.yaml);
        } catch {
            data = undefined;
        }
        const document = (data && typeof data === 'object' && !Array.isArray(data))
            ? data as Record<string, unknown>
            : {};
        const steps = Array.isArray((data as any)?.do) ? (data as any).do as Record<string, any>[] : [];

        return {
            summary: detail.summary,
            document,
            steps,
            yaml: detail.yaml,
            validation: detail.validation,
        };
    }

    /**
     * 校验单个 workflow；target 为空时校验全部文件。
     */
    public async validate(target?: string): Promise<WorkflowValidationResult> {
        if (target) {
            const filePath = await this.resolveFilePath(target);
            if (!filePath) {
                return {
                    ok: false,
                    issues: [{ path: '', message: `Workflow not found: ${target}`, severity: 'error' }],
                    validator: 'builtin',
                };
            }
            const detail = await this.get(target);
            return detail?.validation ?? {
                ok: false,
                issues: [{ path: '', message: `Workflow not found: ${target}`, severity: 'error' }],
                validator: 'builtin',
            };
        }

        const files = await this.scanFiles(this.directory, 0);
        const issues: WorkflowValidationIssue[] = [];
        for (const file of files) {
            const relativePath = PathUtils.getRelativePath(file, this.root);
            const fallbackName = path.basename(file, path.extname(file));
            try {
                const raw = await this.readWorkflowFile(file);
                const parsed = this.parseDocument(raw, fallbackName);
                issues.push(...parsed.issues.map((issue) => ({
                    ...issue,
                    path: `${relativePath}${issue.path}`,
                })));
            } catch (error: any) {
                issues.push({
                    path: relativePath,
                    message: error?.message || String(error),
                    severity: 'error',
                });
            }
        }

        return {
            ok: issues.every((issue) => issue.severity !== 'error'),
            issues,
            validator: 'builtin',
        };
    }

    private async scanFiles(directory: string, depth: number): Promise<string[]> {
        if (depth > MAX_SCAN_DEPTH) return [];

        let entries: Dirent[];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error: any) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
            throw error;
        }

        const files: string[] = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.isDirectory()) continue;
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                files.push(...await this.scanFiles(absolutePath, depth + 1));
                continue;
            }
            if (entry.isFile() && WORKFLOW_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                files.push(absolutePath);
            }
        }
        return files.sort((left, right) => left.localeCompare(right));
    }

    private async readWorkflowFile(filePath: string): Promise<string> {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_WORKFLOW_FILE_BYTES) {
            throw new Error(`Workflow file exceeds ${MAX_WORKFLOW_FILE_BYTES} bytes: ${filePath}`);
        }
        return fs.readFile(filePath, 'utf8');
    }

    private async resolveFilePath(target: string): Promise<string | undefined> {
        const relative = this.sanitizeTarget(target);
        const directory = this.directory;
        const extension = path.extname(relative).toLowerCase();
        const candidates = WORKFLOW_EXTENSIONS.has(extension)
            ? [path.join(directory, relative)]
            : [
                // 优先匹配规范布局 *.workflow.yaml，再兼容普通 *.yaml
                path.join(directory, `${relative}.workflow.yaml`),
                path.join(directory, `${relative}.workflow.yml`),
                path.join(directory, `${relative}.yaml`),
                path.join(directory, `${relative}.yml`),
            ];

        for (const candidate of candidates) {
            const absolutePath = path.resolve(candidate);
            if (!this.isInsideDirectory(directory, absolutePath)) continue;
            try {
                const stat = await fs.stat(absolutePath);
                if (stat.isFile()) return absolutePath;
            } catch {
                // 尝试下一个候选
            }
        }

        // 允许用 document.name 引用（文件路径与流程名不一致时）
        for (const file of await this.scanFiles(directory, 0)) {
            try {
                const raw = await fs.readFile(file, 'utf8');
                const parsed: any = yaml.load(raw);
                const name = parsed?.document?.name;
                if (typeof name === 'string' && name.trim() === relative) {
                    return file;
                }
            } catch {
                // 忽略无法解析的文件，继续按名称匹配
            }
        }

        return undefined;
    }

    private sanitizeTarget(target: string): string {
        const normalized = String(target || '').trim().replace(/\\/g, '/');
        if (!normalized || normalized.includes('\0')) {
            throw new Error('Invalid workflow name');
        }
        const withoutPrefix = normalized.replace(/^\.?\/?\.workflow\//, '');
        const segments = withoutPrefix.split('/');
        if (segments.some((segment) => segment === '..' || segment === '')) {
            throw new Error('Invalid workflow path');
        }
        return withoutPrefix;
    }

    private isInsideDirectory(directory: string, candidate: string): boolean {
        const relative = path.relative(path.resolve(directory), path.resolve(candidate));
        return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    private parseDocument(raw: string, fallbackName: string): ParsedDocumentResult {
        let data: any;
        try {
            data = yaml.load(raw);
        } catch (error: any) {
            return {
                summary: this.buildFallbackSummary(fallbackName),
                issues: [{
                    path: '/',
                    message: `YAML 解析失败：${error?.message || String(error)}`,
                    severity: 'error',
                }],
            };
        }

        const issues: WorkflowValidationIssue[] = [];
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            issues.push({ path: '/', message: 'workflow 根节点必须是对象', severity: 'error' });
            return { summary: this.buildFallbackSummary(fallbackName), issues };
        }

        const document = (data as any).document;
        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            issues.push({ path: '/document', message: '缺少 document 对象', severity: 'error' });
        }

        const name = typeof document?.name === 'string' && document.name.trim()
            ? document.name.trim()
            : fallbackName;
        if (!document?.name) {
            issues.push({ path: '/document/name', message: '建议声明 document.name', severity: 'warning' });
        }

        if (document?.dsl === undefined) {
            issues.push({ path: '/document/dsl', message: '建议声明 document.dsl: 1.0.0', severity: 'warning' });
        } else if (document.dsl !== '1.0.0') {
            issues.push({
                path: '/document/dsl',
                message: `当前仅支持 DSL 1.0.0，实际为 ${String(document.dsl)}`,
                severity: 'warning',
            });
        }

        const steps = (data as any).do;
        if (!Array.isArray(steps) || steps.length === 0) {
            issues.push({ path: '/do', message: 'do 必须是非空步骤数组', severity: 'error' });
        } else {
            steps.forEach((step: any, index: number) => {
                if (!step || typeof step !== 'object' || Array.isArray(step)) {
                    issues.push({ path: `/do/${index}`, message: '步骤必须是对象', severity: 'error' });
                    return;
                }
                const names = Object.keys(step);
                if (names.length === 0) {
                    issues.push({ path: `/do/${index}`, message: '步骤缺少名称', severity: 'error' });
                } else if (names.length > 1) {
                    issues.push({
                        path: `/do/${index}`,
                        message: '单个步骤只应包含一个命名条目',
                        severity: 'warning',
                    });
                }
                for (const stepName of names) {
                    const definition = step[stepName];
                    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
                        issues.push({
                            path: `/do/${index}/${stepName}`,
                            message: '步骤定义必须是对象',
                            severity: 'error',
                        });
                        continue;
                    }
                    if (definition.call !== undefined && typeof definition.call !== 'string') {
                        issues.push({
                            path: `/do/${index}/${stepName}/call`,
                            message: 'call 必须是字符串',
                            severity: 'error',
                        });
                    }
                    if (definition.run !== undefined && (typeof definition.run !== 'object' || Array.isArray(definition.run))) {
                        issues.push({
                            path: `/do/${index}/${stepName}/run`,
                            message: 'run 必须是对象',
                            severity: 'error',
                        });
                    }
                }
            });
        }

        return {
            summary: {
                name,
                path: '',
                title: typeof document?.title === 'string' ? document.title : name,
                summary: typeof document?.summary === 'string'
                    ? document.summary
                    : (typeof document?.description === 'string' ? document.description : undefined),
                version: document?.version !== undefined ? String(document.version) : undefined,
                namespace: typeof document?.namespace === 'string' ? document.namespace : undefined,
                inputs: this.extractInputs(document),
                stepCount: Array.isArray(steps) ? steps.length : 0,
            },
            issues,
        };
    }

    private buildFallbackSummary(fallbackName: string): WorkflowSummary {
        return {
            name: fallbackName,
            path: '',
            title: fallbackName,
            inputs: [],
            stepCount: 0,
        };
    }

    private extractInputs(document: any): WorkflowInputDefinition[] {
        const raw = document?.input?.schema ?? document?.input ?? document?.inputs;
        if (!raw) return [];

        if (Array.isArray(raw)) {
            return raw
                .map((item: any): WorkflowInputDefinition | null => {
                    if (typeof item === 'string') return { name: item };
                    if (item && typeof item === 'object' && typeof item.name === 'string') {
                        return {
                            name: item.name,
                            type: typeof item.type === 'string' ? item.type : undefined,
                            description: typeof item.description === 'string' ? item.description : undefined,
                            required: item.required === true,
                            default: item.default,
                        };
                    }
                    return null;
                })
                .filter((item): item is WorkflowInputDefinition => item !== null);
        }

        if (typeof raw === 'object' && raw.properties && typeof raw.properties === 'object') {
            const required = new Set(Array.isArray(raw.required) ? raw.required : []);
            return Object.entries<any>(raw.properties).map(([name, schema]) => ({
                name,
                type: typeof schema?.type === 'string' ? schema.type : undefined,
                description: typeof schema?.description === 'string' ? schema.description : undefined,
                required: required.has(name),
                default: schema?.default,
            }));
        }

        return [];
    }
}
