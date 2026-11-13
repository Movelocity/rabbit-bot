import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { WorkingMemory } from "../../lib/types.ts";
import { Badge, Button, Card, CardMeta, Empty, StatusText } from "../../components/ui.tsx";

export function WorkingMemoryView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [data, setData] = useState<WorkingMemory | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const next = await request<WorkingMemory>("/v1/working-memory");
      setData(next);
      setStatus({ text: next.content ? "" : "memory.md 还是空的。" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant={data?.truncated ? "warn" : "default"}>
          {data ? `${data.chars} / ${data.limit} 字` : "—"}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          刷新
        </Button>
      </div>
      <StatusText text={status.text} error={status.error} />
      {data ? (
        <Card>
          <CardMeta>
            <span className="font-mono wrap-anywhere">{data.path}</span>
          </CardMeta>
          <pre className="rb-thin-scroll mt-3 max-h-[calc(100dvh-320px)] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-[10px] border border-border bg-surface2 p-3.5 font-mono text-[12px] leading-[1.7]">
            {data.content || "（空）"}
          </pre>
        </Card>
      ) : (
        <Empty>读不到 memory.md。</Empty>
      )}
    </>
  );
}
