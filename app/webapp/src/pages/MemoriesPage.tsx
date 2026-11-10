import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { formatTs, friendlyError } from "../lib/format.ts";
import type { Memory } from "../lib/types.ts";
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
  StatusText,
  Textarea,
} from "../components/ui.tsx";

export function MemoriesPage({
  currentPool,
  detectedUser,
  reloadSignal,
}: {
  currentPool: string | null;
  detectedUser: string;
  reloadSignal: number;
}) {
  const request = useApi();
  const [user, setUser] = useState(detectedUser);
  const [rows, setRows] = useState<Memory[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [localTick, setLocalTick] = useState(0);

  useEffect(() => {
    setUser(detectedUser);
  }, [detectedUser]);

  useEffect(() => {
    if (!currentPool) {
      setRows([]);
      setStatus({ text: "先在「会话」页选一个池。" });
      return;
    }
    const u = user.trim();
    if (!u) {
      setRows([]);
      setStatus({ text: "这个池还没有识别到用户；可以手动填 user id 再查询。" });
      return;
    }
    let cancelled = false;
    setStatus({ text: "加载中…" });
    const timer = window.setTimeout(async () => {
      try {
        const data = await request<Memory[]>(
          `/v1/memories?user=${encodeURIComponent(u)}&pool=${encodeURIComponent(currentPool)}&all=1&limit=200`,
        );
        if (cancelled) return;
        setRows(data);
        setStatus({ text: data.length ? "" : "没有可见的记忆。" });
      } catch (e) {
        if (cancelled) return;
        setRows([]);
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [user, currentPool, reloadSignal, localTick, request]);

  const reload = useCallback(() => setLocalTick((n) => n + 1), []);

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditContent(m.content);
  };

  const save = async (m: Memory) => {
    const content = editContent.trim();
    if (!content) {
      setStatus({ text: "正文不能为空；不想留了就删除。", error: true });
      return;
    }
    setSaving(true);
    try {
      await request(`/v1/memories/${m.id}`, {
        method: "PUT",
        body: { user: user.trim(), content },
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
    if (!window.confirm(`删除记忆 #${m.id}？\n\n${m.content}`)) return;
    setDeletingId(m.id);
    try {
      await request(`/v1/memories/${m.id}?user=${encodeURIComponent(user.trim())}`, {
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

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <div className="my-3 grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
        <Field label="当前池">
          <Input readOnly placeholder="先在会话页选一个池" value={currentPool || ""} />
        </Field>
        <Field label="用户 user id">
          <Input
            type="text"
            placeholder="当前池暂无已识别用户"
            value={user}
            onChange={(e) => setUser(e.target.value)}
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
                <span>
                  有效 {formatTs(m.from)} → {m.to ? formatTs(m.to) : "至今"}
                </span>
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
    </div>
  );
}
