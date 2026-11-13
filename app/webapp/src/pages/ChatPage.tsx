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
import type { Pool, PoolMessage, PoolMessages, SendReviewSettingsResponse } from "../lib/types.ts";
import { Button, Chip, Empty, Input, Notice, Segmented } from "../components/ui.tsx";

type PoolReviewMode = "inherit" | "review" | "direct";

function mergeMessages(prev: PoolMessage[], incoming: PoolMessage[]): PoolMessage[] {
  const map = new Map(prev.map((m) => [m.seq, m]));
  for (const m of incoming) map.set(m.seq, m);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

function initial(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 1) : "?";
}

function poolBucketKind(kind: string): string {
  return kind || "group";
}

const BUCKET_LABEL: Record<string, string> = {
  private: "私聊",
  group: "群聊",
  task: "任务",
};

export function ChatPage({
  currentPool,
  onCurrentPoolChange,
  reloadSignal,
}: {
  currentPool: string | null;
  onCurrentPoolChange: (alias: string | null) => void;
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
  const [view, setView] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [sendReview, setSendReview] = useState<SendReviewSettingsResponse | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);

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
        const rows = await request<Pool[]>(`/v1/pools${view === "archived" ? "?archived=1" : ""}`);
        const visible = view === "archived" ? rows.filter((p) => p.archived) : rows.filter((p) => !p.archived);
        setPools(visible);
        if (visible.some((p) => p.alias === currentRef.current)) return;
        onCurrentPoolChange(visible[0]?.alias ?? null);
      } catch (e) {
        if (!silent) setStatus({ text: `读取会话池失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, onCurrentPoolChange, view],
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

  const loadSendReview = useCallback(async () => {
    try {
      setSendReview(await request<SendReviewSettingsResponse>("/v1/send-review"));
    } catch {
      // 老后端没有这个接口时不影响聊天
    }
  }, [request]);

  useEffect(() => {
    void loadPools(false);
    void loadSendReview();
  }, [loadPools, loadSendReview]);

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
    void loadSendReview();
    void loadPools(false).then(() => loadLatest(false));
  }, [reloadSignal, loadSendReview, loadPools, loadLatest]);

  useLayoutEffect(() => {
    const box = messagesBox.current;
    const action = pendingScroll.current;
    pendingScroll.current = null;
    if (!box || !action) return;
    if (action === "bottom") box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevMetrics.current.top + (box.scrollHeight - prevMetrics.current.height);
  }, [messages]);

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

  const changePoolReview = useCallback(
    async (mode: PoolReviewMode) => {
      if (!pool || !sendReview || reviewSaving) return;
      setReviewSaving(true);
      try {
        const overrides = { ...sendReview.overrides };
        // 默认就是直接发时，「直接发」等于回到默认，不写死一条覆盖
        if (mode === "inherit" || (mode === "direct" && !sendReview.defaultReview)) {
          delete overrides[pool.pool_id];
        } else {
          overrides[pool.pool_id] = mode === "review";
        }
        const saved = await request<SendReviewSettingsResponse>("/v1/send-review", {
          method: "PUT",
          body: {
            // 给某个会话打开审批时顺手把总开关打开，省得再去设置页找
            enabled: mode === "review" ? true : sendReview.enabled,
            defaultReview: sendReview.defaultReview,
            primaryPoolId: sendReview.primaryPoolId,
            overrides,
          },
        });
        setSendReview(saved);
        setStatus({ text: "" });
      } catch (e) {
        setStatus({ text: `设置发送审核失败：${friendlyError(e)}`, error: true });
      } finally {
        setReviewSaving(false);
      }
    },
    [pool, sendReview, reviewSaving, request],
  );

  const isPrimary = !!pool && sendReview?.primaryPoolId === pool.pool_id;
  // 这个会话当前实际走不走审批：主对话永远免审；否则看单独覆盖，再退到全局默认
  const effectiveReview = !pool || isPrimary
    ? false
    : (sendReview?.overrides[pool.pool_id] ?? sendReview?.defaultReview ?? false);

  const setPrimaryPool = useCallback(
    async (makePrimary: boolean) => {
      if (!pool || !sendReview || reviewSaving) return;
      setReviewSaving(true);
      try {
        const saved = await request<SendReviewSettingsResponse>("/v1/send-review", {
          method: "PUT",
          body: {
            enabled: sendReview.enabled,
            defaultReview: sendReview.defaultReview,
            primaryPoolId: makePrimary ? pool.pool_id : null,
            overrides: sendReview.overrides,
          },
        });
        setSendReview(saved);
        setStatus({
          text: makePrimary
            ? "已设为主聊天：任务汇报只发这里，它发送的消息永不审批，审批消息也发到这里"
            : "已取消主聊天",
        });
      } catch (e) {
        setStatus({ text: `设置主聊天失败：${friendlyError(e)}`, error: true });
      } finally {
        setReviewSaving(false);
      }
    },
    [pool, sendReview, reviewSaving, request],
  );

  const canLoadOlder =
    oldestSeq !== null && messages.length > 0 && messages[0].seq > oldestSeq;

  const query = search.trim().toLowerCase();
  const visiblePools = pools.filter(
    (p) => !query || `${p.title} ${p.alias}`.toLowerCase().includes(query),
  );
  const buckets = new Map<string, Pool[]>();
  for (const p of visiblePools) {
    const key = poolBucketKind(p.kind);
    const list = buckets.get(key) ?? [];
    list.push(p);
    buckets.set(key, list);
  }
  const bucketOrder = ["private", "group", "task"];
  const orderedBuckets = [...buckets.entries()].sort(
    (a, b) =>
      (bucketOrder.indexOf(a[0]) === -1 ? 9 : bucketOrder.indexOf(a[0])) -
      (bucketOrder.indexOf(b[0]) === -1 ? 9 : bucketOrder.indexOf(b[0])),
  );
  const recentMessages = messages.slice(-3).reverse();

  let previous: PoolMessage | null = null;
  let previousDay = "";

  return (
    <div className="grid h-full min-h-0 grid-cols-[288px_minmax(0,1fr)_308px] max-[1200px]:grid-cols-[260px_minmax(0,1fr)] max-[820px]:grid-cols-1">
      <aside
        className={cx(
          "flex min-h-0 flex-col border-r border-border bg-surface max-[820px]:border-r-0",
          reading && "max-[820px]:hidden",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 pt-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
              会话池
            </div>
            <div className="mt-0.5 text-[11px] text-muted">{visiblePools.length} 个会话</div>
          </div>
          <Segmented
            value={view}
            options={[
              { value: "active", label: "活跃" },
              { value: "archived", label: "已归档" },
            ]}
            onChange={setView}
            label="会话池视图"
          />
        </div>
        <div className="px-3 pb-2.5">
          <Input
            type="search"
            aria-label="搜索会话或别名"
            placeholder="搜索会话或别名…"
            className="py-1.5 text-[12px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {!visiblePools.length ? (
            <Empty>
              {view === "archived"
                ? "还没有已归档的会话。"
                : query
                  ? "没有匹配的会话。"
                  : "还没有会话池。"}
            </Empty>
          ) : (
            orderedBuckets.map(([kind, rows]) => (
              <div key={kind}>
                <div className="px-2 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                  {BUCKET_LABEL[kind] ?? kindLabel(kind)} · {rows.length}
                </div>
                {rows.map((p) => {
                  const selected = p.alias === currentPool;
                  return (
                    <button
                      key={p.alias}
                      type="button"
                      title={p.title || p.alias}
                      aria-current={selected ? "true" : undefined}
                      className={cx(
                        "relative flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition hover:bg-surface2",
                        selected && "bg-accent-soft",
                      )}
                      onClick={() => {
                        setReading(true);
                        if (currentPool !== p.alias) onCurrentPoolChange(p.alias);
                        else if (messagesBox.current) {
                          messagesBox.current.scrollTop = messagesBox.current.scrollHeight;
                        }
                      }}
                    >
                      {selected && (
                        <span className="absolute inset-y-2 left-0 w-[3px] rounded bg-accent" />
                      )}
                      <span
                        className={cx(
                          "grid size-[30px] flex-none place-items-center rounded-[9px] border text-[13px] font-bold",
                          p.kind === "private"
                            ? "border-clay/25 bg-clay-soft text-clay"
                            : "border-accent/25 bg-accent-soft text-accent-ink",
                        )}
                      >
                        {initial(p.title || p.alias)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-tight">
                          <span className="truncate">{p.title || p.alias}</span>
                          {p.is_main && (
                            <Chip tone="accent" className="px-1.5 py-0 text-[9px]">
                              主
                            </Chip>
                          )}
                          {Number(p.unread) > 0 && (
                            <span
                              className="ml-auto grid h-[16px] min-w-[16px] flex-none place-items-center rounded-full bg-clay px-1 text-[10px] font-semibold tabular-nums text-white"
                              aria-label={`${p.unread} 条未读`}
                            >
                              {Number(p.unread) > 99 ? "99+" : p.unread}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted">
                          <code className="truncate font-mono text-[10px] text-faint">
                            {p.alias}
                          </code>
                          <span className="truncate">{p.last_msg_local ? p.last_msg_local.slice(5, 16) : "暂无消息"}</span>
                        </span>
                      </span>
                      <span className="flex flex-none flex-col items-end gap-0.5 text-[10px] text-faint">
                        <span>{kindLabel(p.kind)}</span>
                        <span>{p.total || 0} 条</span>
                      </span>
                    </button>
                  );
                })}
              </div>
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
        <div className="flex min-h-[58px] flex-wrap items-center gap-3 border-b border-border px-5 py-2.5 max-[820px]:px-3">
          <button
            type="button"
            className="hidden flex-none rounded-[9px] border border-border px-2.5 py-1.5 text-[13px] max-[820px]:block"
            onClick={() => setReading(false)}
          >
            会话列表
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="rb-display m-0 truncate text-[17px]">
              {pool ? pool.title || pool.alias : "选择左侧会话"}
            </h2>
            <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11.5px] text-muted">
              {pool ? (
                <>
                  <code className="font-mono text-[10.5px] text-faint">{pool.alias}</code>
                  <span>{kindLabel(pool.kind)}</span>
                  <span>{total} 条消息</span>
                  <span>最后 {pool.last_msg_local || "—"}</span>
                </>
              ) : null}
            </div>
          </div>
          {pool && sendReview && (pool.kind === "group" || pool.kind === "private") && (
            <div className="flex flex-none flex-wrap items-center justify-end gap-2">
              {isPrimary ? (
                <Chip tone="accent">主聊天 · 免审批</Chip>
              ) : (
                <Segmented
                  value={effectiveReview ? "review" : "direct"}
                  options={[
                    { value: "direct", label: "直接发" },
                    { value: "review", label: "需审批" },
                  ]}
                  onChange={(value) => void changePoolReview(value)}
                  label="这个会话发送是否需要审批"
                />
              )}
              <Button
                variant={isPrimary ? "default" : "ghost"}
                size="sm"
                disabled={reviewSaving}
                aria-pressed={isPrimary}
                title={
                  isPrimary
                    ? "主聊天：任务汇报只发这里、永不审批；点此取消"
                    : "设为主聊天：任务汇报只发这里，永不审批，并接收审批消息"
                }
                onClick={() => void setPrimaryPool(!isPrimary)}
              >
                {isPrimary ? "主聊天 ✓" : "设为主聊天"}
              </Button>
              <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void toggleArchive()}>
                {pool.archived ? "取消归档" : "归档"}
              </Button>
            </div>
          )}
        </div>

        {status.text && (
          <p
            className={cx(
              "m-0 border-b border-border bg-bg px-5 py-2 text-[12.5px] max-[820px]:px-3",
              status.error ? "text-bad" : "text-muted",
            )}
            role={status.error ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}

        <div
          ref={messagesBox}
          className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(24px,calc((100%-760px)/2))] pb-8 pt-3 [scrollbar-gutter:stable] max-[820px]:px-3.5 max-[820px]:pb-6"
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
                        <div className="my-4 flex items-center gap-3 text-[10.5px] tracking-[0.08em] text-faint">
                          <span className="h-px flex-1 bg-border" />
                          {day}
                          <span className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <article
                        className={cx(
                          "my-3 flex max-w-[min(680px,88%)] items-start gap-2.5 max-[820px]:max-w-[94%]",
                          m.from_self && "ml-auto flex-row-reverse",
                          grouped && "mt-1.5",
                        )}
                      >
                        <span
                          className={cx(
                            "grid size-6 flex-none place-items-center rounded-[7px] border text-[11px] font-bold",
                            m.from_self
                              ? "border-transparent bg-accent text-white"
                              : "border-border bg-surface3 text-muted",
                            grouped && "opacity-0",
                          )}
                        >
                          {initial(m.sender || "机器人")}
                        </span>
                        <div className="min-w-0">
                          <div
                            className={cx(
                              "mb-1 flex flex-wrap items-baseline gap-2 text-[10.5px] text-faint",
                              m.from_self && "justify-end",
                              grouped && "hidden",
                            )}
                          >
                            <b className="text-[11px] font-semibold text-muted">
                              {m.sender || (m.from_self ? "机器人" : "未知")}
                            </b>
                            {m.from_self && <span>机器人</span>}
                            <time className="tabular-nums">
                              {stamp.match(/\d{2}:\d{2}/)?.[0] || stamp}
                            </time>
                          </div>
                          <div
                            className={cx(
                              "whitespace-pre-wrap wrap-anywhere rounded-[3px_12px_12px_12px] border border-border bg-surface2 px-3 py-2.5 text-[13px] leading-[1.75]",
                              m.from_self &&
                                "rounded-[12px_3px_12px_12px] border-accent/20 bg-accent-soft",
                            )}
                          >
                            {m.text || ""}
                          </div>
                        </div>
                      </article>
                    </Fragment>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-2 text-[11px] text-muted max-[820px]:px-3">
          <span>只读 · 收发走已启用的 IM</span>
          <div className="flex items-center gap-1.5">
            {canLoadOlder && (
              <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                加载更早
              </Button>
            )}
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
        </div>
      </section>

      <aside className="rb-thin-scroll min-h-0 overflow-y-auto border-l border-border bg-surface p-3.5 max-[1200px]:hidden">
        <div className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
            会话信息
          </div>
          {pool ? (
            <>
              <dl className="rb-kv">
                <dt>pool_id</dt>
                <dd>
                  <code className="font-mono text-[10.5px]">{pool.pool_id}</code>
                </dd>
                <dt>类型</dt>
                <dd>{kindLabel(pool.kind)}</dd>
                <dt>消息</dt>
                <dd>{pool.total || 0} 条</dd>
                <dt>最后</dt>
                <dd>{pool.last_msg_local || "—"}</dd>
              </dl>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted">
                {pool.is_main
                  ? "主聊天：任务汇报与审批消息都发这里，发送永不审批。"
                  : "只读值班台：修改发送策略只影响机器人后续发送。"}
              </p>
            </>
          ) : (
            <p className="m-0 text-[12px] text-muted">选择左侧会话查看信息。</p>
          )}
        </div>

        <div className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
            发送策略
          </div>
          {pool && sendReview ? (
            isPrimary ? (
              <Notice tone="accent">
                主聊天永远免审批；任务汇报只发这里，审批消息也发这里。
              </Notice>
            ) : (
              <>
                <p className="m-0 mb-2 text-[11.5px] leading-relaxed text-muted">
                  这个会话当前：
                  <b className="text-text">{effectiveReview ? "需审批" : "直接发"}</b>
                  。改策略只影响后续机器人发送。
                </p>
                <Segmented
                  value={effectiveReview ? "review" : "direct"}
                  options={[
                    { value: "direct", label: "直接发" },
                    { value: "review", label: "需审批" },
                  ]}
                  onChange={(value) => void changePoolReview(value)}
                  label="发送审批"
                />
              </>
            )
          ) : (
            <p className="m-0 text-[11.5px] text-muted">发送审核接口不可用。</p>
          )}
          {pool && sendReview ? (
            <>
              <div className="my-3 h-px bg-border" />
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={reviewSaving}
                onClick={() => void setPrimaryPool(!isPrimary)}
              >
                {isPrimary ? "取消主聊天" : "设为主聊天"}
              </Button>
            </>
          ) : null}
        </div>

        <div className="rounded-[11px] border border-border bg-surface p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
            最近消息
          </div>
          {recentMessages.length ? (
            <ol className="m-0 grid list-none gap-2 p-0 text-[11px]">
              {recentMessages.map((m) => (
                <li key={m.seq} className="grid grid-cols-[48px_minmax(0,1fr)] gap-2 text-muted">
                  <time className="font-mono text-[10px] text-faint tabular-nums">
                    {(m.local || formatTs(m.ts)).match(/\d{2}:\d{2}/)?.[0] || "—"}
                  </time>
                  <span className="min-w-0">
                    <b className="text-text">{m.sender || "未知"}</b>
                    <span className="mt-0.5 block truncate">{m.text || ""}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="m-0 text-[11.5px] text-muted">还没有消息。</p>
          )}
        </div>
      </aside>
    </div>
  );
}
