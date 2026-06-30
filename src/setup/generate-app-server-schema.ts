import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface GenerateOptions {
  codexBin: string;
  outDir: string;
}

const bundledSchemaFile = "codex_app_server_protocol.schemas.json";

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const outDir = path.resolve(options.outDir);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-app-server-schema-"));
  const generatorArgs = ["app-server", "generate-json-schema", "--experimental", "--out", tempDir];

  try {
    const codexVersion = commandOutput(options.codexBin, ["--version"]);
    const generated = spawnSync(options.codexBin, generatorArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (generated.status !== 0) {
      throw new Error(
        `Schema generation failed: ${generated.stderr || generated.stdout || "unknown error"}`,
      );
    }

    await fs.mkdir(outDir, { recursive: true });
    const source = path.join(tempDir, bundledSchemaFile);
    const target = path.join(outDir, bundledSchemaFile);
    const schema = await fs.readFile(source);
    await fs.writeFile(target, schema);

    const manifest = {
      generatedAt: new Date().toISOString(),
      codexVersion,
      command: `${options.codexBin} app-server generate-json-schema --experimental --out <temp-dir>`,
      schemaFile: bundledSchemaFile,
      schemaSha256: createHash("sha256").update(schema).digest("hex"),
      note: "Regenerate after Codex CLI upgrades and review the schema diff before changing app-server wiring.",
    };
    await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${target}`);
    console.log(`Wrote ${path.join(outDir, "manifest.json")}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): GenerateOptions {
  const options: GenerateOptions = {
    codexBin: process.env.CODEX_BIN || "codex",
    outDir:
      process.env.CODEX_APP_SERVER_SCHEMA_DIR ||
      path.join("docs", "codex-app-server-protocol"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--codex-bin") {
      options.codexBin = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--out") {
      options.outDir = requireValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: bun src/setup/generate-app-server-schema.ts [options]

Options:
  --codex-bin <path>  Codex executable (default: CODEX_BIN or codex)
  --out <dir>         output directory (default: docs/codex-app-server-protocol)
`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Failed to run ${command} ${args.join(" ")}: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}
