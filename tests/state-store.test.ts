import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { JsonStateStore } from "../src/state/store.js";
import type {
  BridgeState,
  DurableCodexJob,
  DurableCodexJobStatus,
  DurableOutboxMessage,
  DurableOutboxStatus,
} from "../src/state/types.js";

describe("JsonStateStore", () => {
  test("loads empty state when no file exists and persists state atomically", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    try {
      const stateDirectory = path.join(tempDir, "nested");
      const store = new JsonStateStore(path.join(stateDirectory, "state.json"));
      expect(await store.load()).toEqual({
        chats: {},
        jobs: {},
        outbox: {},
        pendingMessages: {},
        processedMessageIds: [],
        diagnostics: {},
      });

      await store.save({
        chats: {
          oc_chat: {
            cwd: tempDir,
            updatedAt: "2026-06-29T00:00:00.000Z",
            threadId: "thread_1",
          },
        },
        jobs: {},
        outbox: {},
        pendingMessages: {},
        processedMessageIds: Array.from({ length: 510 }, (_, index) => `m${index}`),
        diagnostics: {
          lastEvent: {
            at: "2026-06-29T00:00:00.000Z",
            outcome: "routed",
            messageId: "m1",
            chatId: "oc_chat",
            chatType: "direct",
            messageType: "text",
            mentionCount: 0,
            startsWithMention: false,
            attachmentCount: 0,
            textLength: 5,
            botIdentityResolved: true,
          },
          recentFailures: Array.from({ length: 7 }, (_, index) => ({
            at: `2026-06-29T00:0${index}:00.000Z`,
            category: "unknown",
            cwd: tempDir,
            promptPreview: `prompt ${index}`,
            detail: `failure ${index}`,
          })),
        },
      });

      const loaded = await store.load();
      expect(loaded.chats.oc_chat?.threadId).toBe("thread_1");
      expect(loaded.processedMessageIds).toHaveLength(500);
      expect(loaded.processedMessageIds[0]).toBe("m10");
      expect(loaded.diagnostics.lastEvent?.messageId).toBe("m1");
      expect(loaded.diagnostics.recentFailures).toHaveLength(5);
      expect(loaded.diagnostics.recentFailures?.[0]?.detail).toBe("failure 2");
      expect(loaded.diagnostics.recentFailures?.at(-1)?.detail).toBe("failure 6");

      if (process.platform !== "win32") {
        expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(stateDirectory, "state.json"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not change permissions on an existing parent directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    const stateDirectory = path.join(tempDir, "existing");
    try {
      await mkdir(stateDirectory, { mode: 0o755 });
      await chmod(stateDirectory, 0o755);
      const store = new JsonStateStore(path.join(stateDirectory, "state.json"));
      await store.save({
        chats: {},
        jobs: {},
        outbox: {},
        pendingMessages: {},
        processedMessageIds: [],
        diagnostics: {},
      });

      if (process.platform !== "win32") {
        expect((await stat(stateDirectory)).mode & 0o777).toBe(0o755);
        expect((await stat(path.join(stateDirectory, "state.json"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("serializes concurrent saves targeting the same state file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    const statePath = path.join(tempDir, "nested", "state.json");
    try {
      const stores = [new JsonStateStore(statePath), new JsonStateStore(statePath)];
      const saves = Array.from({ length: 50 }, (_, index) =>
        stores[index % stores.length]!.save({
          chats: {
            oc_chat: {
              cwd: tempDir,
              updatedAt: `2026-06-29T00:00:${String(index).padStart(2, "0")}.000Z`,
              threadId: `thread_${index}`,
            },
          },
          jobs: {},
          outbox: {},
          pendingMessages: {},
          processedMessageIds: [`m${index}`],
          diagnostics: {},
        }),
      );

      await Promise.all(saves);

      const loaded = await stores[0]!.load();
      expect(loaded.chats.oc_chat?.threadId).toBe("thread_49");
      expect(loaded.processedMessageIds).toEqual(["m49"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("loads pre-outbox state with empty durable job collections", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    const statePath = path.join(tempDir, "state.json");
    try {
      await Bun.write(
        statePath,
        JSON.stringify({
          chats: {},
          pendingMessages: {},
          processedMessageIds: ["legacy"],
          diagnostics: {},
        }),
      );

      const loaded = await new JsonStateStore(statePath).load();
      expect(loaded.jobs).toEqual({});
      expect(loaded.outbox).toEqual({});
      expect(loaded.processedMessageIds).toEqual(["legacy"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("prunes the oldest terminal jobs and delivered outbox records to configured limits", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    const statePath = path.join(tempDir, "state.json");
    try {
      const store = new JsonStateStore(statePath, {
        jobRetentionCount: 3,
        outboxRetentionCount: 3,
      });
      const state = durableState(
        [
          durableJob("job_1", "completed", timestamp(1), ["outbox_1"]),
          durableJob("job_2", "failed", timestamp(2), ["outbox_2"]),
          durableJob("job_3", "completed", timestamp(3), ["outbox_3"]),
          durableJob("job_4", "queued", timestamp(4), ["outbox_4"]),
          durableJob("job_5", "running", timestamp(5), ["outbox_5"]),
        ],
        [
          durableOutbox("outbox_1", "job_1", "delivered", timestamp(1)),
          durableOutbox("outbox_2", "job_2", "delivered", timestamp(2)),
          durableOutbox("outbox_3", "job_3", "delivered", timestamp(3)),
          durableOutbox("outbox_4", "job_4", "pending", timestamp(4)),
          durableOutbox("outbox_5", "job_5", "sending", timestamp(5)),
        ],
      );

      await store.save(state);

      expect(Object.keys(state.jobs)).toEqual(["job_3", "job_4", "job_5"]);
      expect(Object.keys(state.outbox)).toEqual(["outbox_3", "outbox_4", "outbox_5"]);
      expect(state.jobs.job_3?.deliveryIds).toEqual(["outbox_3"]);
      expect(state.jobs.job_4?.status).toBe("queued");
      expect(state.jobs.job_5?.status).toBe("running");
      expect(state.outbox.outbox_4?.status).toBe("pending");
      expect(state.outbox.outbox_5?.status).toBe("sending");

      const loaded = await store.load();
      expect(Object.keys(loaded.jobs)).toEqual(["job_3", "job_4", "job_5"]);
      expect(Object.keys(loaded.outbox)).toEqual(["outbox_3", "outbox_4", "outbox_5"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps active records above the configured limits and protects their job references", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    const statePath = path.join(tempDir, "state.json");
    try {
      const store = new JsonStateStore(statePath, {
        jobRetentionCount: 0,
        outboxRetentionCount: 0,
      });
      const state = durableState(
        [
          durableJob("job_queued", "queued", timestamp(1), ["outbox_delivered"]),
          durableJob("job_running", "running", timestamp(2), ["outbox_sending"]),
          durableJob("job_blocked", "completed", timestamp(3), ["outbox_pending"]),
        ],
        [
          durableOutbox("outbox_delivered", "job_queued", "delivered", timestamp(1)),
          durableOutbox("outbox_sending", "job_running", "sending", timestamp(2)),
          durableOutbox("outbox_pending", "job_blocked", "pending", timestamp(3)),
        ],
      );

      await store.save(state);

      expect(Object.keys(state.jobs)).toEqual(["job_queued", "job_running", "job_blocked"]);
      expect(Object.keys(state.outbox)).toEqual(["outbox_sending", "outbox_pending"]);
      expect(state.jobs.job_queued?.deliveryIds).toEqual([]);
      expect(state.jobs.job_running?.deliveryIds).toEqual(["outbox_sending"]);
      expect(state.jobs.job_blocked?.deliveryIds).toEqual(["outbox_pending"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("normalizes durable references and applies retention again when loading after restart", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    const statePath = path.join(tempDir, "state.json");
    try {
      const writer = new JsonStateStore(statePath);
      const state = durableState(
        [
          durableJob("job_old", "completed", timestamp(1), ["missing", "outbox_new"]),
          durableJob("job_new", "completed", timestamp(2), []),
        ],
        [
          durableOutbox("outbox_old", "job_old", "delivered", timestamp(1)),
          durableOutbox("outbox_new", "job_new", "delivered", timestamp(2)),
        ],
      );
      await writer.save(state);
      expect(Object.keys((await writer.load()).jobs)).toEqual(["job_old", "job_new"]);

      const restartedStore = new JsonStateStore(statePath, {
        jobRetentionCount: 1,
        outboxRetentionCount: 10,
      });
      const loaded = await restartedStore.load();

      expect(Object.keys(loaded.jobs)).toEqual(["job_new"]);
      expect(Object.keys(loaded.outbox)).toEqual(["outbox_new"]);
      expect(loaded.jobs.job_new?.deliveryIds).toEqual(["outbox_new"]);
      expect(Object.values(loaded.outbox).every((message) => loaded.jobs[message.jobId])).toBe(true);

      await restartedStore.save(loaded);
      const reloaded = await restartedStore.load();
      expect(reloaded.jobs).toEqual(loaded.jobs);
      expect(reloaded.outbox).toEqual(loaded.outbox);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function durableState(
  jobs: DurableCodexJob[],
  outbox: DurableOutboxMessage[],
): BridgeState {
  return {
    chats: {},
    jobs: Object.fromEntries(jobs.map((job) => [job.id, job])),
    outbox: Object.fromEntries(outbox.map((message) => [message.id, message])),
    pendingMessages: {},
    processedMessageIds: [],
    diagnostics: {},
  };
}

function durableJob(
  id: string,
  status: DurableCodexJobStatus,
  at: string,
  deliveryIds: string[],
): DurableCodexJob {
  return {
    id,
    kind: "codex_run",
    messageId: `message_${id}`,
    chatId: "chat_1",
    chatType: "direct",
    cwd: "/repo",
    prompt: `prompt ${id}`,
    status,
    createdAt: at,
    updatedAt: at,
    completedAt: status === "queued" || status === "running" ? undefined : at,
    deliveryIds,
  };
}

function durableOutbox(
  id: string,
  jobId: string,
  status: DurableOutboxStatus,
  at: string,
): DurableOutboxMessage {
  return {
    id,
    jobId,
    chatId: "chat_1",
    kind: "text",
    text: `delivery ${id}`,
    sequence: 0,
    status,
    idempotencyKey: id,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    deliveredAt: status === "delivered" ? at : undefined,
  };
}

function timestamp(minute: number): string {
  return `2026-06-29T00:${String(minute).padStart(2, "0")}:00.000Z`;
}
