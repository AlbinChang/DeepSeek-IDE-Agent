import { ToolLogger } from '@/utils/ToolLogger.js';
import { AgentService } from "@/services/AgentService.js";

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: any;
    execute: (params: any, context?: any) => Promise<any>;
}

export class ToolManager {
    private tools: Map<string, ToolDefinition> = new Map();

    /**
     * 注册工具 (支持覆盖检查)
     */
    registerTool(tool: ToolDefinition) {
        if (this.tools.has(tool.name)) {
            console.warn(`[ToolManager] Overwriting existing tool: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    }

    getTool(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    getAllTools(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    /**
     * 集中式参数类型矫正 (LLM Defense Layer)
     * 大模型生成 tool_call arguments 时经常出现类型偏差：
     *   - 数字带双引号: "30000" → 30000
     *   - 布尔值带双引号: "true" → true
     *   - 数组写成单对象: {...} → [{...}]
     *   - 对象/数组被序列化为字符串: '{"k":"v"}' → {k:"v"}, '[1,2]' → [1,2]
     * 根据工具的 JSON Schema 自动矫正，所有工具自动受益。
     */
    private coerceParams(args: any, schema: any): any {
        if (!schema || !schema.properties) return args;

        // 顶层防御：整个 args 被 LLM 二次 JSON.stringify 为字符串
        if (typeof args === 'string') {
            try {
                const parsed = JSON.parse(args);
                if (typeof parsed === 'object' && parsed !== null) {
                    args = parsed;
                }
            } catch { return args; }
        }

        if (typeof args !== 'object' || args === null) return args;

        const coerced = Array.isArray(args) ? [...args] : { ...args };

        for (const [key, propSchema] of Object.entries<any>(schema.properties)) {
            if (!(key in coerced) || coerced[key] === undefined || coerced[key] === null) continue;

            const val = coerced[key];
            const expectedType = propSchema.type;

            if (expectedType === 'number' || expectedType === 'integer') {
                // "30000" → 30000, "3.14" → 3.14
                if (typeof val === 'string') {
                    const num = Number(val);
                    if (!isNaN(num)) coerced[key] = num;
                }
            } else if (expectedType === 'boolean') {
                // "true"/"false" → true/false
                if (typeof val === 'string') {
                    if (val.toLowerCase() === 'true') coerced[key] = true;
                    else if (val.toLowerCase() === 'false') coerced[key] = false;
                }
            } else if (expectedType === 'array') {
                if (typeof val === 'string') {
                    // 字符串化的数组/对象: '[{"id":1}]' → [{id:1}], '{"id":1}' → [{id:1}]
                    try {
                        const parsed = JSON.parse(val);
                        coerced[key] = Array.isArray(parsed) ? parsed : [parsed];
                    } catch { /* 保持原值 */ }
                } else if (!Array.isArray(val) && typeof val === 'object') {
                    // 单对象 → [obj]（大模型常见错误）
                    coerced[key] = [val];
                }
                // 递归矫正数组内的对象元素
                if (Array.isArray(coerced[key]) && propSchema.items?.properties) {
                    coerced[key] = coerced[key].map((item: any) => {
                        // 数组元素也可能是字符串化的对象
                        if (typeof item === 'string') {
                            try { item = JSON.parse(item); } catch {}
                        }
                        return typeof item === 'object' && item !== null
                            ? this.coerceParams(item, propSchema.items)
                            : item;
                    });
                }
            } else if (expectedType === 'object') {
                if (typeof val === 'string') {
                    // 字符串化的对象: '{"status":"completed"}' → {status:"completed"}
                    try {
                        const parsed = JSON.parse(val);
                        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                            coerced[key] = parsed;
                        }
                    } catch { /* 保持原值 */ }
                }
                // 递归矫正嵌套对象（仅当 Schema 有 properties 定义时）
                if (typeof coerced[key] === 'object' && coerced[key] !== null && propSchema.properties) {
                    coerced[key] = this.coerceParams(coerced[key], propSchema);
                }
            }
        }

        return coerced;
    }

    private validateParams(args: any, schema: any, toolName: string): void {
        const issues = this.collectSchemaIssues(args, schema, '');
        if (issues.length === 0) return;

        const schemaHint = schema?.required?.length
            ? `\n工具 ${toolName} 的 JSON Schema：required 字段 = [${schema.required.join(', ')}]，详见工具定义的 parameters。`
            : '';
        throw new Error(
            `INVALID_TOOL_ARGS: ${toolName} 参数校验失败 —— ${issues.join('；')}。` +
            `请严格按工具 schema 修正参数后重新调用。` +
            `自查清单：所有 required 字段是否已显式传入？类型是否精确匹配（number 不加引号、boolean 用 true/false 不加引号、array 用 [...] 不用 {...}）？是否误传了 schema 未声明的字段？` +
            schemaHint
        );
    }

    private collectSchemaIssues(value: any, schema: any, path: string): string[] {
        if (!schema) return [];

        const issues: string[] = [];
        const schemaType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        const label = path || '参数';

        if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
            issues.push(`${label} 必须是以下枚举值之一: ${schema.enum.join(', ')}`);
        }

        if (schemaType === 'object') {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                issues.push(`${label} 应为 object`);
                return issues;
            }

            const required = Array.isArray(schema.required) ? schema.required : [];
            for (const key of required) {
                if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === null) {
                    issues.push(`${this.joinSchemaPath(path, key)} 缺少必填字段`);
                }
            }

            if (schema.properties) {
                for (const [key, propSchema] of Object.entries<any>(schema.properties)) {
                    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === null) {
                        continue;
                    }
                    issues.push(...this.collectSchemaIssues(value[key], propSchema, this.joinSchemaPath(path, key)));
                }
            }

            return issues;
        }

        if (schemaType === 'array') {
            if (!Array.isArray(value)) {
                issues.push(`${label} 应为 array`);
                return issues;
            }

            if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
                issues.push(`${label} 至少需要 ${schema.minItems} 项`);
            }

            if (schema.items) {
                value.forEach((item: any, index: number) => {
                    issues.push(...this.collectSchemaIssues(item, schema.items, `${label}[${index}]`));
                });
            }

            return issues;
        }

        if (schemaType === 'string' && typeof value !== 'string') {
            issues.push(`${label} 应为 string`);
        } else if (schemaType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
            issues.push(`${label} 应为 number`);
        } else if (schemaType === 'integer' && !Number.isInteger(value)) {
            issues.push(`${label} 应为 integer`);
        } else if (schemaType === 'boolean' && typeof value !== 'boolean') {
            issues.push(`${label} 应为 boolean`);
        }

        if ((schemaType === 'number' || schemaType === 'integer') && typeof value === 'number' && Number.isFinite(value)) {
            if (typeof schema.minimum === 'number' && value < schema.minimum) {
                issues.push(`${label} 必须 >= ${schema.minimum}`);
            }
            if (typeof schema.maximum === 'number' && value > schema.maximum) {
                issues.push(`${label} 必须 <= ${schema.maximum}`);
            }
        }

        return issues;
    }

    private joinSchemaPath(base: string, key: string): string {
        return base ? `${base}.${key}` : key;
    }

    async executeTool(userId: string, toolName: string, args: any, traceId: string, executionContext: any = {}): Promise<any> {
        let resolvedToolName = toolName;
        let resolvedArgs = args;
        let tool = this.getTool(resolvedToolName);

        // LLM 容错：若误把原生 Playwright MCP 工具名当作顶层工具，自动改写为 browser_mcp_call。
        if (!tool) {
            const rewritten = this.rewriteMissingBrowserToolCall(resolvedToolName, resolvedArgs);
            if (rewritten) {
                resolvedToolName = rewritten.toolName;
                resolvedArgs = rewritten.args;
                tool = this.getTool(resolvedToolName);
            }
        }

        if (!tool) {
            throw new Error(`Tool not found: ${toolName}`);
        }

        // 集中式类型矫正：根据工具 Schema 自动修正 LLM 的类型偏差
        const safeArgs = this.coerceParams(resolvedArgs, tool.parameters);
    this.validateParams(safeArgs, tool.parameters, resolvedToolName);

        const workspaceRoot = executionContext?.workspaceRoot || AgentService.getInstance().getWorkspaceRoot(userId);
        
        try {
            const result = await tool.execute(safeArgs, { userId, traceId, ...executionContext });
            
            if (workspaceRoot) {
                ToolLogger.log(workspaceRoot, {
                    userId,
                    toolName: resolvedToolName,
                    args: safeArgs,
                    result,
                    traceId
                });
            }
            
            return result;
        } catch (error: any) {
            if (workspaceRoot) {
                ToolLogger.log(workspaceRoot, {
                    userId,
                    toolName: resolvedToolName,
                    args: safeArgs,
                    error: error.message,
                    traceId
                });
            }
            throw error;
        }
    }

    private rewriteMissingBrowserToolCall(toolName: string, args: any): { toolName: string; args: any } | null {
        const name = String(toolName || '').trim();
        if (!name) return null;
        // 匹配 browser_ 前缀的工具调用（LLM 可能误用旧版命名）
        if (!/^browser_[a-z0-9_]+$/i.test(name)) return null;

        // 尝试改写为 playwright__ 前缀的桥接工具
        const rewrittenName = name.replace(/^browser_/, 'playwright__browser_');
        if (!this.tools.has(rewrittenName)) return null;

        const source = (args && typeof args === 'object' && !Array.isArray(args))
            ? ({ ...(args as Record<string, unknown>) })
            : {};

        return {
            toolName: rewrittenName,
            args: source,
        };
    }

    /**
     * 导出符合 OpenAI SDK 格式的工具集 (兼容 DeepSeek API)
     */
    getAITools(contextGetter: () => any) {
        const aiTools: any = {};
        this.tools.forEach((tool, name) => {
            aiTools[name] = {
                description: tool.description,
                parameters: tool.parameters,
                execute: async (params: any, { toolCallId }: any) => {
                    const ctx = contextGetter();
                    const safeArgs = this.coerceParams(params, tool.parameters);
                    this.validateParams(safeArgs, tool.parameters, name);
                    return await tool.execute(safeArgs, { ...ctx, toolCallId });
                }
            };
        });
        return aiTools;
    }
}
