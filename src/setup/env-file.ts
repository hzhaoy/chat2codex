import fs from "node:fs/promises";
import path from "node:path";

import { packageRoot } from "../package-info.js";

export async function readExistingEnvValue(
  envPath: string,
  key: string,
): Promise<string | null> {
  const env = await fs.readFile(envPath, "utf8").catch(() => null);
  if (env === null) {
    return null;
  }
  for (const line of env.split(/\r?\n/u)) {
    const parsed = parseEnvLine(line);
    if (parsed?.key === key) {
      return parsed.value.trim() || null;
    }
  }
  return null;
}

export async function updateEnvFile(
  filePath: string,
  updates: Record<string, string>,
): Promise<void> {
  const original = await readBaseEnv(filePath);
  const lines = original.split(/\r?\n/u);
  const remaining = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed || !remaining.has(parsed.key)) {
      return line;
    }
    const value = remaining.get(parsed.key) ?? "";
    remaining.delete(parsed.key);
    return `${parsed.key}=${formatEnvValue(value)}`;
  });
  const append = Array.from(remaining.entries()).map(
    ([key, value]) => `${key}=${formatEnvValue(value)}`,
  );
  while (next.at(-1) === "") {
    next.pop();
  }
  if (append.length > 0 && next.length > 0) {
    next.push("");
  }
  next.push(...append);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${next.join("\n")}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

export function mergeCsvValue(existing: string | null, value: string): string {
  return [
    ...new Set(
      [...(existing ?? "").split(","), value]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].join(",");
}

async function readBaseEnv(envPath: string): Promise<string> {
  const existing = await fs.readFile(envPath, "utf8").catch(() => null);
  if (existing !== null) {
    return existing;
  }
  const localExample = await fs
    .readFile(path.resolve(".env.example"), "utf8")
    .catch(() => null);
  if (localExample !== null) {
    return localExample.trimEnd();
  }
  return (
    await fs
      .readFile(path.join(packageRoot(), ".env.example"), "utf8")
      .catch(() => "")
  ).trimEnd();
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
  return match
    ? { key: match[1]!, value: stripEnvQuotes(match[2]!) }
    : null;
}

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return value;
}

function formatEnvValue(value: string): string {
  return /[\s#"'\\]/u.test(value) ? JSON.stringify(value) : value;
}
