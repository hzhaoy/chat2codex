export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class ConsoleLogger implements Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, data?: unknown) {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown) {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown) {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown) {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data?: unknown) {
    if (order[level] < order[this.level]) {
      return;
    }
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    if (data === undefined) {
      console.error(line);
      return;
    }
    console.error(line, data);
  }
}
