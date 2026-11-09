/** 审批面板只读格式化：补本地时间，供 API / Web 展示，不写库、不做裁决。 */
import type { Store } from "../core/db.ts";
import type { Approval, ApprovalFilter } from "../core/approvals.ts";
import { getApproval, listApprovals } from "../core/approvals.ts";
import { fmtLocal } from "../core/time.ts";

export function formatApproval(a: Approval) {
  return {
    ...a,
    created_at_local: fmtLocal(a.created_at),
    expires_at_local: fmtLocal(a.expires_at),
    decided_at_local: a.decided_at === null ? null : fmtLocal(a.decided_at),
  };
}

export function listApprovalViews(store: Store, filter: ApprovalFilter = {}) {
  return listApprovals(store, filter).map(formatApproval);
}

export function getApprovalView(store: Store, id: number) {
  const a = getApproval(store, id);
  return a ? formatApproval(a) : null;
}
