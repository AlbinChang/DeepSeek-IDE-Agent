import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DuckDbProcessClient } from '@/duckdb/DuckDbProcessClient.js';

const FAKE_WORKER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
send({ type: 'ready', protocolVersion: 1, pid: process.pid, node: process.version });
rl.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.type === 'cancel') return;
    switch (request.op) {
        case 'open': return send({ id: request.id, ok: true, result: { opened: true } });
        case 'ping': return send({ id: request.id, ok: true, result: { pong: true, pid: process.pid } });
        case 'query': return send({ id: request.id, ok: false, error: { code: 'DUCKDB_ERROR', message: 'boom' } });
        case 'checkpoint': process.exit(7);
        case 'schema': return; // 永不返回，用于超时测试
        default: return send({ id: request.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'unknown' } });
    }
});
`;

let tempRoot: string;
let entryPath: string;
let client: DuckDbProcessClient;

beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-ipc-test-'));
    await fs.mkdir(path.join(tempRoot, '.duckdb'), { recursive: true });
    entryPath = path.join(tempRoot, 'fakeWorker.cjs');
    await fs.writeFile(entryPath, FAKE_WORKER, 'utf8');
    client = new DuckDbProcessClient({
        entryPath,
        queryTimeoutMs: 5_000,
        idleTimeoutMs: 60_000,
        memoryLimitMb: 256,
        threads: 1,
    });
});

afterAll(async () => {
    await client.shutdownAll();
    await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('DuckDbProcessClient IPC', () => {
    it('spawns the worker and round-trips a ping', async () => {
        const result = await client.run(tempRoot, 'ping') as any;
        expect(result.pong).toBe(true);
        expect(typeof result.pid).toBe('number');
        expect(client.listSessions()).toHaveLength(1);
    });

    it('propagates worker errors with code and message', async () => {
        await expect(client.run(tempRoot, 'query', { sql: 'SELECT 1' }))
            .rejects.toMatchObject({ code: 'DUCKDB_ERROR', message: 'boom' });
    });

    it('times out a stuck request and keeps the worker usable', async () => {
        await expect(client.run(tempRoot, 'schema', {}, { timeoutMs: 300 }))
            .rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
        const result = await client.run(tempRoot, 'ping') as any;
        expect(result.pong).toBe(true);
    });

    it('rejects pending work when the worker exits and restarts on demand', async () => {
        await expect(client.run(tempRoot, 'checkpoint'))
            .rejects.toMatchObject({ code: 'WORKER_EXITED' });
        const result = await client.run(tempRoot, 'ping') as any;
        expect(result.pong).toBe(true);
    });
});

describe('DuckDbProcessClient idle recycle', () => {
    let idleRoot: string;
    let idleClient: DuckDbProcessClient;

    beforeAll(async () => {
        idleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-idle-test-'));
        await fs.mkdir(path.join(idleRoot, '.duckdb'), { recursive: true });
        idleClient = new DuckDbProcessClient({
            entryPath,
            queryTimeoutMs: 5_000,
            idleTimeoutMs: 250,
            memoryLimitMb: 256,
            threads: 1,
        });
    });

    afterAll(async () => {
        await idleClient.shutdownAll();
        await fs.rm(idleRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('keeps the worker alive while a long task holds the keep-alive lease', async () => {
        await idleClient.run(idleRoot, 'ping');
        const release = idleClient.acquireKeepAlive(idleRoot);
        expect(idleClient.describeIdlePolicy(idleRoot).keepAlive).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(idleClient.describeIdlePolicy(idleRoot).running).toBe(true);

        release();
        release(); // 重复释放不应把计数压成负数
        expect(idleClient.describeIdlePolicy(idleRoot).keepAlive).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(idleClient.describeIdlePolicy(idleRoot).running).toBe(false);
    }, 15_000);

    it('recycles the idle worker and can restart it afterwards', async () => {
        await idleClient.run(idleRoot, 'ping');
        expect(idleClient.describeIdlePolicy(idleRoot).running).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(idleClient.describeIdlePolicy(idleRoot).running).toBe(false);

        const result = await idleClient.run(idleRoot, 'ping') as any;
        expect(result.pong).toBe(true);
    }, 15_000);

    it('does not count idle recycle as a crash for the restart guard', async () => {
        // 反复 idle 回收 + 重启 6 次（> MAX_RESTARTS_IN_WINDOW），若回收被计为崩溃会触发暂停重启
        for (let index = 0; index < 6; index += 1) {
            await idleClient.run(idleRoot, 'ping');
            await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const result = await idleClient.run(idleRoot, 'ping') as any;
        expect(result.pong).toBe(true);
    }, 90_000);
});
