import { promises as dns } from 'node:dns';
import * as net from 'node:net';

import {
    WorkflowCancelledError,
    WorkflowError,
    WorkflowTimeoutError,
} from '@/workflow/errors.js';

export interface WorkflowHttpRequestOptions {
    url: string;
    method?: string;
    headers?: Record<string, unknown>;
    body?: unknown;
    failOnError?: boolean;
    timeoutMs?: number;
    allowPrivate: boolean;
    maxResponseBytes: number;
    abortSignal: AbortSignal;
    stepPath: string;
}

export interface WorkflowHttpResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    url: string;
}

const MAX_REDIRECTS = 5;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BLOCKED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'expect', 'upgrade']);

function isPrivateIpv4(address: string): boolean {
    const parts = address.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 198 && b >= 18 && b <= 19) return true;
    if (a >= 224) return true;
    return false;
}

function isPrivateIpAddress(address: string): boolean {
    const version = net.isIP(address);
    if (version === 4) return isPrivateIpv4(address);
    if (version !== 6) return true;

    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
        return true;
    }
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8
    return false;
}

async function assertUrlAllowed(rawUrl: URL, allowPrivate: boolean, stepPath: string): Promise<void> {
    if (rawUrl.protocol !== 'http:' && rawUrl.protocol !== 'https:') {
        throw new WorkflowError(`http 步骤仅支持 http/https: ${rawUrl.protocol}`, 'validation', stepPath);
    }
    if (rawUrl.username || rawUrl.password) {
        throw new WorkflowError('http 步骤不允许在 URL 中携带用户名/密码', 'validation', stepPath);
    }
    if (allowPrivate) return;

    const hostname = rawUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) {
        throw new WorkflowError('http 步骤缺少 hostname', 'validation', stepPath);
    }
    if (hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname.endsWith('.local')
        || hostname.endsWith('.internal')) {
        throw new WorkflowError(`http 步骤默认禁止访问内网主机: ${hostname}`, 'validation', stepPath);
    }

    if (net.isIP(hostname)) {
        if (isPrivateIpAddress(hostname)) {
            throw new WorkflowError(`http 步骤默认禁止访问内网地址: ${hostname}`, 'validation', stepPath);
        }
        return;
    }

    let addresses: Array<{ address: string }>;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error: any) {
        throw new WorkflowError(
            `http 步骤无法解析主机 ${hostname}: ${error?.message || String(error)}`,
            'step',
            stepPath,
        );
    }
    if (addresses.length === 0) {
        throw new WorkflowError(`http 步骤无法解析主机: ${hostname}`, 'step', stepPath);
    }
    const privateAddress = addresses.find((entry) => isPrivateIpAddress(entry.address));
    if (privateAddress) {
        throw new WorkflowError(
            `http 步骤默认禁止访问内网地址: ${hostname} -> ${privateAddress.address}`,
            'validation',
            stepPath,
        );
    }
}

function normalizeHeaders(
    raw: Record<string, unknown> | undefined,
    hasBody: boolean,
    bodyIsString: boolean,
): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const name = key.trim().toLowerCase();
        if (!name || BLOCKED_HEADERS.has(name) || name.startsWith('proxy-')) continue;
        if (value === undefined || value === null) continue;
        headers[name] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
    }
    if (hasBody && !headers['content-type']) {
        headers['content-type'] = bodyIsString ? 'text/plain; charset=utf-8' : 'application/json';
    }
    return headers;
}

async function readLimitedBody(
    response: Response,
    maxBytes: number,
    stepPath: string,
): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new WorkflowError(
                    `http 响应超过上限 ${maxBytes} bytes`,
                    'step',
                    stepPath,
                );
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

function parseResponseBody(text: string, contentType: string | null): unknown {
    if (!text) return '';
    if (contentType && /json/i.test(contentType)) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}

/**
 * 执行 workflow HTTP 步骤。
 *
 * 默认阻止 localhost/私网/链路本地/保留地址，并限制重定向次数、方法、响应大小；
 * 需要访问本地服务时显式设置 WORKFLOW_HTTP_ALLOW_PRIVATE=true。
 */
export async function executeWorkflowHttp(options: WorkflowHttpRequestOptions): Promise<WorkflowHttpResponse> {
    const method = String(options.method || 'GET').trim().toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
        throw new WorkflowError(`http 步骤不支持的方法: ${method}`, 'validation', options.stepPath);
    }
    if ((method === 'GET' || method === 'HEAD') && options.body !== undefined) {
        throw new WorkflowError(`${method} 请求不能携带 body`, 'validation', options.stepPath);
    }

    const timeoutMs = Math.max(1, options.timeoutMs ?? 60_000);

    let currentUrl: URL;
    try {
        currentUrl = new URL(options.url);
    } catch {
        throw new WorkflowError(`http 步骤 URL 无效: ${options.url}`, 'validation', options.stepPath);
    }
    await assertUrlAllowed(currentUrl, options.allowPrivate, options.stepPath);

    const hasBody = options.body !== undefined && options.body !== null;
    const bodyIsString = typeof options.body === 'string';
    const headers = normalizeHeaders(options.headers, hasBody, bodyIsString);
    const body = hasBody
        ? (bodyIsString ? options.body as string : JSON.stringify(options.body))
        : undefined;

    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort(options.abortSignal.reason
                || new WorkflowCancelledError('Workflow cancelled', options.stepPath));
        }
    };
    if (options.abortSignal.aborted) onParentAbort();
    else options.abortSignal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new WorkflowTimeoutError(
            `http 请求超时（>${timeoutMs}ms）`,
            options.stepPath,
        ));
    }, timeoutMs);

    try {
        let response: Response | undefined;
        let requestMethod = method;
        let requestBody = body;
        for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            try {
                response = await fetch(currentUrl, {
                    method: requestMethod,
                    headers,
                    body: requestBody,
                    redirect: 'manual',
                    signal: controller.signal,
                });
            } catch (error: any) {
                if (timedOut) {
                    throw new WorkflowTimeoutError(
                        `http 请求超时（>${timeoutMs}ms）`,
                        options.stepPath,
                    );
                }
                if (options.abortSignal.aborted) {
                    throw options.abortSignal.reason || new WorkflowCancelledError('Workflow cancelled', options.stepPath);
                }
                throw new WorkflowError(
                    `http 请求失败: ${error?.message || String(error)}`,
                    'step',
                    options.stepPath,
                    error,
                );
            }

            const location = response.headers.get('location');
            if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
            if (redirect >= MAX_REDIRECTS) {
                throw new WorkflowError(`http 重定向超过 ${MAX_REDIRECTS} 次`, 'step', options.stepPath);
            }
            try {
                currentUrl = new URL(location, currentUrl);
            } catch {
                throw new WorkflowError(`http 重定向地址无效: ${location}`, 'step', options.stepPath);
            }
            await assertUrlAllowed(currentUrl, options.allowPrivate, options.stepPath);
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod === 'POST')) {
                requestMethod = 'GET';
                requestBody = undefined;
                delete headers['content-type'];
            }
            try {
                await response.body?.cancel();
            } catch {
                // 忽略重定向响应体取消失败
            }
        }

        if (!response) {
            throw new WorkflowError('http 请求未得到响应', 'step', options.stepPath);
        }

        const text = await (async () => {
            try {
                return await readLimitedBody(response!, options.maxResponseBytes, options.stepPath);
            } catch (error: any) {
                if (error instanceof WorkflowError) throw error;
                if (timedOut) {
                    throw new WorkflowTimeoutError(
                        `http 请求超时（>${timeoutMs}ms）`,
                        options.stepPath,
                    );
                }
                if (options.abortSignal.aborted) {
                    throw options.abortSignal.reason || new WorkflowCancelledError('Workflow cancelled', options.stepPath);
                }
                throw new WorkflowError(
                    `http 响应读取失败: ${error?.message || String(error)}`,
                    'step',
                    options.stepPath,
                    error,
                );
            }
        })();
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
            responseHeaders[key] = value;
        }
        const contentType = response.headers.get('content-type');
        const parsed = parseResponseBody(text, contentType);

        if (options.failOnError === true && response.status >= 400) {
            throw new WorkflowError(
                `http 请求返回 ${response.status}: ${text.slice(0, 500)}`,
                'step',
                options.stepPath,
                { status: response.status, headers: responseHeaders },
            );
        }

        return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: parsed,
            url: currentUrl.toString(),
        };
    } finally {
        clearTimeout(timer);
        options.abortSignal.removeEventListener('abort', onParentAbort);
    }
}
