import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CodexProtocolManifest {
  codexVersion: string;
  generatedAt?: string;
  schemaFile?: string;
  schemaSha256?: string;
}

export async function readPackageVersion(): Promise<string> {
  const packageJson = await readJsonFile(path.join(packageRoot(), "package.json"));
  const version = packageJson.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("package.json does not contain a valid version.");
  }
  return version;
}

export async function readBundledProtocolManifest(
  filePath = protocolManifestPath(),
): Promise<CodexProtocolManifest> {
  const manifest = await readJsonFile(filePath);
  const codexVersion = manifest.codexVersion;
  if (typeof codexVersion !== "string" || codexVersion.trim().length === 0) {
    throw new Error("Bundled app-server protocol manifest does not contain codexVersion.");
  }
  return {
    codexVersion,
    ...(typeof manifest.generatedAt === "string" ? { generatedAt: manifest.generatedAt } : {}),
    ...(typeof manifest.schemaFile === "string" ? { schemaFile: manifest.schemaFile } : {}),
    ...(typeof manifest.schemaSha256 === "string" ? { schemaSha256: manifest.schemaSha256 } : {}),
  };
}

export function protocolManifestPath(): string {
  return path.join(packageRoot(), "docs", "codex-app-server-protocol", "manifest.json");
}

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} does not contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}
