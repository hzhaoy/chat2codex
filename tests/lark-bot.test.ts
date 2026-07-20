import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { writeAttachmentResponseAtomicallyForTest } from "../src/bot/lark-bot.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Lark attachment downloads", () => {
  test("streams chunks to a private file and returns the byte count", async () => {
    const { root, directory, filePath } = await attachmentFixture();

    const byteCount = await writeAttachmentResponseAtomicallyForTest(
      {
        headers: { "content-length": "6" },
        getReadableStream: () =>
          Readable.from([Buffer.from("abc"), new Uint8Array([100, 101, 102])]),
      },
      root,
      filePath,
      6,
    );

    expect(byteCount).toBe(6);
    expect(await fs.readFile(filePath, "utf8")).toBe("abcdef");
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await partFiles(directory)).toEqual([]);
  });

  test("does not expose the target until the temporary stream is atomically renamed", async () => {
    const { root, directory, filePath } = await attachmentFixture();
    await fs.writeFile(filePath, "previous");
    const stream = new PassThrough();
    const download = writeAttachmentResponseAtomicallyForTest(
      {
        headers: {},
        getReadableStream: () => stream,
      },
      root,
      filePath,
      20,
    );

    await waitForPartFile(directory);
    stream.write("partial");
    await Bun.sleep(5);
    expect(await fs.readFile(filePath, "utf8")).toBe("previous");
    expect((await partFiles(directory)).length).toBe(1);

    stream.end("-done");
    await expect(download).resolves.toBe(12);
    expect(await fs.readFile(filePath, "utf8")).toBe("partial-done");
    expect(await partFiles(directory)).toEqual([]);
  });

  test("rejects an oversized Content-Length before consuming the stream and clears the target", async () => {
    const { root, directory, filePath } = await attachmentFixture();
    await fs.writeFile(filePath, "stale");
    let streamRequested = false;

    await expect(
      writeAttachmentResponseAtomicallyForTest(
        {
          headers: new Headers({ "Content-Length": "7" }),
          getReadableStream: () => {
            streamRequested = true;
            return Readable.from(["ignored"]);
          },
        },
        root,
        filePath,
        6,
      ),
    ).rejects.toThrow("6-byte per-file limit");

    expect(streamRequested).toBe(false);
    expect(await exists(filePath)).toBe(false);
    expect(await partFiles(directory)).toEqual([]);
  });

  test("enforces the byte limit while streaming and removes partial and target files", async () => {
    const { root, directory, filePath } = await attachmentFixture();
    await fs.writeFile(filePath, "stale");

    await expect(
      writeAttachmentResponseAtomicallyForTest(
        {
          headers: {},
          getReadableStream: () => Readable.from(["abc", "def"]),
        },
        root,
        filePath,
        5,
      ),
    ).rejects.toThrow("5-byte per-file limit");

    expect(await exists(filePath)).toBe(false);
    expect(await partFiles(directory)).toEqual([]);
  });

  test("cleans partial and target files when the source stream fails", async () => {
    const { root, directory, filePath } = await attachmentFixture();
    await fs.writeFile(filePath, "stale");
    const failingStream = Readable.from(
      (async function* () {
        yield Buffer.from("abc");
        throw new Error("download connection failed");
      })(),
    );

    await expect(
      writeAttachmentResponseAtomicallyForTest(
        {
          headers: {},
          getReadableStream: () => failingStream,
        },
        root,
        filePath,
        20,
      ),
    ).rejects.toThrow("download connection failed");

    expect(await exists(filePath)).toBe(false);
    expect(await partFiles(directory)).toEqual([]);
  });

  test("rejects targets outside the configured attachment directory", async () => {
    const { root } = await attachmentFixture();
    const outsidePath = path.join(root, "..", "outside.txt");
    await fs.writeFile(outsidePath, "keep");

    await expect(
      writeAttachmentResponseAtomicallyForTest(
        {
          headers: {},
          getReadableStream: () => Readable.from(["bad"]),
        },
        root,
        outsidePath,
        20,
      ),
    ).rejects.toThrow("escapes the configured download directory");

    expect(await fs.readFile(outsidePath, "utf8")).toBe("keep");
    await fs.rm(outsidePath, { force: true });
  });
});

async function attachmentFixture(): Promise<{
  root: string;
  directory: string;
  filePath: string;
}> {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-lark-attachment-"));
  tempDirectories.push(container);
  const root = path.join(container, "attachments");
  await fs.mkdir(root, { mode: 0o700 });
  const directory = path.join(root, "message-id");
  await fs.mkdir(directory, { mode: 0o700 });
  return {
    root,
    directory,
    filePath: path.join(directory, "report.txt"),
  };
}

async function partFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((entry) => entry.endsWith(".part"));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForPartFile(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await partFiles(directory)).length > 0) {
      return;
    }
    await Bun.sleep(2);
  }
  throw new Error("Attachment temporary file was not created in time.");
}
