import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError, num } from "../../lib/format.ts";
import type {
  ContextLimitSettings, LimitStatus, MemoryReviewSettings, SchedulerSettings, SendReviewSettings,
  SendReviewSettingsResponse, WatchdogSettings,
} from "../../lib/types.ts";
import {
  Button, Card, CardBody, CardHead, CardTitle, Field, Input, Kpi, KpiGrid, Select, StatusText,
} from "../../components/ui.tsx";

const DEFAULT_MEMORY_REVIEW: MemoryReviewSettings = {
  enabled: false,
  everyTurns: 10,
  minIntervalSec: 300,
};

const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: false,
  delayMs: 10000,
  cooldownMs: 600000,
};

const DEFAULT_SEND_REVIEW: SendReviewSettings = {
  enabled: false,
  defaultReview: false,
  primaryPoolId: null,
  overrides: {},
};

export function SettingsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [privateSec, setPrivateSec] = useState("");
  const [groupSec, setGroupSec] = useState("");
  const [taskSec, setTaskSec] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [saving, setSaving] = useState(false);

  const [memoryReview, setMemoryReview] = useState<MemoryReviewSettings>(DEFAULT_MEMORY_REVIEW);
  const [memoryStatus, setMemoryStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [memorySaving, setMemorySaving] = useState(false);

  const [watchdog, setWatchdog] = useState<WatchdogSettings>(DEFAULT_WATCHDOG);
  const [watchdogStatus, setWatchdogStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [watchdogSaving, setWatchdogSaving] = useState(false);

  const [sendReview, setSendReview] = useState<SendReviewSettings>(DEFAULT_SEND_REVIEW);
  const [sendReviewReady, setSendReviewReady] = useState(true);
  const [sendReviewStatus, setSendReviewStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [sendReviewSaving, setSendReviewSaving] = useState(false);

  const [limits, setLimits] = useState<LimitStatus | null>(null);
  const [limitsStatus, setLimitsStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [limitsSaving, setLimitsSaving] = useState(false);

  const [contextLimit, setContextLimit] = useState<ContextLimitSettings | null>(null);
  const [contextLimitStatus, setContextLimitStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [contextLimitSaving, setContextLimitSaving] = useState(false);

  const apply = useCallback((s: SchedulerSettings) => {
    setPrivateSec(String(Math.round(Number(s.privateWakeMs) / 1000)));
    setGroupSec(String(Math.round(Number(s.groupWakeMs) / 1000)));
    setTaskSec(String(Math.round(Number(s.taskWakeMs) / 1000)));
  }, []);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    setMemoryStatus({ text: "加载中…" });
    setWatchdogStatus({ text: "加载中…" });
    setSendReviewStatus({ text: "加载中…" });
    setLimitsStatus({ text: "加载中…" });
    setContextLimitStatus({ text: "加载中…" });
    try {
      const [s, m, w, sr, ls, cl] = await Promise.all([
        request<SchedulerSettings>("/v1/scheduler"),
        request<MemoryReviewSettings>("/v1/memory-review"),
        request<WatchdogSettings>("/v1/watchdog"),
        request<SendReviewSettingsResponse>("/v1/send-review"),
        request<LimitStatus>("/v1/limits"),
        request<ContextLimitSettings>("/v1/context-limit"),
      ]);
      apply(s);
      setMemoryReview(m);
      setWatchdog(w);
      setLimits(ls);
      setContextLimit(cl);
      setSendReview({
        enabled: sr.enabled,
        defaultReview: sr.defaultReview,
        primaryPoolId: sr.primaryPoolId ?? null,
        overrides: sr.overrides ?? {},
      });
      setSendReviewReady(sr.ready !== false);
      setStatus({ text: "" });
      setMemoryStatus({ text: "" });
      setWatchdogStatus({ text: "" });
      setSendReviewStatus({ text: "" });
      setLimitsStatus({ text: "" });
      setContextLimitStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      setMemoryStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      setWatchdogStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      setSendReviewStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      setLimitsStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      setContextLimitStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const save = async () => {
    const fields: [keyof SchedulerSettings, string, string][] = [
      ["privateWakeMs", privateSec, "私聊唤醒间隔"],
      ["groupWakeMs", groupSec, "群聊唤醒间隔"],
      ["taskWakeMs", taskSec, "任务群唤醒间隔"],
    ];
    const body = {} as SchedulerSettings;
    for (const [key, raw, label] of fields) {
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        setStatus({ text: `${label}必须大于 0 秒`, error: true });
        return;
      }
      body[key] = Math.round(seconds * 1000);
    }
    setSaving(true);
    setStatus({ text: "保存中…" });
    try {
      apply(
        await request<SchedulerSettings>("/v1/scheduler", {
          method: "PUT",
          body,
        }),
      );
      setStatus({ text: "已保存并生效" });
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  const saveMemoryReview = async () => {
    setMemorySaving(true);
    setMemoryStatus({ text: "保存中…" });
    try {
      setMemoryReview(
        await request<MemoryReviewSettings>("/v1/memory-review", {
          method: "PUT",
          body: memoryReview,
        }),
      );
      setMemoryStatus({ text: "已保存并生效" });
    } catch (e) {
      setMemoryStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setMemorySaving(false);
    }
  };

  const saveWatchdog = async () => {
    setWatchdogSaving(true);
    setWatchdogStatus({ text: "保存中…" });
    try {
      setWatchdog(
        await request<WatchdogSettings>("/v1/watchdog", {
          method: "PUT",
          body: watchdog,
        }),
      );
      setWatchdogStatus({ text: "已保存并生效" });
    } catch (e) {
      setWatchdogStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setWatchdogSaving(false);
    }
  };

  const saveSendReview = async () => {
    setSendReviewSaving(true);
    setSendReviewStatus({ text: "保存中…" });
    try {
      const saved = await request<SendReviewSettingsResponse>("/v1/send-review", {
        method: "PUT",
        body: {
          enabled: sendReview.enabled,
          defaultReview: sendReview.defaultReview,
          primaryPoolId: sendReview.primaryPoolId,
          overrides: sendReview.overrides,
        },
      });
      setSendReview({
        enabled: saved.enabled,
        defaultReview: saved.defaultReview,
        primaryPoolId: saved.primaryPoolId ?? null,
        overrides: saved.overrides ?? {},
      });
      setSendReviewReady(saved.ready !== false);
      setSendReviewStatus({ text: "已保存并生效" });
    } catch (e) {
      setSendReviewStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSendReviewSaving(false);
    }
  };

  const saveLimits = async () => {
    if (!limits) return;
    setLimitsSaving(true);
    setLimitsStatus({ text: "保存中…" });
    try {
      setLimits(
        await request<LimitStatus>("/v1/limits", {
          method: "PUT",
          body: {
            dailyLlmCalls: limits.dailyLlmCalls,
            dailyTokens: limits.dailyTokens,
            dailyCny: limits.dailyCny,
          },
        }),
      );
      setLimitsStatus({ text: "已保存，下一轮唤醒生效" });
    } catch (e) {
      setLimitsStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setLimitsSaving(false);
    }
  };

  const saveContextLimit = async () => {
    if (!contextLimit) return;
    setContextLimitSaving(true);
    setContextLimitStatus({ text: "保存中…" });
    try {
      setContextLimit(
        await request<ContextLimitSettings>("/v1/context-limit", {
          method: "PUT",
          body: { tokenLimit: contextLimit.tokenLimit },
        }),
      );
      setContextLimitStatus({ text: "已保存，下一轮唤醒生效" });
    } catch (e) {
      setContextLimitStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setContextLimitSaving(false);
    }
  };

  const setLimitNumber = (key: keyof Pick<LimitStatus, "dailyLlmCalls" | "dailyTokens" | "dailyCny">, raw: string) => {
    setLimits((x) => (x ? { ...x, [key]: raw === "" ? 0 : Number(raw) } : x));
  };

  return (
    <>
      <Card>
        <CardHead>
          <CardTitle>唤醒间隔</CardTitle>
        </CardHead>
        <CardBody>
          <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
            <Field label="私聊唤醒间隔（秒）">
              <Input
                type="number"
                min={1}
                step={1}
                value={privateSec}
                onChange={(e) => setPrivateSec(e.target.value)}
              />
            </Field>
            <Field label="群聊唤醒间隔（秒）">
              <Input
                type="number"
                min={1}
                step={1}
                value={groupSec}
                onChange={(e) => setGroupSec(e.target.value)}
              />
            </Field>
            <Field label="任务群唤醒间隔（秒）">
              <Input
                type="number"
                min={1}
                step={1}
                value={taskSec}
                onChange={(e) => setTaskSec(e.target.value)}
              />
            </Field>
          </div>
          <div className="my-3">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
          <StatusText text={status.text} error={status.error} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHead>
          <CardTitle>日额度</CardTitle>
        </CardHead>
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            每天到量后不再唤醒模型。调用次数 / 折算 token 填 <code>-1</code> 表示不限；花费上限填 <code>0</code> 表示不按钱限额。
            保存后下一轮唤醒生效，重启仍保留。
          </p>
          {limits ? (
            <>
              <KpiGrid>
                <Kpi
                  label={`今日调用（${limits.today.day}）`}
                  value={num(limits.today.llm_calls)}
                  note={limits.dailyLlmCalls < 0 ? "额度不限" : `剩 ${num(limits.today.calls_left ?? 0)} 次`}
                />
                <Kpi
                  label="今日折算 token"
                  value={num(limits.today.tokens)}
                  note={limits.dailyTokens < 0 ? "额度不限" : `剩 ${num(limits.today.tokens_left ?? 0)}`}
                />
                <Kpi
                  label="今日花费"
                  value={`¥${Number(limits.today.cost_cny || 0).toFixed(2)}`}
                  note={limits.dailyCny > 0 ? `剩 ¥${Number(limits.today.cny_left ?? 0).toFixed(2)}` : "额度不限"}
                />
              </KpiGrid>
              <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
                <Field label="每日调用次数（-1 不限）">
                  <Input
                    type="number"
                    min={-1}
                    step={1}
                    value={limits.dailyLlmCalls}
                    onChange={(e) => setLimitNumber("dailyLlmCalls", e.target.value)}
                  />
                </Field>
                <Field label="每日折算 token（-1 不限）">
                  <Input
                    type="number"
                    min={-1}
                    step={1}
                    value={limits.dailyTokens}
                    onChange={(e) => setLimitNumber("dailyTokens", e.target.value)}
                  />
                </Field>
                <Field label="每日花费上限（元，0 = 不限）">
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={limits.dailyCny}
                    onChange={(e) => setLimitNumber("dailyCny", e.target.value)}
                  />
                </Field>
              </div>
              <div className="my-3">
                <Button variant="primary" disabled={limitsSaving} onClick={() => void saveLimits()}>
                  {limitsSaving ? "保存中…" : "保存"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">正在读取额度…</p>
          )}
          <StatusText text={limitsStatus.text} error={limitsStatus.error} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHead>
          <CardTitle>上下文交接</CardTitle>
        </CardHead>
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            上下文涨到这一档就写交接文档、换一个新会话，避免越聊越贵。避免长上下文降智。
          </p>
          {contextLimit ? (
            <>
              <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
                <Field label="上下文上限">
                  <Select
                    value={String(contextLimit.tokenLimit)}
                    onValueChange={(value) => setContextLimit((x) => (x ? { ...x, tokenLimit: Number(value) } : x))}
                    options={[
                      { value: "60000", label: "60k" },
                      { value: "100000", label: "100k" },
                      { value: "200000", label: "200k" },
                      { value: "500000", label: "500k" },
                      { value: "800000", label: "800k" },
                    ]}
                    ariaLabel="上下文交接阈值"
                  />
                </Field>
              </div>
              <div className="my-3">
                <Button variant="primary" disabled={contextLimitSaving} onClick={() => void saveContextLimit()}>
                  {contextLimitSaving ? "保存中…" : "保存"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">正在读取上下文阈值…</p>
          )}
          <StatusText text={contextLimitStatus.text} error={contextLimitStatus.error} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHead>
          <CardTitle>后台记忆梳理</CardTitle>
        </CardHead>
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            到点后另起一个只带 `memory` 工具的会话，把最近的对话里值得留下的事实整理出来。技能和业务关系不走这里。默认关闭。
          </p>
          <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
            <Field label="总开关">
              <Select
                value={memoryReview.enabled ? "on" : "off"}
                onValueChange={(value) => setMemoryReview((x) => ({ ...x, enabled: value === "on" }))}
                options={[
                  { value: "off", label: "关闭" },
                  { value: "on", label: "开启" },
                ]}
                ariaLabel="后台记忆梳理总开关"
              />
            </Field>
            <Field label="每 N 个用户回合">
              <Input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={memoryReview.everyTurns}
                onChange={(e) => setMemoryReview((x) => ({ ...x, everyTurns: Number(e.target.value) }))}
              />
            </Field>
            <Field label="最小间隔（秒）">
              <Input
                type="number"
                min={30}
                max={86400}
                step={1}
                value={memoryReview.minIntervalSec}
                onChange={(e) => setMemoryReview((x) => ({ ...x, minIntervalSec: Number(e.target.value) }))}
              />
            </Field>
          </div>
          <div className="my-3">
            <Button variant="primary" disabled={memorySaving} onClick={() => void saveMemoryReview()}>
              {memorySaving ? "保存中…" : "保存"}
            </Button>
          </div>
          <StatusText text={memoryStatus.text} error={memoryStatus.error} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHead>
          <CardTitle>发完消息后的看门狗</CardTitle>
        </CardHead>
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            发完消息后静默 N 秒，另起一个无工具会话复核最后一条：如果是「万事俱备、只欠用户点头」的项目内动作，
            就往池里插一条系统消息并立即执行。待办是发聊天消息、要用户做业务取舍或给权限时不会自动放行。
            提示词在「人设与提示词」里改 <code>watchdog</code> 和 <code>watchdog-system</code>。默认关闭。
          </p>
          <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
            <Field label="总开关">
              <Select
                value={watchdog.enabled ? "on" : "off"}
                onValueChange={(value) => setWatchdog((x) => ({ ...x, enabled: value === "on" }))}
                options={[
                  { value: "off", label: "关闭" },
                  { value: "on", label: "开启" },
                ]}
                ariaLabel="看门狗总开关"
              />
            </Field>
            <Field label="静默多久后复核（秒）">
              <Input
                type="number"
                min={1}
                max={3600}
                step={1}
                value={Math.round(watchdog.delayMs / 1000)}
                onChange={(e) => setWatchdog((x) => ({ ...x, delayMs: Number(e.target.value) * 1000 }))}
              />
            </Field>
            <Field label="同一池冷却（秒）">
              <Input
                type="number"
                min={0}
                max={86400}
                step={1}
                value={Math.round(watchdog.cooldownMs / 1000)}
                onChange={(e) => setWatchdog((x) => ({ ...x, cooldownMs: Number(e.target.value) * 1000 }))}
              />
            </Field>
          </div>
          <div className="my-3">
            <Button variant="primary" disabled={watchdogSaving} onClick={() => void saveWatchdog()}>
              {watchdogSaving ? "保存中…" : "保存"}
            </Button>
          </div>
          <StatusText text={watchdogStatus.text} error={watchdogStatus.error} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHead>
          <CardTitle>发送审核</CardTitle>
        </CardHead>
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            agent 发出的消息先在审批房预览，主人贴 OK / 👍 才真正发到聊天；贴 No / 👎 或超时就不发。
            按会话的开关在「会话」页顶部：主聊天（main chat）默认直接发，任务汇报也只发主聊天；需要审的群单独打开。默认关闭。
          </p>
          {!sendReviewReady && (
            <p className="mb-3 text-sm text-bad">
              审批房还没配好：先在 config/local.json 的 sendReview（或 approval）里填 platform / roomId / ownerIds，重启后才能打开。
            </p>
          )}
          <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
            <Field label="总开关">
              <Select
                value={sendReview.enabled ? "on" : "off"}
                onValueChange={(value) => setSendReview((x) => ({ ...x, enabled: value === "on" }))}
                options={[
                  { value: "off", label: "关闭（全部直接发）" },
                  { value: "on", label: "开启" },
                ]}
                ariaLabel="发送审核总开关"
              />
            </Field>
            <Field label="未单独设置的会话">
              <Select
                value={sendReview.defaultReview ? "review" : "direct"}
                onValueChange={(value) => setSendReview((x) => ({ ...x, defaultReview: value === "review" }))}
                options={[
                  { value: "review", label: "需审批" },
                  { value: "direct", label: "直接发送" },
                ]}
                ariaLabel="发送审核默认策略"
              />
            </Field>
          </div>

          <div className="my-3">
            <Button variant="primary" disabled={sendReviewSaving} onClick={() => void saveSendReview()}>
              {sendReviewSaving ? "保存中…" : "保存"}
            </Button>
          </div>
          <StatusText text={sendReviewStatus.text} error={sendReviewStatus.error} />
        </CardBody>
      </Card>

    </>
  );
}
