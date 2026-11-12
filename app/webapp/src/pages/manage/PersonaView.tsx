import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { RuntimeFile } from "../../lib/types.ts";
import { Button, Card, StatusText } from "../../components/ui.tsx";
import { Modal } from "../../components/Modal.tsx";

type PromptInfo = { name: string; source: "runtime" | "repo" };
type Editing = { kind: "persona" } | { kind: "prompt"; name: string };

const PROMPT_LABELS: Record<string, string> = {
  system: "系统提示词",
  "scene-message": "场景 · 有人说话",
  "scene-tick": "场景 · 定时检查",
  wake: "唤醒",
  handoff: "交接",
  "memory-review": "记忆梳理",
  "memory-review-system": "记忆梳理 · 系统",
  "voice-examples": "语气示例",
  "part-topics": "话题素材",
  watchdog: "看门狗 · 复核",
  "watchdog-system": "看门狗 · 系统",
};

const PROMPT_ORDER = [
  "system",
  "scene-message",
  "scene-tick",
  "wake",
  "handoff",
  "memory-review",
  "memory-review-system",
  "voice-examples",
  "part-topics",
  "watchdog",
  "watchdog-system",
];

const promptLabel = (name: string) => PROMPT_LABELS[name] ?? name;

function sortPrompts(rows: PromptInfo[]): PromptInfo[] {
  const rank = (name: string) => {
    const i = PROMPT_ORDER.indexOf(name);
    return i === -1 ? PROMPT_ORDER.length : i;
  };
  return [...rows].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function LineNumberEditor({
  value,
  onChange,
  onSave,
  disabled,
  wrap,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  disabled?: boolean;
  wrap: boolean;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [visualRows, setVisualRows] = useState<number[]>([]);
  const [widthTick, setWidthTick] = useState(0);
  const lines = value.split("\n");

  // 弹窗/窗口宽度变了要重新量；否则滚动条宽度一变，换行位置就错。
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidthTick((t) => t + 1));
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);

  // 换行模式下行号要按“视觉行”排：先量出每个逻辑行占几行，再给多出来的行补空号。
  useLayoutEffect(() => {
    if (!wrap) return;
    const el = mirrorRef.current;
    const ta = taRef.current;
    if (!el || !ta) return;
    el.style.width = `${ta.clientWidth}px`; // 和 textarea 的内容宽度对齐，扣掉滚动条
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const rows = Array.from(el.children).map((c) =>
      Math.max(1, Math.round((c as HTMLElement).offsetHeight / lh)),
    );
    setVisualRows(rows);
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, [value, wrap, widthTick]);

  const gutterRows: { num: number | null }[] = [];
  lines.forEach((_, i) => {
    const n = wrap ? (visualRows[i] ?? 1) : 1;
    for (let k = 0; k < n; k++) gutterRows.push({ num: k === 0 ? i + 1 : null });
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    onChange(value.slice(0, start) + "  " + value.slice(end));
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 2;
    });
  };

  return (
    <div className="flex h-[56vh] min-h-[320px] overflow-hidden rounded-[9px] border border-border bg-surface">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="h-full flex-none select-none overflow-hidden border-r border-border bg-surface2 px-2 py-2 text-right font-mono text-[15px] leading-[1.6] tabular-nums text-muted"
      >
        {gutterRows.map((row, i) => (
          <div key={i}>{row.num ?? ""}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <textarea
          ref={taRef}
          className="relative z-10 h-full w-full resize-none overflow-auto break-words border-0 bg-transparent p-2 font-mono text-[15px] leading-[1.6] outline-none disabled:opacity-60"
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={onKeyDown}
        />
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="invisible absolute left-0 top-0 h-full overflow-hidden whitespace-pre-wrap break-words p-2 font-mono text-[15px] leading-[1.6]"
        >
          {lines.map((line, i) => (
            <div key={i}>{line || " "}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PersonaView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [persona, setPersona] = useState<RuntimeFile | null>(null);
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [charCounts, setCharCounts] = useState<Record<string, number>>({});
  const [totalChars, setTotalChars] = useState<number | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const [editing, setEditing] = useState<Editing | null>(null);
  const [editFile, setEditFile] = useState<RuntimeFile | null>(null);
  const [editText, setEditText] = useState("");
  const [editStatus, setEditStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [wrap, setWrap] = useState(true);
  const editReq = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setStatus({ text: "加载中…" });
    try {
      const [p, list] = await Promise.all([
        request<RuntimeFile>("/v1/persona"),
        request<PromptInfo[]>("/v1/prompts"),
      ]);
      const sorted = sortPrompts(list);
      const contents = await Promise.all(
        sorted.map(async (item) => {
          try {
            const file = await request<RuntimeFile>(`/v1/prompts/${encodeURIComponent(item.name)}`);
            return file.content ?? "";
          } catch {
            return "";
          }
        }),
      );
      setPersona(p);
      setPrompts(sorted);
      const counts: Record<string, number> = { persona: p.content?.length ?? 0 };
      sorted.forEach((item, i) => {
        counts[item.name] = contents[i].length;
      });
      setCharCounts(counts);
      setTotalChars(Object.values(counts).reduce((sum, n) => sum + n, 0));
      setStatus({ text: "" });
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

  const openEditor = async (target: Editing) => {
    const id = ++editReq.current;
    setEditing(target);
    setEditFile(null);
    setEditText("");
    setEditStatus({ text: "加载中…" });
    try {
      const file =
        target.kind === "persona"
          ? await request<RuntimeFile>("/v1/persona")
          : await request<RuntimeFile>(`/v1/prompts/${encodeURIComponent(target.name)}`);
      if (editReq.current !== id) return;
      setEditFile(file);
      setEditText(file.content ?? "");
      setEditStatus({ text: "" });
    } catch (e) {
      if (editReq.current !== id) return;
      setEditStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  };

  const closeEditor = useCallback(() => {
    editReq.current++;
    setEditing(null);
    setEditFile(null);
    setEditText("");
    setEditStatus({ text: "" });
  }, []);

  const saveEdit = async () => {
    if (!editing) return;
    setEditSaving(true);
    setEditStatus({ text: "保存中…" });
    try {
      const saved =
        editing.kind === "persona"
          ? await request<RuntimeFile>("/v1/persona", {
              method: "PUT",
              body: { content: editText },
            })
          : await request<RuntimeFile>(`/v1/prompts/${encodeURIComponent(editing.name)}`, {
              method: "PUT",
              body: { content: editText },
            });
      setEditFile(saved);
      setEditStatus({ text: "已保存，下一轮生效。" });
      if (editing.kind === "persona") setPersona(saved);
      void load(true);
    } catch (e) {
      setEditStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setEditSaving(false);
    }
  };

  const editTitle =
    editing?.kind === "persona"
      ? "编辑人设"
      : editing?.kind === "prompt"
        ? `编辑提示词 · ${promptLabel(editing.name)}`
        : "";
  const countText = (key: string) =>
    charCounts[key] === undefined ? "" : `${charCounts[key].toLocaleString("zh-CN")} 字`;

  return (
    <>
      <StatusText text={status.text} error={status.error} />
      <Card className="mt-3 flex min-w-0 flex-col gap-2">
        <div className="text-base font-semibold">
          人设与提示词
          <span className="mt-0.5 block text-[13px] font-normal text-muted">
            {totalChars === null
              ? "统计中…"
              : `${prompts.length + 1} 个文件 · 共 ${totalChars.toLocaleString("zh-CN")} 字`}
          </span>
        </div>
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium">人设</div>
              <div className="mt-0.5 truncate text-[13px] text-muted">
                persona.md · {persona?.source ?? "加载中…"}
              </div>
            </div>
            <span className="flex-none text-[13px] tabular-nums text-muted">
              {countText("persona")}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void openEditor({ kind: "persona" })}>
              编辑
            </Button>
          </div>
          {prompts.length === 0 ? (
            <div className="px-3 py-6 text-center text-[15px] text-muted">没有提示词文件</div>
          ) : (
            prompts.map((p) => (
              <div key={p.name} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium">{promptLabel(p.name)}</div>
                  <div className="mt-0.5 truncate text-[13px] text-muted">
                    {p.name}.md · {p.source}
                  </div>
                </div>
                <span className="flex-none text-[13px] tabular-nums text-muted">
                  {countText(p.name)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void openEditor({ kind: "prompt", name: p.name })}
                >
                  编辑
                </Button>
              </div>
            ))
          )}
        </div>
      </Card>

      {editing && (
        <Modal title={editTitle} onClose={closeEditor} backdropBlur={false}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 truncate text-[13px] text-muted">
              {editFile ? `${editFile.source} · ${editFile.path}` : "加载中…"}
            </div>
            <div className="flex flex-none items-center gap-3 text-[13px] text-muted">
              <button
                type="button"
                aria-pressed={wrap}
                onClick={() => setWrap((v) => !v)}
                className="rounded-full border border-border px-2 py-0.5 transition hover:bg-surface2"
              >
                自动换行：{wrap ? "开" : "关"}
              </button>
              <span className="tabular-nums">
                {editText.split("\n").length} 行 · {editText.length} 字
              </span>
            </div>
          </div>
          <LineNumberEditor
            value={editText}
            onChange={setEditText}
            onSave={() => void saveEdit()}
            disabled={editFile === null || editSaving}
            wrap={wrap}
          />
          {editStatus.text && (
            <div className="mt-2">
              <StatusText text={editStatus.text} error={editStatus.error} />
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={editSaving} onClick={closeEditor}>
              关闭
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={editFile === null || editSaving}
              onClick={() => void saveEdit()}
            >
              {editSaving ? "保存中…" : "保存"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
