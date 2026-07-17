import fs from "node:fs/promises";
import path from "node:path";

import { lock } from "proper-lockfile";

// Automatic stale-lock reclamation has a check/remove race that can admit two
// bridge processes. Use an effectively non-expiring lease instead; normal
// exits are cleaned up by proper-lockfile, while hard-crash leftovers require
// explicit operator removal after confirming no bridge is running.
const staleLockMs = Number.MAX_SAFE_INTEGER;
const lockUpdateMs = 10_000;

export interface BridgeInstanceLock {
  lockPath: string;
  release(): Promise<void>;
}

export async function acquireBridgeInstanceLock(
  statePath: string,
  onCompromised?: (error: Error) => void,
): Promise<BridgeInstanceLock> {
  const resolvedStatePath = path.resolve(statePath);
  const directory = path.dirname(resolvedStatePath);
  const createdDirectory = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (createdDirectory) {
    await fs.chmod(directory, 0o700);
  }

  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lock(resolvedStatePath, {
      realpath: false,
      retries: 0,
      stale: staleLockMs,
      update: lockUpdateMs,
      ...(onCompromised ? { onCompromised } : {}),
    });
  } catch (error) {
    if (getErrorCode(error) === "ELOCKED") {
      throw new Error(
        [
          `Another Chat2Codex bridge is already using this state file, or a hard-crash lock remains: ${resolvedStatePath}`,
          `After confirming no Chat2Codex bridge is running, remove ${resolvedStatePath}.lock and start again.`,
        ].join("\n"),
        { cause: error },
      );
    }
    throw error;
  }

  let released = false;
  return {
    lockPath: `${resolvedStatePath}.lock`,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await releaseLock();
    },
  };
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
