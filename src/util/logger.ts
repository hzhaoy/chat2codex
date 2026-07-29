import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface ConsoleLoggerOptions {
  filePath?: string;
  maxEntryBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const defaultMaxEntryBytes = 16 * 1024;
const defaultMaxFileBytes = 10 * 1024 * 1024;
const defaultMaxFiles = 3;
const truncationMarker = "[truncated]";
const sensitiveFieldPattern =
  /(aes.?key|authorization|cookie|credential|encryption.?key|password|prompt|secret|token)/iu;

export class ConsoleLogger implements Logger {
  private readonly fileSink: RotatingFileSink | undefined;
  private readonly maxEntryBytes: number;

  constructor(
    private readonly level: LogLevel,
    options: ConsoleLoggerOptions = {},
  ) {
    this.maxEntryBytes = requirePositiveInteger(
      options.maxEntryBytes ?? defaultMaxEntryBytes,
      "maxEntryBytes",
    );
    const filePath = options.filePath?.trim();
    if (filePath) {
      this.fileSink = new RotatingFileSink(
        filePath,
        requirePositiveInteger(options.maxFileBytes ?? defaultMaxFileBytes, "maxFileBytes"),
        requirePositiveInteger(options.maxFiles ?? defaultMaxFiles, "maxFiles"),
      );
    }
  }

  debug(message: string, data?: unknown) {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown) {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown) {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown) {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data?: unknown) {
    if (order[level] < order[this.level]) {
      return;
    }
    const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    const rendered = data === undefined ? prefix : `${prefix} ${formatLogData(data)}`;
    const line = truncateUtf8(rendered, this.maxEntryBytes);
    if (!this.fileSink) {
      console.error(line);
      return;
    }
    try {
      this.fileSink.write(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        truncateUtf8(`Chat2Codex file logger failed: ${detail}; ${line}`, this.maxEntryBytes),
      );
    }
  }
}

class RotatingFileSink {
  constructor(
    private readonly filePath: string,
    private readonly maxFileBytes: number,
    private readonly maxFiles: number,
  ) {}

  write(line: string): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneExcessBackups();
    const payload = this.buildPayload(line);
    const currentBytes = fileSize(this.filePath);
    if (currentBytes > 0 && currentBytes + payload.byteLength > this.maxFileBytes) {
      this.rotate();
    }
    fs.appendFileSync(this.filePath, payload, { mode: 0o600 });
    fs.chmodSync(this.filePath, 0o600);
  }

  private buildPayload(line: string): Buffer {
    if (this.maxFileBytes === 1) {
      return Buffer.from("\n");
    }
    return Buffer.from(`${truncateUtf8(line, this.maxFileBytes - 1)}\n`);
  }

  private rotate(): void {
    if (this.maxFiles === 1) {
      removeIfPresent(this.filePath);
      return;
    }

    removeIfPresent(`${this.filePath}.${this.maxFiles - 1}`);
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      renameIfPresent(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
    }
    renameIfPresent(this.filePath, `${this.filePath}.1`);
  }

  private pruneExcessBackups(): void {
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const index = Number(entry.slice(prefix.length));
      if (Number.isSafeInteger(index) && index >= this.maxFiles) {
        removeIfPresent(path.join(directory, entry));
      }
    }
  }
}

export function truncateUtf8(value: string, maxBytes: number): string {
  requirePositiveInteger(maxBytes, "maxBytes");
  if (Buffer.byteLength(value) <= maxBytes) {
    return value;
  }

  const markerBytes = Buffer.byteLength(truncationMarker);
  if (maxBytes <= markerBytes) {
    return utf8Prefix(truncationMarker, maxBytes);
  }
  const prefix = utf8Prefix(value, maxBytes - markerBytes - 1);
  return `${prefix} ${truncationMarker}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function formatLogData(data: unknown): string {
  try {
    return inspect(redactSensitiveFields(data), {
      breakLength: Infinity,
      compact: true,
      customInspect: false,
      depth: 4,
      maxArrayLength: 100,
      maxStringLength: 10_000,
    });
  } catch {
    return "[uninspectable]";
  }
}

function redactSensitiveFields(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof URL) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Error) {
    const safeError: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    seen.set(value, safeError);
    copySafeProperties(value, safeError, seen, new Set(["name", "message", "stack"]));
    return safeError;
  }
  if (Array.isArray(value)) {
    const safeArray: unknown[] = [];
    seen.set(value, safeArray);
    safeArray.push(...value.slice(0, 100).map((entry) => redactSensitiveFields(entry, seen)));
    return safeArray;
  }
  if (value instanceof Map) {
    const safeMap = new Map<unknown, unknown>();
    seen.set(value, safeMap);
    for (const [key, entry] of [...value.entries()].slice(0, 100)) {
      safeMap.set(
        redactSensitiveFields(key, seen),
        typeof key === "string" && sensitiveFieldPattern.test(key)
          ? "[redacted]"
          : redactSensitiveFields(entry, seen),
      );
    }
    return safeMap;
  }
  if (value instanceof Set) {
    const safeSet = new Set<unknown>();
    seen.set(value, safeSet);
    for (const entry of [...value.values()].slice(0, 100)) {
      safeSet.add(redactSensitiveFields(entry, seen));
    }
    return safeSet;
  }

  const safeRecord: Record<string, unknown> = {};
  seen.set(value, safeRecord);
  copySafeProperties(value, safeRecord, seen);
  return safeRecord;
}

function copySafeProperties(
  source: object,
  target: Record<string, unknown>,
  seen: WeakMap<object, unknown>,
  excluded = new Set<string>(),
): void {
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of Object.keys(descriptors).slice(0, 100)) {
    if (excluded.has(key)) {
      continue;
    }
    if (sensitiveFieldPattern.test(key)) {
      target[key] = "[redacted]";
      continue;
    }
    const descriptor = descriptors[key];
    target[key] = descriptor && "value" in descriptor
      ? redactSensitiveFields(descriptor.value, seen)
      : "[accessor]";
  }
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (isFileNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
