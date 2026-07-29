/*
 * QR login behavior is adapted from the MIT-licensed
 * @tencent-weixin/openclaw-weixin 2.4.6 implementation. See
 * THIRD_PARTY_NOTICES.md.
 */
import crypto from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import qrcode from "qrcode-terminal";

import {
  defaultChat2CodexHome,
  defaultEnvPath,
} from "../config/paths.js";
import {
  loadWeixinCredentials,
  saveWeixinCredentials,
} from "../adapters/weixin/store.js";
import type { WeixinCredentials } from "../adapters/weixin/types.js";
import {
  mergeCsvValue,
  readExistingEnvValue,
  updateEnvFile,
} from "./env-file.js";

const fixedQrBaseUrl = "https://ilinkai.weixin.qq.com";
const maxQrRefreshCount = 3;
const qrLoginTimeoutMs = 8 * 60 * 1_000;

interface WeixinSetupOptions {
  envFile: string;
  help: boolean;
  workdir: string;
}

interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

if (isDirectRun()) {
  await runWeixinSetup(process.argv.slice(2));
}

export async function runWeixinSetup(argv: string[] = []): Promise<void> {
  const options = parseWeixinSetupArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const envPath = path.resolve(options.envFile);
  const configuredCredentialsPath = await readExistingEnvValue(
    envPath,
    "WEIXIN_CREDENTIALS_PATH",
  );
  const credentialsPath = path.resolve(
    configuredCredentialsPath ||
      path.join(defaultChat2CodexHome(), "weixin", "credentials.json"),
  );
  const existingCredentials = await loadWeixinCredentials(credentialsPath).catch(
    () => undefined,
  );
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  console.log("Chat2Codex 微信 ClawBot setup");
  console.log("请使用个人微信扫描终端二维码。Token 只会写入权限为 0600 的凭据文件。");
  console.log();

  try {
    const result = await runQrLogin(
      existingCredentials ? [existingCredentials.token] : [],
      controller.signal,
    );
    const credentials =
      result.kind === "already_connected"
        ? requireExistingCredentials(existingCredentials)
        : {
            schemaVersion: 1 as const,
            accountId: result.accountId,
            token: result.token,
            baseUrl: result.baseUrl,
            userId: result.userId,
            savedAt: new Date().toISOString(),
          };
    if (result.kind === "confirmed") {
      await saveWeixinCredentials(credentialsPath, credentials);
    }

    const existingAllowedUsers = await readExistingEnvValue(
      envPath,
      "ALLOWED_USER_IDS",
    );
    const updates: Record<string, string> = {
      CHAT2CODEX_ADAPTER: "weixin",
      WEIXIN_CREDENTIALS_PATH: credentialsPath,
      CODEX_WORKDIR: path.resolve(options.workdir),
      ALLOW_DIRECT_MESSAGES: "true",
      ALLOW_GROUPS: "false",
    };
    if (credentials.userId) {
      updates.ALLOWED_USER_IDS = mergeCsvValue(
        existingAllowedUsers,
        credentials.userId,
      );
    }
    await updateEnvFile(envPath, updates);

    console.log();
    console.log(`微信凭据已保存到 ${credentialsPath}。`);
    console.log(`配置已写入 ${envPath}。`);
    console.log(`已绑定 ClawBot：${credentials.accountId}`);
    console.log("Next: chat2codex doctor");
    console.log("Then: chat2codex start");
  } catch (error) {
    console.error(
      controller.signal.aborted
        ? "Setup cancelled."
        : `Setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

type QrLoginResult =
  | {
      kind: "confirmed";
      accountId: string;
      token: string;
      baseUrl: string;
      userId: string;
    }
  | { kind: "already_connected" };

async function runQrLogin(
  localTokenList: string[],
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  hooks: {
    displayQr?: (url: string) => void;
    readVerifyCode?: (prompt: string, signal: AbortSignal) => Promise<string>;
    delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<QrLoginResult> {
  const showQr = hooks.displayQr ?? displayQr;
  const requestVerifyCode = hooks.readVerifyCode ?? readVerifyCode;
  const delay = hooks.delay ?? abortableDelay;
  let qr = await fetchQrCode(localTokenList.slice(0, 10), signal, fetchImpl);
  showQr(qr.qrcode_img_content);
  let currentBaseUrl = fixedQrBaseUrl;
  let verifyCode: string | undefined;
  let scanned = false;
  let refreshCount = 0;
  const deadline = Date.now() + qrLoginTimeoutMs;

  while (!signal.aborted && Date.now() < deadline) {
    const status = await fetchQrStatus(
      currentBaseUrl,
      qr.qrcode,
      verifyCode,
      signal,
      fetchImpl,
    );
    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        verifyCode = undefined;
        if (!scanned) {
          console.log("二维码已扫描，正在等待手机确认…");
          scanned = true;
        }
        break;
      case "need_verifycode":
        verifyCode = await requestVerifyCode(
          verifyCode
            ? "数字验证码不匹配，请重新输入："
            : "请输入手机微信显示的数字验证码：",
          signal,
        );
        continue;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          currentBaseUrl = normalizeRedirectHost(status.redirect_host);
          console.log("扫码请求已切换到微信指定的 IDC，继续等待确认…");
        }
        break;
      case "expired":
      case "verify_code_blocked":
        refreshCount += 1;
        if (refreshCount >= maxQrRefreshCount) {
          throw new Error(
            status.status === "expired"
              ? "二维码多次过期，请稍后重试。"
              : "数字验证码多次错误，请稍后重试。",
          );
        }
        console.log(
          status.status === "expired"
            ? "二维码已过期，正在刷新…"
            : "数字验证码尝试次数过多，正在刷新二维码…",
        );
        qr = await fetchQrCode(localTokenList.slice(0, 10), signal, fetchImpl);
        currentBaseUrl = fixedQrBaseUrl;
        verifyCode = undefined;
        scanned = false;
        showQr(qr.qrcode_img_content);
        break;
      case "binded_redirect":
        console.log("这个 ClawBot 已与当前本地凭据绑定，无需重复连接。");
        return { kind: "already_connected" };
      case "confirmed": {
        const accountId = status.ilink_bot_id?.trim();
        const token = status.bot_token?.trim();
        const userId = status.ilink_user_id?.trim();
        if (!accountId || !token || !userId) {
          throw new Error("微信确认成功，但响应缺少 Bot ID、Token 或用户 ID。");
        }
        const baseUrl = requireHttpsBaseUrl(status.baseurl || currentBaseUrl);
        console.log("微信确认成功。");
        return {
          kind: "confirmed",
          accountId,
          token,
          baseUrl,
          userId,
        };
      }
    }
    await delay(1_000, signal);
  }
  if (signal.aborted) {
    throw abortError();
  }
  throw new Error("等待微信扫码确认超时，请重新运行 setup weixin。");
}

async function fetchQrCode(
  localTokenList: string[],
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<QrCodeResponse> {
  const response = await fetchImpl(
    `${fixedQrBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      method: "POST",
      headers: ilinkHeaders(),
      body: JSON.stringify({ local_token_list: localTokenList }),
      signal,
    },
  );
  const body = await parseJsonResponse<QrCodeResponse>(response, "获取微信二维码");
  if (!body.qrcode?.trim() || !body.qrcode_img_content?.trim()) {
    throw new Error("微信二维码响应缺少必要字段。");
  }
  return body;
}

async function fetchQrStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<QrStatusResponse> {
  const url = new URL("ilink/bot/get_qrcode_status", trailingSlash(baseUrl));
  url.searchParams.set("qrcode", qrcode);
  if (verifyCode) {
    url.searchParams.set("verify_code", verifyCode);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(url, {
      headers: ilinkHeaders(),
      signal: controller.signal,
    });
    return await parseJsonResponse<QrStatusResponse>(response, "查询微信扫码状态");
  } catch (error) {
    if (signal.aborted) {
      throw abortError();
    }
    if (isAbortError(error)) {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

async function parseJsonResponse<T>(
  response: Response,
  label: string,
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label}失败：HTTP ${response.status}。`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}失败：响应不是有效 JSON。`);
  }
}

function displayQr(url: string): void {
  qrcode.generate(url, { small: true });
  console.log();
  console.log("请扫描上方二维码；如果终端无法显示，可打开下面的链接：");
  console.log(url);
  console.log();
}

async function readVerifyCode(prompt: string, signal: AbortSignal): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = (await readline.question(prompt, { signal })).trim();
    if (!/^\d+$/u.test(value)) {
      throw new Error("数字验证码只能包含数字。");
    }
    return value;
  } finally {
    readline.close();
  }
}

function ilinkHeaders(): Record<string, string> {
  const uin = crypto.randomBytes(4).readUInt32BE(0);
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(0x000700),
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
  };
}

function requireExistingCredentials(
  credentials: WeixinCredentials | undefined,
): WeixinCredentials {
  if (!credentials) {
    throw new Error(
      "微信报告已重复绑定，但本机没有可复用的凭据；请先解除旧绑定后重试。",
    );
  }
  return credentials;
}

function normalizeRedirectHost(host: string): string {
  const url = new URL(host.includes("://") ? host : `https://${host}`);
  if (url.protocol !== "https:") {
    throw new Error("微信 IDC 跳转地址必须使用 HTTPS。");
  }
  return url.origin;
}

function requireHttpsBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("微信 API Base URL 必须使用 HTTPS。");
  }
  return url.toString().replace(/\/$/u, "");
}

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseWeixinSetupArgs(argv: string[]): WeixinSetupOptions {
  const options: WeixinSetupOptions = {
    envFile: defaultEnvPath(),
    help: false,
    workdir: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--env" || arg === "--env-file") {
      options.envFile = requireValue(argv, ++index, arg);
    } else if (arg === "--workdir") {
      options.workdir = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown setup argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: chat2codex setup weixin [options]

Options:
  --env <path>       File to create or update (default: ~/.chat2codex/.env)
  --workdir <path>   CODEX_WORKDIR value (default: current directory)
`);
}

function isDirectRun(): boolean {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;
}

export const weixinSetupInternals = {
  fetchQrCode,
  fetchQrStatus,
  normalizeRedirectHost,
  requireHttpsBaseUrl,
  runQrLogin,
};
