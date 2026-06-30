#!/usr/bin/env node

import "dotenv/config";

import { runBridge } from "./bot/lark-bot.js";
import { loadConfig } from "./config/env.js";
import { ConsoleLogger } from "./util/logger.js";

const config = loadConfig(process.env);
const logger = new ConsoleLogger(config.logLevel);

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection", error);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  process.exitCode = 1;
});

await runBridge(config, logger);
