import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

export type AttachmentStoreErrorCode =
  | "attachment_root_invalid"
  | "attachment_path_outside_root"
  | "attachment_path_not_regular"
  | "message_total_exceeded"
  | "store_total_exceeded"
  | "invalid_attachment_limit";

export class AttachmentStoreError extends Error {
  readonly name = "AttachmentStoreError";

  constructor(
    readonly code: AttachmentStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface EnforceAttachmentStoreLimitsInput {
  rootDir: string;
  downloadedPaths: readonly string[];
  retentionHours: number;
  messageMaxBytes: number;
  storeMaxBytes: number;
  nowMs?: number;
}

export interface AttachmentStoreUsage {
  messageBytes: number;
  storeBytes: number;
  removedExpiredFiles: number;
  removedExpiredBytes: number;
  skippedSymlinks: number;
}

interface StoreScanResult {
  storeBytes: number;
  removedExpiredFiles: number;
  removedExpiredBytes: number;
  skippedSymlinks: number;
}

const storeLockTails = new Map<string, Promise<void>>();

/**
 * Cleans expired files, validates a downloaded batch, and checks its per-message
 * and whole-store byte quotas while holding the root's in-process lock.
 */
export async function enforceAttachmentStoreLimits(
  input: EnforceAttachmentStoreLimitsInput,
): Promise<AttachmentStoreUsage> {
  validatePositiveLimit(input.retentionHours, "retentionHours");
  validatePositiveLimit(input.messageMaxBytes, "messageMaxBytes");
  validatePositiveLimit(input.storeMaxBytes, "storeMaxBytes");
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new AttachmentStoreError(
      "invalid_attachment_limit",
      "Attachment cleanup time must be a finite number.",
    );
  }

  return withAttachmentStoreLock(input.rootDir, async () => {
    const root = await ensureAttachmentRoot(input.rootDir);
    const cutoffMs = nowMs - input.retentionHours * 60 * 60 * 1_000;
    const scan = await scanAndCleanupStore(root, cutoffMs);
    const downloadedFiles = await validateDownloadedFiles(root, input.downloadedPaths);
    const messageBytes = downloadedFiles.reduce(
      (total, file) => safeAddBytes(total, file.size),
      0,
    );

    if (messageBytes > input.messageMaxBytes) {
      throw new AttachmentStoreError(
        "message_total_exceeded",
        `Downloaded attachments total ${messageBytes} bytes exceeds the configured ${input.messageMaxBytes}-byte per-message limit.`,
      );
    }
    if (scan.storeBytes > input.storeMaxBytes) {
      throw new AttachmentStoreError(
        "store_total_exceeded",
        `Attachment store uses ${scan.storeBytes} bytes after cleanup, exceeding the configured ${input.storeMaxBytes}-byte limit.`,
      );
    }

    return {
      messageBytes,
      storeBytes: scan.storeBytes,
      removedExpiredFiles: scan.removedExpiredFiles,
      removedExpiredBytes: scan.removedExpiredBytes,
      skippedSymlinks: scan.skippedSymlinks,
    };
  });
}

/**
 * Removes files created for the current message. Every parent directory is
 * canonicalized and checked before any unlink occurs, so an invalid group is
 * rejected without partially deleting its valid entries.
 */
export async function removeAttachmentFiles(
  rootDir: string,
  filePaths: readonly string[],
): Promise<number> {
  return withAttachmentStoreLock(rootDir, async () => {
    const root = await ensureAttachmentRoot(rootDir);
    const candidates = new Set<string>();
    for (const filePath of filePaths) {
      const candidate = await resolveContainedEntry(root, filePath, true);
      if (!candidate) {
        continue;
      }
      const stats = await lstatIfPresent(candidate);
      if (!stats) {
        continue;
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        throw new AttachmentStoreError(
          "attachment_path_not_regular",
          "Attachment cleanup refused to remove a directory.",
        );
      }
      candidates.add(candidate);
    }

    let removed = 0;
    for (const candidate of candidates) {
      try {
        await fs.unlink(candidate);
        removed += 1;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
    return removed;
  });
}

async function withAttachmentStoreLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(rootDir);
  const previous = storeLockTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  storeLockTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (storeLockTails.get(key) === tail) {
      storeLockTails.delete(key);
    }
  }
}

async function ensureAttachmentRoot(rootDir: string): Promise<string> {
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(rootDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AttachmentStoreError(
      "attachment_root_invalid",
      "Attachment store root must be a real directory, not a symbolic link.",
    );
  }
  await fs.chmod(rootDir, 0o700);
  return fs.realpath(rootDir);
}

async function scanAndCleanupStore(root: string, cutoffMs: number): Promise<StoreScanResult> {
  const result: StoreScanResult = {
    storeBytes: 0,
    removedExpiredFiles: 0,
    removedExpiredBytes: 0,
    skippedSymlinks: 0,
  };
  await scanDirectory(root, root, cutoffMs, result);
  return result;
}

async function scanDirectory(
  root: string,
  directory: string,
  cutoffMs: number,
  result: StoreScanResult,
): Promise<void> {
  for (const entry of await fs.readdir(directory)) {
    const entryPath = path.join(directory, entry);
    const stats = await lstatIfPresent(entryPath);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      result.skippedSymlinks += 1;
      continue;
    }
    if (stats.isDirectory()) {
      const resolvedDirectory = await realpathIfPresent(entryPath);
      if (!resolvedDirectory || !isPathInside(root, resolvedDirectory)) {
        continue;
      }
      await scanDirectory(root, resolvedDirectory, cutoffMs, result);
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    if (stats.mtimeMs <= cutoffMs) {
      try {
        await fs.unlink(entryPath);
        result.removedExpiredFiles += 1;
        result.removedExpiredBytes = safeAddBytes(result.removedExpiredBytes, stats.size);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      continue;
    }
    result.storeBytes = safeAddBytes(result.storeBytes, stats.size);
  }
}

async function validateDownloadedFiles(
  root: string,
  filePaths: readonly string[],
): Promise<Array<{ path: string; size: number }>> {
  const files = new Map<string, { path: string; size: number }>();
  for (const filePath of filePaths) {
    const candidate = await resolveContainedEntry(root, filePath, false);
    const stats = await lstatIfPresent(candidate);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw new AttachmentStoreError(
        "attachment_path_not_regular",
        "Downloaded attachment must be a non-symlink regular file inside the attachment store.",
      );
    }
    files.set(candidate, { path: candidate, size: stats.size });
  }
  return [...files.values()];
}

async function resolveContainedEntry(
  root: string,
  filePath: string,
  allowMissing: false,
): Promise<string>;
async function resolveContainedEntry(
  root: string,
  filePath: string,
  allowMissing: true,
): Promise<string | null>;
async function resolveContainedEntry(
  root: string,
  filePath: string,
  allowMissing: boolean,
): Promise<string | null> {
  const absolutePath = path.resolve(filePath);
  const resolvedParent = await realpathIfPresent(path.dirname(absolutePath));
  if (!resolvedParent) {
    if (allowMissing) {
      return null;
    }
    throw new AttachmentStoreError(
      "attachment_path_not_regular",
      "Downloaded attachment parent directory does not exist.",
    );
  }
  if (!isPathInside(root, resolvedParent) && resolvedParent !== root) {
    throw new AttachmentStoreError(
      "attachment_path_outside_root",
      "Attachment path is outside the configured attachment store.",
    );
  }

  const candidate = path.join(resolvedParent, path.basename(absolutePath));
  if (!isPathInside(root, candidate)) {
    throw new AttachmentStoreError(
      "attachment_path_outside_root",
      "Attachment path is outside the configured attachment store.",
    );
  }
  return candidate;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validatePositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AttachmentStoreError(
      "invalid_attachment_limit",
      `${name} must be a positive safe integer.`,
    );
  }
}

function safeAddBytes(total: number, size: number): number {
  if (!Number.isSafeInteger(size) || size < 0 || total > Number.MAX_SAFE_INTEGER - size) {
    return Number.MAX_SAFE_INTEGER;
  }
  return total + size;
}

async function lstatIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function realpathIfPresent(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
