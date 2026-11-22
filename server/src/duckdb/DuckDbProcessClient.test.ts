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
