import path from "node:path";
import { fileURLToPath } from "node:url";

import * as lark from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

import { defaultEnvPath } from "../config/paths.js";
import {
  mergeCsvValue,
  readExistingEnvValue,
  updateEnvFile,
} from "./env-file.js";

type LarkDomain = "feishu" | "lark";

interface BotProbeResult {
  botName?: string;
  botOpenId?: string;
}

interface FeishuSetupOptions {
  envFile: string;
  help: boolean;
  workdir: string;
}

if (isDirectRun()) {
  await runFeishuSetup(process.argv.slice(2));
}

export async function runFeishuSetup(argv: string[] = []): Promise<void> {
  const options = parseSetupArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const envPath = path.resolve(options.envFile);
  const workdir = path.resolve(options.workdir);
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  console.log("Chat2Codex Feishu/Lark setup");
  console.log("Scan the terminal QR code with Feishu/Lark to create and connect an app.");
  console.log();

  try {
    const result = await lark.registerApp({
      source: "chat2codex",
      createOnly: true,
      appPreset: {
        name: "Chat2Codex {user}",
        desc: "Run local Codex from Feishu/Lark chat.",
      },
      addons: {
        scopes: {
          tenant: ["im:message:send_as_bot", "im:message"],
        },
        events: {
          items: {
            tenant: ["im.message.receive_v1"],
          },
        },
        callbacks: {
          items: ["card.action.trigger"],
        },
      },
      signal: controller.signal,
      onQRCodeReady(info) {
        qrcode.generate(info.url, { small: true });
        console.log();
        console.log("Scan the QR code above to create and connect the Feishu/Lark app.");
        console.log(`Setup URL: ${info.url}`);
        console.log(`Expires in ${info.expireIn} seconds.`);
        console.log();
      },
      onStatusChange(info) {
        if (info.status === "domain_switched") {
          console.log("Detected a Lark tenant; switching registration domain...");
          return;
        }
        if (info.status === "slow_down") {
          console.log(`Feishu/Lark asked us to slow down polling to ${info.interval ?? "?"}s.`);
        }
      },
    });

    const domain = normalizeTenantBrand(result.user_info?.tenant_brand);
    const updates: Record<string, string> = {
      CHAT2CODEX_ADAPTER: "feishu",
      FEISHU_APP_ID: result.client_id,
      FEISHU_APP_SECRET: result.client_secret,
      LARK_DOMAIN: domain,
    };

    const existingWorkdir = await readExistingEnvValue(envPath, "CODEX_WORKDIR");
    if (!existingWorkdir || existingWorkdir === "/absolute/path/to/your/repo") {
      updates.CODEX_WORKDIR = workdir;
    }

    const setupUserOpenId = result.user_info?.open_id?.trim();
    if (setupUserOpenId) {
      const existingAllowedUsers = await readExistingEnvValue(envPath, "ALLOWED_USER_IDS");
      updates.ALLOWED_USER_IDS = mergeCsvValue(existingAllowedUsers, setupUserOpenId);
    }

    const bot = await probeBot(result.client_id, result.client_secret, domain);
    if (bot?.botOpenId) {
      updates.FEISHU_BOT_OPEN_ID = bot.botOpenId;
    }

    await updateEnvFile(envPath, updates);

    console.log(`Credentials saved to ${envPath}.`);
    if (bot) {
      console.log(`Connected as ${bot.botName ?? bot.botOpenId ?? "Feishu/Lark bot"}.`);
    } else {
      console.log("Saved credentials, but bot info probe did not return a bot identity.");
    }
    console.log();
    console.log("Next: chat2codex doctor");
    console.log("Then: chat2codex start");
  } catch (error) {
    const code = getErrorField(error, "code");
    const description = getErrorField(error, "description") ?? getErrorMessage(error);
    if (code === "abort") {
      console.error("Setup cancelled.");
    } else if (code) {
      console.error(`Setup failed: ${code}${description ? ` - ${description}` : ""}`);
    } else {
      console.error(`Setup failed: ${description}`);
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function parseSetupArgs(argv: string[]): FeishuSetupOptions {
  const options: FeishuSetupOptions = { envFile: defaultEnvPath(), help: false, workdir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--env" || arg === "--env-file") {
      options.envFile = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--workdir") {
      options.workdir = requireValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown setup argument: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: chat2codex setup [options]

Options:
  --env <path>       File to create or update (default: ~/.chat2codex/.env)
  --workdir <path>   CODEX_WORKDIR value (default: current directory)
`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function normalizeTenantBrand(value: unknown): LarkDomain {
  return value === "lark" ? "lark" : "feishu";
}

async function probeBot(
  appId: string,
  appSecret: string,
  domain: LarkDomain,
): Promise<BotProbeResult | null> {
  const baseUrl = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  try {
    const tokenResponse = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenPayload = (await tokenResponse.json()) as {
      tenant_access_token?: string;
    };
    if (!tokenPayload.tenant_access_token) {
      return null;
    }

    const botResponse = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
      headers: {
        Authorization: `Bearer ${tokenPayload.tenant_access_token}`,
        "Content-Type": "application/json",
      },
    });
    const botPayload = (await botResponse.json()) as {
      code?: number;
      bot?: { app_name?: string; bot_name?: string; open_id?: string };
      data?: { bot?: { app_name?: string; bot_name?: string; open_id?: string } };
    };
    if (botPayload.code !== 0) {
      return null;
    }
    const bot = botPayload.bot ?? botPayload.data?.bot;
    return {
      botName: bot?.app_name ?? bot?.bot_name,
      botOpenId: bot?.open_id,
    };
  } catch {
    return null;
  }
}

function getErrorField(error: unknown, field: "code" | "description"): string | null {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return null;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}
