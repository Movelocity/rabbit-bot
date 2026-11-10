import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { formatTs, friendlyError, kindLabel } from "../lib/format.ts";
import type { Pool, PoolMessage, PoolMessages } from "../lib/types.ts";
import { Button, Empty } from "../components/ui.tsx";

function mergeMessages(prev: PoolMessage[], incoming: PoolMessage[]): PoolMessage[] {
  const map = new Map(prev.map((m) => [m.seq, m]));
  for (const m of incoming) map.set(m.seq, m);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function ChatPage({
  currentPool,
  onCurrentPoolChange,
  onDetectedUserChange,
  reloadSignal,
}: {
  currentPool: string | null;
  onCurrentPoolChange: (alias: string | null) => void;
  onDetectedUserChange: (userId: string) => void;
  reloadSignal: number;
}) {
  const request = useApi();
  const [pools, setPools] = useState<Pool[]>([]);
  const [messages, setMessages] = useState<PoolMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reading, setReading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const messagesBox = useRef<HTMLDivElement>(null);
  const messagesData = useRef<PoolMessage[]>([]);
  const loadingLatest = useRef(false);
  const requestId = useRef(0);
  const pendingScroll = useRef<"bottom" | "preserve" | null>(null);
  const prevMetrics = useRef({ height: 0, top: 0 });
  const currentRef = useRef(currentPool);
  currentRef.current = currentPool;

  const applyMessages = useCallback(
    (updater: (prev: PoolMessage[]) => PoolMessage[]) => {
      const next = updater(messagesData.current);
      messagesData.current = next;
      setMessages(next);
    },
    [],
  );

  const loadPools = useCallback(
    async (silent = false) => {
      try {
        const rows = await request<Pool[]>(`/v1/pools${showArchived ? "?archived=1" : ""}`);
        setPools(rows);
        if (currentRef.current && !rows.some((p) => p.alias === currentRef.current)) {
          onCurrentPoolChange(null);
        } else if (!currentRef.current && rows.length) {
          onCurrentPoolChange(rows[0].alias);
        }
      } catch (e) {
        if (!silent) setStatus({ text: `读取会话池失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, onCurrentPoolChange, showArchived],
  );

  const loadLatest = useCallback(
    async (silent = false) => {
      const alias = currentRef.current;
      if (!alias || loadingLatest.current) return;
      const box = messagesBox.current;
      const stickToBottom = box
        ? box.scrollHeight - box.scrollTop - box.clientHeight < 140
        : true;
      const id = ++requestId.current;
      loadingLatest.current = true;
      try {
        const data = await request<PoolMessages>(
          `/v1/pools/${encodeURIComponent(alias)}/messages?limit=${silent ? 40 : 25}`,
        );
        if (currentRef.current !== alias || id !== requestId.current) return;
        setStatus({ text: "" });
        setTotal(data.total || 0);
        if (data.oldest_seq !== null && data.oldest_seq !== undefined) {
          setOldestSeq(data.oldest_seq);
        }
        const next = mergeMessages(messagesData.current, data.messages || []);
        if (next.length > messagesData.current.length || !silent) {
          pendingScroll.current = stickToBottom || !silent ? "bottom" : null;
        }
        applyMessages(() => next);
      } catch (e) {
        const msg = friendlyError(e);
        if (msg && currentRef.current === alias) {
          setStatus({ text: "读取失败，请点击刷新重试。", error: true });
        }
      } finally {
        if (id === requestId.current) loadingLatest.current = false;
      }
    },
    [request, applyMessages],
  );

  const loadOlder = useCallback(async () => {
    const alias = currentRef.current;
    if (!alias || !messagesData.current.length || loadingOlder) return;
    setLoadingOlder(true);
    const box = messagesBox.current;
    prevMetrics.current = { height: box?.scrollHeight ?? 0, top: box?.scrollTop ?? 0 };
    const before = messagesData.current[0].seq;
    try {
      const data = await request<PoolMessages>(
        `/v1/pools/${encodeURIComponent(alias)}/messages?limit=25&before_seq=${before}`,
      );
      if (currentRef.current !== alias) return;
      setStatus({ text: "" });
      setTotal((t) => data.total || t);
      if (data.oldest_seq !== null && data.oldest_seq !== undefined) {
        setOldestSeq(data.oldest_seq);
      }
      pendingScroll.current = "preserve";
      applyMessages((prev) => mergeMessages(prev, data.messages || []));
    } catch (e) {
      const msg = friendlyError(e);
      if (msg && currentRef.current === alias) {
        setStatus({ text: `加载更早失败：${msg}`, error: true });
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [request, loadingOlder, applyMessages]);

  useEffect(() => {
    void loadPools(false);
  }, [loadPools]);

  useEffect(() => {
    requestId.current++;
    loadingLatest.current = false;
    messagesData.current = [];
    setMessages([]);
    setTotal(0);
    setOldestSeq(null);
    setLoadingOlder(false);
    if (currentPool) {
      setStatus({ text: "正在读取消息…" });
      void loadLatest(false);
    } else {
      setStatus({ text: "" });
    }
  }, [currentPool, loadLatest]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void loadPools(false).then(() => loadLatest(false));
  }, [reloadSignal, loadPools, loadLatest]);

  useLayoutEffect(() => {
    const box = messagesBox.current;
    const action = pendingScroll.current;
    pendingScroll.current = null;
    if (!box || !action) return;
    if (action === "bottom") box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevMetrics.current.top + (box.scrollHeight - prevMetrics.current.height);
  }, [messages]);

  useEffect(() => {
    const last = [...messages].reverse().find((m) => !m.from_self && m.user_id);
    if (last) onDetectedUserChange(last.user_id);
  }, [messages, onDetectedUserChange]);

  usePolling(async () => {
    await loadPools(true);
    if (currentRef.current) await loadLatest(true);
  }, 3000);

  const pool = pools.find((p) => p.alias === currentPool);

  const toggleArchive = useCallback(async () => {
    if (!pool || archiving) return;
    setArchiving(true);
    try {
      await request(`/v1/pools/${encodeURIComponent(pool.alias)}/archive`, {
        method: "POST",
        body: { archived: !pool.archived },
      });
      await loadPools(false);
    } catch (e) {
      setStatus({ text: `归档失败：${friendlyError(e)}`, error: true });
    } finally {
      setArchiving(false);
    }
  }, [pool, archiving, request, loadPools]);

  const canLoadOlder =
    oldestSeq !== null && messages.length > 0 && messages[0].seq > oldestSeq;

  let previous: PoolMessage | null = null;
  let previousDay = "";

  return (
    <div className="grid h-full grid-cols-[280px_minmax(0,1fr)] min-h-0 max-[820px]:grid-cols-1">
      <aside
        className={cx(
          "flex min-h-0 flex-col border-r border-border bg-surface max-[820px]:border-r-0",
          reading && "max-[820px]:hidden",
        )}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-[18px] text-[13px] text-muted">
          <span>会话池</span>
          <button
            type="button"
            className={cx("rounded px-1.5 py-0.5 text-[11px] transition hover:text-text", showArchived && "text-text")}
            title={showArchived ? "隐藏已归档" : "显示已归档"}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "隐藏归档" : "显示归档"}
          </button>
        </div>
        <div className="overflow-y-auto px-2.5 pb-4">
          {!pools.length ? (
            <Empty>还没有会话池。</Empty>
          ) : (
            pools.map((p) => (
              <button
                key={p.alias}
                type="button"
                title={p.title || p.alias}
                aria-current={p.alias === currentPool}
                className={cx(
                  "mb-1 block w-full rounded-md border-0 px-3 py-3.5 text-left transition hover:bg-surface2",
                  p.alias === currentPool ? "bg-surface2" : "bg-transparent",
                  p.archived && "opacity-55",
                )}
                onClick={() => {
                  setReading(true);
                  if (currentPool !== p.alias) onCurrentPoolChange(p.alias);
                  else if (messagesBox.current) {
                    messagesBox.current.scrollTop = messagesBox.current.scrollHeight;
                  }
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-semibold">
                    {p.title || "（无标题）"}
                  </span>
                  <span className="flex-none text-[11px] text-muted">
                    {p.archived ? "已归档 · " : ""}{kindLabel(p.kind)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-baseline gap-2 text-xs text-muted [font-variant-numeric:tabular-nums]">
                  <span className="font-mono text-[11px]">{p.alias}</span>
                  <span
                    className="flex-1"
                    title={p.last_msg_local || ""}
                  >
                    {p.last_msg_local ? p.last_msg_local.slice(5, 16) : "暂无消息"}
                  </span>
                  <span>{p.total || 0} 条</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section
        className={cx(
          "flex min-h-0 min-w-0 flex-col bg-surface",
          !reading && "max-[820px]:hidden",
        )}
        aria-label="会话记录"
      >
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-7 py-2 max-[820px]:px-4 max-[820px]:py-1.5">
          <button
            type="button"
            className="hidden flex-none rounded-[9px] border border-border px-2.5 py-1.5 text-[13px] max-[820px]:block"
            onClick={() => setReading(false)}
          >
            会话列表
          </button>
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            <h2 className="m-0 truncate text-sm font-semibold">
              {pool ? pool.title || pool.alias : "选择左侧会话"}
            </h2>
            <div className="flex-none text-xs text-muted max-[820px]:hidden">
              {pool ? `${total} 条消息` : ""}
            </div>
          </div>
          {pool && (
            <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void toggleArchive()}>
              {pool.archived ? "取消归档" : "归档"}
            </Button>
          )}
        </div>

        {status.text && (
          <p
            className={cx(
              "m-0 bg-bg px-7 py-2.5 text-[13px] max-[820px]:px-4",
              status.error ? "text-bad" : "text-muted",
            )}
            role={status.error ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}

        <div
          ref={messagesBox}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(28px,calc((100%-800px)/2))] pb-9 pt-4 [scrollbar-gutter:stable] max-[820px]:px-4 max-[820px]:pb-6"
          tabIndex={0}
          aria-label="消息记录"
        >
          {!currentPool ? (
            <Empty>从左侧选择一个会话池。</Empty>
          ) : (
            <>
              {canLoadOlder && (
                <div className="text-center">
                  <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                    {loadingOlder ? "正在加载…" : "加载更早的消息"}
                  </Button>
                </div>
              )}
              {!messages.length ? (
                <Empty>这个池还没有消息。收发消息请用已启用的 IM。</Empty>
              ) : (
                messages.map((m) => {
                  const stamp = m.local || formatTs(m.ts);
                  const day = stamp.split(/[ T]/)[0];
                  const showDay = !!day && day !== previousDay;
                  const grouped =
                    !!previous &&
                    day === previousDay &&
                    previous.from_self === m.from_self &&
                    previous.sender === m.sender &&
                    previous.user_id === m.user_id &&
                    Number(m.ts) - Number(previous.ts) >= 0 &&
                    Number(m.ts) - Number(previous.ts) < 5 * 60 * 1000;
                  previous = m;
                  previousDay = day;
                  return (
                    <Fragment key={m.seq}>
                      {showDay && (
                        <div className="my-6 flex items-center gap-[18px] text-xs text-muted [font-variant-numeric:tabular-nums] before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-['']">
                          {day}
                        </div>
                      )}
                      <article
                        className={cx(
                          "mt-6 w-fit max-w-[88%] max-[820px]:max-w-[94%]",
                          m.from_self && "ml-auto",
                          grouped && "mt-2",
                        )}
                      >
                        <div
                          className={cx(
                            "mb-1.5 flex flex-wrap items-baseline gap-2 text-xs text-muted",
                            grouped && "mb-0.5 text-[11px]",
                          )}
                        >
                          <span
                            className={cx(
                              "wrap-anywhere font-semibold text-text",
                              grouped && "hidden",
                            )}
                          >
                            {m.sender || (m.from_self ? "机器人" : "未知")}
                          </span>
                          {m.from_self && !grouped && (
                            <span className="text-[11px]">机器人</span>
                          )}
                          <span className="ml-auto pl-3 [font-variant-numeric:tabular-nums]">
                            {stamp.match(/\d{2}:\d{2}/)?.[0] || stamp}
                          </span>
                        </div>
                        <div
                          className={cx(
                            "whitespace-pre-wrap wrap-anywhere rounded-[3px_12px_12px] bg-surface2 px-4 py-3 leading-[1.8] max-[820px]:px-3 max-[820px]:py-2.5",
                            m.from_self && "rounded-[12px_3px_12px_12px] bg-self",
                          )}
                        >
                          {m.text || ""}
                        </div>
                      </article>
                    </Fragment>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-7 py-2.5 text-xs text-muted max-[820px]:px-4">
          <span>只读 · 收发走已启用的 IM</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (messagesBox.current) messagesBox.current.scrollTop = messagesBox.current.scrollHeight;
            }}
          >
            回到最新
          </Button>
        </div>
      </section>
    </div>
  );
}
