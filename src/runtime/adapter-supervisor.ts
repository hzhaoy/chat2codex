import type { ActionResponse } from "../core/actions.js";
import type {
  AdapterEventHandler,
  AdapterId,
  AttachmentRef,
  AttachmentStream,
  ChatAdapter,
  DeliveryOptions,
  DeliveryResult,
  InboundEvent,
  MessageReaction,
  MessageReactionHandle,
  MessageReactionRemovalResult,
  MessageReactionResult,
  MessageRef,
  ViewHandle,
  ViewTarget,
} from "../core/contracts.js";
import type { ChatView } from "../core/view-models.js";

export type AdapterHealth = "stopped" | "starting" | "ready" | "degraded" | "stopping";

export interface AdapterStatus {
  adapterId: AdapterId;
  platformKind: string;
  accountId: string;
  health: AdapterHealth;
  error?: string;
}

export interface AdapterSupervisorLogger {
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
}

const silentLogger: AdapterSupervisorLogger = {
  info() {},
  warn() {},
};

/** Owns adapter lifecycle and is the only runtime component that selects by adapterId. */
export class AdapterSupervisor {
  private readonly adapters = new Map<AdapterId, ChatAdapter>();
  private readonly statuses = new Map<AdapterId, AdapterStatus>();
  private started = false;
  private stopped = false;

  constructor(
    adapters: readonly ChatAdapter[],
    private readonly logger: AdapterSupervisorLogger = silentLogger,
  ) {
    for (const adapter of adapters) {
      const { adapterId, platformKind, accountId } = adapter.descriptor;
      if (this.adapters.has(adapterId)) {
        throw new Error(`Duplicate chat adapter id: ${adapterId}`);
      }
      this.adapters.set(adapterId, adapter);
      this.statuses.set(adapterId, {
        adapterId,
        platformKind,
        accountId,
        health: "stopped",
      });
    }
  }

  listStatuses(): AdapterStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }));
  }

  capabilities(adapterId: AdapterId): ChatAdapter["capabilities"] {
    return this.requireAdapter(adapterId).capabilities;
  }

  async start(handler: AdapterEventHandler): Promise<void> {
    if (this.started) {
      throw new Error("AdapterSupervisor has already been started.");
    }
    if (this.stopped) {
      throw new Error("AdapterSupervisor cannot restart after it has been stopped.");
    }
    this.started = true;

    const results = await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        const adapterId = adapter.descriptor.adapterId;
        this.setStatus(adapterId, "starting");
        try {
          await adapter.start((event) => this.dispatch(adapterId, event, handler));
          this.setStatus(adapterId, "ready");
          this.logger.info("Chat adapter ready", { adapterId });
        } catch (error) {
          const detail = errorMessage(error);
          this.setStatus(adapterId, "degraded", detail);
          await adapter.stop().catch(() => undefined);
          this.logger.warn("Chat adapter failed to start", { adapterId, error: detail });
          throw error;
        }
      }),
    );

    if (this.readyCount() === 0 && this.adapters.size > 0) {
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      throw new AggregateError(errors, "No chat adapter started successfully.");
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const adapters = [...this.adapters.values()].reverse();
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const adapterId = adapter.descriptor.adapterId;
        this.setStatus(adapterId, "stopping");
        try {
          await adapter.stop();
          this.setStatus(adapterId, "stopped");
        } catch (error) {
          this.setStatus(adapterId, "degraded", errorMessage(error));
          throw error;
        }
      }),
    );
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) {
      throw new AggregateError(errors, "One or more chat adapters failed to stop cleanly.");
    }
  }

  sendView(
    target: ViewTarget,
    view: ChatView,
    options?: DeliveryOptions,
  ): Promise<DeliveryResult> {
    return this.requireReadyAdapter(target.adapterId).sendView(target, view, options);
  }

  updateView(handle: ViewHandle, view: ChatView): Promise<DeliveryResult> {
    return this.requireReadyAdapter(handle.adapterId).updateView(handle, view);
  }

  addReaction(ref: MessageRef, reaction: MessageReaction): Promise<MessageReactionResult> {
    const adapter = this.requireReadyAdapter(ref.adapterId);
    if (!adapter.capabilities.messageReactions) {
      return Promise.resolve({
        status: "unsupported",
        reason: `Adapter ${ref.adapterId} does not support message reactions.`,
      });
    }
    return adapter.addReaction(ref, reaction);
  }

  removeReaction(handle: MessageReactionHandle): Promise<MessageReactionRemovalResult> {
    const adapter = this.requireReadyAdapter(handle.adapterId);
    if (!adapter.capabilities.messageReactions) {
      return Promise.resolve({
        status: "unsupported",
        reason: `Adapter ${handle.adapterId} does not support message reactions.`,
      });
    }
    return adapter.removeReaction(handle);
  }

  openAttachment(ref: AttachmentRef): Promise<AttachmentStream> {
    return this.requireReadyAdapter(ref.message.adapterId).openAttachment(ref);
  }

  private async dispatch(
    adapterId: AdapterId,
    event: InboundEvent,
    handler: AdapterEventHandler,
  ): Promise<ActionResponse | void> {
    if (eventAdapterId(event) !== adapterId) {
      throw new Error(
        `Adapter ${adapterId} emitted an event scoped to ${eventAdapterId(event)}.`,
      );
    }
    return handler(event);
  }

  private requireAdapter(adapterId: AdapterId): ChatAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`Unknown chat adapter: ${adapterId}`);
    }
    return adapter;
  }

  private requireReadyAdapter(adapterId: AdapterId): ChatAdapter {
    const adapter = this.requireAdapter(adapterId);
    if (this.statuses.get(adapterId)?.health !== "ready") {
      throw new Error(`Chat adapter is not ready: ${adapterId}`);
    }
    return adapter;
  }

  private readyCount(): number {
    return [...this.statuses.values()].filter((status) => status.health === "ready").length;
  }

  private setStatus(adapterId: AdapterId, health: AdapterHealth, error?: string): void {
    const current = this.statuses.get(adapterId);
    if (!current) {
      return;
    }
    this.statuses.set(adapterId, {
      ...current,
      health,
      ...(error ? { error } : { error: undefined }),
    });
  }
}

function eventAdapterId(event: InboundEvent): AdapterId {
  if (event.kind === "message") {
    return event.ref.adapterId;
  }
  return event.adapterId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
