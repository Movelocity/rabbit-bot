import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { cx } from "../../lib/cx.ts";
import { friendlyError } from "../../lib/format.ts";
import type { ExecutorInfo, ExecutorPreference } from "../../lib/types.ts";
import { Badge, Button, Card, StatusText } from "../../components/ui.tsx";

export function ExecutorsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setStatus({ text: "正在读取默认项并探测本地 CLI…" });
    try {
      const [list, pref] = await Promise.all([
        request<ExecutorInfo[]>("/v1/executors"),
        request<ExecutorPreference>("/v1/executor-preference"),
      ]);
      setExecutors(list);
      setCurrent(pref.executor);
      setSelected(pref.executor);
      setStatus({ text: list.length ? "" : "没有探测结果，请重新探测。", error: !list.length });
    } catch (e) {
      setStatus({ text: `读取失败：${friendlyError(e)}。请重新探测。`, error: true });
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, reloadSignal]);

  const save = async () => {
    if (busy.current || current === null || !selected || selected === current) return;
    busy.current = true;
    setSaving(true);
    setStatus({ text: "保存中…" });
    try {
      const pref = await request<ExecutorPreference>("/v1/executor-preference", {
        method: "PUT", body: { executor: selected },
      });
      setCurrent(pref.executor);
      setSelected(pref.executor);
      setStatus({ text: "已保存，新建任务默认使用此 CLI。" });
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(false);
      busy.current = false;
    }
  };

  const unavailable = executors.find((e) => e.name === selected)?.available === false;
  const changed = current !== null && selected !== current;

  return (
    <div className="max-w-5xl space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs text-muted">当前默认 CLI</p>
            <p className="mt-1 text-xl font-semibold">{current ?? (loading ? "读取中…" : "读取失败")}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">仅用于未指定执行器的新建任务，已有任务不受影响。</p>
          </div>
          <Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => void load()}>
            {loading ? "探测中…" : "重新探测"}
          </Button>
        </div>
      </Card>

      <fieldset disabled={loading || saving || current === null}>
        <legend className="mb-3 text-sm font-semibold">选择默认 CLI</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {executors.map((executor) => (
            <label key={executor.name} className={cx(
              "min-w-0 cursor-pointer rounded-[14px] border bg-surface p-4 transition focus-within:ring-2 focus-within:ring-accent/40",
              selected === executor.name ? "border-accent bg-accent-soft" : "border-border hover:border-accent/50",
              (loading || saving) && "cursor-wait opacity-60",
            )}>
              <div className="flex flex-wrap items-center gap-2">
                <input type="radio" name="executor" value={executor.name} checked={selected === executor.name}
                  className="accent-[var(--rb-accent)]" onChange={() => { setSelected(executor.name); setStatus({ text: "" }); }} />
                <span className="font-semibold">{executor.name}</span>
                <Badge variant={executor.available ? "done" : "closed"}>{executor.available ? "可用" : "不可用"}</Badge>
                {current === executor.name && <Badge variant="info">当前默认</Badge>}
              </div>
              <p className="mt-3 break-all text-xs text-muted">{executor.version || (executor.available ? "未返回版本信息" : "未安装或探测失败")}</p>
              <p className="mt-2 break-all font-mono text-xs text-muted">{executor.bin}</p>
              {!executor.available && executor.error && <p className="mt-2 break-all text-xs text-bad">{executor.error}</p>}
            </label>
          ))}
        </div>
      </fieldset>

      <Card>
        {unavailable && <p className="mb-3 text-sm text-amber">所选 CLI 当前不可用。可以先保存偏好，但执行任务前需完成安装并重新探测。</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">{changed ? `待保存：${current} → ${selected}` : "选择 CLI 后保存，重启后仍保留。"}</p>
          <Button variant="primary" disabled={!changed || !selected || loading || saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存默认 CLI"}
          </Button>
        </div>
        <div role="status" aria-live="polite"><StatusText text={status.text} error={status.error} /></div>
      </Card>
      <p className="text-xs leading-relaxed text-muted">CLI 需安装在运行 rabbit-bot 的主机上。探测成功表示命令可调用；实际执行任务还需对应 CLI 完成登录或配置凭据。</p>
    </div>
  );
}
