/** Agent 的自定义工具（pi customTools）。send 是唯一的输出通道。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { Hub } from "../core/hub.ts";
import { validateSchedule } from "../core/plans.ts";
import { parseIsoInTz, fmtLocal } from "../core/time.ts";
import type { MemoryScope } from "../types.ts";
import { fmtGrouped, fmtMsg, poolLabel } from "./prompt.ts";

export interface ToolDeps { store: Store; hub: Hub; cfg: Config; now: () => number }

const txt = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

export function createTools(d: ToolDeps) {
  const send = defineTool({
    name: "send",
    label: "send",
    executionMode: "sequential",
    description: "向聊天池发一条消息（唯一会被用户看到的输出）。返回发送确认和这期间的新消息。",
    parameters: Type.Object({
      pool: Type.String({ description: "池别名，如 p1" }),
      content: Type.String({ description: "一条短消息；表情包写 [emoji:中文id]" }),
    }),
    async execute(_id, p) {
      const r = await d.hub.send(p.pool, p.content);
      if (!r.ok) return txt(`发送失败：${r.error}${r.newMessages.length ? `\n新消息：\n${fmtGrouped(d.store, r.newMessages)}` : ""}`, { ok: false });
      const unconfirmed = r.sentParts.filter((x) => !x.confirmed).length;
      const head = unconfirmed ? `已发送，但有 ${unconfirmed} 段暂未确认出现在聊天里` : "已发送并确认";
      const tail = r.newMessages.length ? `\n期间新消息：\n${fmtGrouped(d.store, r.newMessages)}` : "\n期间无新消息";
      return txt(head + tail, { ok: true, newCount: r.newMessages.length });
    },
  });

  const listPools = defineTool({
    name: "list_pools",
    label: "list_pools",
    executionMode: "sequential",
    description: "列出所有聊天池。",
    parameters: Type.Object({}),
    async execute() {
      const ps = d.store.listPools();
      return txt(ps.map((p) => `${poolLabel(d.store, p)} 最后消息 ${p.last_msg_at ? fmtLocal(p.last_msg_at) : "-"}`).join("\n") || "（没有池）");
    },
  });

  const readPool = defineTool({
    name: "read_pool",
    label: "read_pool",
    executionMode: "sequential",
    description: "读某个池的历史消息（不影响未读游标）。",
    parameters: Type.Object({
      pool: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      before_seq: Type.Optional(Type.Integer({ description: "只看此 #seq 之前" })),
    }),
    async execute(_id, p) {
      const pool = d.store.resolvePool(p.pool);
      if (!pool) return txt(`未知的池 ${p.pool}`);
      const msgs = d.store.recentMessages(pool.pool_id, p.limit ?? 15, p.before_seq ? p.before_seq - 1 : undefined);
      return txt(msgs.map((m) => fmtMsg(m)).join("\n") || "（无消息）");
    },
  });

  const planAdd = defineTool({
    name: "plan_add",
    label: "plan_add",
    executionMode: "sequential",
    description: "写一条计划。kind=once 时 when 为 ISO 时间（无时区按 Asia/Shanghai）；kind=cron 时 when 为 cron（分 时 日 月 周）；kind=none 为无时间的备忘。",
    parameters: Type.Object({
      title: Type.String(),
      content: Type.Optional(Type.String()),
      pool: Type.Optional(Type.String({ description: "相关池别名" })),
      kind: Type.Union([Type.Literal("once"), Type.Literal("cron"), Type.Literal("none")]),
      when: Type.Optional(Type.String()),
      expires: Type.Optional(Type.String({ description: "过期时间 ISO，可选" })),
    }),
    async execute(_id, p) {
      const now = d.now();
      const v = validateSchedule({ kind: p.kind, value: p.when }, now, d.cfg.timezone);
      if (!v.ok) return txt(`计划格式错误：${v.error}`, { ok: false });
      let expires: number | null = null;
      if (p.expires) {
        expires = parseIsoInTz(p.expires, d.cfg.timezone);
        if (expires === null) return txt("expires 不是合法 ISO 时间", { ok: false });
      }
      const pool = p.pool ? d.store.resolvePool(p.pool) : undefined;
      if (p.pool && !pool) return txt(`未知的池 ${p.pool}`, { ok: false });
      const plan = d.store.insertPlan({ title: p.title, content: p.content ?? "", pool_id: pool?.pool_id ?? null, schedule_kind: v.kind, schedule: v.schedule, expires_at: expires });
      return txt(`已记下计划#${plan.id}${v.firstFire ? `，下次触发 ${fmtLocal(v.firstFire)}` : ""}`, { ok: true, id: plan.id });
    },
  });

  const planUpdate = defineTool({
    name: "plan_update",
    label: "plan_update",
    executionMode: "sequential",
    description: "修改计划状态：done 完成 / cancelled 取消 / pending 待办。",
    parameters: Type.Object({ id: Type.Integer(), status: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("cancelled")]) }),
    async execute(_id, p) {
      return txt(d.store.setPlanStatus(p.id, p.status) ? `计划#${p.id} → ${p.status}` : `没有计划#${p.id}`);
    },
  });

  const planList = defineTool({
    name: "plan_list",
    label: "plan_list",
    executionMode: "sequential",
    description: "列出待办计划。",
    parameters: Type.Object({}),
    async execute() {
      const ps = d.store.listPlans("pending");
      return txt(ps.map((p) => `#${p.id}「${p.title}」${p.schedule_kind}${p.schedule ? ` ${p.schedule}` : ""}${p.pool_id ? ` ${d.store.poolAlias(p.pool_id)}` : ""}`).join("\n") || "（无待办计划）");
    },
  });

  const memoryAdd = defineTool({
    name: "memory_add",
    label: "memory_add",
    executionMode: "sequential",
    description: "按 user_id 记一条长期记忆/话题。scope：pool 仅来源池 / private 所有私聊 / group 所有群 / all 全部；默认按来源池类型。",
    parameters: Type.Object({
      user_id: Type.String(),
      content: Type.String(),
      source_pool: Type.String({ description: "信息来自哪个池" }),
      kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("topic")])),
      scope: Type.Optional(Type.Union([Type.Literal("pool"), Type.Literal("private"), Type.Literal("group"), Type.Literal("all")])),
    }),
    async execute(_id, p) {
      const pool = d.store.resolvePool(p.source_pool);
      if (!pool) return txt(`未知的池 ${p.source_pool}`, { ok: false });
      const scope: MemoryScope = p.scope ?? (pool.kind === "private" ? "private" : "group");
      const id = d.store.addMemory({ user_id: p.user_id, kind: p.kind, content: p.content, source_pool_id: pool.pool_id, source_kind: pool.kind, scope });
      return txt(`已记住#${id}（${scope}）`, { ok: true });
    },
  });

  const memorySearch = defineTool({
    name: "memory_search",
    label: "memory_search",
    executionMode: "sequential",
    description: "查某个 user_id 在指定池里可见的记忆。",
    parameters: Type.Object({ user_id: Type.String(), pool: Type.String() }),
    async execute(_id, p) {
      const pool = d.store.resolvePool(p.pool);
      if (!pool) return txt(`未知的池 ${p.pool}`);
      const ms = d.store.visibleMemories(p.user_id, pool, 20);
      return txt(ms.map((m: any) => `#${m.id}[${m.kind}] ${m.content}`).join("\n") || "（无）");
    },
  });

  return [send, listPools, readPool, planAdd, planUpdate, planList, memoryAdd, memorySearch];
}
