import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { badgeVariant, formatTs, friendlyError } from "../lib/format.ts";
import type { Approval } from "../lib/types.ts";
import {
  Badge,
  Card,
  CardBody,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  Field,
  Select,
  StatusText,
} from "../components/ui.tsx";

export function ApprovalsPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [statusFilter, setStatusFilter] = useState("");
  const [rows, setRows] = useState<Approval[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      try {
        const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
        const data = await request<Approval[]>(`/v1/approvals${query}`);
        setRows(data);
        setStatus({ text: data.length ? "" : "没有权限申请。" });
      } catch (e) {
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, statusFilter],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load(false);
  }, [reloadSignal, load]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const aPriority = a.status === "pending" ? 0 : 1;
        const bPriority = b.status === "pending" ? 0 : 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        if (a.created_at !== b.created_at) return b.created_at - a.created_at;
        return b.id - a.id;
      }),
    [rows],
  );

  usePolling(() => load(true), 3000);

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <div className="my-3 flex flex-wrap items-end gap-3">
        <Field label="status" compact>
          <Select
            value={statusFilter}
            onValueChange={setStatusFilter}
            options={[
              { value: "", label: "全部（混合）" },
              { value: "pending", label: "pending" },
              { value: "approved", label: "approved" },
              { value: "rejected", label: "rejected" },
              { value: "timeout", label: "timeout" },
            ]}
          />
        </Field>
      </div>

      <StatusText text={status.text} error={status.error} />

      <div className="grid gap-2.5">
        {!sortedRows.length ? (
          <Empty>没有权限申请。审批请在飞书里完成。</Empty>
        ) : (
          sortedRows.map((a) => (
            <Card key={a.id}>
              <CardHead>
                <CardTitle>
                  <span className="font-mono text-[13px] font-semibold text-muted">#{a.id}</span>{" "}
                  {a.action || "（无 action）"}
                </CardTitle>
                <Badge variant={badgeVariant(a.status)}>{a.status}</Badge>
              </CardHead>
              <CardMeta>
                <span>task #{a.task_id}</span>
                <span>worker {a.worker_id || "—"}</span>
                <span>创建 {a.created_at_local || formatTs(a.created_at)}</span>
                <span>过期 {a.expires_at_local || formatTs(a.expires_at)}</span>
                {a.decided_at && (
                  <span>裁决 {a.decided_at_local || formatTs(a.decided_at)}</span>
                )}
              </CardMeta>
              {a.detail && <CardBody>detail：{a.detail}</CardBody>}
              {a.why && <CardBody>why：{a.why}</CardBody>}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
