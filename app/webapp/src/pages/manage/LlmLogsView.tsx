import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { formatTs, friendlyError, money, num } from "../../lib/format.ts";
import { cx } from "../../lib/cx.ts";
import type { LlmLogMessage, LlmSessionDetail, LlmSessionSummary } from "../../lib/types.ts";
import { Badge, Button, Empty, StatusText } from "../../components/ui.tsx";

const SESSION_PAGE = 30;
const MESSAGE_PAGE = 40;

const ROLE_LABEL: Record<string, string> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  toolResult: "tool",
};

function roleVariant(role: string): "default" | "info" | "done" | "warn" {
  if (role === "user") return "info";
  if (role === "assistant") return "done";
  if (role === "toolResult") return "warn";
  return "default";
}

function usageLine(m: LlmLogMessage): string {
  const u = m.usage;
  const bits: string[] = [];
  if (u?.totalTokens) bits.push(`${num(u.totalTokens)} tok`);
  if (u?.input) bits.push(`in ${num(u.input)}`);
  if (u?.output) bits.push(`out ${num(u.output)}`);
  if (u?.cacheRead) bits.push(`cache ${num(u.cacheRead)}`);
  if (u?.costUsd) bits.push(money(u.costUsd));
  if (m.duration_ms !== undefined) bits.push(`${num(m.duration_ms)}ms`);
  if (m.stop_reason) bits.push(m.stop_reason);
  return bits.join(" · ");
}

/** 长正文先折叠：系统提示词和工具输出动辄上万字，全展开会把页面撑爆。 */
function LongText({ text, initial = 1_800 }: { text: string; initial?: number }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  if (text.length <= initial) {
    return <div className="whitespace-pre-wrap wrap-anywhere text-[13px] leading-[1.75]">{text}</div>;
  }
  return (
    <div className="text-[13px] leading-[1.75]">
      <div className="whitespace-pre-wrap wrap-anywhere">{open ? text : `${text.slice(0, initial)}…`}</div>
      <button
        type="button"
        className="mt-1 text-xs text-accent hover:underline"
        onClick={() => setOpen((x) => !x)}
      >
        {open ? "收起" : `展开全部（${num(text.length)} 字）`}
      </button>
    </div>
  );
}

function ToolCallBlock({ call }: { call: NonNullable<LlmLogMessage["tool_calls"]>[number] }) {
  return (
    <div className="rounded-md border border-border bg-bg px-2.5 py-2">
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="font-semibold text-text">{call.name}</span>
        {call.id && <span className="truncate font-mono text-[10px] text-muted">{call.id}</span>}
      </div>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-normal text-muted">
        {call.args}{call.args_truncated ? "\n…（已截断）" : ""}
      </pre>
    </div>
  );
}

function MessageCard({ m }: { m: LlmLogMessage }) {
  const isSystem = m.role === "system";
  const meta = usageLine(m);
  const body = (
    <>
      {m.text && <LongText text={m.text} />}
      {!!m.tool_calls?.length && (
        <div className="mt-2 space-y-1.5">
          {m.tool_calls.map((c, i) => <ToolCallBlock key={`${c.id ?? c.name}-${i}`} call={c} />)}
        </div>
      )}
      {m.truncated && <div className="mt-1 text-[11px] text-muted">（原文过长，后端已截断）</div>}
    </>
  );
  return (
    <article className="rounded-[10px] border border-border bg-surface px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <Badge variant={roleVariant(m.role)}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
        {m.tool_name && <span className="font-mono">{m.tool_name}</span>}
        {m.is_error && <Badge variant="closed">error</Badge>}
        <span className="ml-auto tabular-nums">{formatTs(m.ts)}</span>
      </div>
      {meta && <div className="mb-1.5 text-[11px] text-muted [font-variant-numeric:tabular-nums]">{meta}</div>}
      {isSystem ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted">
            系统提示词（{num(m.text.length)} 字，点击展开）
          </summary>
          <div className="mt-1.5">{body}</div>
        </details>
      ) : body}
    </article>
  );
}

export function LlmLogsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [sessions, setSessions] = useState<LlmSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LlmSessionDetail | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const detailReq = useRef(0);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const rows = await request<LlmSessionSummary[]>(`/v1/llm-logs?limit=${SESSION_PAGE}`);
      setSessions(rows);
      setStatus({ text: "" });
      setSelected((prev) => (prev && rows.some((x) => x.id === prev) ? prev : rows[0]?.id ?? null));
    } catch (e) {
      setStatus({ text: `读取模型日志失败：${friendlyError(e)}`, error: true });
    } finally {
      setSessionsLoading(false);
    }
  }, [request]);

  const loadDetail = useCallback(async (id: string, before?: number, append = false) => {
    const req = ++detailReq.current;
    if (append) setOlderLoading(true);
    else setDetailLoading(true);
    try {
      const q = new URLSearchParams({ limit: String(MESSAGE_PAGE) });
      if (before !== undefined) q.set("before", String(before));
      const data = await request<LlmSessionDetail>(`/v1/llm-logs/${encodeURIComponent(id)}?${q}`);
      if (req !== detailReq.current) return;
      setDetail((prev) => {
        if (!append || !prev || prev.id !== data.id) return data;
        return {
          ...data,
          messages: [...data.messages, ...prev.messages],
          next_before: data.messages.length ? data.next_before : prev.next_before,
        };
      });
      setStatus({ text: "" });
    } catch (e) {
      if (req === detailReq.current) setStatus({ text: `读取会话失败：${friendlyError(e)}`, error: true });
    } finally {
      if (req === detailReq.current) {
        setDetailLoading(false);
        setOlderLoading(false);
      }
    }
  }, [request]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, reloadSignal]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(selected);
  }, [selected, loadDetail, reloadSignal]);

  const current = sessions.find((x) => x.id === selected) ?? null;

  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={sessionsLoading} onClick={() => void loadSessions()}>
          {sessionsLoading ? "读取中…" : "刷新会话"}
        </Button>
      </div>

      <StatusText text={status.text} error={status.error} />

      <div className="grid gap-3 min-[980px]:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="max-h-[72vh] overflow-y-auto rounded-[14px] border border-border bg-surface p-2">
          {!sessions.length && !sessionsLoading ? (
            <Empty>还没有模型会话日志。</Empty>
          ) : (
            <div className="space-y-1">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelected(s.id)}
                  className={cx(
                    "block w-full rounded-lg px-2.5 py-2 text-left transition hover:bg-surface2",
                    s.id === selected && "bg-accent-soft",
                  )}
                  aria-current={s.id === selected ? "true" : undefined}
                >
                  <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                    <span className="tabular-nums">{formatTs(s.updated_at)}</span>
                    <span>{num(s.messages)} 条</span>
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-text">
                    {s.preview || "（没有用户消息）"}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted">
                    {s.model && <span className="rounded border border-border px-1 py-px">{s.model}</span>}
                    {s.pools.map((p) => (
                      <span key={p} className="rounded border border-border px-1 py-px font-mono">{p}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="min-w-0 rounded-[14px] border border-border bg-surface p-3">
          {!selected || !detail ? (
            <Empty>{detailLoading ? "读取中…" : "从左侧选择一个会话。"}</Empty>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2 text-[11px] text-muted">
                <span className="text-[13px] font-semibold text-text">{current?.model || detail.model || "未知模型"}</span>
                <span>{num(detail.total)} 条消息</span>
                <span>开始 {formatTs(detail.started_at)}</span>
                <span className="font-mono">{detail.id}</span>
                {!!detail.pools.length && <span>池 {detail.pools.join(" / ")}</span>}
              </div>
              <div className="max-h-[68vh] space-y-2 overflow-y-auto pr-1">
                {detail.next_before !== null && (
                  <div className="text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={olderLoading}
                      onClick={() => void loadDetail(detail.id, detail.next_before ?? undefined, true)}
                    >
                      {olderLoading ? "加载中…" : "加载更早"}
                    </Button>
                  </div>
                )}
                {!detail.messages.length && <Empty>这个会话还没有消息。</Empty>}
                {detail.messages.map((m) => <MessageCard key={m.index} m={m} />)}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
