import type { BridgeConfig } from "../config/env.js";
import type { JsonStateStore } from "../state/store.js";
import type { EventDiagnosticOutcome } from "../state/types.js";
import type { Logger } from "../util/logger.js";
import type { CardActionResponse, IncomingCardAction } from "./actions.js";
import {
  BridgeRunner,
  type ChatSender,
  type CodexClient,
  type IncomingEventDiagnostic,
  type IncomingTextMessage,
  type MessageRouterRuntimeControl,
} from "./bridge-runner.js";
import type { InteractionPolicy } from "./interaction-policy.js";

export * from "./bridge-runner.js";

/**
 * Thin ingress facade. It owns no execution state; BridgeRunner owns queueing,
 * persistence, approvals, and Codex lifecycle.
 */
export class MessageRouter {
  private readonly runner: BridgeRunner;

  constructor(
    config: BridgeConfig,
    store: JsonStateStore,
    sender: ChatSender,
    logger: Logger,
    codex: CodexClient,
    interactionPolicy: InteractionPolicy,
    runtimeControl: MessageRouterRuntimeControl = {},
  ) {
    this.runner = new BridgeRunner(
      config,
      store,
      sender,
      logger,
      codex,
      interactionPolicy,
      runtimeControl,
    );
  }

  start(): Promise<void> {
    return this.runner.start();
  }

  dispose(): Promise<void> {
    return this.runner.dispose();
  }

  accept(message: IncomingTextMessage): Promise<void> {
    return this.runner.accept(message);
  }

  recordEventDiagnostic(
    outcome: EventDiagnosticOutcome,
    diagnostic: IncomingEventDiagnostic,
  ): Promise<void> {
    return this.runner.recordEventDiagnostic(outcome, diagnostic);
  }

  enqueue(message: IncomingTextMessage): Promise<void> {
    return this.runner.enqueue(message);
  }

  handleCardAction(action: IncomingCardAction): Promise<CardActionResponse | undefined> {
    return this.runner.handleCardAction(action);
  }
}
