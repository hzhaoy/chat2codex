import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  enforceAttachmentStoreLimits,
  removeAttachmentFiles,
} from "../src/bot/attachment-store.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("attachment store", () => {
  test("removes expired regular files before measuring store usage", async () => {
    const { root } = await storeFixture();
    const fresh = path.join(root, "message", "fresh.txt");
    const expired = path.join(root, "old", "expired.txt");
    await writeSizedFile(fresh, 4);
    await writeSizedFile(expired, 7);
    const nowMs = Date.UTC(2026, 6, 20, 0, 0, 0);
    await fs.utimes(expired, new Date(nowMs - 49 * 60 * 60 * 1_000), new Date(nowMs - 49 * 60 * 60 * 1_000));
    await fs.utimes(fresh, new Date(nowMs), new Date(nowMs));

    const usage = await enforceAttachmentStoreLimits({
      rootDir: root,
      downloadedPaths: [fresh],
      retentionHours: 24,
      messageMaxBytes: 10,
      storeMaxBytes: 10,
      nowMs,
    });

    expect(usage).toEqual({
      messageBytes: 4,
      storeBytes: 4,
      removedExpiredFiles: 1,
      removedExpiredBytes: 7,
      skippedSymlinks: 0,
    });
    expect(await exists(expired)).toBe(false);
    expect(await fs.readFile(fresh, "utf8")).toBe("xxxx");
  });

  test("does not follow file or directory symlinks while cleaning and measuring", async () => {
    const { container, root } = await storeFixture();
    const outsideDirectory = path.join(container, "outside");
    const outsideFile = path.join(outsideDirectory, "old.txt");
    const downloaded = path.join(root, "message", "downloaded.txt");
    await writeSizedFile(outsideFile, 50);
    await writeSizedFile(downloaded, 3);
    const nowMs = Date.UTC(2026, 6, 20, 0, 0, 0);
    await fs.utimes(outsideFile, new Date(0), new Date(0));
    await fs.utimes(downloaded, new Date(nowMs), new Date(nowMs));
    await fs.symlink(outsideDirectory, path.join(root, "linked-directory"));
    await fs.symlink(outsideFile, path.join(root, "linked-file"));

    const usage = await enforceAttachmentStoreLimits({
      rootDir: root,
      downloadedPaths: [downloaded],
      retentionHours: 1,
      messageMaxBytes: 10,
      storeMaxBytes: 10,
      nowMs,
    });

    expect(usage.storeBytes).toBe(3);
    expect(usage.removedExpiredFiles).toBe(0);
    expect(usage.skippedSymlinks).toBe(2);
    expect(await fs.readFile(outsideFile, "utf8")).toHaveLength(50);
  });

  test("rejects downloaded files outside the root and symlinks inside it", async () => {
    const { container, root } = await storeFixture();
    const inside = path.join(root, "message", "inside.txt");
    const outside = path.join(container, "outside.txt");
    const linked = path.join(root, "message", "linked.txt");
    await writeSizedFile(inside, 1);
    await writeSizedFile(outside, 1);
    await fs.symlink(outside, linked);

    await expect(
      enforceAttachmentStoreLimits({
        rootDir: root,
        downloadedPaths: [outside],
        retentionHours: 24,
        messageMaxBytes: 10,
        storeMaxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "attachment_path_outside_root" });

    await expect(
      enforceAttachmentStoreLimits({
        rootDir: root,
        downloadedPaths: [linked],
        retentionHours: 24,
        messageMaxBytes: 10,
        storeMaxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "attachment_path_not_regular" });
    expect(await fs.readFile(outside, "utf8")).toBe("x");
  });

  test("reports per-message and whole-store quota failures separately", async () => {
    const { root } = await storeFixture();
    const first = path.join(root, "message", "first.txt");
    const second = path.join(root, "message", "second.txt");
    const retained = path.join(root, "other", "retained.txt");
    await writeSizedFile(first, 4);
    await writeSizedFile(second, 3);
    await writeSizedFile(retained, 5);

    await expect(
      enforceAttachmentStoreLimits({
        rootDir: root,
        downloadedPaths: [first, second],
        retentionHours: 24,
        messageMaxBytes: 6,
        storeMaxBytes: 20,
      }),
    ).rejects.toMatchObject({ code: "message_total_exceeded" });

    await expect(
      enforceAttachmentStoreLimits({
        rootDir: root,
        downloadedPaths: [first],
        retentionHours: 24,
        messageMaxBytes: 10,
        storeMaxBytes: 11,
      }),
    ).rejects.toMatchObject({ code: "store_total_exceeded" });
  });

  test("validates an entire cleanup group before deleting any file", async () => {
    const { container, root } = await storeFixture();
    const inside = path.join(root, "message", "inside.txt");
    const outside = path.join(container, "outside.txt");
    await writeSizedFile(inside, 2);
    await writeSizedFile(outside, 3);

    await expect(removeAttachmentFiles(root, [inside, outside])).rejects.toMatchObject({
      code: "attachment_path_outside_root",
    });
    expect(await fs.readFile(inside, "utf8")).toBe("xx");
    expect(await fs.readFile(outside, "utf8")).toBe("xxx");

    await expect(removeAttachmentFiles(root, [inside])).resolves.toBe(1);
    expect(await exists(inside)).toBe(false);
  });

  test("unlinks an in-root symlink without touching its outside target", async () => {
    const { container, root } = await storeFixture();
    const outside = path.join(container, "outside.txt");
    const linked = path.join(root, "message", "linked.txt");
    await writeSizedFile(outside, 3);
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.symlink(outside, linked);

    await expect(removeAttachmentFiles(root, [linked])).resolves.toBe(1);
    expect(await exists(linked)).toBe(false);
    expect(await fs.readFile(outside, "utf8")).toBe("xxx");
  });
});

async function storeFixture(): Promise<{ container: string; root: string }> {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-attachment-store-"));
  tempDirectories.push(container);
  const root = path.join(container, "attachments");
  await fs.mkdir(root, { mode: 0o700 });
  return { container, root };
}

async function writeSizedFile(filePath: string, size: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "x".repeat(size));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
