import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConsoleLogger, truncateUtf8 } from "../src/util/logger.js";

describe("bounded logger", () => {
  test("truncates entries on UTF-8 boundaries and marks the result", () => {
    const truncated = truncateUtf8("日志".repeat(20), 24);

    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(24);
    expect(truncated).toEndWith("[truncated]");
    expect(truncated).not.toContain("�");
  });

  test("writes a bounded rotating file set", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-logger-"));
    const logPath = path.join(tempDir, "nested", "chat2codex.log");
    try {
      const logger = new ConsoleLogger("info", {
        filePath: logPath,
        maxEntryBytes: 200,
        maxFileBytes: 72,
        maxFiles: 3,
      });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, "old entry\n", { mode: 0o644 });
      await fs.writeFile(`${logPath}.7`, "stale backup");

      for (let index = 1; index <= 4; index += 1) {
        logger.info(`entry-${index}-${"x".repeat(100)}`);
      }

      const files = await Promise.all(
        [logPath, `${logPath}.1`, `${logPath}.2`].map(async (filePath) => ({
          content: await fs.readFile(filePath, "utf8"),
          size: (await fs.stat(filePath)).size,
        })),
      );
      expect(files[0]?.content).toContain("entry-4");
      expect(files[1]?.content).toContain("entry-3");
      expect(files[2]?.content).toContain("entry-2");
      expect(files.every((file) => file.size <= 72)).toBe(true);
      expect(files.every((file) => file.content.includes("[truncated]"))).toBe(true);
      expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
      await expect(fs.access(`${logPath}.3`)).rejects.toThrow();
      await expect(fs.access(`${logPath}.7`)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps only the active file when maxFiles is one", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-logger-one-"));
    const logPath = path.join(tempDir, "chat2codex.log");
    try {
      const logger = new ConsoleLogger("info", {
        filePath: logPath,
        maxEntryBytes: 100,
        maxFileBytes: 60,
        maxFiles: 1,
      });

      logger.info(`old-${"x".repeat(80)}`);
      logger.info(`new-${"y".repeat(80)}`);

      expect(await fs.readFile(logPath, "utf8")).toContain("new-");
      await expect(fs.access(`${logPath}.1`)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("redacts prompt and credential-shaped fields", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-logger-redact-"));
    const logPath = path.join(tempDir, "chat2codex.log");
    try {
      const logger = new ConsoleLogger("info", {
        filePath: logPath,
        maxEntryBytes: 4_096,
        maxFileBytes: 8_192,
        maxFiles: 2,
      });

      logger.warn("safe diagnostic", {
        appSecret: "never-write-this-secret",
        prompt: "never-write-this-prompt",
        safeField: "kept",
        nested: {
          accessToken: "never-write-this-token",
          aes_key: "never-write-this-aes-key",
          context_token: "never-write-this-context",
        },
      });

      const content = await fs.readFile(logPath, "utf8");
      expect(content).toContain("safeField: 'kept'");
      expect(content).toContain("[redacted]");
      expect(content).not.toContain("never-write-this");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
