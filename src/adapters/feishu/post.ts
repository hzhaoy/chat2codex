export interface LarkMarkdownPost {
  zh_cn: {
    title?: string;
    content: Array<
      Array<{
        tag: "md";
        text: string;
      }>
    >;
  };
}

export function buildMarkdownPost(markdown: string): LarkMarkdownPost {
  return {
    zh_cn: {
      content: [
        [
          {
            tag: "md",
            text: markdown,
          },
        ],
      ],
    },
  };
}
