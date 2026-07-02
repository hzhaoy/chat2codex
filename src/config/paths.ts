import os from "node:os";
import path from "node:path";

export function defaultChat2CodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CHAT2CODEX_HOME || path.join(os.homedir(), ".chat2codex"));
}

export function defaultEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CHAT2CODEX_ENV || path.join(defaultChat2CodexHome(env), ".env"));
}
