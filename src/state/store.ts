import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type BridgeState,
  type BridgeStateEnvelopeV2,
  type DurableCodexJob,
  type DurableOutboxMessage,
  bridgeStateSchemaVersion,
  createSessionEpoch,
  emptyState,
} from "./types.js";

const maxProcessedMessageIds = 500;
const maxRecentFailures = 5;
const saveQueues = new Map<string, Promise<void>>();

export interface JsonStateStoreOptions {
  adapterId?: string;
  jobRetentionCount?: number;
  outboxRetentionCount?: number;
}

export const defaultAdapterId = "feishu:default";

export class JsonStateStore {
  readonly adapterId: string;
  private readonly jobRetentionCount: number;
  private readonly outboxRetentionCount: number;

  constructor(
    private readonly filePath: string,
    options: JsonStateStoreOptions = {},
  ) {
    this.adapterId = normalizeAdapterId(options.adapterId ?? defaultAdapterId);
    this.jobRetentionCount = retentionCount(
      options.jobRetentionCount,
      "jobRetentionCount",
    );
    this.outboxRetentionCount = retentionCount(
      options.outboxRetentionCount,
      "outboxRetentionCount",
    );
  }

  async load(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const persisted = JSON.parse(raw) as unknown;
      assertSupportedSchema(persisted);
      const state = isBridgeStateEnvelopeV2(persisted)
        ? coerceBridgeState(persisted.adapters[this.adapterId])
        : coerceBridgeState(persisted);
      normalizeChatSessionEpochs(state);
      enforceDurableRetention(
        state,
        this.jobRetentionCount,
        this.outboxRetentionCount,
      );
      return state;
    } catch (error) {
      if (isNotFound(error)) {
        return emptyState();
      }
      throw error;
    }
  }

  async save(state: BridgeState): Promise<void> {
    normalizeChatSessionEpochs(state);
    enforceDurableRetention(
      state,
      this.jobRetentionCount,
      this.outboxRetentionCount,
    );
    state.processedMessageIds = state.processedMessageIds.slice(-maxProcessedMessageIds);
    if (state.diagnostics.recentFailures) {
      state.diagnostics.recentFailures = state.diagnostics.recentFailures.slice(-maxRecentFailures);
    }
    for (const diagnostics of Object.values(state.diagnostics.byChat ?? {})) {
      if (diagnostics.recentFailures) {
        diagnostics.recentFailures = diagnostics.recentFailures.slice(-maxRecentFailures);
      }
    }
    const queueKey = path.resolve(this.filePath);
    const previousSave = saveQueues.get(queueKey) ?? Promise.resolve();
    const currentSave = previousSave.catch(() => undefined).then(async () => {
      const directory = path.dirname(this.filePath);
      const createdDirectory = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (createdDirectory) {
        await fs.chmod(directory, 0o700);
      }

      const currentPersisted = await readPersistedState(this.filePath);
      assertSupportedSchema(currentPersisted);
      const migratedLegacy = currentPersisted !== null && !isBridgeStateEnvelopeV2(currentPersisted);
      const envelope: BridgeStateEnvelopeV2 = isBridgeStateEnvelopeV2(currentPersisted)
        ? currentPersisted
        : {
            schemaVersion: bridgeStateSchemaVersion,
            adapters: currentPersisted === null
              ? {}
              : { [this.adapterId]: coerceBridgeState(currentPersisted) },
          };
      envelope.adapters[this.adapterId] = state;
      const serializedState = `${JSON.stringify(envelope, null, 2)}\n`;

      if (migratedLegacy) {
        await preserveLegacyBackup(this.filePath);
      }

      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tempPath, serializedState, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await fs.rename(tempPath, this.filePath);
        await fs.chmod(this.filePath, 0o600);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });

    saveQueues.set(queueKey, currentSave);
    try {
      await currentSave;
    } finally {
      if (saveQueues.get(queueKey) === currentSave) {
        saveQueues.delete(queueKey);
      }
    }
  }
}

function normalizeAdapterId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f]/.test(normalized)) {
    throw new RangeError("adapterId must be a non-empty bounded string without control characters.");
  }
  return normalized;
}

function coerceBridgeState(value: unknown): BridgeState {
  const parsed = isRecord(value) ? value as Partial<BridgeState> : {};
  return {
    chats: parsed.chats ?? {},
    jobs: parsed.jobs ?? {},
    outbox: parsed.outbox ?? {},
    pendingMessages: parsed.pendingMessages ?? {},
    processedMessageIds: parsed.processedMessageIds ?? [],
    diagnostics: parsed.diagnostics ?? {},
  };
}

function isBridgeStateEnvelopeV2(value: unknown): value is BridgeStateEnvelopeV2 {
  return Boolean(
    isRecord(value) &&
      value.schemaVersion === bridgeStateSchemaVersion &&
      isRecord(value.adapters),
  );
}

function assertSupportedSchema(value: unknown): void {
  if (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "schemaVersion") &&
    !isBridgeStateEnvelopeV2(value)
  ) {
    throw new Error(`Unsupported bridge state schema version: ${String(value.schemaVersion)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPersistedState(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function preserveLegacyBackup(filePath: string): Promise<void> {
  const backupPath = `${filePath}.v0.6.bak`;
  try {
    await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(backupPath, 0o600);
  } catch (error) {
    if (isAlreadyExists(error)) {
      return;
    }
    throw error;
  }
}

function normalizeChatSessionEpochs(state: BridgeState): void {
  for (const session of Object.values(state.chats)) {
    if (
      typeof session.sessionEpoch !== "string" ||
      session.sessionEpoch.trim().length === 0
    ) {
      session.sessionEpoch = createSessionEpoch();
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function retentionCount(value: number | undefined, name: string): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function enforceDurableRetention(
  state: BridgeState,
  jobRetentionCount: number,
  outboxRetentionCount: number,
): void {
  normalizeDeliveryReferences(state);
  pruneDeliveredOutbox(state, outboxRetentionCount);
  pruneTerminalJobs(state, jobRetentionCount);
  normalizeDeliveryReferences(state);
}

function pruneDeliveredOutbox(state: BridgeState, retentionCount: number): void {
  const removalCount = Object.keys(state.outbox).length - retentionCount;
  if (removalCount <= 0) {
    return;
  }

  const candidates = Object.values(state.outbox)
    .filter((message) => message.status === "delivered")
    .sort(compareOutboxAge);
  for (const message of candidates.slice(0, removalCount)) {
    delete state.outbox[message.id];
  }
}

function pruneTerminalJobs(state: BridgeState, retentionCount: number): void {
  let jobCount = Object.keys(state.jobs).length;
  if (jobCount <= retentionCount) {
    return;
  }

  const jobsWithActiveOutbox = new Set(
    Object.values(state.outbox)
      .filter((message) => message.status !== "delivered")
      .map((message) => message.jobId),
  );
  const candidates = Object.values(state.jobs)
    .filter(
      (job) =>
        isTerminalJob(job) &&
        job.capacityNoticeActive !== true &&
        !jobsWithActiveOutbox.has(job.id),
    )
    .sort(compareJobAge);

  for (const job of candidates) {
    if (jobCount <= retentionCount) {
      break;
    }
    for (const message of Object.values(state.outbox)) {
      if (message.jobId === job.id && message.status === "delivered") {
        delete state.outbox[message.id];
      }
    }
    delete state.jobs[job.id];
    jobCount -= 1;
  }
}

function normalizeDeliveryReferences(state: BridgeState): void {
  const deliveriesByJob = new Map<string, DurableOutboxMessage[]>();
  for (const message of Object.values(state.outbox)) {
    if (!state.jobs[message.jobId]) {
      continue;
    }
    const deliveries = deliveriesByJob.get(message.jobId) ?? [];
    deliveries.push(message);
    deliveriesByJob.set(message.jobId, deliveries);
  }

  for (const job of Object.values(state.jobs)) {
    job.deliveryIds = (deliveriesByJob.get(job.id) ?? [])
      .sort(compareDeliverySequence)
      .map((message) => message.id);
  }
}

function isTerminalJob(job: DurableCodexJob): boolean {
  return (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "interrupted"
  );
}

function compareJobAge(left: DurableCodexJob, right: DurableCodexJob): number {
  return compareAge(
    left.completedAt ?? left.updatedAt ?? left.createdAt,
    left.id,
    right.completedAt ?? right.updatedAt ?? right.createdAt,
    right.id,
  );
}

function compareOutboxAge(
  left: DurableOutboxMessage,
  right: DurableOutboxMessage,
): number {
  return compareAge(
    left.deliveredAt ?? left.updatedAt ?? left.createdAt,
    left.id,
    right.deliveredAt ?? right.updatedAt ?? right.createdAt,
    right.id,
  );
}

function compareDeliverySequence(
  left: DurableOutboxMessage,
  right: DurableOutboxMessage,
): number {
  return (
    left.sequence - right.sequence ||
    compareAge(left.createdAt, left.id, right.createdAt, right.id)
  );
}

function compareAge(
  leftAt: string,
  leftId: string,
  rightAt: string,
  rightId: string,
): number {
  const leftTime = parsedTime(leftAt);
  const rightTime = parsedTime(rightAt);
  return leftTime - rightTime || leftId.localeCompare(rightId);
}

function parsedTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
