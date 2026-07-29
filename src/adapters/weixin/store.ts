import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  emptyWeixinRuntimeState,
  type WeixinCredentials,
  type WeixinRuntimeState,
} from "./types.js";

export async function loadWeixinCredentials(
  filePath: string,
): Promise<WeixinCredentials> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `Weixin credentials not found at ${filePath}; run chat2codex setup weixin first.`,
      );
    }
    throw error;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported Weixin credentials at ${filePath}.`);
  }
  const accountId = requiredString(parsed.accountId, "accountId");
  const token = requiredString(parsed.token, "token");
  const baseUrl = requiredHttpsUrl(parsed.baseUrl, "baseUrl");
  const savedAt = requiredString(parsed.savedAt, "savedAt");
  const userId =
    typeof parsed.userId === "string" && parsed.userId.trim()
      ? parsed.userId.trim()
      : undefined;
  return { schemaVersion: 1, accountId, token, baseUrl, userId, savedAt };
}

export async function saveWeixinCredentials(
  filePath: string,
  credentials: WeixinCredentials,
): Promise<void> {
  await writePrivateJsonAtomically(filePath, credentials);
}

export function weixinRuntimePath(credentialsPath: string): string {
  return path.join(path.dirname(credentialsPath), "runtime.json");
}

export async function loadWeixinRuntime(
  filePath: string,
): Promise<WeixinRuntimeState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) {
      return emptyWeixinRuntimeState();
    }
    throw error;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported Weixin runtime state at ${filePath}.`);
  }
  return {
    schemaVersion: 1,
    getUpdatesBuf:
      typeof parsed.getUpdatesBuf === "string" ? parsed.getUpdatesBuf : "",
    conversations: isRecord(parsed.conversations)
      ? (parsed.conversations as WeixinRuntimeState["conversations"])
      : {},
    attachments: isRecord(parsed.attachments)
      ? (parsed.attachments as WeixinRuntimeState["attachments"])
      : {},
  };
}

export async function saveWeixinRuntime(
  filePath: string,
  state: WeixinRuntimeState,
): Promise<void> {
  await writePrivateJsonAtomically(filePath, state);
}

export async function writePrivateJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid Weixin credential field: ${name}.`);
  }
  return value.trim();
}

function requiredHttpsUrl(value: unknown, name: string): string {
  const text = requiredString(value, name);
  const url = new URL(text);
  if (url.protocol !== "https:") {
    throw new Error(`Invalid Weixin credential field: ${name} must use https.`);
  }
  return url.toString().replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
