import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { usePolling } from "../../lib/use-polling.ts";
import { badgeVariant, formatTs, friendlyError } from "../../lib/format.ts";
import type { Worker } from "../../lib/types.ts";
import {
  Badge,
  Card,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  StatusText,
} from "../../components/ui.tsx";

export function WorkersView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Worker[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      try {
        const data = await request<Worker[]>("/v1/workers");
        setRows(data);
        setStatus({ text: data.length ? "" : "还没有注册 worker。" });
      } catch (e) {
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load(false);
  }, [reloadSignal, load]);

  usePolling(() => load(true), 3000);

  return (
    <>
      <StatusText text={status.text} error={status.error} />
      <div className="grid gap-2.5">
        {!rows.length ? (
          <Empty>还没有注册 worker。</Empty>
        ) : (
          rows.map((w) => (
            <Card key={w.worker_id}>
              <CardHead>
                <CardTitle>{w.name || w.worker_id}</CardTitle>
                <Badge variant={badgeVariant(w.status)}>{w.status}</Badge>
              </CardHead>
              <CardMeta>
                <span>worker_id {w.worker_id}</span>
                <span>kind {w.kind || "—"}</span>
                <span>last_seen {formatTs(w.last_seen_at)}</span>
              </CardMeta>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
