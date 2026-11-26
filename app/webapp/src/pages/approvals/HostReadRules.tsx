import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { formatTs, friendlyError } from "../../lib/format.ts";
import type { HostReadCheck, HostReadSettings } from "../../lib/types.ts";
import {
  Badge, Button, Chip, Input, Kpi, KpiGrid, Notice, Segmented, SectionTitle, StatusText,
} from "../../components/ui.tsx";
import { RULE_LABEL } from "./shared.ts";

const SOURCE_LABEL = { web: "管理台", config: "配置 readRoots", volume: "沙盒挂载" } as const;

const VERDICT_LABEL = { allow: "直接读", ask: "要审批", deny: "禁止" } as const;
const VERDICT_VARIANT = { allow: "done", ask: "warn", deny: "closed" } as const;

/** 白名单目录 + 未登记类型策略 + 路径试算 + 规则说明。 */
export function HostReadRules({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [settings, setSettings] = useState<HostReadSettings | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [newPath, setNewPath] = useState("");
  const [newNote, setNewNote] = useState("");
  const [checkPath, setCheckPath] = useState("");
  const [check, setCheck] = useState<HostReadCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await request<HostReadSettings>("/v1/host-read"));
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setStatus({ text: ok });
      await load();
    } catch (e) {
      setStatus({ text: friendlyError(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      await request("/v1/host-read/roots", { method: "POST", body: { path: newPath.trim(), note: newNote.trim() } });
      setNewPath("");
      setNewNote("");
    }, "已加入白名单。");

  const remove = (p: string) => {
    if (!window.confirm(`从白名单移除？\n${p}`)) return;
    void run(
      () => request(`/v1/host-read/roots?path=${encodeURIComponent(p)}`, { method: "DELETE" }),
      "已移除。",
    );
  };

  const setUnknown = (unknown: "ask" | "allow") =>
    run(() => request("/v1/host-read", { method: "PUT", body: { unknown } }), unknown === "allow" ? "未登记类型改为直接读。" : "未登记类型改为要审批。");

  const doCheck = async () => {
    if (!checkPath.trim()) return;
    try {
      setCheck(await request<HostReadCheck>(`/v1/host-read/check?path=${encodeURIComponent(checkPath.trim())}`));
    } catch (e) {
      setCheck(null);
      setStatus({ text: friendlyError(e), error: true });
    }
  };

  const day = settings?.stats.day ?? {};
  const week = settings?.stats.week ?? {};
  const asked = (s: typeof day) => (s.approved ?? 0) + (s.rejected ?? 0) + (s.timeout ?? 0);

  return (
    <div>
      <KpiGrid>
        <Kpi label="24 小时自动放行" value={day.auto ?? 0} note={`7 天 ${week.auto ?? 0}`} tone="accent" />
        <Kpi label="24 小时发生审批" value={asked(day)} note={`7 天 ${asked(week)}`} tone="amber" />
        <Kpi label="24 小时拒绝 / 超时" value={(day.rejected ?? 0) + (day.timeout ?? 0)} note={`7 天 ${(week.rejected ?? 0) + (week.timeout ?? 0)}`} tone="rose" />
        <Kpi label="白名单目录" value={settings?.roots.length ?? 0} />
      </KpiGrid>

      <StatusText text={status.text} error={status.error} />

      <SectionTitle count={settings ? `${settings.roots.length} 个` : undefined}>白名单目录</SectionTitle>
      <p className="mb-2 mt-0 text-[12px] text-muted">
        目录下的任何文件都直接读（包括未登记类型）。疑似密钥的文件在白名单目录里也照样要审批。
      </p>
      <div className="mb-2.5 flex flex-wrap gap-2">
        <Input
          className="min-w-[280px] flex-[2] py-1.5 font-mono text-[12px]"
          placeholder="/Users/you/projects/xxx 或 ~/projects/xxx"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newPath.trim() && void add()}
        />
        <Input
          className="min-w-[160px] flex-1 py-1.5 text-[12px]"
          placeholder="备注（可选）"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
        />
        <Button variant="primary" size="sm" disabled={busy || !newPath.trim()} onClick={() => void add()}>
          加入白名单
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        {settings?.roots.map((r) => (
          <div key={r.path} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2">
            <span className="min-w-0 flex-1 font-mono text-[12px] wrap-anywhere">{r.path}</span>
            {!r.exists ? <Badge variant="warn">目录不存在</Badge> : null}
            {r.note ? <span className="text-[11px] text-muted">{r.note}</span> : null}
            {r.added_at ? <span className="text-[10.5px] text-faint">{formatTs(r.added_at)}</span> : null}
            <Chip tone={r.source === "web" ? "accent" : "default"}>{SOURCE_LABEL[r.source]}</Chip>
            {r.source === "web" ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(r.path)}>
                移除
              </Button>
            ) : (
              <span className="text-[10.5px] text-faint" title="改 config/local.json">配置项</span>
            )}
          </div>
        ))}
      </div>

      <SectionTitle>未登记类型</SectionTitle>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={settings?.unknown ?? "ask"}
          options={[
            { value: "ask", label: "要审批" },
            { value: "allow", label: "直接读" },
          ]}
          onChange={(v) => void setUnknown(v)}
          label="未登记类型的处理"
        />
        <span className="text-[12px] text-muted">
          白名单目录外、既不是代码/文档也不像密钥的文件（如 .db、.sqlite、无扩展名）怎么处理。
        </span>
      </div>

      <SectionTitle>试算</SectionTitle>
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-[280px] flex-1 py-1.5 font-mono text-[12px]"
          placeholder="输入一个绝对路径，看看会怎么判"
          value={checkPath}
          onChange={(e) => setCheckPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void doCheck()}
        />
        <Button size="sm" onClick={() => void doCheck()}>试算</Button>
      </div>
      {check ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <Badge variant={VERDICT_VARIANT[check.verdict]}>{VERDICT_LABEL[check.verdict]}</Badge>
          <span className="text-muted">{RULE_LABEL[check.rule] ?? check.rule} · {check.why}</span>
          {check.path !== checkPath.trim() ? <span className="font-mono text-[11px] text-faint">实际路径 {check.path}</span> : null}
        </div>
      ) : null}

      <SectionTitle>规则顺序</SectionTitle>
      <Notice>
        <ol className="m-0 list-decimal space-y-1 pl-4">
          <li><b>禁止</b>：~/.ssh 私钥、GPG 私钥、系统钥匙串、浏览器登录数据、本 bot 的 env。审批也不给。</li>
          <li><b>疑似密钥要审批</b>：.env / .env.*、*.pem / *.key / *.p12、credentials、.npmrc / .netrc、secrets.*、*.tfvars，以及 .ssh / .aws / .kube / .secrets 目录下的文件。批准只放行这一次。</li>
          <li><b>白名单目录</b>：上面列出的目录，直接读。</li>
          <li><b>代码 / 文档</b>：常见源码、Markdown、JSON / YAML / TOML、日志、Dockerfile 等，直接读；.env.example 这类模板也算。</li>
          <li><b>其他</b>：按「未登记类型」的设置。</li>
        </ol>
        <p className="mb-0 mt-1.5">路径会先解开软链再判定。改白名单和策略要在管理台登录（API token 只能看）。</p>
      </Notice>
    </div>
  );
}
