import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { JsonStateStore } from "../src/state/store.js";

describe("JsonStateStore", () => {
  test("loads empty state when no file exists and persists state atomically", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-state-"));
    try {
      const store = new JsonStateStore(path.join(tempDir, "nested", "state.json"));
      expect(await store.load()).toEqual({ chats: {}, processedMessageIds: [], diagnostics: {} });

      await store.save({
        chats: {
          oc_chat: {
            cwd: tempDir,
            updatedAt: "2026-06-29T00:00:00.000Z",
            threadId: "thread_1",
          },
        },
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
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
