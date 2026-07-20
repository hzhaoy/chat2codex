import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { JsonStateStore } from "../src/state/store.js";

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
});
