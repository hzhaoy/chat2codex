import { createFeishuAdapter } from "../adapters/feishu/adapter.js";
import { feishuInteractionPolicy } from "../adapters/feishu/interaction-policy.js";
import { createWeixinAdapter } from "../adapters/weixin/adapter.js";
import type { BridgeConfig } from "../config/env.js";
import { textInteractionPolicy } from "../core/interaction-policy.js";
import type { Logger } from "../util/logger.js";
import type { PlatformAdapterBundle } from "./bridge-runtime.js";

/** Selects transport only; core runtime composition remains platform-neutral. */
export async function createPlatformAdapterBundle(
  config: BridgeConfig,
  logger: Logger,
): Promise<PlatformAdapterBundle> {
  if (config.chatAdapter === "weixin") {
    return {
      adapter: await createWeixinAdapter(config, logger),
      interactionPolicy: textInteractionPolicy,
    };
  }
  return {
    adapter: createFeishuAdapter(config, logger),
    interactionPolicy: feishuInteractionPolicy,
  };
}
