import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowError, WorkflowTimeoutError } from '@/workflow/errors.js';
import { executeWorkflowHttp } from '@/workflow/httpStep.js';

let server: http.Server;
let baseUrl: string;

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
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    });

    it('follows redirects and validates the target', async () => {
        const result = await executeWorkflowHttp(requestOptions({ url: `${baseUrl}/redirect` }));
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ok: true });
    });

    it('enforces the response size cap', async () => {
        await expect(executeWorkflowHttp(requestOptions({
            url: `${baseUrl}/large`,
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
    });
});
