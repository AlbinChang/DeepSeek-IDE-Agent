import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export type AgentStage = "主Agent" | "评估Agent";
export type LLMRequestStatus = "pending" | "completed" | "discarded";

export interface LLMRequestRecoveryContext {
    userInstruction?: string;
    pinnedUserMessage?: string;
    mainAgentFinalReply?: string;
}

export interface LLMRequestMetadata {
    requestIndex: number;
    userId: string;
    modelId: string;
    providerId?: string;
    agentStage: AgentStage;
    timestamp: number;
    crc32: string;
    traceId?: string;
    status: LLMRequestStatus;
    recoveryContext?: LLMRequestRecoveryContext;
}

export interface LLMRequestRecord {
    requestIndex: number;
    metadata: LLMRequestMetadata;
    payload: Record<string, any>;
}

interface RecordRequestOptions {
    root: string;
    userId: string;
    modelId: string;
    providerId?: string;
    agentStage: AgentStage;
    traceId?: string;
    recoveryContext?: LLMRequestRecoveryContext;
    payload: Record<string, any>;
    timestamp?: number;
}

interface StoredLLMRequestRecord extends LLMRequestRecord {
    rawPayload: string;
}

const MAX_REQUEST_FILES = 50;
const REQUEST_FILE_PATTERN = /^request-(\d+)\.json$/;
const VALID_STAGES = new Set<AgentStage>(["主Agent", "评估Agent"]);
const VALID_STATUSES = new Set<LLMRequestStatus>(["pending", "completed", "discarded"]);
const CRC_CHUNK_SIZE = 64 * 1024;
const crc32Table = new Uint32Array(256);

for (let index = 0; index < crc32Table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    crc32Table[index] = value >>> 0;
}

export function calculateCrc32(value: string | Buffer): string {
    let crc = 0xffffffff;
    const update = (bytes: Buffer) => {
        for (const byte of bytes) {
            crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
    };

    if (Buffer.isBuffer(value)) {
        update(value);
    } else {
        for (let offset = 0; offset < value.length;) {
            let end = Math.min(offset + CRC_CHUNK_SIZE, value.length);
            const lastCodeUnit = value.charCodeAt(end - 1);
            if (
                end < value.length
                && lastCodeUnit >= 0xd800
                && lastCodeUnit <= 0xdbff
            ) {
                end--;
            }
            update(Buffer.from(value.slice(offset, end), "utf8"));
            offset = end;
        }
    }

    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

export class LLMRequestJournal {
    private static instance: LLMRequestJournal;
    private readonly workspaceQueues = new Map<string, Promise<void>>();
    private readonly trackedDirectories = new Set<string>();
    private readonly nextRequestIndices = new Map<string, number>();

    public static getInstance(): LLMRequestJournal {
        if (!this.instance) {
            this.instance = new LLMRequestJournal();
        }
        return this.instance;
    }

    public trackWorkspace(root: string): void {
        this.trackedDirectories.add(this.getDirectory(root));
    }

    public async recordRequest(options: RecordRequestOptions): Promise<LLMRequestMetadata> {
        const directory = this.getDirectory(options.root);
        this.trackedDirectories.add(directory);

        return this.runExclusive(directory, async () => {
            await fs.mkdir(directory, { recursive: true });
            const sequenceKey = this.getQueueKey(directory);
            let requestIndex = this.nextRequestIndices.get(sequenceKey);
            if (requestIndex === undefined) {
                requestIndex = await this.restoreNextRequestIndex(directory);
            }
            const rawPayload = JSON.stringify(options.payload);
            if (!rawPayload) {
                throw new Error("LLM request payload cannot be serialized to JSON");
            }

            const metadata: LLMRequestMetadata = {
                requestIndex,
                userId: options.userId,
                modelId: options.modelId,
                providerId: options.providerId,
                agentStage: options.agentStage,
                timestamp: options.timestamp ?? Date.now(),
                crc32: calculateCrc32(rawPayload),
                traceId: options.traceId,
                status: "pending",
                recoveryContext: options.recoveryContext,
            };
            const filePath = path.join(directory, `request-${requestIndex}.json`);
            await this.writeRecordAtomically(filePath, metadata, rawPayload);
            this.nextRequestIndices.set(sequenceKey, requestIndex + 1);
            await this.pruneOldRequests(directory);

            return metadata;
        });
    }

    public async getPendingRecovery(root: string, userId: string): Promise<LLMRequestRecord | null> {
        const directory = this.getDirectory(root);
        this.trackedDirectories.add(directory);

        return this.runExclusive(directory, async () => {
            const stopFlagPath = path.join(directory, "stop-normal.flag");
            let normalShutdown = false;
            try {
                await fs.access(stopFlagPath);
                normalShutdown = true;
            } catch (error) {
                if (!isNodeError(error) || error.code !== "ENOENT") throw error;
            }

            await this.restoreNextRequestIndex(directory);

            if (normalShutdown) {
                await this.updateRequestStatuses(directory, () => true, "completed");
                await fs.unlink(stopFlagPath);
                return null;
            }

            await this.pruneOldRequests(directory);
            const files = (await this.listRequestFiles(directory))
                .sort((left, right) => right.requestIndex - left.requestIndex);
            for (const file of files) {
                const record = await this.readRecordFile(file.filePath, file.requestIndex);
                if (record && record.metadata.userId === userId) {
                    return record.metadata.status === "pending" ? this.toRequestRecord(record) : null;
                }
            }
            return null;
        });
    }

    public async readPendingRequest(root: string, userId: string, requestIndex: number): Promise<LLMRequestRecord> {
        const directory = this.getDirectory(root);
        this.trackedDirectories.add(directory);

        return this.runExclusive(directory, async () => {
            if (!Number.isSafeInteger(requestIndex) || requestIndex < 0) {
                throw new Error("Invalid LLM request index");
            }
            const filePath = path.join(directory, `request-${requestIndex}.json`);
            const record = await this.readRecordFile(filePath, requestIndex);
            if (!record || record.metadata.userId !== userId || record.metadata.status !== "pending") {
                throw new Error(`Pending LLM request ${requestIndex} was not found or is no longer recoverable`);
            }
            return this.toRequestRecord(record);
        });
    }

    public async findLatestPendingRequestForTrace(
        root: string,
        userId: string,
        traceId: string,
        agentStage: AgentStage,
    ): Promise<LLMRequestRecord | null> {
        const directory = this.getDirectory(root);
        this.trackedDirectories.add(directory);

        return this.runExclusive(directory, async () => {
            const files = (await this.listRequestFiles(directory))
                .sort((left, right) => right.requestIndex - left.requestIndex);
            for (const file of files) {
                const record = await this.readRecordFile(file.filePath, file.requestIndex);
                if (
                    record
                    && record.metadata.userId === userId
                    && record.metadata.traceId === traceId
                    && record.metadata.agentStage === agentStage
                    && record.metadata.status === "pending"
                ) {
                    return this.toRequestRecord(record);
                }
            }
            return null;
        });
    }

    public async discardRecovery(root: string, userId: string, requestIndex: number): Promise<void> {
        const directory = this.getDirectory(root);
        this.trackedDirectories.add(directory);

        await this.runExclusive(directory, async () => {
            if (!Number.isSafeInteger(requestIndex) || requestIndex < 0) {
                throw new Error("Invalid LLM request index");
            }
            const filePath = path.join(directory, `request-${requestIndex}.json`);
            const record = await this.readRecordFile(filePath, requestIndex, false);
            if (!record || record.metadata.userId !== userId || record.metadata.status !== "pending") {
                throw new Error(`Pending LLM request ${requestIndex} was not found or is no longer recoverable`);
            }

            await this.updateRequestStatuses(
                directory,
                (candidate) => candidate.metadata.userId === userId
                    && (record.metadata.traceId
                        ? candidate.metadata.traceId === record.metadata.traceId
                        : candidate.requestIndex === requestIndex),
                "discarded",
            );
        });
    }

    public async completeTrace(root: string, userId: string, traceId: string): Promise<void> {
        if (!traceId) return;
        const directory = this.getDirectory(root);
        this.trackedDirectories.add(directory);

        await this.runExclusive(directory, async () => {
            await this.updateRequestStatuses(
                directory,
                (record) => record.metadata.userId === userId && record.metadata.traceId === traceId,
                "completed",
            );
        });
    }

    public async discardPendingForUser(root: string, userId: string): Promise<void> {
        const directory = this.getDirectory(root);
        this.trackedDirectories.add(directory);

        await this.runExclusive(directory, async () => {
            await this.updateRequestStatuses(
                directory,
                (record) => record.metadata.userId === userId,
                "discarded",
            );
        });
    }

    public async markNormalShutdown(): Promise<void> {
        const directories = [...this.trackedDirectories];
        const failures: Error[] = [];

        for (const directory of directories) {
            try {
                await this.runExclusive(directory, async () => {
                    await fs.mkdir(directory, { recursive: true });
                    await fs.writeFile(
                        path.join(directory, "stop-normal.flag"),
                        `${new Date().toISOString()}\n`,
                        "utf8",
                    );
                });
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                console.error(`[LLMRequestJournal] Failed to mark normal shutdown in ${directory}:`, failure);
                failures.push(failure);
            }
        }

        if (failures.length > 0) {
            throw new AggregateError(failures, "Failed to mark one or more workspaces for normal shutdown");
        }
    }

    private getDirectory(root: string): string {
        if (typeof root !== "string" || !root.trim() || !path.isAbsolute(root)) {
            throw new Error("A valid absolute workspace path is required for LLM request recovery");
        }
        return path.join(path.resolve(root), ".llm-request");
    }

    private async restoreNextRequestIndex(directory: string): Promise<number> {
        const files = await this.listRequestFiles(directory);
        const latestIndex = files.reduce((max, file) => Math.max(max, file.requestIndex), -1);
        const sequenceKey = this.getQueueKey(directory);
        const nextIndex = Math.max(
            this.nextRequestIndices.get(sequenceKey) ?? 0,
            latestIndex + 1,
        );
        this.nextRequestIndices.set(sequenceKey, nextIndex);
        return nextIndex;
    }

    private getQueueKey(directory: string): string {
        return process.platform === "win32" ? directory.toLowerCase() : directory;
    }

    private async runExclusive<T>(directory: string, operation: () => Promise<T>): Promise<T> {
        const key = this.getQueueKey(directory);
        const previous = this.workspaceQueues.get(key) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        const settled = current.then(() => undefined, () => undefined);
        this.workspaceQueues.set(key, settled);

        try {
            return await current;
        } finally {
            if (this.workspaceQueues.get(key) === settled) {
                this.workspaceQueues.delete(key);
            }
        }
    }

    private async listRequestFiles(directory: string): Promise<Array<{ requestIndex: number; filePath: string }>> {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return [];
            throw error;
        }

        return entries.flatMap((entry) => {
            if (!entry.isFile()) return [];
            const match = REQUEST_FILE_PATTERN.exec(entry.name);
            if (!match) return [];
            const requestIndex = Number(match[1]);
            if (!Number.isSafeInteger(requestIndex)) return [];
            return [{ requestIndex, filePath: path.join(directory, entry.name) }];
        });
    }

    private async readRecordFile(
        filePath: string,
        expectedIndex: number,
        parsePayload = true,
    ): Promise<StoredLLMRequestRecord | null> {
        let contents: string;
        try {
            contents = await fs.readFile(filePath, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return null;
            throw error;
        }

        const separator = contents.indexOf("\n");
        if (separator < 0) {
            console.warn(`[LLMRequestJournal] Ignoring malformed request file: ${filePath}`);
            return null;
        }

        let parsedMetadata: Partial<LLMRequestMetadata>;
        try {
            parsedMetadata = JSON.parse(contents.slice(0, separator));
        } catch (error) {
            console.warn(`[LLMRequestJournal] Ignoring request with invalid metadata: ${filePath}`, error);
            return null;
        }

        const rawPayload = contents.slice(separator + 1);
        if (
            parsedMetadata.requestIndex !== expectedIndex
            || typeof parsedMetadata.userId !== "string"
            || typeof parsedMetadata.modelId !== "string"
            || !VALID_STAGES.has(parsedMetadata.agentStage as AgentStage)
            || !Number.isFinite(parsedMetadata.timestamp)
            || typeof parsedMetadata.crc32 !== "string"
            || calculateCrc32(rawPayload) !== parsedMetadata.crc32.toLowerCase()
        ) {
            console.warn(`[LLMRequestJournal] Ignoring request with invalid metadata or CRC: ${filePath}`);
            return null;
        }

        let payload: Record<string, any> = {};
        if (parsePayload) {
            try {
                payload = JSON.parse(rawPayload);
            } catch (error) {
                console.warn(`[LLMRequestJournal] Ignoring request with invalid JSON payload: ${filePath}`, error);
                return null;
            }
            if (
                !payload
                || typeof payload !== "object"
                || Array.isArray(payload)
                || !Array.isArray(payload.messages)
                || typeof payload.model !== "string"
                || payload.model !== parsedMetadata.modelId
                || payload.stream !== true
            ) {
                console.warn(`[LLMRequestJournal] Ignoring request without a valid streamed chat payload: ${filePath}`);
                return null;
            }
        }

        const status = VALID_STATUSES.has(parsedMetadata.status as LLMRequestStatus)
            ? parsedMetadata.status as LLMRequestStatus
            : "pending";
        const metadata: LLMRequestMetadata = {
            requestIndex: expectedIndex,
            userId: parsedMetadata.userId,
            modelId: parsedMetadata.modelId,
            providerId: parsedMetadata.providerId,
            agentStage: parsedMetadata.agentStage as AgentStage,
            timestamp: parsedMetadata.timestamp!,
            crc32: parsedMetadata.crc32,
            traceId: parsedMetadata.traceId,
            status,
            recoveryContext: parsedMetadata.recoveryContext,
        };
        return { requestIndex: expectedIndex, metadata, payload, rawPayload };
    }

    private async updateRequestStatuses(
        directory: string,
        matches: (record: LLMRequestRecord) => boolean,
        status: LLMRequestStatus,
    ): Promise<void> {
        const files = (await this.listRequestFiles(directory))
            .sort((left, right) => right.requestIndex - left.requestIndex);
        for (const file of files) {
            const record = await this.readRecordFile(file.filePath, file.requestIndex, false);
            if (!record || record.metadata.status !== "pending" || !matches(record)) continue;
            const metadata = { ...record.metadata, status };
            await this.writeRecordAtomically(file.filePath, metadata, record.rawPayload);
        }
    }

    private async pruneOldRequests(directory: string): Promise<void> {
        const files = (await this.listRequestFiles(directory))
            .sort((left, right) => left.requestIndex - right.requestIndex);
        const oldFiles = files.slice(0, Math.max(0, files.length - MAX_REQUEST_FILES));
        for (const file of oldFiles) {
            await fs.unlink(file.filePath);
        }
    }

    private toRequestRecord(record: StoredLLMRequestRecord): LLMRequestRecord {
        return {
            requestIndex: record.requestIndex,
            metadata: record.metadata,
            payload: record.payload,
        };
    }

    private async writeRecordAtomically(
        filePath: string,
        metadata: LLMRequestMetadata,
        rawPayload: string,
    ): Promise<void> {
        const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
        const handle = await fs.open(temporaryPath, "wx");
        let closed = false;
        try {
            await this.writeUtf8InChunks(handle, `${JSON.stringify(metadata)}\n`);
            await this.writeUtf8InChunks(handle, rawPayload);
            await handle.sync();
            await handle.close();
            closed = true;
            await fs.rename(temporaryPath, filePath);
        } catch (error) {
            if (!closed) {
                try {
                    await handle.close();
                } catch (closeError) {
                    console.error(`[LLMRequestJournal] Failed to close temporary file ${temporaryPath}:`, closeError);
                }
            }
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
                    console.error(`[LLMRequestJournal] Failed to clean up temporary file ${temporaryPath}:`, cleanupError);
                }
            }
            throw error;
        }
    }

    private async writeUtf8InChunks(handle: FileHandle, value: string): Promise<void> {
        for (let offset = 0; offset < value.length;) {
            let end = Math.min(offset + CRC_CHUNK_SIZE, value.length);
            const lastCodeUnit = value.charCodeAt(end - 1);
            if (
                end < value.length
                && lastCodeUnit >= 0xd800
                && lastCodeUnit <= 0xdbff
            ) {
                end--;
            }
            await handle.writeFile(value.slice(offset, end), "utf8");
            offset = end;
        }
    }

}
