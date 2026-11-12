/**
 * 项目体检（PM 判定器）：把任务表算成「在轨 / 延期 / 卡住 / 未验」。
 *
 * 这里只做确定性判定，不调模型。理由：项目经理该给的是可复核的数字，
 * 而不是每次都重新想一遍的判断。解释和取舍交给上层（UFA/人）。
 */

export type PmLevel = "red" | "yellow";

export interface PmTaskRow {
  id: number;
  name: string;
  goal: string;
  acceptance: string;
  status: string;
  doc_path: string;
  result: string;
  artifact: string;
  note: string;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
  end_at: number | null;
}

export interface PmFinding {
  taskId: number;
  code: string;
  level: PmLevel;
  /** 一句话说清问题（能直接进汇报） */
  message: string;
  /** 建议动作（谁做什么） */
  action: string;
}

export interface PmAuditOptions {
  now: number;
  /** 静默多久算疑似卡住 */
  stallMs?: number;
  /** 多久没收口算超期 */
  overdueMs?: number;
}

export const DEFAULT_STALL_MS = 2 * 3600_000;
export const DEFAULT_OVERDUE_MS = 7 * 24 * 3600_000;

const ACTIVE = new Set(["pending", "running", "claimed", "queued"]);

/** 单个任务的体检。只对没结束的任务报问题，已结束的只在「有结论没落盘」时提示。 */
export function auditTask(t: PmTaskRow, opts: PmAuditOptions): PmFinding[] {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const overdueMs = opts.overdueMs ?? DEFAULT_OVERDUE_MS;
  const now = opts.now;
  const out: PmFinding[] = [];
  const active = ACTIVE.has(t.status);

  if (active) {
    if (!t.acceptance.trim()) {
      out.push({
        taskId: t.id,
        code: "no-acceptance",
        level: "red",
        message: `#${t.id} 没有验收标准就开工了（「${t.name || t.goal.slice(0, 20)}」）`,
        action: "补一句能被别人判定的验收句；补不出来就先停下来定验收",
      });
    }
    if (t.lease_until != null && t.lease_until > 0 && t.lease_until < now) {
      out.push({
        taskId: t.id,
        code: "lease-expired",
        level: "red",
        message: `#${t.id} 租约已过期（${new Date(t.lease_until).toLocaleString("zh-CN")}），执行进程失联`,
        action: "查 runner 是否还活着；死了就重派或标卡住",
      });
    }
    if (t.status === "running" && t.updated_at > 0 && now - t.updated_at > stallMs) {
      const h = Math.round((now - t.updated_at) / 3600_000);
      out.push({
        taskId: t.id,
        code: "stalled",
        level: "yellow",
        message: `#${t.id} 在跑但 ${h} 小时没有状态更新`,
        action: "问一句进度；答不上来就当作卡住，写清卡在哪",
      });
    }
    if (!t.doc_path.trim()) {
      out.push({
        taskId: t.id,
        code: "no-handoff-doc",
        level: "yellow",
        message: `#${t.id} 没有交接文档，接手的只能靠记忆`,
        action: "让执行方补任务文档：目标、验收、边界、已知的坑",
      });
    }
    if (t.created_at > 0 && now - t.created_at > overdueMs) {
      const d = Math.round((now - t.created_at) / 86400_000);
      out.push({
        taskId: t.id,
        code: "overdue",
        level: "red",
        message: `#${t.id} 开了 ${d} 天还没收口`,
        action: "要么给出新的预计完成时间，要么按停损条件砍掉——别让它挂着",
      });
    }
  }

  if (t.result.trim() && !t.artifact.trim()) {
    out.push({
      taskId: t.id,
      code: "no-artifact",
      level: "yellow",
      message: `#${t.id} 有结论但没有产出文件`,
      action: "把结果落盘到 shared/outputs/task-<id>/，汇报里给绝对路径",
    });
  }

  if (!active && t.status === "done" && !t.result.trim()) {
    out.push({
      taskId: t.id,
      code: "done-without-result",
      level: "yellow",
      message: `#${t.id} 标了 completed 但没写结果`,
      action: "补结果，或者把状态改回未验",
    });
  }

  return out;
}

export interface PmReport {
  findings: PmFinding[];
  red: number;
  yellow: number;
  /** 一句话结论，直接能贴进汇报 */
  headline: string;
}

export function auditTasks(rows: PmTaskRow[], opts: PmAuditOptions): PmReport {
  const findings = rows.flatMap((t) => auditTask(t, opts));
  const red = findings.filter((f) => f.level === "red").length;
  const yellow = findings.length - red;
  const active = rows.filter((t) => ACTIVE.has(t.status)).length;
  const headline =
    findings.length === 0
      ? `${active} 个在跑任务，无异常`
      : `${active} 个在跑任务，${red} 项红、${yellow} 项黄`;
  return { findings, red, yellow, headline };
}

/** 体检结果渲染成 markdown（给人看、或落盘当汇报依据） */
export function renderPmReport(report: PmReport, rows: PmTaskRow[], at: Date): string {
  const lines: string[] = [];
  lines.push(`# 项目体检 · ${at.toLocaleString("zh-CN")}`);
  lines.push("");
  lines.push(`结论：${report.headline}`);
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("无异常项。");
    lines.push("");
  } else {
    const order: PmLevel[] = ["red", "yellow"];
    for (const level of order) {
      const group = report.findings.filter((f) => f.level === level);
      if (group.length === 0) continue;
      lines.push(`## ${level === "red" ? "红（要处理）" : "黄（要盯）"}`);
      lines.push("");
      for (const f of group) lines.push(`- ${f.message} — ${f.action} \`${f.code}\``);
      lines.push("");
    }
  }
  lines.push("## 任务清单");
  lines.push("");
  if (rows.length === 0) lines.push("库里没有任务。");
  for (const t of rows) {
    const acc = t.acceptance.trim() ? "有验收" : "无验收";
    lines.push(
      `- #${t.id} ${t.status} · ${acc} · ${t.name || t.goal.slice(0, 24)}（更新 ${t.updated_at ? new Date(t.updated_at).toLocaleString("zh-CN") : "未知"}）`,
    );
  }
  return lines.join("\n") + "\n";
}
