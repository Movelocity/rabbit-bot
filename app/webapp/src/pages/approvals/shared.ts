import type { BadgeVariant } from "../../lib/format.ts";
import type { HostReadOutcome } from "../../lib/types.ts";

export const OUTCOME_LABEL: Record<HostReadOutcome, string> = {
  auto: "自动放行",
  approved: "审批通过",
  rejected: "审批拒绝",
  timeout: "审批超时",
  denied: "禁止读取",
  unavailable: "需审批但未开",
};

export const OUTCOME_VARIANT: Record<HostReadOutcome, BadgeVariant> = {
  auto: "default",
  approved: "done",
  rejected: "closed",
  timeout: "warn",
  denied: "closed",
  unavailable: "warn",
};

export const RULE_LABEL: Record<string, string> = {
  ext: "代码/文档类型",
  name: "常见文件名",
  template: "模板文件",
  dir: "白名单目录",
  secret: "疑似密钥",
  deny: "硬禁区",
  unknown: "未登记类型",
};

/**
 * 一个文件路径往上的候选目录（近 → 远），给「加白名单」选层级。
 * 不给根目录和家目录本身——后端也不收。
 */
export function ancestorDirs(filePath: string, max = 6): string[] {
  const segs = filePath.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = segs.length - 1; i >= 1 && out.length < max; i--) {
    const dir = "/" + segs.slice(0, i).join("/");
    // /Users/<name> 或 /home/<name> 这一层就是家目录
    if (/^\/(Users|home)\/[^/]+$/.test(dir)) break;
    out.push(dir);
  }
  return out;
}
