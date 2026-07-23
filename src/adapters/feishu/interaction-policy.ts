import type { InteractionPolicy } from "../../core/interaction-policy.js";
import {
  getMcpElicitationCardOptionValue,
  isApprovalDecisionIndexAllowed,
  isMcpElicitationCardDecisionAllowed,
  isMcpElicitationCardSkipAllowed,
  isPermissionApprovalCardDecisionAllowed,
} from "./card.js";

export const feishuInteractionPolicy: InteractionPolicy = {
  isApprovalDecisionAllowed: isApprovalDecisionIndexAllowed,
  isPermissionDecisionAllowed: isPermissionApprovalCardDecisionAllowed,
  getMcpOptionValue: getMcpElicitationCardOptionValue,
  isMcpSkipAllowed: isMcpElicitationCardSkipAllowed,
  isMcpDecisionAllowed: isMcpElicitationCardDecisionAllowed,
};
