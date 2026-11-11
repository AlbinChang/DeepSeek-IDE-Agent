import * as http from 'node:http';
import { promises as dns } from 'node:dns';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkflowError, WorkflowTimeoutError } from '@/workflow/errors.js';
import { executeWorkflowHttp } from '@/workflow/httpStep.js';

let server: http.Server;
let redirectServer: http.Server;
let baseUrl: string;
let redirectBaseUrl: string;

function requestOptions(overrides: Partial<Parameters<typeof executeWorkflowHttp>[0]>) {
    return {
        allowPrivate: true,
        maxResponseBytes: 1024 * 1024,
        abortSignal: new AbortController().signal,
        stepPath: '/do/0/http',
        ...overrides,
    } as Parameters<typeof executeWorkflowHttp>[0];
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, method: req.method }));
            return;
        }
        if (req.url === '/echo') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
            });
            return;
        }
        if (req.url === '/redirect') {
            res.writeHead(302, { location: '/json' });
            res.end();
            return;
        }
        if (req.url === '/redirect-cross') {
            res.writeHead(302, { location: `${redirectBaseUrl}/headers` });
            res.end();
            return;
        }
        if (req.url === '/compressed') {
            res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
            res.end(gzipSync('x'.repeat(2048)));
            return;
        }
        if (req.url === '/large') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('x'.repeat(2048));
            return;
        }
        if (req.url === '/slow') {
            setTimeout(() => {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('late');
            }, 500);
            return;
        }
        if (req.url === '/slow-body') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('started');
            setTimeout(() => res.end('late'), 500);
            return;
        }
        if (req.url === '/error') {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('boom');
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    redirectServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ headers: req.headers, method: req.method }));
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    redirectBaseUrl = `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
});

describe('executeWorkflowHttp', () => {
    it('performs a JSON POST and parses the response', async () => {
        const result = await executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/echo`,
            method: 'POST',
            body: { hello: 'world' },
        }));
        expect(result.status).toBe(201);
        expect(result.body).toMatchObject({
            received: '{"hello":"world"}',
            contentType: 'application/json',
        });
    });

    it('blocks private addresses by default', async () => {
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/json`,
            allowPrivate: false,
        }))).rejects.toBeInstanceOf(WorkflowError);
        for (const address of ['[::1]', '[::ffff:127.0.0.1]', '192.0.2.1', '198.51.100.1']) {
            await expect(executeWorkflowHttp(requestOptions({
                url: `http://${address}/`,
                allowPrivate: false,
            }))).rejects.toThrow(/禁止访问内网地址/);
        }
    });

    it('follows redirects and validates the target', async () => {
        const result = await executeWorkflowHttp(requestOptions({ url: `${baseUrl}/redirect` }));
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ok: true });
    });

    it('does not forward credentials to a different redirect origin', async () => {
        const result = await executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/redirect-cross`,
            headers: {
                authorization: 'Bearer test-credential',
                cookie: 'session=test',
                'x-api-key': 'test-key',
                'x-custom': 'retained',
            },
        }));
        const body = result.body as { headers: Record<string, string> };
        expect(body.headers.authorization).toBeUndefined();
        expect(body.headers.cookie).toBeUndefined();
        expect(body.headers['x-api-key']).toBeUndefined();
        expect(body.headers['x-custom']).toBe('retained');
    });

    it('uses the validated DNS answer for the actual connection', async () => {
        const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([
            { address: '127.0.0.1', family: 4 },
        ] as never);
        try {
            const port = (server.address() as AddressInfo).port;
            const result = await executeWorkflowHttp(requestOptions({
                url: `http://rebinding-test.invalid:${port}/json`,
            }));
            expect(result.status).toBe(200);
            expect(lookup).toHaveBeenCalledTimes(1);
        } finally {
            lookup.mockRestore();
        }
    });

    it('applies the timeout while waiting for DNS resolution', async () => {
        const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => new Promise(() => {}));
        try {
            await expect(executeWorkflowHttp(requestOptions({
                url: 'http://slow-dns.invalid/',
                timeoutMs: 40,
            }))).rejects.toBeInstanceOf(WorkflowTimeoutError);
        } finally {
            lookup.mockRestore();
        }
    });

    it('enforces the response size cap', async () => {
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/large`,
            maxResponseBytes: 64,
        }))).rejects.toThrow(/响应超过上限/);
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/compressed`,
            maxResponseBytes: 64,
        }))).rejects.toThrow(/响应超过上限/);
    });

    it('fails on HTTP errors when failOnError is enabled', async () => {
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/error`,
            failOnError: true,
        }))).rejects.toThrow(/返回 500/);
    });

    it('times out slow requests', async () => {
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/slow`,
            timeoutMs: 50,
        }))).rejects.toBeInstanceOf(WorkflowTimeoutError);
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/slow-body`,
            timeoutMs: 50,
        }))).rejects.toBeInstanceOf(WorkflowTimeoutError);
    });
});
