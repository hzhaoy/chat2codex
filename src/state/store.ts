import fs from "node:fs/promises";
import path from "node:path";

import { BridgeState, emptyState } from "./types.js";

const maxProcessedMessageIds = 500;

export class JsonStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      return {
        chats: parsed.chats ?? {},
        processedMessageIds: parsed.processedMessageIds ?? [],
        diagnostics: parsed.diagnostics ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) {
        return emptyState();
      }
      throw error;
    }
  }

  async save(state: BridgeState): Promise<void> {
    state.processedMessageIds = state.processedMessageIds.slice(-maxProcessedMessageIds);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(tempPath, this.filePath);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
