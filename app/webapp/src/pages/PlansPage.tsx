import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { badgeVariant, friendlyError } from "../lib/format.ts";
import type { Plan } from "../lib/types.ts";
import {
  Badge,
  Card,
  CardBody,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  StatusText,
} from "../components/ui.tsx";

export function PlansPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Plan[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const data = await request<Plan[]>("/v1/plans");
      setRows(data);
      setStatus({ text: data.length ? "" : "没有待办计划。" });
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
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <StatusText text={status.text} error={status.error} />
      <div className="grid gap-2.5">
        {!rows.length ? (
          <Empty>没有待办计划。</Empty>
        ) : (
          rows.map((p) => (
            <Card key={p.id}>
              <CardHead>
                <CardTitle>
                  <span className="font-mono text-[13px] font-semibold text-muted">#{p.id}</span>{" "}
                  {p.title}
                </CardTitle>
                <Badge variant={badgeVariant(p.status)}>{p.status || "pending"}</Badge>
              </CardHead>
              <CardMeta>
                <Badge>{p.kind || "none"}</Badge>
                {p.pool && <span>池 {p.pool}</span>}
                {p.anchor && <span>锚点 {p.anchor}</span>}
                {p.next_fire_local ? (
                  <span>下次 {p.next_fire_local}</span>
                ) : (
                  p.schedule && <span>规则 {p.schedule}</span>
                )}
              </CardMeta>
              {p.why && <CardBody>{p.why}</CardBody>}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
