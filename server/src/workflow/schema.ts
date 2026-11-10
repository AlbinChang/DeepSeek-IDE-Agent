/**
 * 轻量 JSON Schema 校验（Workflow output.schema 子集）。
 * 不引入 AJV，覆盖 type/required/properties/items/enum/数值与长度约束。
 */

export interface SchemaValidationIssue {
    path: string;
    message: string;
}

function joinPath(base: string, key: string | number): string {
    return `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function typeOf(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
    if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (expected === 'number') return typeof value === 'number';
    return typeOf(value) === expected;
}

export function validateJsonSchema(value: unknown, schema: any, basePath = ''): SchemaValidationIssue[] {
    if (!schema || typeof schema !== 'object') return [];
    const issues: SchemaValidationIssue[] = [];

    if (typeof schema.type === 'string' || Array.isArray(schema.type)) {
        const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!expected.some((type: string) => matchesType(value, type))) {
            issues.push({ path: basePath || '/', message: `应为 ${expected.join(' | ')}` });
            return issues;
        }
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => item === value)) {
        issues.push({ path: basePath || '/', message: `必须是枚举值之一: ${schema.enum.map(String).join(', ')}` });
    }

    if (Object.prototype.hasOwnProperty.call(schema, 'const') && schema.const !== value) {
        issues.push({ path: basePath || '/', message: `必须等于 ${String(schema.const)}` });
    }

    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            issues.push({ path: basePath || '/', message: `长度不能小于 ${schema.minLength}` });
        }
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
            issues.push({ path: basePath || '/', message: `长度不能大于 ${schema.maxLength}` });
        }
        if (typeof schema.pattern === 'string') {
            try {
                if (!new RegExp(schema.pattern).test(value)) {
                    issues.push({ path: basePath || '/', message: `不匹配正则 ${schema.pattern}` });
                }
            } catch {
                // 非法正则忽略，避免坏 schema 阻塞执行
            }
        }
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            issues.push({ path: basePath || '/', message: `不能小于 ${schema.minimum}` });
        }
        if (typeof schema.maximum === 'number' && value > schema.maximum) {
            issues.push({ path: basePath || '/', message: `不能大于 ${schema.maximum}` });
        }
    }

    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            issues.push({ path: basePath || '/', message: `元素数量不能小于 ${schema.minItems}` });
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            issues.push({ path: basePath || '/', message: `元素数量不能大于 ${schema.maxItems}` });
        }
        if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
            value.forEach((item, index) => {
                issues.push(...validateJsonSchema(item, schema.items, joinPath(basePath, index)));
            });
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (Array.isArray(schema.required)) {
            for (const key of schema.required) {
                if (typeof key === 'string' && !(key in record)) {
                    issues.push({ path: joinPath(basePath, key), message: '缺少必填字段' });
                }
            }
        }
        if (schema.properties && typeof schema.properties === 'object') {
            for (const [key, propertySchema] of Object.entries<any>(schema.properties)) {
                if (key in record) {
                    issues.push(...validateJsonSchema(record[key], propertySchema, joinPath(basePath, key)));
                }
            }
            if (schema.additionalProperties === false) {
                for (const key of Object.keys(record)) {
                    if (!(key in schema.properties)) {
                        issues.push({ path: joinPath(basePath, key), message: '不允许的额外字段' });
                    }
                }
            }
        }
    }

    if (Array.isArray(schema.allOf)) {
        for (const sub of schema.allOf) {
            issues.push(...validateJsonSchema(value, sub, basePath));
        }
    }
    if (Array.isArray(schema.anyOf)) {
        const results = schema.anyOf.map((sub: any) => validateJsonSchema(value, sub, basePath));
        if (!results.some((result: SchemaValidationIssue[]) => result.length === 0)) {
            issues.push({ path: basePath || '/', message: '不满足 anyOf 中的任一 Schema' });
        }
    }
    if (Array.isArray(schema.oneOf)) {
        const results = schema.oneOf.map((sub: any) => validateJsonSchema(value, sub, basePath));
        if (results.filter((result: SchemaValidationIssue[]) => result.length === 0).length !== 1) {
            issues.push({ path: basePath || '/', message: '必须恰好满足 oneOf 中的一个 Schema' });
        }
    }

    return issues;
}
