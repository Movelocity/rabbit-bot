import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { usePolling } from "../../lib/use-polling.ts";
import { formatTs, friendlyError } from "../../lib/format.ts";
import type { HostReadLogRow, HostReadSettings } from "../../lib/types.ts";
import { Badge, Button, Empty, Input, Segmented, StatusText } from "../../components/ui.tsx";
import { ancestorDirs, OUTCOME_LABEL, OUTCOME_VARIANT, RULE_LABEL } from "./shared.ts";

type Filter = "" | "asked" | "auto" | "denied";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "", label: "全部" },
  { value: "asked", label: "发生审批" },
  { value: "auto", label: "自动放行" },
  { value: "denied", label: "禁止" },
];

const PAGE = 100;

/** 宿主文件读取记录：每次 read_file scope=host 一行，能直接把所在目录加白名单。 */
export function HostReadLog({ onChanged }: { onChanged?: () => void }) {
  const request = useApi();
  const [filter, setFilter] = useState<Filter>("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<HostReadLogRow[]>([]);
  const [more, setMore] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  /** 正在选「加哪一级目录」的那一行 */
  const [picking, setPicking] = useState<number | null>(null);

  const query = useCallback(
    (before?: number) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (filter) p.set("outcome", filter);
      if (q.trim()) p.set("q", q.trim());
      if (before) p.set("before", String(before));
      return `/v1/host-read/log?${p}`;
    },
    [filter, q],
  );

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      try {
        const [data, settings] = await Promise.all([
          request<HostReadLogRow[]>(query()),
          request<HostReadSettings>("/v1/host-read"),
        ]);
        setRows(data);
        setMore(data.length === PAGE);
        setRoots(settings.roots.map((r) => r.path));
        setStatus({ text: "" });
      } catch (e) {
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, query],
  );

  useEffect(() => {
    void load(false);
  }, [load]);
  usePolling(() => load(true), 5000, picking === null);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    try {
      const data = await request<HostReadLogRow[]>(query(last.id));
      setRows((prev) => [...prev, ...data]);
      setMore(data.length === PAGE);
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  };

  const addRoot = async (dir: string) => {
    try {
      await request("/v1/host-read/roots", { method: "POST", body: { path: dir, note: "从读取记录添加" } });
      setPicking(null);
      setStatus({ text: `已加入白名单：${dir}` });
      onChanged?.();
      await load(true);
    } catch (e) {
      setStatus({ text: `没加上：${friendlyError(e)}`, error: true });
    }
  };

  const covered = (p: string) => roots.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented value={filter} options={FILTERS} onChange={setFilter} label="按结果筛选" />
        <Input
          className="max-w-[320px] py-1.5 text-[12.5px]"
          placeholder="按路径搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <StatusText text={status.text} error={status.error} />

      {!rows.length ? (
        <Empty>还没有读取记录。UFA 用 read_file 读本机文件时会记在这里。</Empty>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => {
            const inRoot = covered(row.path);
            // 密钥和硬禁区加了目录也照样问，不给按钮免得误会
            const canAdd = !inRoot && row.rule !== "secret" && row.rule !== "deny";
            return (
              <div key={row.id} className="rounded-[10px] border border-border bg-surface px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="tabular-nums text-faint">{formatTs(row.ts)}</span>
                  <Badge variant={OUTCOME_VARIANT[row.outcome] ?? "default"}>
                    {OUTCOME_LABEL[row.outcome] ?? row.outcome}
                  </Badge>
                  <span className="text-muted">
                    {RULE_LABEL[row.rule] ?? row.rule}
                    {row.why ? ` · ${row.why}` : ""}
                  </span>
                  {row.approval_id ? <span className="font-mono text-[10.5px] text-faint">审批 #{row.approval_id}</span> : null}
                  {row.by ? <span className="text-[10.5px] text-faint">by {row.by}</span> : null}
                  <span className="flex-1" />
                  {canAdd ? (
                    <Button size="sm" variant="ghost" onClick={() => setPicking(picking === row.id ? null : row.id)}>
                      {picking === row.id ? "收起" : "加目录到白名单"}
                    </Button>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-[11.5px] wrap-anywhere">{row.path}</div>
                {picking === row.id ? (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
                    <span className="self-center text-[11px] text-muted">选一级：</span>
                    {ancestorDirs(row.path).map((dir) => (
                      <Button key={dir} size="sm" onClick={() => void addRoot(dir)}>
                        <span className="font-mono text-[11px]">{dir}</span>
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {more ? (
            <Button variant="ghost" size="sm" className="mt-1.5 self-center" onClick={() => void loadMore()}>
              加载更早的
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
