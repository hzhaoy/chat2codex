import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { BridgeState, emptyState } from "./types.js";

const maxProcessedMessageIds = 500;
const maxRecentFailures = 5;
const saveQueues = new Map<string, Promise<void>>();

export class JsonStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      return {
        chats: parsed.chats ?? {},
        jobs: parsed.jobs ?? {},
        outbox: parsed.outbox ?? {},
        pendingMessages: parsed.pendingMessages ?? {},
        processedMessageIds: parsed.processedMessageIds ?? [],
        diagnostics: parsed.diagnostics ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) {
        return emptyState();
      }
      throw error;
    }
  }

  async save(state: BridgeState): Promise<void> {
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
