import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { Skill } from "../../lib/types.ts";
import {
  Badge,
  Card,
  CardBody,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  StatusText,
} from "../../components/ui.tsx";

export function SkillsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Skill[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const data = await request<Skill[]>("/v1/skills");
      setRows(data);
      setStatus({ text: data.length ? "" : "没有发现技能。" });
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
      <StatusText text={status.text} error={status.error} />
      <div className="grid gap-2.5">
        {!rows.length ? (
          <Empty>没有发现技能。</Empty>
        ) : (
          rows.map((s) => (
            <Card key={s.name}>
              <CardHead>
                <CardTitle>{s.name}</CardTitle>
                <Badge variant={s.has_data ? "done" : "default"}>
                  {s.has_data ? "有 data" : "无 data"}
                </Badge>
              </CardHead>
              {s.description && <CardBody>{s.description}</CardBody>}
              <CardMeta>
                <span>{s.skill}</span>
                <span>{s.data}</span>
              </CardMeta>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
