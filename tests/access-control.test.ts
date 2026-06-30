import { describe, expect, test } from "bun:test";

import {
  decideAccess,
  normalizeChatType,
  type AccessContext,
} from "../src/bot/access-control.js";
import type { AccessControlConfig } from "../src/config/env.js";

const baseConfig: AccessControlConfig = {
  allowDirectMessages: true,
  allowGroups: false,
  allowedChatIds: [],
  allowedUserIds: [],
};

const baseContext: AccessContext = {
  chatId: "oc_chat",
  chatType: "direct",
  sender: { openId: "ou_user" },
};

describe("access control", () => {
  test("allows direct messages by default", () => {
    expect(decideAccess(baseConfig, baseContext)).toEqual({ allowed: true });
  });

  test("denies group messages unless group access and chat allowlist are both set", () => {
    expect(
      decideAccess(baseConfig, { ...baseContext, chatType: "group" }),
    ).toEqual({ allowed: false, reason: "groups_disabled" });

    expect(
      decideAccess(
        { ...baseConfig, allowGroups: true },
        { ...baseContext, chatType: "group", chatId: "oc_other" },
      ),
    ).toEqual({ allowed: false, reason: "chat_not_allowed" });

    expect(
      decideAccess(
        { ...baseConfig, allowGroups: true, allowedChatIds: ["oc_chat"] },
        { ...baseContext, chatType: "group" },
      ),
    ).toEqual({ allowed: true });
  });

  test("restricts by any known sender id when user allowlist is set", () => {
    expect(
      decideAccess(
        { ...baseConfig, allowedUserIds: ["on_union"] },
        { ...baseContext, sender: { unionId: "on_union" } },
      ),
    ).toEqual({ allowed: true });

    expect(
      decideAccess(
        { ...baseConfig, allowedUserIds: ["ou_allowed"] },
        { ...baseContext, sender: { openId: "ou_other" } },
      ),
    ).toEqual({ allowed: false, reason: "sender_not_allowed" });
  });

  test("normalizes Feishu chat type values", () => {
    expect(normalizeChatType("p2p")).toBe("direct");
    expect(normalizeChatType("group")).toBe("group");
    expect(normalizeChatType(undefined)).toBe("group");
  });
});
