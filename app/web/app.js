(() => {
  "use strict";

  const TOKEN_KEY = "rabbit-bot.api-token";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    pools: [],
    current: null,
    messages: [],
    total: 0,
    oldestSeq: null,
    tab: "chat",
    loadingMessages: false,
    pollTimer: null,
    memUser: "",
    personaLoaded: false,
    tasks: [],
    taskStatus: "",
    expandedTaskId: null,
    taskSnapshots: {},
    approvals: [],
    approvalStatus: "pending",
    workers: [],
    logoutRequested: false,
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function kindLabel(kind) {
    return kind === "private" ? "私聊" : kind === "group" ? "群聊" : String(kind || "");
  }

  function formatTs(ms) {
    if (!ms) return "";
    try {
      return new Date(Number(ms)).toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return String(ms);
    }
  }

  async function rawFetch(path, opts = {}, tokenOverride) {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const tok = tokenOverride === undefined ? state.token : tokenOverride;
    if (tok) headers.authorization = `Bearer ${tok}`;
    const res = await fetch(path, Object.assign({}, opts, { headers, cache: "no-store" }));
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { res, body };
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET" };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const { res, body } = await rawFetch(path, init);
    if (res.status === 401) {
      showLogin("token 不对或已失效，请重新输入");
      throw new Error("未登录");
    }
    if (!res.ok || !body || body.ok !== true) {
      throw new Error((body && body.error) || `HTTP ${res.status}`);
    }
    return body.data;
  }

  function setHealth(ok, text) {
    const dot = $("#health-dot");
    dot.classList.toggle("ok", ok === true);
    dot.classList.toggle("bad", ok === false);
    $("#health-text").textContent = text;
  }

  async function checkHealth() {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      const body = await res.json();
      if (res.ok && body && body.ok) setHealth(true, "API 正常");
      else setHealth(false, "API 异常");
    } catch {
      setHealth(false, "无法连接 API");
    }
  }

  function setPanelStatus(id, text, isError) {
    const node = $(id);
    node.textContent = text || "";
    node.classList.toggle("error", !!isError);
  }

  function friendlyError(e) {
    const msg = e && e.message ? e.message : String(e);
    return msg === "未登录" ? "" : msg;
  }

  // ---------- 登录 ----------

  function showLogin(message) {
    stopPolling();
    $("#login").classList.remove("hidden");
    $("#app").classList.add("hidden");
    const err = $("#login-error");
    err.textContent = message || "";
    err.classList.toggle("hidden", !message);
    $("#token-input").value = state.token || "";
  }

  async function verifyAndEnter(rawToken) {
    const err = $("#login-error");
    err.classList.add("hidden");
    if (!rawToken) {
      err.textContent = "请先填入 token";
      err.classList.remove("hidden");
      return;
    }
    try {
      const { res, body } = await rawFetch("/v1/pools", {}, rawToken);
      if (res.status === 401) {
        err.textContent = "token 不对。默认在 app/data/run/api.token，或由 RABBIT_BOT_API_TOKEN 提供。";
        err.classList.remove("hidden");
        return;
      }
      if (!res.ok || !body || body.ok !== true) {
        err.textContent = (body && body.error) || `HTTP ${res.status}`;
        err.classList.remove("hidden");
        return;
      }
      state.token = rawToken;
      localStorage.setItem(TOKEN_KEY, rawToken);
      $("#login").classList.add("hidden");
      $("#app").classList.remove("hidden");
      await bootData();
    } catch (e) {
      err.textContent = `连接失败：${e.message || e}`;
      err.classList.remove("hidden");
    }
  }

  async function bootData() {
    setHealth(true, "已连接");
    await loadPools();
    startPolling();
  }

  // ---------- 轮询 ----------

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (document.hidden || !state.token) return;
      try {
        await loadPools(true);
        if (state.tab === "chat" && state.current) await loadLatestMessages(true);
        else if (state.tab === "tasks") await loadTasks(true);
        else if (state.tab === "approvals") await loadApprovals(true);
        else if (state.tab === "workers") await loadWorkers(true);
      } catch (e) {
        if (friendlyError(e)) setHealth(false, "API 异常");
      }
    }, 3000);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // ---------- 会话池 ----------

  async function loadPools(silent) {
    const pools = await api("/v1/pools");
    state.pools = Array.isArray(pools) ? pools : [];
    if (state.current && !state.pools.some((p) => p.alias === state.current)) {
      state.current = null;
      state.messages = [];
      state.total = 0;
      state.oldestSeq = null;
      renderMessages();
    }
    renderPools();
    if (!state.current && state.pools.length) await selectPool(state.pools[0].alias);
    else if (state.current) updateConversationHeader();
    if (!silent) setHealth(true, "API 正常");
  }

  function renderPools() {
    const list = $("#pool-list");
    list.replaceChildren();
    if (!state.pools.length) {
      list.appendChild(el("p", "empty", "还没有会话池。"));
      return;
    }
    for (const pool of state.pools) {
      const btn = el("button", "pool" + (pool.alias === state.current ? " active" : ""));
      btn.type = "button";
      btn.addEventListener("click", () => void selectPool(pool.alias));

      const top = el("div", "pool-top");
      top.appendChild(el("span", "pool-alias", pool.alias));
      top.appendChild(el("span", "pool-title", pool.title || "（无标题）"));
      top.appendChild(el("span", "chip", kindLabel(pool.kind)));
      btn.appendChild(top);

      const meta = el("div", "pool-meta");
      meta.appendChild(el("span", "", pool.last_msg_local || "暂无消息"));
      meta.appendChild(el("span", "", `${pool.total || 0} 条`));
      btn.appendChild(meta);
      list.appendChild(btn);
    }
  }

  async function selectPool(alias) {
    if (!alias) return;
    state.current = alias;
    state.messages = [];
    state.total = 0;
    state.oldestSeq = null;
    state.memUser = "";
    const memUser = $("#mem-user");
    if (memUser) memUser.value = "";
    renderPools();
    renderMessages();
    try {
      await loadLatestMessages(false);
    } catch (e) {
      const msg = friendlyError(e);
      if (msg) setHealth(false, "读取消息失败");
    }
  }

  function updateConversationHeader() {
    const pool = state.pools.find((p) => p.alias === state.current);
    if (!pool) {
      $("#conv-title").textContent = "选择左侧会话";
      $("#conv-meta").textContent = "";
      return;
    }
    $("#conv-title").textContent = pool.title || pool.alias;
    const loaded = state.messages.length ? ` · 已加载 ${state.messages.length}` : "";
    $("#conv-meta").textContent =
      `${pool.alias} · ${kindLabel(pool.kind)} · ${state.total} 条消息${loaded}`;
  }

  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  }

  async function loadLatestMessages(silent) {
    if (!state.current || state.loadingMessages) return;
    const alias = state.current;
    const box = $("#messages");
    const stickToBottom = nearBottom(box);
    state.loadingMessages = true;
    try {
      const data = await api(
        `/v1/pools/${encodeURIComponent(alias)}/messages?limit=${silent ? 40 : 25}`,
      );
      if (state.current !== alias) return;
      state.total = data.total || 0;
      if (data.oldest_seq !== null && data.oldest_seq !== undefined) state.oldestSeq = data.oldest_seq;

      const before = state.messages.length;
      const map = new Map(state.messages.map((m) => [m.seq, m]));
      for (const m of data.messages || []) map.set(m.seq, m);
      state.messages = Array.from(map.values()).sort((a, b) => a.seq - b.seq);
      const grew = state.messages.length > before;

      if (grew || !silent) renderMessages({ scrollBottom: stickToBottom || !silent });
      updateConversationHeader();
      detectMemoryUser();
    } finally {
      state.loadingMessages = false;
    }
  }

  async function loadOlderMessages() {
    if (!state.current || !state.messages.length) return;
    const alias = state.current;
    const before = state.messages[0].seq;
    try {
      const data = await api(
        `/v1/pools/${encodeURIComponent(alias)}/messages?limit=25&before_seq=${before}`,
      );
      if (state.current !== alias) return;
      state.total = data.total || state.total;
      if (data.oldest_seq !== null && data.oldest_seq !== undefined) state.oldestSeq = data.oldest_seq;
      const map = new Map(state.messages.map((m) => [m.seq, m]));
      for (const m of data.messages || []) map.set(m.seq, m);
      state.messages = Array.from(map.values()).sort((a, b) => a.seq - b.seq);
      renderMessages({ keepScroll: true });
      updateConversationHeader();
    } catch (e) {
      const msg = friendlyError(e);
      if (msg) setPanelStatus("#send-status", `加载更早失败：${msg}`, true);
    }
  }

  function renderMessages(opts = {}) {
    const box = $("#messages");
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    box.replaceChildren();

    if (!state.current) {
      box.appendChild(el("div", "empty", "从左侧选择一个会话池。"));
      return;
    }

    const canLoadOlder =
      state.oldestSeq !== null &&
      state.messages.length > 0 &&
      state.messages[0].seq > state.oldestSeq;
    if (canLoadOlder) {
      const btn = el("button", "load-older ghost", "加载更早的消息");
      btn.type = "button";
      btn.addEventListener("click", () => void loadOlderMessages());
      box.appendChild(btn);
    }

    if (!state.messages.length) {
      box.appendChild(el("div", "empty", "这个池还没有消息。收发消息请用飞书。"));
      return;
    }

    for (const m of state.messages) {
      const row = el("div", "msg" + (m.from_self ? " self" : ""));
      const meta = el("div", "msg-meta");
      meta.appendChild(el("span", "msg-sender", m.from_self ? `${m.sender || "机器人"}（机器人）` : (m.sender || "未知")));
      meta.appendChild(el("span", "", m.local || formatTs(m.ts)));
      meta.appendChild(el("span", "msg-seq", `#${m.seq}`));
      row.appendChild(meta);
      row.appendChild(el("div", "msg-text", m.text || ""));
      box.appendChild(row);
    }

    if (opts.scrollBottom) {
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    } else if (opts.keepScroll) {
      requestAnimationFrame(() => {
        box.scrollTop = box.scrollHeight - prevHeight + prevTop;
      });
    }
  }

  function detectMemoryUser() {
    const last = [...state.messages].reverse().find((m) => !m.from_self && m.user_id);
    if (!last) return;
    state.memUser = last.user_id;
    const input = $("#mem-user");
    if (input) input.value = last.user_id;
  }

  // ---------- 计划 ----------

  async function loadPlans() {
    setPanelStatus("#plans-status", "加载中…");
    try {
      const plans = await api("/v1/plans");
      renderPlans(Array.isArray(plans) ? plans : []);
      setPanelStatus("#plans-status", plans.length ? "" : "没有待办计划。");
    } catch (e) {
      setPanelStatus("#plans-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderPlans(plans) {
    const list = $("#plans-list");
    list.replaceChildren();
    for (const p of plans) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      head.appendChild(el("div", "card-title", `#${p.id} ${p.title}`));
      head.appendChild(el("span", "badge", p.status || "pending"));
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(el("span", "badge", p.kind || "none"));
      if (p.pool) meta.appendChild(el("span", "", `池 ${p.pool}`));
      if (p.anchor) meta.appendChild(el("span", "", `锚点 ${p.anchor}`));
      if (p.next_fire_local) meta.appendChild(el("span", "", `下次 ${p.next_fire_local}`));
      else if (p.schedule) meta.appendChild(el("span", "", `规则 ${p.schedule}`));
      card.appendChild(meta);

      if (p.why) card.appendChild(el("div", "card-body", p.why));
      list.appendChild(card);
    }
  }

  // ---------- 记忆 ----------

  async function loadMemories() {
    const poolInput = $("#mem-pool");
    poolInput.value = state.current || "";
    const user = $("#mem-user").value.trim();
    state.memUser = user;
    const list = $("#mem-list");

    if (!state.current) {
      list.replaceChildren();
      setPanelStatus("#mem-status", "先在「会话」页选一个池。");
      return;
    }
    if (!user) {
      list.replaceChildren();
      setPanelStatus("#mem-status", "这个池还没有识别到用户；可以手动填 user id 再刷新。");
      return;
    }

    setPanelStatus("#mem-status", "加载中…");
    try {
      const rows = await api(
        `/v1/memories?user=${encodeURIComponent(user)}&pool=${encodeURIComponent(state.current)}&all=1&limit=200`,
      );
      renderMemories(Array.isArray(rows) ? rows : []);
      setPanelStatus("#mem-status", rows.length ? "" : "没有可见的记忆。");
    } catch (e) {
      list.replaceChildren();
      setPanelStatus("#mem-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderMemories(rows) {
    const list = $("#mem-list");
    list.replaceChildren();
    for (const m of rows) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      const title = el("div", "card-title", m.content);
      head.appendChild(title);
      head.appendChild(el("span", "badge" + (m.to ? " closed" : ""), m.to ? "已失效" : "有效"));
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(el("span", "", `#${m.id}`));
      meta.appendChild(el("span", "badge", m.kind || "fact"));
      meta.appendChild(el("span", "badge", `scope ${m.scope}`));
      meta.appendChild(el("span", "", `有效 ${formatTs(m.from)} → ${m.to ? formatTs(m.to) : "至今"}`));
      if (m.replaced_by) meta.appendChild(el("span", "", `被 #${m.replaced_by} 顶替`));
      card.appendChild(meta);

      const actions = el("div", "card-actions");
      const editBtn = el("button", "ghost small", "编辑");
      const delBtn = el("button", "danger small", "删除");
      editBtn.addEventListener("click", () => {
        const ta = el("textarea", "memory-edit");
        ta.value = m.content;
        ta.rows = 3;
        const save = el("button", "primary small", "保存");
        const cancel = el("button", "ghost small", "取消");
        head.replaceChild(ta, title);
        actions.replaceChildren(save, cancel);
        save.addEventListener("click", async () => {
          const content = ta.value.trim();
          if (!content) {
            setPanelStatus("#mem-status", "正文不能为空；不想留了就删除。", true);
            return;
          }
          save.disabled = true;
          try {
            await api(`/v1/memories/${m.id}`, { method: "PUT", body: { user: state.memUser, content } });
            await loadMemories();
          } catch (e) {
            save.disabled = false;
            setPanelStatus("#mem-status", `保存失败：${friendlyError(e) || "未登录"}`, true);
          }
        });
        cancel.addEventListener("click", () => void loadMemories());
      });
      delBtn.addEventListener("click", async () => {
        if (!confirm(`删除记忆 #${m.id}？\n\n${m.content}`)) return;
        delBtn.disabled = true;
        try {
          await api(`/v1/memories/${m.id}?user=${encodeURIComponent(state.memUser)}`, { method: "DELETE" });
          await loadMemories();
        } catch (e) {
          delBtn.disabled = false;
          setPanelStatus("#mem-status", `删除失败：${friendlyError(e) || "未登录"}`, true);
        }
      });
      actions.append(editBtn, delBtn);
      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  // ---------- 人格与提示词 ----------

  async function loadEditors(force) {
    if (state.personaLoaded && !force) return;
    setPanelStatus("#persona-status", "加载中…");
    try {
      const [persona, prompt] = await Promise.all([api("/v1/persona"), api("/v1/prompts/system")]);
      $("#persona-editor").value = persona.content;
      $("#persona-path").textContent = `${persona.source} · ${persona.path}`;
      $("#prompt-editor").value = prompt.content;
      $("#prompt-path").textContent = `${prompt.source} · ${prompt.path}`;
      state.personaLoaded = true;
      setPanelStatus("#persona-status", "");
    } catch (e) {
      state.personaLoaded = false;
      setPanelStatus("#persona-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  async function savePersona() {
    const btn = $("#save-persona");
    btn.disabled = true;
    setPanelStatus("#persona-status", "保存中…");
    try {
      const saved = await api("/v1/persona", {
        method: "PUT",
        body: { content: $("#persona-editor").value },
      });
      $("#persona-path").textContent = `${saved.source} · ${saved.path}`;
      setPanelStatus("#persona-status", "人设已保存，下一轮换新会话生效。");
    } catch (e) {
      setPanelStatus("#persona-status", `保存失败：${friendlyError(e) || "未登录"}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function saveSystemPrompt() {
    const btn = $("#save-prompt");
    btn.disabled = true;
    setPanelStatus("#persona-status", "保存中…");
    try {
      const saved = await api("/v1/prompts/system", {
        method: "PUT",
        body: { content: $("#prompt-editor").value },
      });
      $("#prompt-path").textContent = `${saved.source} · ${saved.path}`;
      setPanelStatus("#persona-status", "系统提示词已保存，下一轮换新会话生效。");
    } catch (e) {
      setPanelStatus("#persona-status", `保存失败：${friendlyError(e) || "未登录"}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 任务 ----------

  function statusBadge(status) {
    const s = String(status || "");
    const cls = ["done", "approved", "online"].includes(s)
      ? " done"
      : ["failed", "rejected", "timeout", "offline", "blocked"].includes(s)
        ? " closed"
        : ["running", "pending"].includes(s) ? " info" : "";
    return el("span", "badge" + cls, s || "—");
  }

  function detailRow(label, value, mono) {
    const row = el("div", "detail-row");
    row.appendChild(el("span", "detail-label", label));
    const v = el("div", "detail-value" + (mono ? " mono" : ""));
    v.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    row.appendChild(v);
    return row;
  }

  function noteSummary(note) {
    const first = String(note || "").split("\n").find((line) => line.trim()) || "";
    return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  }

  async function loadTasks(silent) {
    if (!silent) setPanelStatus("#tasks-status", "加载中…");
    try {
      const query = state.taskStatus ? `?status=${encodeURIComponent(state.taskStatus)}` : "";
      const rows = await api(`/v1/tasks${query}`);
      state.tasks = Array.isArray(rows) ? rows : [];
      if (state.expandedTaskId !== null && !state.tasks.some((t) => t.id === state.expandedTaskId)) {
        state.expandedTaskId = null;
      }
      renderTasks();
      setPanelStatus("#tasks-status", state.tasks.length ? "" : "没有任务。");
      if (state.expandedTaskId !== null) await loadTaskSnapshot(state.expandedTaskId, true);
    } catch (e) {
      setPanelStatus("#tasks-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  async function loadTaskSnapshot(id, silent) {
    try {
      const snapshot = await api(`/v1/tasks/${id}/snapshot`);
      state.taskSnapshots[id] = snapshot;
      if (state.expandedTaskId === id) renderTasks();
    } catch (e) {
      if (!silent) setPanelStatus("#tasks-status", `任务快照加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  async function toggleTask(id) {
    if (state.expandedTaskId === id) {
      state.expandedTaskId = null;
      renderTasks();
      return;
    }
    state.expandedTaskId = id;
    renderTasks();
    await loadTaskSnapshot(id, false);
  }

  function renderTasks() {
    const list = $("#tasks-list");
    list.replaceChildren();
    if (!state.tasks.length) {
      list.appendChild(el("p", "empty", "没有任务。"));
      return;
    }
    for (const t of state.tasks) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      const title = el("div", "card-title");
      title.appendChild(el("span", "task-id", `#${t.id}`));
      title.appendChild(document.createTextNode(` ${t.goal || "（无目标）"}`));
      head.appendChild(title);
      const expand = el("button", "ghost small", state.expandedTaskId === t.id ? "收起" : "展开详情");
      expand.type = "button";
      expand.addEventListener("click", () => void toggleTask(t.id));
      head.appendChild(expand);
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(statusBadge(t.status));
      if (t.stage) meta.appendChild(el("span", "", `stage ${t.stage}`));
      meta.appendChild(el("span", "", `worker ${t.worker_id || "未领取"}`));
      meta.appendChild(el("span", "", `更新 ${t.updated_at_local || formatTs(t.updated_at)}`));
      const summary = noteSummary(t.note);
      if (summary) meta.appendChild(el("span", "meta-wide", `note ${summary}`));
      card.appendChild(meta);

      if (state.expandedTaskId === t.id) {
        const detail = el("div", "task-detail");
        detail.appendChild(detailRow("deliverable", t.deliverable));
        detail.appendChild(detailRow("constraints", t.constraints));
        detail.appendChild(detailRow("acceptance", t.acceptance));
        detail.appendChild(detailRow("result", t.result));
        detail.appendChild(detailRow("artifact", t.artifact, true));
        detail.appendChild(detailRow("note", t.note));
        detail.appendChild(detailRow("start_at", t.start_at_local || formatTs(t.start_at)));
        detail.appendChild(detailRow("end_at", t.end_at_local || (t.end_at ? formatTs(t.end_at) : "")));
        const snap = state.taskSnapshots[t.id];
        const worker = snap && snap.worker;
        detail.appendChild(detailRow(
          "worker 快照",
          worker
            ? `${worker.worker_id} · ${worker.status} · 最后心跳 ${formatTs(worker.last_seen_at)}`
            : (t.worker_id ? `${t.worker_id} · 没有 worker 快照` : "未领取"),
          true,
        ));
        card.appendChild(detail);
      }
      list.appendChild(card);
    }
  }

  // ---------- 权限申请 ----------

  async function loadApprovals(silent) {
    if (!silent) setPanelStatus("#approvals-status", "加载中…");
    try {
      const query = state.approvalStatus ? `?status=${encodeURIComponent(state.approvalStatus)}` : "";
      const rows = await api(`/v1/approvals${query}`);
      state.approvals = Array.isArray(rows) ? rows : [];
      renderApprovals();
      setPanelStatus("#approvals-status", state.approvals.length ? "" : "没有权限申请。");
    } catch (e) {
      setPanelStatus("#approvals-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderApprovals() {
    const list = $("#approvals-list");
    list.replaceChildren();
    if (!state.approvals.length) {
      list.appendChild(el("p", "empty", "没有权限申请。审批请在飞书里完成。"));
      return;
    }
    for (const a of state.approvals) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      const title = el("div", "card-title");
      title.appendChild(el("span", "task-id", `#${a.id}`));
      title.appendChild(document.createTextNode(` ${a.action || "（无 action）"}`));
      head.appendChild(title);
      head.appendChild(statusBadge(a.status));
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(el("span", "", `task #${a.task_id}`));
      meta.appendChild(el("span", "", `worker ${a.worker_id || "—"}`));
      meta.appendChild(el("span", "", `创建 ${a.created_at_local || formatTs(a.created_at)}`));
      meta.appendChild(el("span", "", `过期 ${a.expires_at_local || formatTs(a.expires_at)}`));
      if (a.decided_at) meta.appendChild(el("span", "", `裁决 ${a.decided_at_local || formatTs(a.decided_at)}`));
      card.appendChild(meta);

      if (a.detail) card.appendChild(el("div", "card-body", `detail：${a.detail}`));
      if (a.why) card.appendChild(el("div", "card-body", `why：${a.why}`));
      list.appendChild(card);
    }
  }

  // ---------- Worker ----------

  async function loadWorkers(silent) {
    if (!silent) setPanelStatus("#workers-status", "加载中…");
    try {
      const rows = await api("/v1/workers");
      state.workers = Array.isArray(rows) ? rows : [];
      renderWorkers();
      setPanelStatus("#workers-status", state.workers.length ? "" : "还没有注册 worker。");
    } catch (e) {
      setPanelStatus("#workers-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderWorkers() {
    const list = $("#workers-list");
    list.replaceChildren();
    if (!state.workers.length) {
      list.appendChild(el("p", "empty", "还没有注册 worker。"));
      return;
    }
    for (const w of state.workers) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      head.appendChild(el("div", "card-title", w.name || w.worker_id));
      head.appendChild(statusBadge(w.status));
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(el("span", "", `worker_id ${w.worker_id}`));
      meta.appendChild(el("span", "", `kind ${w.kind || "—"}`));
      meta.appendChild(el("span", "", `last_seen ${formatTs(w.last_seen_at)}`));
      card.appendChild(meta);
      list.appendChild(card);
    }
  }

  // ---------- 技能 ----------

  async function loadSkills() {
    setPanelStatus("#skills-status", "加载中…");
    try {
      const rows = await api("/v1/skills");
      renderSkills(Array.isArray(rows) ? rows : []);
      setPanelStatus("#skills-status", rows.length ? "" : "没有发现技能。");
    } catch (e) {
      setPanelStatus("#skills-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderSkills(rows) {
    const list = $("#skills-list");
    list.replaceChildren();
    for (const s of rows) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      head.appendChild(el("div", "card-title", s.name));
      head.appendChild(el("span", "badge" + (s.has_data ? " done" : ""), s.has_data ? "有 data" : "无 data"));
      card.appendChild(head);
      if (s.description) card.appendChild(el("div", "card-body", s.description));
      const meta = el("div", "card-meta");
      meta.appendChild(el("span", "", s.skill));
      meta.appendChild(el("span", "", s.data));
      card.appendChild(meta);
      list.appendChild(card);
    }
  }

  // ---------- 页签 ----------

  function switchTab(name) {
    state.tab = name;
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    if (name === "chat") {
      if (state.current) void loadLatestMessages(true).catch(() => {});
    } else if (name === "tasks") {
      void loadTasks();
    } else if (name === "approvals") {
      void loadApprovals();
    } else if (name === "workers") {
      void loadWorkers();
    } else if (name === "plans") {
      void loadPlans();
    } else if (name === "memories") {
      void loadMemories();
    } else if (name === "persona") {
      void loadEditors();
    } else if (name === "skills") {
      void loadSkills();
    }
  }

  // ---------- 初始化 ----------

  function bind() {
    $("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void verifyAndEnter($("#token-input").value.trim());
    });

    $("#logout").addEventListener("click", () => {
      state.logoutRequested = true;
      state.token = "";
      localStorage.removeItem(TOKEN_KEY);
      stopPolling();
      showLogin();
    });

    $$(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("#reload-pools").addEventListener("click", () => {
      void loadPools(false).catch((e) => {
        const msg = friendlyError(e);
        if (msg) setHealth(false, "刷新失败");
      });
    });
    $("#reload-plans").addEventListener("click", () => void loadPlans());
    $("#reload-memories").addEventListener("click", () => void loadMemories());
    $("#reload-persona").addEventListener("click", () => void loadEditors(true));
    $("#save-persona").addEventListener("click", () => void savePersona());
    $("#save-prompt").addEventListener("click", () => void saveSystemPrompt());
    $("#reload-skills").addEventListener("click", () => void loadSkills());
    $("#reload-tasks").addEventListener("click", () => void loadTasks());
    $("#reload-approvals").addEventListener("click", () => void loadApprovals());
    $("#reload-workers").addEventListener("click", () => void loadWorkers());

    $("#task-status-filter").addEventListener("change", (e) => {
      state.taskStatus = e.target.value;
      state.expandedTaskId = null;
      void loadTasks();
    });
    $("#approval-status-filter").addEventListener("change", (e) => {
      state.approvalStatus = e.target.value;
      void loadApprovals();
    });
  }

  function init() {
    $("#base-url").textContent = location.origin;
    bind();
    void checkHealth();
    setInterval(() => void checkHealth(), 10000);

    if (!state.token) {
      showLogin();
      return;
    }
    void verifyAndEnter(state.token);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
