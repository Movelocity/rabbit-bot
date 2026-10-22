/**
 * 无凭据时的“桩 LLM”：基于 pi-ai 自带的 faux provider，走真实的 pi 会话/工具/扩展流程，
 * 只是“模型”换成一段确定性脚本。用于模拟器和端到端测试。
 * 行为：对私聊/被@的未读消息回复「收到：…」；“/plan”写一条 1 分钟后的计划；“记住”写记忆；
 * “/loop”故意死循环以演示防死循环；计划到点时发提醒；交接提示时输出交接文档。
 */
import path from "node:path";
import fs from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai";

const textOf = (m: any): string => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join(""));

interface Parsed { pool: string; kind: "私聊" | "群聊"; uid: string; text: string; mention: boolean }

export function parseMessages(block: string): Parsed[] {
  const out: Parsed[] = [];
  let pool = "", kind: Parsed["kind"] = "私聊";
  for (const line of block.split("\n")) {
    const h = /^\[(p\d+) \S*?(私聊|群聊)「/.exec(line);
    if (h) { pool = h[1]; kind = h[2] as Parsed["kind"]; continue; }
    const m = /^#\d+ \S+ \S+ (.+?)\(([^)]+)\)(\[@我\])?: (.*)$/.exec(line);
    if (m && pool) out.push({ pool, kind, uid: m[2], text: m[4], mention: !!m[3] });
  }
  return out;
}

function turnToolCallsBefore(msgs: any[]): any {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].role === "assistant" ? msgs[i].content.filter((x: any) => x.type === "toolCall") : [];
    if (c.length) return c[c.length - 1];
  }
  return null;
}

function respond(context: any): any {
  const msgs = context.messages as any[];
  const last = msgs[msgs.length - 1];
  const lastUserIdx = msgs.map((m) => (m.role === "user" && !textOf(m).includes("loop-guard") ? "u" : "")).lastIndexOf("u");
  const turnToolCalls = msgs.slice(lastUserIdx).filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c: any) => c.type === "toolCall"));

  // 桩模型“固执”：收到 loop-guard 的警告仍继续重复，用来演示第 10 次被拦截并结束本轮
  if (last.role === "user" && textOf(last).includes("loop-guard")) {
    const lc = turnToolCallsBefore(msgs);
    if (lc) return fauxAssistantMessage(fauxToolCall(lc.name, lc.arguments));
  }
  if (last.role === "user") {
    const t = textOf(last);
    if (t.includes("请写一份交接文档")) {
      const pools = [...new Set([...msgs.map(textOf).join("\n").matchAll(/\[(p\d+) /g)].map((x) => x[1]))];
      return fauxAssistantMessage(`交接文档（桩）\n- 涉及池：${pools.join(",") || "无"}\n- 共 ${msgs.length} 条上下文消息\n- 无未完成承诺`);
    }
    const calls: any[] = [];
    const planBlock = /到点的计划：\n([\s\S]*?)(?:\n(?:近期上下文|记忆|未读消息|没有未读)|$)/.exec(t)?.[1] ?? "";
    for (const pl of planBlock.split("\n")) {
      const m = /^- 计划#(\d+)「(.+?)」.*?（池 (p\d+)）/.exec(pl);
      if (m) calls.push(fauxToolCall("send", { pool: m[3], content: `⏰ 提醒：${m[2]}` }));
    }
    const unread = t.split("未读消息：\n")[1] ?? "";
    const parsed = parseMessages(unread);
    const nowStr = /现在 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(t)?.[1];
    for (const p of parsed) {
      if (p.text.includes("/loop")) return fauxAssistantMessage(fauxToolCall("read_pool", { pool: p.pool, limit: 1 }));
    }
    const replyTo = new Map<string, Parsed>();
    for (const p of parsed) if (p.kind === "私聊" || p.mention) replyTo.set(p.pool, p);
    for (const [pool, p] of replyTo) {
      calls.push(fauxToolCall("send", { pool, content: `收到：${p.text}` }));
      if (p.text.includes("/plan") && nowStr) {
        const d = new Date(Date.parse(nowStr.replace(" ", "T") + ":00+08:00") + 60_000);
        const when = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16);
        calls.push(fauxToolCall("plan_add", { title: "一分钟后提醒", pool, kind: "once", when }));
      }
      if (p.text.includes("记住")) calls.push(fauxToolCall("memory_add", { user_id: p.uid, content: p.text, source_pool: pool }));
    }
    if (!calls.length) return fauxAssistantMessage(parsed.length ? "群里没人@我，先不说话。" : "无事可做。");
    return fauxAssistantMessage(calls);
  }

  if (last.role === "toolResult") {
    // 死循环演示：继续用同样参数调用
    const lastCall = turnToolCalls[turnToolCalls.length - 1];
    if (lastCall?.name === "read_pool" && turnToolCalls.length < 50) return fauxAssistantMessage(fauxToolCall("read_pool", lastCall.arguments));
    // send 返回里出现新的私聊/@消息 → 再回一条（最多 5 次）
    const r = textOf(last);
    if (r.includes("期间新消息：") && turnToolCalls.length < 5) {
      const parsed = parseMessages(r.split("期间新消息：\n")[1] ?? "").filter((p) => p.kind === "私聊" || p.mention);
      const p = parsed[parsed.length - 1];
      if (p) return fauxAssistantMessage(fauxToolCall("send", { pool: p.pool, content: `又收到：${p.text}` }));
    }
    const sends = turnToolCalls.filter((c: any) => c.name === "send").length;
    return fauxAssistantMessage(fauxText(`本轮结束：调用 ${turnToolCalls.length} 次工具，发送 ${sends} 条。`));
  }
  return fauxAssistantMessage("（无）");
}

export async function createFauxModel(dataDir: string): Promise<{ model: Model<any>; modelRuntime: ModelRuntime }> {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-brain", contextWindow: 200_000, maxTokens: 4096 }], tokensPerSecond: 100000 });
  const factory = (ctx: any) => { faux.appendResponses([factory]); return respond(ctx); };
  faux.setResponses([factory]);
  const piDir = path.join(dataDir, "pi-agent");
  fs.mkdirSync(piDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(piDir, "auth.json"), modelsPath: path.join(piDir, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  return { model: faux.getModel(), modelRuntime };
}
