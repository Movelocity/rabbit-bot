import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { cx } from "../lib/cx.ts";
import { formatTs, friendlyError } from "../lib/format.ts";
import type { Memory, MemoryList, MemoryTrace } from "../lib/types.ts";
import {
  Badge,
  Button,
  Chip,
  Empty,
  Field,
  FilterBar,
  Input,
  Page,
  PageHead,
  Select,
  StatusText,
  Textarea,
} from "../components/ui.tsx";
import { Modal } from "../components/Modal.tsx";

const KIND_OPTIONS = [
  { value: "", label: "全部" },
  { value: "fact", label: "fact" },
  { value: "plan", label: "plan" },
  { value: "alias", label: "alias" },
  { value: "topic", label: "topic" },
];

const SCOPE_OPTIONS = [
  { value: "", label: "全部" },
  { value: "all", label: "all" },
  { value: "pool", label: "pool" },
  { value: "private", label: "private" },
  { value: "group", label: "group" },
];

const STATUS_OPTIONS = [
  { value: "", label: "全部" },
  { value: "valid", label: "有效" },
  { value: "expired", label: "已失效" },
];

export function MemoriesPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [user, setUser] = useState("");
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const [validity, setValidity] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tracingId, setTracingId] = useState<number | null>(null);
  const [trace, setTrace] = useState<MemoryTrace | null>(null);
  const [localTick, setLocalTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus({ text: "加载中…" });
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        global: "1",
        limit: String(pageSize),
        offset: String((page - 1) * pageSize),
      });
      if (user.trim()) params.set("user", user.trim());
      if (kind) params.set("kind", kind);
      if (scope) params.set("scope", scope);
      if (validity) params.set("status", validity);
      if (q.trim()) params.set("q", q.trim());
      try {
        const data = await request<MemoryList>(`/v1/memories?${params.toString()}`);
        if (cancelled) return;
        if (!data.rows.length && data.total > 0 && page > 1) {
          setPage(Math.max(1, Math.ceil(data.total / pageSize)));
          return;
        }
        setRows(data.rows);
        setTotal(data.total);
        setStatus({ text: data.rows.length ? "" : "没有匹配的记忆。" });
      } catch (e) {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [user, kind, scope, validity, q, page, pageSize, reloadSignal, localTick, request]);

  useEffect(() => {
    if (!rows.length) {
      setSelectedId(null);
      return;
    }
    if (selectedId === null || !rows.some((m) => m.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const reload = useCallback(() => setLocalTick((n) => n + 1), []);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pages);
  const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(total, currentPage * pageSize);

  const resetPage = () => setPage(1);

  const selected = rows.find((m) => m.id === selectedId) ?? rows[0] ?? null;

  const selectMemory = (id: number) => {
    setSelectedId(id);
    setEditingId(null);
    setTrace(null);
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditContent(m.content);
  };

  const save = async (m: Memory) => {
    const content = editContent.trim();
    const owner = m.user_id || user.trim();
    if (!content) {
      setStatus({ text: "正文不能为空；不想留了就删除。", error: true });
      return;
    }
    if (!owner) {
      setStatus({ text: "这条记忆缺少 user id，无法保存。", error: true });
      return;
    }
    setSaving(true);
    try {
      await request(`/v1/memories/${m.id}`, {
        method: "PUT",
        body: { user: owner, content },
      });
      setEditingId(null);
      setStatus({ text: "" });
      reload();
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const m = pendingDelete;
    if (!m) return;
    const owner = m.user_id || user.trim();
    if (!owner) {
      setStatus({ text: "这条记忆缺少 user id，无法删除。", error: true });
      setPendingDelete(null);
      return;
    }
    setDeleting(true);
    try {
      await request(`/v1/memories/${m.id}?user=${encodeURIComponent(owner)}`, {
        method: "DELETE",
      });
      setStatus({ text: "" });
      setPendingDelete(null);
      reload();
    } catch (e) {
      setStatus({ text: `删除失败：${friendlyError(e)}`, error: true });
    } finally {
      setDeleting(false);
    }
  };

  const showTrace = async (m: Memory) => {
    const owner = m.user_id || user.trim();
    if (!owner) {
      setStatus({ text: "这条记忆缺少 user id，无法回溯来源。", error: true });
      return;
    }
    setTracingId(m.id);
    try {
      const data = await request<MemoryTrace>(
        `/v1/memories/${m.id}/trace?user=${encodeURIComponent(owner)}&before=5&after=5`,
      );
      setTrace(data);
    } catch (e) {
      setStatus({ text: `回溯失败：${friendlyError(e)}`, error: true });
    } finally {
      setTracingId(null);
    }
  };

  return (
    <Page>
      <PageHead
        eyebrow="Memories"
        title="记忆"
        sub="Web 只改正文和删除；新增、过期、跨会话梳理仍走 IM。来源可回溯到具体消息。"
        actions={<Chip>{rows.length} / {total} 条</Chip>}
      />

      <FilterBar>
        <Field label="用户" compact>
          <Input
            type="text"
            placeholder="全部用户"
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              resetPage();
            }}
          />
        </Field>
        <Field label="kind" compact>
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              resetPage();
            }}
            options={KIND_OPTIONS}
            ariaLabel="记忆 kind"
          />
        </Field>
        <Field label="scope" compact>
          <Select
            value={scope}
            onValueChange={(value) => {
              setScope(value);
              resetPage();
            }}
            options={SCOPE_OPTIONS}
            ariaLabel="记忆 scope"
          />
        </Field>
        <Field label="状态" compact>
          <Select
            value={validity}
            onValueChange={(value) => {
              setValidity(value);
              resetPage();
            }}
            options={STATUS_OPTIONS}
            ariaLabel="记忆状态"
          />
        </Field>
        <Field label="搜索" grow>
          <Input
            type="search"
            placeholder="正文关键词"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              resetPage();
            }}
          />
        </Field>
      </FilterBar>

      <StatusText text={status.text} error={status.error} />

      <div className="grid items-start gap-3.5 min-[1200px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          {!rows.length ? (
            <Empty>{status.text ? "" : "没有可见的记忆。"}</Empty>
          ) : (
            rows.map((m) => (
              <button
                key={m.id}
                type="button"
                className={cx(
                  "mb-1.5 block w-full rounded-[10px] border bg-surface px-3 py-2.5 text-left transition",
                  selected?.id === m.id
                    ? "border-accent/48 bg-accent-soft"
                    : "border-border hover:border-line-strong",
                )}
                onClick={() => selectMemory(m.id)}
              >
                <div className="line-clamp-2 text-[12.5px] leading-snug">{m.content}</div>
                <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-[10.5px] text-muted">
                  <span>#{m.id}</span>
                  <Badge variant={m.to ? "closed" : "done"}>{m.to ? "已失效" : "有效"}</Badge>
                  <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10px]">
                    {m.kind || "fact"}
                  </span>
                  <span>scope {m.scope}</span>
                  {m.user_id && <span className="font-mono">{m.user_id}</span>}
                  <span>
                    {formatTs(m.from)} → {m.to ? formatTs(m.to) : "至今"}
                  </span>
                  {m.replaced_by && <span>被 #{m.replaced_by} 顶替</span>}
                </div>
              </button>
            ))
          )}

          {total > 0 && (
            <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
              <Button
                variant="ghost"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </Button>
              <span>
                {start}–{end} / 共 {total} 条 · 第 {currentPage} / {pages} 页
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={currentPage >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </Button>
              <span className="flex-1" />
              <Select
                className="!w-auto py-1.5"
                ariaLabel="每页条数"
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value) || 20);
                  setPage(1);
                }}
                options={[10, 20, 50, 100].map((n) => ({
                  value: String(n),
                  label: `${n} 条/页`,
                }))}
              />
            </div>
          )}
        </div>

        {selected ? (
          <aside className="rounded-[13px] border border-border bg-surface p-4 shadow-[var(--rb-shadow)] min-[1200px]:sticky min-[1200px]:top-0">
            <div className="flex items-start gap-2">
              <h3 className="rb-display m-0 flex-1 text-[17px]">记忆 #{selected.id}</h3>
              <Badge variant={selected.to ? "closed" : "done"}>
                {selected.to ? "已失效" : "有效"}
              </Badge>
            </div>

            {editingId === selected.id ? (
              <>
                <Textarea
                  className="mt-2.5 min-h-[96px] text-[13px]"
                  rows={5}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
                <div className="mt-2 flex gap-1.5">
                  <Button variant="primary" size="sm" disabled={saving} onClick={() => void save(selected)}>
                    {saving ? "保存中…" : "保存"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                    取消
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="m-0 mb-2.5 mt-2 whitespace-pre-wrap text-[13px] leading-[1.75]">
                  {selected.content}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => startEdit(selected)}>
                    编辑
                  </Button>
                  {selected.source_seq_start ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={tracingId === selected.id}
                      onClick={() => void showTrace(selected)}
                    >
                      {tracingId === selected.id ? "回溯中…" : "来源"}
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setPendingDelete(selected)}
                  >
                    删除
                  </Button>
                </div>
              </>
            )}

            <div className="my-3 h-px bg-border" />
            <dl className="rb-kv">
              <dt>kind</dt>
              <dd>{selected.kind || "fact"}</dd>
              <dt>scope</dt>
              <dd>{selected.scope}</dd>
              <dt>user</dt>
              <dd className="font-mono">{selected.user_id || "—"}</dd>
              <dt>来源池</dt>
              <dd>{selected.source_pool || "—"}</dd>
              <dt>有效</dt>
              <dd>
                {formatTs(selected.from)} → {selected.to ? formatTs(selected.to) : "至今"}
              </dd>
              {selected.replaced_by ? (
                <>
                  <dt>替换</dt>
                  <dd>被 #{selected.replaced_by} 顶替</dd>
                </>
              ) : null}
            </dl>

            {trace && trace.id === selected.id ? (
              <div className="mt-2.5 overflow-hidden rounded-[10px] border border-border">
                {trace.note ? (
                  <div className="border-b border-border bg-surface2 px-2.5 py-2 text-[11.5px] text-muted">
                    {trace.note}
                  </div>
                ) : null}
                {trace.messages.map((msg) => (
                  <div
                    key={msg.seq}
                    className={cx(
                      "border-b border-border px-2.5 py-2 text-[11.5px] last:border-b-0",
                      msg.anchor && "bg-accent-soft",
                    )}
                  >
                    <div className="mb-0.5 flex flex-wrap gap-1.5 text-[10px] text-faint">
                      <span>#{msg.seq}</span>
                      <span>{msg.local}</span>
                      <span className={msg.from_self ? "text-accent" : ""}>
                        {msg.from_self ? "我" : msg.sender}
                      </span>
                      {msg.anchor ? <Badge variant="done">来源</Badge> : null}
                    </div>
                    <div className="whitespace-pre-wrap wrap-anywhere">{msg.text}</div>
                  </div>
                ))}
                <div className="border-t border-border p-2">
                  <Button variant="ghost" size="sm" onClick={() => setTrace(null)}>
                    收起来源
                  </Button>
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {pendingDelete && (
        <Modal title={`删除记忆 #${pendingDelete.id}？`} onClose={() => setPendingDelete(null)}>
          <p className="m-0 text-sm leading-relaxed text-muted">
            {pendingDelete.content}
            <br />
            <br />
            删除后不可撤销；如果只是过期，应该走 IM 标记失效。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" size="sm" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
