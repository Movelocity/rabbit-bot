import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { formatTs, friendlyError } from "../lib/format.ts";
import type { Memory, MemoryList, MemoryTrace } from "../lib/types.ts";
import { Drawer } from "../components/Drawer.tsx";
import {
  Badge,
  Button,
  Card,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  Field,
  Input,
  Select,
  StatusText,
  Textarea,
} from "../components/ui.tsx";

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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
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

  const reload = useCallback(() => setLocalTick((n) => n + 1), []);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pages);
  const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(total, currentPage * pageSize);

  const resetPage = () => setPage(1);

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

  const remove = async (m: Memory) => {
    const owner = m.user_id || user.trim();
    if (!owner) {
      setStatus({ text: "这条记忆缺少 user id，无法删除。", error: true });
      return;
    }
    if (!window.confirm(`删除记忆 #${m.id}？\n\n${m.content}`)) return;
    setDeletingId(m.id);
    try {
      await request(`/v1/memories/${m.id}?user=${encodeURIComponent(owner)}`, {
        method: "DELETE",
      });
      setStatus({ text: "" });
      reload();
    } catch (e) {
      setStatus({ text: `删除失败：${friendlyError(e)}`, error: true });
    } finally {
      setDeletingId(null);
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
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <div className="my-3 flex flex-wrap items-end gap-3">
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
      </div>

      <StatusText text={status.text} error={status.error} />

      <div className="grid gap-2.5">
        {!rows.length ? (
          <Empty>{status.text ? "" : "没有可见的记忆。"}</Empty>
        ) : (
          rows.map((m) => (
            <Card key={m.id}>
              <CardHead>
                {editingId === m.id ? (
                  <Textarea
                    className="min-h-[76px] text-sm"
                    rows={3}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                  />
                ) : (
                  <CardTitle>{m.content}</CardTitle>
                )}
                <Badge variant={m.to ? "closed" : "done"}>{m.to ? "已失效" : "有效"}</Badge>
              </CardHead>
              <CardMeta>
                <span>#{m.id}</span>
                <Badge>{m.kind || "fact"}</Badge>
                <Badge>scope {m.scope}</Badge>
                {m.user_id && <span className="font-mono">{m.user_id}</span>}
                {m.source_pool && <span>池 {m.source_pool}</span>}
                <span>
                  有效 {formatTs(m.from)} → {m.to ? formatTs(m.to) : "至今"}
                </span>
                {m.created_at ? <span>创建 {formatTs(m.created_at)}</span> : null}
                {m.replaced_by && <span>被 #{m.replaced_by} 顶替</span>}
              </CardMeta>
              <div className="mt-2.5 flex gap-2">
                {editingId === m.id ? (
                  <>
                    <Button variant="primary" size="sm" disabled={saving} onClick={() => void save(m)}>
                      {saving ? "保存中…" : "保存"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    {m.source_seq_start ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={tracingId === m.id}
                        onClick={() => void showTrace(m)}
                      >
                        {tracingId === m.id ? "回溯中…" : "来源"}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => startEdit(m)}>
                      编辑
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={deletingId === m.id}
                      onClick={() => void remove(m)}
                    >
                      {deletingId === m.id ? "删除中…" : "删除"}
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ))
        )}
      </div>

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

      {trace ? (
        <Drawer title={`记忆 #${trace.id} 的来源`} onClose={() => setTrace(null)}>
          <div className="mb-3 rounded-[14px] border border-border bg-surface2 px-3 py-2.5 text-sm">
            <div className="font-semibold">{trace.content}</div>
            <div className="mt-1 text-xs text-muted">
              {trace.source
                ? `来源 ${trace.source.pool} · #${trace.source.from}${trace.source.to !== trace.source.from ? `-${trace.source.to}` : ""}`
                : "没有来源消息索引"}
            </div>
          </div>
          {trace.note ? <p className="text-sm text-muted">{trace.note}</p> : null}
          <div className="grid gap-2">
            {trace.messages.map((msg) => (
              <div
                key={msg.seq}
                className={`rounded-[12px] border px-3 py-2 text-sm ${
                  msg.anchor ? "border-accent bg-accent-soft" : "border-border bg-surface"
                }`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span className="font-mono">#{msg.seq}</span>
                  <span>{msg.local}</span>
                  <span className={msg.from_self ? "text-accent" : ""}>{msg.from_self ? "我" : msg.sender}</span>
                  {msg.anchor ? <Badge variant="done">来源</Badge> : null}
                </div>
                <div className="whitespace-pre-wrap break-words">{msg.text}</div>
              </div>
            ))}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
