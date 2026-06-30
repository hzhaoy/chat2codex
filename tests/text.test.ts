import { describe, expect, test } from "bun:test";

import { extractTextContent, normalizeRoutedText, splitForChat } from "../src/util/text.js";

describe("text utilities", () => {
  test("extracts Feishu text payloads and tolerates plain text", () => {
    expect(extractTextContent('{"text":"hello   "}')).toBe("hello");
    expect(extractTextContent("plain text  ")).toBe("plain text");
    expect(extractTextContent('{"notText":"hello"}')).toBeNull();
  });

  test("splits long responses without exceeding the limit", () => {
    const chunks = splitForChat("hello\n\nworld\n\nagain", 8);
    expect(chunks).toEqual(["hello", "world", "again"]);
    expect(chunks.every((chunk) => chunk.length <= 8)).toBe(true);
  });

  test("removes leading Feishu bot mention tokens from routed group text", () => {
    expect(normalizeRoutedText("@_user_1 /whoami")).toBe("/whoami");
    expect(normalizeRoutedText('<at user_id="ou_bot">Chat2Codex</at> /status')).toBe("/status");
    expect(normalizeRoutedText("@_user_1 @_user_2 summarize")).toBe("summarize");
  });
});
