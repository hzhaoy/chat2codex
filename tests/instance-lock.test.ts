import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { acquireBridgeInstanceLock } from "../src/state/instance-lock.js";

describe("bridge instance lock", () => {
  test("rejects a second live bridge and releases the state path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-lock-"));
    const statePath = path.join(tempDir, "runtime", "state.json");
    try {
      const first = await acquireBridgeInstanceLock(statePath);
      await expect(acquireBridgeInstanceLock(statePath)).rejects.toThrow(
        "Another Chat2Codex bridge is already using this state file",
      );
      await first.release();

      const second = await acquireBridgeInstanceLock(statePath);
      await second.release();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("releases the operating-system lock for the next bridge", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-lock-"));
    const statePath = path.join(tempDir, "state.json");
    try {
      const first = await acquireBridgeInstanceLock(statePath);
      expect(first.lockPath).toBe(`${path.resolve(statePath)}.lock`);
      await first.release();

      const second = await acquireBridgeInstanceLock(statePath);
      await second.release();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("never auto-reclaims an old lock under concurrent startup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-lock-"));
    const statePath = path.join(tempDir, "state.json");
    const lockPath = `${statePath}.lock`;
    try {
      await mkdir(lockPath);
      const staleAt = new Date(Date.now() - 60_000);
      await utimes(lockPath, staleAt, staleAt);

      const results = await Promise.allSettled([
        acquireBridgeInstanceLock(statePath),
        acquireBridgeInstanceLock(statePath),
      ]);
      expect(results.every((result) => result.status === "rejected")).toBe(true);

      await rm(lockPath, { recursive: true });
      const lock = await acquireBridgeInstanceLock(statePath);
      await lock.release();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
