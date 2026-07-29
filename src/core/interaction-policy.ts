import type { CodexApprovalRequest } from "../agent/codex-runner.js";
import type {
  McpElicitationDecision,
  PermissionApprovalDecision,
} from "./actions.js";
import type {
  McpElicitationCardInput,
  PermissionApprovalCardInput,
} from "./view-models.js";

/**
 * Validates interactive choices against the exact information an adapter disclosed.
 * This keeps the runner platform-neutral while preventing forged callbacks.
 */
export interface InteractionPolicy {
  isApprovalDecisionAllowed(request: CodexApprovalRequest, decisionIndex: number): boolean;
  isPermissionDecisionAllowed(
    request: PermissionApprovalCardInput["request"],
    decision: PermissionApprovalDecision,
  ): boolean;
  getMcpOptionValue(
    input: McpElicitationCardInput,
    fieldId: string,
    optionIndex: number,
  ): string | boolean | undefined;
  isMcpSkipAllowed(input: McpElicitationCardInput, fieldId: string): boolean;
  isMcpDecisionAllowed(
    input: McpElicitationCardInput,
    decision: Exclude<McpElicitationDecision, "skip">,
  ): boolean;
}

/**
 * Platform-neutral policy for adapters that disclose interactive requests as
 * ordinary text. Decisions still resolve only through the original Codex
 * request, never through values supplied by chat.
 */
export const textInteractionPolicy: InteractionPolicy = {
  isApprovalDecisionAllowed(request, decisionIndex) {
    return (
      Number.isInteger(decisionIndex) &&
      decisionIndex >= 0 &&
      decisionIndex < request.decisions.length
    );
  },
  isPermissionDecisionAllowed(request, decision) {
    if (decision === "deny") {
      return true;
    }
    return Boolean(request.cwd.trim()) && hasPermissionDetails(request.permissions);
  },
  getMcpOptionValue(input, fieldId, optionIndex) {
    if (
      input.status !== "pending" ||
      input.request.mode !== "form" ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0
    ) {
      return undefined;
    }
    const answered = new Set(input.answeredFieldIds ?? []);
    const field = input.request.fields.find(
      (candidate) => !answered.has(candidate.name),
    );
    if (!field || field.name !== fieldId) {
      return undefined;
    }
    if (field.type === "boolean") {
      return optionIndex === 0 ? true : optionIndex === 1 ? false : undefined;
    }
    if (field.type !== "enum") {
      return undefined;
    }
    return field.options[optionIndex]?.value;
  },
  isMcpSkipAllowed(input, fieldId) {
    if (input.status !== "pending" || input.request.mode !== "form") {
      return false;
    }
    const answered = new Set(input.answeredFieldIds ?? []);
    const field = input.request.fields.find(
      (candidate) => !answered.has(candidate.name),
    );
    return Boolean(field && field.name === fieldId && !field.required);
  },
  isMcpDecisionAllowed(input, decision) {
    if (input.status !== "pending") {
      return false;
    }
    if (decision === "decline" || decision === "cancel") {
      return true;
    }
    if (input.request.mode === "url") {
      try {
        return new URL(input.request.url).protocol === "https:";
      } catch {
        return false;
      }
    }
    return input.request.fields.every(
      (field) => !field.required || (input.answeredFieldIds ?? []).includes(field.name),
    );
  },
};

function hasPermissionDetails(
  permissions: PermissionApprovalCardInput["request"]["permissions"],
): boolean {
  const fileSystem = permissions.fileSystem;
  return Boolean(
    permissions.network?.enabled !== undefined ||
      fileSystem?.entries?.length ||
      fileSystem?.read?.length ||
      fileSystem?.write?.length,
  );
}
