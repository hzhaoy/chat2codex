import { describe, expect, test } from "bun:test";

import { buildMarkdownPost } from "../src/bot/lark-post.js";

describe("Lark markdown post messages", () => {
  test("wraps markdown in a post md element", () => {
    const post = buildMarkdownPost("## Result\n\n- item");

    expect(post).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: "## Result\n\n- item",
            },
          ],
        ],
      },
    });
  });
});
