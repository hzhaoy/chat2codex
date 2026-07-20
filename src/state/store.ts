import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type BridgeState,
  type DurableCodexJob,
  type DurableOutboxMessage,
  emptyState,
} from "./types.js";

const maxProcessedMessageIds = 500;
const maxRecentFailures = 5;
const saveQueues = new Map<string, Promise<void>>();

export interface JsonStateStoreOptions {
  jobRetentionCount?: number;
  outboxRetentionCount?: number;
}

export class JsonStateStore {
  private readonly jobRetentionCount: number;
  private readonly outboxRetentionCount: number;

  constructor(
    private readonly filePath: string,
    options: JsonStateStoreOptions = {},
  ) {
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
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      const state: BridgeState = {
        chats: parsed.chats ?? {},
        jobs: parsed.jobs ?? {},
        outbox: parsed.outbox ?? {},
        pendingMessages: parsed.pendingMessages ?? {},
        processedMessageIds: parsed.processedMessageIds ?? [],
        diagnostics: parsed.diagnostics ?? {},
      };
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
    const serializedState = `${JSON.stringify(state, null, 2)}\n`;
    const queueKey = path.resolve(this.filePath);
    const previousSave = saveQueues.get(queueKey) ?? Promise.resolve();
    const currentSave = previousSave.catch(() => undefined).then(async () => {
      const directory = path.dirname(this.filePath);
      const createdDirectory = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (createdDirectory) {
        await fs.chmod(directory, 0o700);
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
