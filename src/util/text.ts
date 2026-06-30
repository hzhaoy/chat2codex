export function extractTextContent(rawContent: string | undefined): string | null {
  if (!rawContent) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    if (typeof parsed.text !== "string") {
      return null;
    }
    return parsed.text.replace(/\s+$/u, "");
  } catch {
    return rawContent.trim();
  }
}

export function normalizeRoutedText(text: string): string {
  let remaining = text.trim();
  while (true) {
    const next = remaining
      .replace(/^<at\b[^>]*>.*?<\/at>\s*/isu, "")
      .replace(/^@\S+\s*/u, "")
      .trimStart();
    if (next === remaining) {
      return remaining;
    }
    remaining = next;
  }
}

export function splitForChat(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const breakpoint = Math.max(
      remaining.lastIndexOf("\n\n", maxLength),
      remaining.lastIndexOf("\n", maxLength),
      remaining.lastIndexOf("。", maxLength),
    );
    const end = breakpoint > maxLength * 0.5 ? breakpoint + 1 : maxLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
