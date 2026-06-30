import fs from "node:fs/promises";
import path from "node:path";

import * as lark from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

type LarkDomain = "feishu" | "lark";

interface BotProbeResult {
  botName?: string;
  botOpenId?: string;
}

const envPath = path.resolve(".env");
const envExamplePath = path.resolve(".env.example");

const controller = new AbortController();
process.on("SIGINT", () => {
  controller.abort();
});

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
    FEISHU_APP_ID: result.client_id,
    FEISHU_APP_SECRET: result.client_secret,
    LARK_DOMAIN: domain,
  };

  const existingWorkdir = await readExistingEnvValue("CODEX_WORKDIR");
  if (!existingWorkdir || existingWorkdir === "/absolute/path/to/your/repo") {
    updates.CODEX_WORKDIR = process.cwd();
  }

  const bot = await probeBot(result.client_id, result.client_secret, domain);
  if (bot?.botOpenId) {
    updates.FEISHU_BOT_OPEN_ID = bot.botOpenId;
  }

  await updateEnvFile(envPath, updates);

  console.log("Credentials saved to .env.");
  if (bot) {
    console.log(`Connected as ${bot.botName ?? bot.botOpenId ?? "Feishu/Lark bot"}.`);
  } else {
    console.log("Saved credentials, but bot info probe did not return a bot identity.");
  }
  console.log();
  console.log("Next: bun run dev");
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
}

async function readExistingEnvValue(key: string): Promise<string | null> {
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

async function updateEnvFile(filePath: string, updates: Record<string, string>): Promise<void> {
  const original = await readBaseEnv();
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
  while (next.length > 0 && next[next.length - 1] === "") {
    next.pop();
  }
  if (append.length > 0 && next.length > 0) {
    next.push("");
  }
  next.push(...append);

  await fs.writeFile(filePath, `${next.join("\n")}\n`, { mode: 0o600 });
}

async function readBaseEnv(): Promise<string> {
  const existing = await fs.readFile(envPath, "utf8").catch(() => null);
  if (existing !== null) {
    return existing;
  }
  return (await fs.readFile(envExamplePath, "utf8").catch(() => "")).trimEnd();
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
  if (!match) {
    return null;
  }
  return { key: match[1], value: stripEnvQuotes(match[2]) };
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
  if (/[\s#"'\\]/u.test(value)) {
    return JSON.stringify(value);
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
