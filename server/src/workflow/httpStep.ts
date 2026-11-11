import { promises as dns } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

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
const PRIVATE_IPV6 = new net.BlockList();
for (const [address, prefix] of [
    ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7],
    ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) {
    PRIVATE_IPV6.addSubnet(address, prefix, 'ipv6');
}

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
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && b >= 18 && b <= 19) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
}

function isPrivateIpAddress(address: string): boolean {
    const version = net.isIP(address);
    if (version === 4) return isPrivateIpv4(address);
    if (version !== 6) return true;

    return PRIVATE_IPV6.check(address, 'ipv6');
}

async function resolveTarget(
    rawUrl: URL,
    allowPrivate: boolean,
    stepPath: string,
    signal: AbortSignal,
): Promise<LookupAddress[]> {
    if (rawUrl.protocol !== 'http:' && rawUrl.protocol !== 'https:') {
        throw new WorkflowError(`http 步骤仅支持 http/https: ${rawUrl.protocol}`, 'validation', stepPath);
    }
    if (rawUrl.username || rawUrl.password) {
        throw new WorkflowError('http 步骤不允许在 URL 中携带用户名/密码', 'validation', stepPath);
    }
    const hostname = rawUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) {
        throw new WorkflowError('http 步骤缺少 hostname', 'validation', stepPath);
    }
    if (!allowPrivate && (hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname.endsWith('.local')
        || hostname.endsWith('.internal'))) {
        throw new WorkflowError(`http 步骤默认禁止访问内网主机: ${hostname}`, 'validation', stepPath);
    }

    const family = net.isIP(hostname);
    if (family) {
        if (!allowPrivate && isPrivateIpAddress(hostname)) {
            throw new WorkflowError(`http 步骤默认禁止访问内网地址: ${hostname}`, 'validation', stepPath);
        }
        return [{ address: hostname, family }];
    }

    let addresses: LookupAddress[];
    try {
        if (signal.aborted) throw signal.reason;
        addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                reject(signal.reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            dns.lookup(hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => {
                signal.removeEventListener('abort', onAbort);
            });
        });
    } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        throw new WorkflowError(
            `http 步骤无法解析主机 ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
            'step',
            stepPath,
        );
    }
    if (addresses.length === 0) {
        throw new WorkflowError(`http 步骤无法解析主机: ${hostname}`, 'step', stepPath);
    }
    const privateAddress = !allowPrivate && addresses.find((entry) => isPrivateIpAddress(entry.address));
    if (privateAddress) {
        throw new WorkflowError(
            `http 步骤默认禁止访问内网地址: ${hostname} -> ${privateAddress.address}`,
            'validation',
            stepPath,
        );
    }
    return addresses;
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
    response: http.IncomingMessage,
    maxBytes: number,
    stepPath: string,
): Promise<string> {
    const encoding = response.headers['content-encoding']?.toLowerCase();
    const stream = !encoding || encoding === 'identity'
        ? response
        : encoding === 'gzip' ? response.pipe(createGunzip())
            : encoding === 'deflate' ? response.pipe(createInflate())
                : encoding === 'br' ? response.pipe(createBrotliDecompress())
                    : undefined;
    if (!stream) throw new WorkflowError(`http 响应编码不受支持: ${encoding}`, 'step', stepPath);
    if (stream !== response) response.once('error', (error) => stream.destroy(error));
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for await (const chunk of stream) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += value.byteLength;
        if (total > maxBytes) {
            response.destroy();
            throw new WorkflowError(`http 响应超过上限 ${maxBytes} bytes`, 'step', stepPath);
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

function parseResponseBody(text: string, contentType: string | undefined): unknown {
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

function requestOnce(
    url: URL,
    addresses: LookupAddress[],
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
): Promise<http.IncomingMessage> {
    const lookup: net.LookupFunction = (_hostname, options, callback) => {
        if (options.all) {
            callback(null, addresses);
            return;
        }
        const address = addresses.find((entry) => !options.family || entry.family === options.family) ?? addresses[0];
        callback(null, address.address, address.family);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const connectionOptions: Pick<net.TcpNetConnectOpts, 'autoSelectFamily'> = { autoSelectFamily: true };
    return new Promise((resolve, reject) => {
        const request = transport.request(url, {
            ...connectionOptions,
            method,
            headers,
            lookup,
            agent: false,
            signal,
        }, resolve);
        request.once('error', reject);
        request.end(body);
    });
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
        let response: http.IncomingMessage | undefined;
        let requestMethod = method;
        let requestBody = body;
        for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            try {
                const addresses = await resolveTarget(currentUrl, options.allowPrivate, options.stepPath, controller.signal);
                response = await requestOnce(currentUrl, addresses, requestMethod, headers, requestBody, controller.signal);
            } catch (error: unknown) {
                if (timedOut) {
                    throw new WorkflowTimeoutError(
                        `http 请求超时（>${timeoutMs}ms）`,
                        options.stepPath,
                    );
                }
                if (options.abortSignal.aborted) {
                    throw options.abortSignal.reason || new WorkflowCancelledError('Workflow cancelled', options.stepPath);
                }
                if (error instanceof WorkflowError) throw error;
                throw new WorkflowError(
                    `http 请求失败: ${error instanceof Error ? error.message : String(error)}`,
                    'step',
                    options.stepPath,
                    error,
                );
            }

            const location = response.headers.location;
            const status = response.statusCode ?? 0;
            if (![301, 302, 303, 307, 308].includes(status) || !location) break;
            if (redirect >= MAX_REDIRECTS) {
                throw new WorkflowError(`http 重定向超过 ${MAX_REDIRECTS} 次`, 'step', options.stepPath);
            }
            try {
                const nextUrl = new URL(location, currentUrl);
                if (nextUrl.origin !== currentUrl.origin) {
                    for (const header of Object.keys(headers)) {
                        if (/authorization|cookie|secret|token|key/i.test(header)) delete headers[header];
                    }
                }
                currentUrl = nextUrl;
            } catch {
                throw new WorkflowError(`http 重定向地址无效: ${location}`, 'step', options.stepPath);
            }
            if ((status === 303 && requestMethod !== 'GET' && requestMethod !== 'HEAD')
                || ((status === 301 || status === 302) && requestMethod === 'POST')) {
                requestMethod = 'GET';
                requestBody = undefined;
                delete headers['content-type'];
            }
            response.destroy();
        }

        if (!response) {
            throw new WorkflowError('http 请求未得到响应', 'step', options.stepPath);
        }

        const text = await (async () => {
            try {
                return await readLimitedBody(response!, options.maxResponseBytes, options.stepPath);
            } catch (error: unknown) {
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
                    `http 响应读取失败: ${error instanceof Error ? error.message : String(error)}`,
                    'step',
                    options.stepPath,
                    error,
                );
            }
        })();
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        const contentType = response.headers['content-type'];
        const parsed = parseResponseBody(text, contentType);

        const status = response.statusCode ?? 0;
        if (options.failOnError === true && status >= 400) {
            throw new WorkflowError(
                `http 请求返回 ${status}`,
                'step',
                options.stepPath,
                { status, headers: responseHeaders },
            );
        }

        return {
            status,
            statusText: response.statusMessage ?? '',
            headers: responseHeaders,
            body: parsed,
            url: currentUrl.toString(),
        };
    } finally {
        clearTimeout(timer);
        options.abortSignal.removeEventListener('abort', onParentAbort);
    }
}
