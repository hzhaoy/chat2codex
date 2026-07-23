import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const workspaceRoot = path.resolve(import.meta.dir, "..");

describe("architecture boundaries", () => {
  test("core never imports platform adapters or Lark SDK modules", async () => {
    const files = await typescriptFiles(path.join(workspaceRoot, "src/core"));
    const violations: string[] = [];
    const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1]?.toLowerCase() ?? "";
        if (
          specifier.includes("/adapters/") ||
          specifier.includes("lark") ||
          specifier.includes("feishu") ||
          specifier.includes("@larksuite")
        ) {
          violations.push(`${path.relative(workspaceRoot, file)} -> ${match[1]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the core router receives a CodexClient instead of constructing CodexRunner", async () => {
    const routerSource = await readFile(
      path.join(workspaceRoot, "src/core/message-router.ts"),
      "utf8",
    );
    const runnerSource = await readFile(
      path.join(workspaceRoot, "src/core/bridge-runner.ts"),
      "utf8",
    );
    expect(`${routerSource}\n${runnerSource}`).not.toMatch(/new\s+CodexRunner\b/);
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptFiles(target);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  }));
  return nested.flat();
}
