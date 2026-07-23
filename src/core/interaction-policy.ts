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
