(() => {
  "use strict";

  const TOKEN_KEY = "rabbit-bot.api-token";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const TAB_NAMES = new Set(["chat", "tasks", "approvals", "plans", "memories", "business", "manage"]);
  const MANAGE_VIEWS = new Set(["workers", "users", "persona", "settings", "usage", "skills"]);
  const LEGACY_TAB_VIEW = { workers: "workers", users: "users", persona: "persona", settings: "settings", usage: "usage", skills: "skills" };

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    pools: [],
    current: null,
    messages: [],
    total: 0,
    oldestSeq: null,
    tab: "chat",
    manageView: "workers",
    loadingMessages: false,
    messageRequest: 0,
    loadingOlder: false,
    pollTimer: null,
    memUser: "",
    personaLoaded: false,
    tasks: [],
    taskStatus: "",
    taskSearch: "",
    taskExecutor: "",
    taskPage: 1,
    taskPageSize: 20,
    taskModalId: null,
    taskModalLoading: false,
    taskSnapshots: {},
    approvals: [],
    approvalStatus: "pending",
    usageBucket: "hour",
    usageRange: "24h",
    workers: [],
    business: null,
    businessView: "list",
    businessCategory: "objects",
    businessSelected: null,
    logoutRequested: false,
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function kindLabel(kind) {
    return kind === "private" ? "私聊" : kind === "group" ? "群聊" : kind === "task" ? "任务" : String(kind || "");
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
    closeTaskModal();
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
    applyLocationState({ replace: true });
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
        else if (state.tab === "manage" && state.manageView === "workers") await loadWorkers(true);
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
    const nextPools = Array.isArray(pools) ? pools : [];
    const poolsChanged = JSON.stringify(nextPools) !== JSON.stringify(state.pools);
    state.pools = nextPools;
    if (state.current && !state.pools.some((p) => p.alias === state.current)) {
      state.current = null;
      state.messages = [];
      state.total = 0;
      state.oldestSeq = null;
      renderMessages();
    }
    if (poolsChanged) renderPools();
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
      btn.setAttribute("aria-current", String(pool.alias === state.current));
      btn.title = pool.title || pool.alias;
      btn.addEventListener("click", () => {
        $("#tab-chat").classList.add("reading");
        if (state.current !== pool.alias) void selectPool(pool.alias);
        else $("#messages").scrollTop = $("#messages").scrollHeight;
      });

      const top = el("div", "pool-top");
      top.appendChild(el("span", "pool-title", pool.title || "（无标题）"));
      top.appendChild(el("span", "chip", kindLabel(pool.kind)));
      btn.appendChild(top);

      const meta = el("div", "pool-meta");
      meta.appendChild(el("span", "pool-alias", pool.alias));
      const time = el("span", "pool-time", pool.last_msg_local ? pool.last_msg_local.slice(5, 16) : "暂无消息");
      time.title = pool.last_msg_local || "";
      meta.appendChild(time);
      meta.appendChild(el("span", "", `${pool.total || 0} 条`));
      btn.appendChild(meta);
      list.appendChild(btn);
    }
  }

  async function selectPool(alias) {
    if (!alias) return;
    state.current = alias;
    state.messageRequest++;
    state.loadingMessages = false;
    state.loadingOlder = false;
    chatStatus("正在读取消息…");
    state.messages = [];
    state.total = 0;
    state.oldestSeq = null;
    state.memUser = "";
    const memUser = $("#mem-user");
    if (memUser) memUser.value = "";
    renderPools();
    renderMessages();
    updateConversationHeader();
    try {
      await loadLatestMessages(false);
    } catch (e) {
      const msg = friendlyError(e);
      if (msg && state.current === alias) chatStatus("读取失败，请点击刷新重试。", true);
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
    $("#conv-meta").textContent = `${state.total} 条消息`;
    $("#conv-title").title = `${pool.title || pool.alias} · ${pool.alias} · ${kindLabel(pool.kind)}`;
  }

  function chatStatus(text, error = false) {
    const status = $("#chat-status");
    status.textContent = text;
    status.classList.toggle("hidden", !text);
    status.classList.toggle("error", error);
  }

  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  }

  async function loadLatestMessages(silent) {
    if (!state.current || state.loadingMessages) return;
    const alias = state.current;
    const box = $("#messages");
    const stickToBottom = nearBottom(box);
    const request = ++state.messageRequest;
    state.loadingMessages = true;
    try {
      const data = await api(
        `/v1/pools/${encodeURIComponent(alias)}/messages?limit=${silent ? 40 : 25}`,
      );
      if (state.current !== alias || request !== state.messageRequest) return;
      chatStatus("");
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
      if (request === state.messageRequest) state.loadingMessages = false;
    }
  }

  async function loadOlderMessages() {
    if (!state.current || !state.messages.length || state.loadingOlder) return;
    state.loadingOlder = true;
    const olderButton = $(".load-older");
    if (olderButton) { olderButton.disabled = true; olderButton.textContent = "正在加载…"; }
    const alias = state.current;
    const before = state.messages[0].seq;
    try {
      const data = await api(
        `/v1/pools/${encodeURIComponent(alias)}/messages?limit=25&before_seq=${before}`,
      );
      if (state.current !== alias) return;
      chatStatus("");
      state.total = data.total || state.total;
      if (data.oldest_seq !== null && data.oldest_seq !== undefined) state.oldestSeq = data.oldest_seq;
      const map = new Map(state.messages.map((m) => [m.seq, m]));
      for (const m of data.messages || []) map.set(m.seq, m);
      state.messages = Array.from(map.values()).sort((a, b) => a.seq - b.seq);
      renderMessages({ keepScroll: true });
      updateConversationHeader();
    } catch (e) {
      const msg = friendlyError(e);
      if (msg && state.current === alias) chatStatus(`加载更早失败：${msg}`, true);
    } finally {
      if (state.current === alias) state.loadingOlder = false;
      if (olderButton) { olderButton.disabled = false; olderButton.textContent = "加载更早的消息"; }
    }
  }

  function renderMessages(opts = {}) {
    const box = $("#messages");
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const boxTop = box.getBoundingClientRect().top;
    const anchor = $$(".msg", box).find((row) => row.getBoundingClientRect().bottom > boxTop);
    const anchorSeq = anchor?.dataset.seq;
    const anchorTop = anchor?.getBoundingClientRect().top;
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
      box.appendChild(el("div", "empty", "这个池还没有消息。收发消息请用已启用的 IM。"));
      return;
    }

    let previous = null;
    let previousDay = "";
    for (const m of state.messages) {
      const stamp = m.local || formatTs(m.ts);
      const day = stamp.split(/[ T]/)[0];
      if (day && day !== previousDay) {
        box.appendChild(el("div", "message-day", day));
      }
      const grouped = previous && day === previousDay &&
        previous.from_self === m.from_self && previous.sender === m.sender &&
        previous.user_id === m.user_id && Number(m.ts) - Number(previous.ts) >= 0 &&
        Number(m.ts) - Number(previous.ts) < 5 * 60 * 1000;
      const row = el("article", "msg" + (m.from_self ? " self" : "") + (grouped ? " continued" : ""));
      row.dataset.seq = m.seq;
      const meta = el("div", "msg-meta");
      meta.appendChild(el("span", "msg-sender", m.sender || (m.from_self ? "机器人" : "未知")));
      if (m.from_self) meta.appendChild(el("span", "msg-role", "机器人"));
      const time = el("span", "msg-time", stamp.match(/\d{2}:\d{2}/)?.[0] || stamp);
      time.title = `${stamp} · 消息 #${m.seq}`;
      meta.appendChild(time);
      row.appendChild(meta);
      row.appendChild(el("div", "msg-text", m.text || ""));
      box.appendChild(row);
      previous = m;
      previousDay = day;
    }

    if (opts.scrollBottom) {
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    } else {
      const restored = $$(".msg", box).find((row) => row.dataset.seq === anchorSeq);
      if (restored) box.scrollTop = prevTop + restored.getBoundingClientRect().top - anchorTop;
      else box.scrollTop = opts.keepScroll ? box.scrollHeight - prevHeight + prevTop : prevTop;
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

  // ---------- 用户别名 ----------

  async function loadUsers() {
    setPanelStatus("#users-status", "加载中…");
    try {
      const rows = await api("/v1/users");
      renderUsers(Array.isArray(rows) ? rows : []);
      setPanelStatus("#users-status", rows.length ? "" : "还没有识别到用户。");
    } catch (e) {
      setPanelStatus("#users-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderUsers(rows) {
    const list = $("#users-list");
    list.replaceChildren();
    for (const u of rows) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      head.appendChild(el("div", "card-title", u.alias || u.display_name || u.user_id));
      head.appendChild(el("span", "badge", u.alias ? "有别名" : "自动名"));
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(el("span", "", u.user_id));
      for (const i of u.identities || []) {
        meta.appendChild(el("span", "", `${i.platform}:${i.platform_user_id}`));
      }
      card.appendChild(meta);

      const form = el("div", "alias-form");
      const input = el("input");
      input.type = "text";
      input.value = u.alias || "";
      input.placeholder = u.display_name || "给这个用户起个别名";
      const save = el("button", "primary small", "保存别名");
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await api(`/v1/users/${encodeURIComponent(u.user_id)}`, {
            method: "PATCH",
            body: { alias: input.value, backfill: true },
          });
          await loadUsers();
        } catch (e) {
          save.disabled = false;
          setPanelStatus("#users-status", `保存失败：${friendlyError(e) || "未登录"}`, true);
        }
      });
      form.append(input, save);
      card.appendChild(form);
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
        : s === "pending_approval" ? " warn"
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

  function formField(label, node) {
    const field = el("label", "field");
    field.appendChild(el("span", "", label));
    field.appendChild(node);
    return field;
  }

  function taskApprovalForm(t) {
    const form = el("div", "task-approve");
    form.appendChild(el("h3", "task-approve-title", "审批并执行"));

    const name = el("input");
    name.type = "text";
    name.value = t.name || "";
    const goal = el("textarea");
    goal.value = t.goal || "";
    const deliverable = el("textarea");
    deliverable.value = t.deliverable || "";
    const constraints = el("textarea");
    constraints.value = t.constraints || "";
    const acceptance = el("textarea");
    acceptance.value = t.acceptance || "";

    const grid = el("div", "task-approve-grid");
    grid.appendChild(formField("name", name));
    grid.appendChild(formField("goal", goal));
    grid.appendChild(formField("deliverable", deliverable));
    grid.appendChild(formField("constraints", constraints));
    grid.appendChild(formField("acceptance", acceptance));
    form.appendChild(grid);
    form.appendChild(el("p", "muted task-approve-hint", "优先在飞书审批房给任务提示贴 OK；这里是备用入口。work_dir / executor / model 只读，v1 不支持在 Web 修改。"));

    const actions = el("div", "card-actions");
    const approve = el("button", "primary small", "通过并执行");
    approve.type = "button";
    const reject = el("button", "ghost small", "驳回");
    reject.type = "button";
    actions.appendChild(approve);
    actions.appendChild(reject);
    form.appendChild(actions);

    approve.addEventListener("click", async () => {
      const body = {};
      const collect = (key, node) => {
        const value = node.value;
        if (value !== (t[key] ?? "")) body[key] = value;
      };
      collect("name", name);
      collect("goal", goal);
      collect("deliverable", deliverable);
      collect("constraints", constraints);
      collect("acceptance", acceptance);

      const message = t.executor === "mimo"
        ? "通过后会立即以无审批模式启动 mimo，可能执行任意命令。\n\n确定通过？"
        : "通过后会立即以无审批模式启动 opencode（带 --dangerously-skip-permissions），可能执行任意命令。\n\n确定通过？";
      if (!confirm(message)) return;

      approve.disabled = true;
      reject.disabled = true;
      setPanelStatus("#tasks-status", "审批通过，正在启动…");
      try {
        await api(`/v1/tasks/${t.id}/approve`, { method: "POST", body });
        setPanelStatus("#tasks-status", `任务 #${t.id} 已通过并启动。`);
        closeTaskModal();
        await loadTasks();
      } catch (e) {
        setPanelStatus("#tasks-status", `审批失败：${friendlyError(e) || "未登录"}`, true);
        approve.disabled = false;
        reject.disabled = false;
      }
    });

    reject.addEventListener("click", async () => {
      const reason = prompt("驳回原因（可留空）");
      if (reason === null) return;
      approve.disabled = true;
      reject.disabled = true;
      setPanelStatus("#tasks-status", "正在驳回…");
      try {
        await api(`/v1/tasks/${t.id}/reject`, { method: "POST", body: { reason, by: "web" } });
        setPanelStatus("#tasks-status", `任务 #${t.id} 已驳回，未执行。`);
        closeTaskModal();
        await loadTasks();
      } catch (e) {
        setPanelStatus("#tasks-status", `驳回失败：${friendlyError(e) || "未登录"}`, true);
        approve.disabled = false;
        reject.disabled = false;
      }
    });

    return form;
  }

  function taskMatches(t) {
    if (state.taskExecutor && String(t.executor || "") !== state.taskExecutor) return false;
    const q = state.taskSearch.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      t.id, t.name, t.goal, t.deliverable, t.constraints, t.acceptance,
      t.result, t.artifact, t.files, t.status, t.stage, t.worker_id,
      t.executor, t.model, t.note,
    ].map((v) => String(v ?? "")).join(" ").toLowerCase();
    return hay.includes(q);
  }

  function filteredTasks() {
    return state.tasks.filter(taskMatches);
  }

  function taskPageCount(total) {
    return Math.max(1, Math.ceil(total / state.taskPageSize));
  }

  function clampTaskPage(total) {
    const pages = taskPageCount(total);
    if (state.taskPage > pages) state.taskPage = pages;
    if (state.taskPage < 1) state.taskPage = 1;
    return pages;
  }

  async function loadTasks(silent) {
    if (!silent) setPanelStatus("#tasks-status", "加载中…");
    try {
      const query = state.taskStatus ? `?status=${encodeURIComponent(state.taskStatus)}` : "";
      const rows = await api(`/v1/tasks${query}`);
      state.tasks = Array.isArray(rows) ? rows : [];
      if (state.taskModalId !== null && !state.tasks.some((t) => t.id === state.taskModalId)) {
        closeTaskModal();
      }
      renderTasks();
      setPanelStatus("#tasks-status", state.tasks.length ? "" : "没有任务。");
      if (state.taskModalId !== null) await loadTaskSnapshot(state.taskModalId, true);
    } catch (e) {
      setPanelStatus("#tasks-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  async function loadTaskSnapshot(id, silent) {
    try {
      const snapshot = await api(`/v1/tasks/${id}/snapshot`);
      state.taskSnapshots[id] = snapshot;
      if (state.taskModalId === id) {
        state.taskModalLoading = false;
        if (!silent) renderTaskModal();
      }
    } catch (e) {
      if (state.taskModalId === id) {
        state.taskModalLoading = false;
        if (!silent) renderTaskModal();
      }
      if (!silent) setPanelStatus("#tasks-status", `任务快照加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function openTaskModal(id) {
    state.taskModalId = id;
    state.taskModalLoading = !state.taskSnapshots[id];
    renderTaskModal();
    $("#task-modal").classList.remove("hidden");
    document.body.classList.add("modal-open");
    $("#task-modal-close").focus();
    void loadTaskSnapshot(id, false);
  }

  function closeTaskModal() {
    state.taskModalId = null;
    state.taskModalLoading = false;
    $("#task-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    $("#task-modal-body").replaceChildren();
  }

  function modalDetailRows(t, snap) {
    const detail = el("div", "task-detail in-modal");
    const add = (label, value, mono) => {
      if (value === null || value === undefined || String(value).trim() === "") return;
      detail.appendChild(detailRow(label, value, mono));
    };
    add("goal", t.goal);
    add("deliverable", t.deliverable);
    add("constraints", t.constraints);
    add("acceptance", t.acceptance);
    add("result", t.result);
    add("artifact", t.artifact, true);
    add("work_dir", t.work_dir, true);
    add("model", t.model, true);
    add("stage", t.stage);
    add("worker", t.worker_id, true);
    add("start_at", t.start_at_local || formatTs(t.start_at));
    add("end_at", t.end_at_local || (t.end_at ? formatTs(t.end_at) : ""));
    add("updated", t.updated_at_local || formatTs(t.updated_at));
    add("session_id", t.session_id, true);
    add("doc_path", t.doc_path, true);
    add("note", t.note);
    const ctx = t.context || {};
    const ctxLines = [
      ctx.objects?.length ? `objects: ${ctx.objects.join(", ")}` : "",
      ctx.relations?.length ? `relations: ${ctx.relations.join(", ")}` : "",
      ctx.forbidden?.length ? `forbidden: ${ctx.forbidden.join(", ")}` : "",
    ].filter(Boolean);
    if (ctxLines.length) add("context", ctxLines.join("\n"));
    if (t.files && t.files !== "[]") {
      let files = t.files;
      try { files = JSON.parse(t.files).join("\n"); } catch { /* keep raw */ }
      add("files", files, true);
    }
    const worker = snap && snap.worker;
    detail.appendChild(detailRow(
      "worker 快照",
      worker
        ? `${worker.worker_id} · ${worker.status} · 最后心跳 ${formatTs(worker.last_seen_at)}`
        : (t.worker_id ? `${t.worker_id} · 没有 worker 快照` : "未领取"),
      true,
    ));
    return detail;
  }

  function modalEvents(snap) {
    const box = el("section", "task-modal-section");
    box.appendChild(el("h3", "", "最近事件"));
    const events = snap && Array.isArray(snap.recent_events) ? snap.recent_events : [];
    if (!events.length) {
      box.appendChild(el("p", "task-modal-empty", "还没收到任务事件。"));
      return box;
    }
    const list = el("ol", "task-events");
    for (const ev of events) {
      const li = el("li");
      li.appendChild(el("div", "event-meta", `${ev.local || formatTs(ev.ts)} · ${ev.sender || "task"}`));
      li.appendChild(el("div", "event-text", ev.text || ""));
      list.appendChild(li);
    }
    box.appendChild(list);
    return box;
  }

  function renderTaskModal() {
    const id = state.taskModalId;
    if (id === null) return;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) { closeTaskModal(); return; }
    $("#task-modal-title").textContent = `#${task.id} ${task.name || "任务详情"}`;
    const body = $("#task-modal-body");
    body.replaceChildren();
    const head = el("div", "card-meta");
    head.appendChild(statusBadge(task.status));
    head.appendChild(el("span", "", `executor ${task.executor || "—"}`));
    head.appendChild(el("span", "", `更新 ${task.updated_at_local || formatTs(task.updated_at)}`));
    body.appendChild(head);
    const snap = state.taskSnapshots[id] || null;
    body.appendChild(modalDetailRows(task, snap));
    if (state.taskModalLoading) {
      body.appendChild(el("p", "task-modal-empty", "正在加载任务快照…"));
    } else {
      body.appendChild(modalEvents(snap));
      if (task.status === "pending_approval") body.appendChild(taskApprovalForm(task));
    }
  }

  function renderTaskPager(total) {
    const pager = $("#tasks-pager");
    pager.replaceChildren();
    if (!total) { pager.hidden = true; return; }
    pager.hidden = false;
    const pages = clampTaskPage(total);
    const start = (state.taskPage - 1) * state.taskPageSize + 1;
    const end = Math.min(total, state.taskPage * state.taskPageSize);
    const prev = el("button", "ghost small", "上一页");
    prev.type = "button";
    prev.dataset.taskPage = String(state.taskPage - 1);
    prev.disabled = state.taskPage <= 1;
    const next = el("button", "ghost small", "下一页");
    next.type = "button";
    next.dataset.taskPage = String(state.taskPage + 1);
    next.disabled = state.taskPage >= pages;
    const size = el("select");
    size.id = "task-page-size";
    size.setAttribute("aria-label", "每页条数");
    for (const n of [10, 20, 50, 100]) {
      const opt = el("option", "", `${n} 条/页`);
      opt.value = String(n);
      if (n === state.taskPageSize) opt.selected = true;
      size.appendChild(opt);
    }
    pager.appendChild(prev);
    pager.appendChild(el("span", "", `${start}–${end} / 共 ${total} 条 · 第 ${state.taskPage} / ${pages} 页`));
    pager.appendChild(next);
    pager.appendChild(el("span", "pager-spacer"));
    pager.appendChild(size);
  }

  function renderTasks() {
    const list = $("#tasks-list");
    list.replaceChildren();
    const rows = filteredTasks();
    if (!rows.length) {
      list.appendChild(el("p", "empty", state.tasks.length ? "没有匹配的任务。" : "没有任务。"));
      renderTaskPager(0);
      return;
    }
    clampTaskPage(rows.length);
    const start = (state.taskPage - 1) * state.taskPageSize;
    const pageRows = rows.slice(start, start + state.taskPageSize);
    for (const t of pageRows) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      const title = el("div", "card-title");
      title.appendChild(el("span", "task-id", `#${t.id}`));
      title.appendChild(document.createTextNode(` ${t.goal || "（无目标）"}`));
      head.appendChild(title);
      const preview = el("button", "ghost small", t.status === "pending_approval" ? "审批 / 预览" : "预览详情");
      preview.type = "button";
      preview.addEventListener("click", () => openTaskModal(t.id));
      head.appendChild(preview);
      card.appendChild(head);

      const meta = el("div", "card-meta");
      meta.appendChild(statusBadge(t.status));
      if (t.stage) meta.appendChild(el("span", "", `stage ${t.stage}`));
      meta.appendChild(el("span", "", `worker ${t.worker_id || "未领取"}`));
      meta.appendChild(el("span", "", `更新 ${t.updated_at_local || formatTs(t.updated_at)}`));
      const summary = noteSummary(t.note);
      if (summary) meta.appendChild(el("span", "meta-wide", `note ${summary}`));
      card.appendChild(meta);
      list.appendChild(card);
    }
    renderTaskPager(rows.length);
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

  // ---------- 业务知识 ----------

  const BUSINESS_CATEGORIES = [
    { id: "objects", label: "对象" },
    { id: "relations", label: "关系" },
    { id: "actions", label: "动作" },
    { id: "terms", label: "术语" },
    { id: "types", label: "类型" },
  ];

  async function loadBusiness() {
    setPanelStatus("#business-status", "加载中…");
    try {
      const data = await api("/v1/business");
      state.business = data;
      updateFooter();
      ensureBusinessSelection(data);
      renderBusiness();
      setPanelStatus("#business-status", data.exists ? "" : "还没有业务地图。");
    } catch (e) {
      state.business = null;
      state.businessSelected = null;
      updateFooter();
      $("#business-summary").replaceChildren();
      $("#business-categories").replaceChildren();
      $("#business-items").replaceChildren();
      $("#business-detail").replaceChildren();
      $("#business-graph").replaceChildren();
      $("#business-graph-detail").replaceChildren();
      setPanelStatus("#business-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function businessQuery() {
    return ($("#business-search").value || "").trim().toLowerCase();
  }

  function businessTypeName(data, id) {
    return (data.types || []).find((t) => t.id === id)?.name || id;
  }

  function businessObjectName(data, id) {
    const o = (data.objects || []).find((x) => x.id === id);
    return o ? (o.name || o.id) : id;
  }

  function businessRelationName(data, id) {
    const r = (data.relations || []).find((x) => x.id === id);
    return r ? (r.name || r.id) : id;
  }

  function businessItemsFor(data, category, q) {
    const hit = (...vals) => !q || vals.filter(Boolean).join(" ").toLowerCase().includes(q);
    if (category === "objects") {
      return (data.objects || [])
        .filter((o) => hit(o.id, o.type, o.name, ...(o.aliases || []), o.description, ...(o.tags || [])))
        .map((o) => ({
          kind: "objects", id: o.id,
          title: o.name || o.id,
          subtitle: `${businessTypeName(data, o.type)} · ${o.id}`,
        }));
    }
    if (category === "relations") {
      return (data.relations || [])
        .filter((r) => hit(r.id, r.name, r.fromType, r.toType, r.semantics))
        .map((r) => ({
          kind: "relations", id: r.id,
          title: `${businessTypeName(data, r.fromType)} → ${businessTypeName(data, r.toType)}`,
          subtitle: `${r.name || r.id} · ${r.edge_count ?? 0} 条边`,
        }));
    }
    if (category === "actions") {
      return (data.actions || [])
        .filter((a) => hit(a.id, a.name, a.description, ...(a.appliesTo || []), ...(a.requiresRelations || [])))
        .map((a) => ({
          kind: "actions", id: a.id,
          title: a.name || a.id,
          subtitle: `${(a.appliesTo || []).map((t) => businessTypeName(data, t)).join(" / ") || "未限定类型"}${a.risk ? ` · ${a.risk}` : ""}`,
        }));
    }
    if (category === "terms") {
      return (data.terms || [])
        .filter((t) => hit(t.term, t.objectId, t.note))
        .map((t) => ({
          kind: "terms", id: t.term,
          title: t.term,
          subtitle: `${t.objectId}${t.note ? ` · ${t.note}` : ""}`,
        }));
    }
    const typeCounts = new Map();
    for (const o of data.objects || []) typeCounts.set(o.type, (typeCounts.get(o.type) || 0) + 1);
    return (data.types || [])
      .filter((t) => hit(t.id, t.name, t.description))
      .map((t) => ({
        kind: "types", id: t.id,
        title: t.name || t.id,
        subtitle: `${t.id} · ${typeCounts.get(t.id) || 0} 个对象`,
      }));
  }

  function ensureBusinessSelection(data) {
    const items = businessItemsFor(data, state.businessCategory, businessQuery());
    const cur = state.businessSelected;
    if (cur && items.some((i) => i.kind === cur.kind && i.id === cur.id)) return;
    state.businessSelected = items.length ? { kind: items[0].kind, id: items[0].id } : null;
  }

  function selectBusinessItem(kind, id) {
    state.businessSelected = { kind, id };
    state.businessCategory = kind;
    renderBusiness();
  }

  function syncBusinessView() {
    $$("#business-view-switch button").forEach((b) => b.classList.toggle("active", b.dataset.businessView === state.businessView));
    $("#business-list-view").hidden = state.businessView !== "list";
    $("#business-graph-view").hidden = state.businessView !== "graph";
  }

  function renderBusiness() {
    const data = state.business;
    const summary = $("#business-summary");
    summary.replaceChildren();
    if (!data) return;
    const counts = [
      ["对象类型", data.types?.length || 0],
      ["对象", data.objects?.length || 0],
      ["关系", data.relations?.length || 0],
      ["动作", data.actions?.length || 0],
      ["术语", data.terms?.length || 0],
    ];
    for (const [label, count] of counts) summary.appendChild(el("span", "badge", `${label} ${count}`));
    syncBusinessView();

    if (!data.exists) {
      $("#business-categories").replaceChildren();
      $("#business-items").replaceChildren();
      $("#business-graph").replaceChildren(el("p", "empty", "没有可展示的关系图。"));
      $("#business-graph-note").textContent = "";
      const hint = `还没有业务地图。在 ${data.dir || "runtime/business"} 下放 objects.json / relations.json 后再刷新。`;
      $("#business-detail").replaceChildren(el("p", "business-hint", hint));
      $("#business-graph-detail").replaceChildren(el("p", "business-hint", "没有可展示的关系图。"));
      return;
    }

    renderBusinessCategories(data);
    renderBusinessItems(data);
    renderBusinessDetail($("#business-detail"), data, state.businessSelected);
    renderBusinessDetail($("#business-graph-detail"), data, state.businessSelected);
    if (state.businessView === "graph") renderBusinessGraph(data);
  }

  function renderBusinessCategories(data) {
    const nav = $("#business-categories");
    nav.replaceChildren();
    const counts = {
      objects: data.objects?.length || 0,
      relations: data.relations?.length || 0,
      actions: data.actions?.length || 0,
      terms: data.terms?.length || 0,
      types: data.types?.length || 0,
    };
    for (const c of BUSINESS_CATEGORIES) {
      const btn = el("button", "business-category" + (state.businessCategory === c.id ? " active" : ""), `${c.label} ${counts[c.id] || 0}`);
      btn.type = "button";
      btn.addEventListener("click", () => {
        state.businessCategory = c.id;
        ensureBusinessSelection(data);
        renderBusiness();
      });
      nav.appendChild(btn);
    }
  }

  function renderBusinessItems(data) {
    const box = $("#business-items");
    box.replaceChildren();
    const q = businessQuery();
    const items = businessItemsFor(data, state.businessCategory, q);
    if (!items.length) {
      box.appendChild(el("p", "empty", q ? `没有匹配「${q}」的条目。` : "这一分类还没有条目。"));
      return;
    }
    for (const item of items) {
      const active = state.businessSelected?.kind === item.kind && state.businessSelected?.id === item.id;
      const btn = el("button", "business-item" + (active ? " active" : ""));
      btn.type = "button";
      btn.appendChild(el("div", "business-item-title", item.title));
      if (item.subtitle) btn.appendChild(el("div", "business-item-sub", item.subtitle));
      btn.addEventListener("click", () => selectBusinessItem(item.kind, item.id));
      box.appendChild(btn);
    }
  }

  function businessDetailHead(container, title, badge, cls) {
    const head = el("div", "card-head");
    head.appendChild(el("h3", "", title));
    if (badge) head.appendChild(el("span", `badge ${cls || "info"}`, badge));
    container.appendChild(head);
  }

  function businessDetailBody(container, text) {
    if (text) container.appendChild(el("div", "detail-body", text));
  }

  function businessDetailRows(container, rows) {
    const grid = el("div", "task-detail");
    for (const [label, value, mono] of rows) {
      if (value === undefined || value === null || value === "") continue;
      const row = el("div", "detail-row");
      row.appendChild(el("span", "detail-label", label));
      row.appendChild(el("div", "detail-value" + (mono ? " mono" : ""), String(value)));
      grid.appendChild(row);
    }
    container.appendChild(grid);
  }

  function businessDetailSubhead(container, text) {
    container.appendChild(el("h4", "business-subhead", text));
  }

  function businessLink(text, onClick) {
    const btn = el("button", "business-link", text);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
  }

  function businessEdgeRow(data, edge, selectedId) {
    const row = el("div", "business-edge");
    const outgoing = edge.from === selectedId;
    row.appendChild(el("span", "edge-arrow", outgoing ? "→" : "←"));
    row.appendChild(el("span", "", businessRelationName(data, edge.relation)));
    const other = outgoing ? edge.to : edge.from;
    row.appendChild(businessLink(businessObjectName(data, other), () => selectBusinessItem("objects", other)));
    return row;
  }

  function renderBusinessDetail(container, data, sel) {
    container.replaceChildren();
    if (!data || !data.exists) {
      container.appendChild(el("p", "business-hint", "还没有业务地图。"));
      return;
    }
    if (!sel) {
      container.appendChild(el("p", "business-hint", "选一个条目看详情，或切到关系图点节点。"));
      return;
    }
    const typeName = (id) => businessTypeName(data, id);
    const objName = (id) => businessObjectName(data, id);
    const relName = (id) => businessRelationName(data, id);
    if (sel.kind === "objects") {
      const o = (data.objects || []).find((x) => x.id === sel.id);
      if (!o) { container.appendChild(el("p", "business-hint", `对象 ${sel.id} 不存在。`)); return; }
      businessDetailHead(container, o.name || o.id, typeName(o.type));
      businessDetailBody(container, o.description);
      businessDetailRows(container, [
        ["id", o.id, true],
        ["type", `${typeName(o.type)}（${o.type}）`],
        ["别名", (o.aliases || []).join(" / ")],
        ["key", o.key?.value ? `${o.key.kind ? `${o.key.kind}:` : ""}${o.key.value}` : "", true],
        ["source", o.source?.value ? `${o.source.kind ? `${o.source.kind}:` : ""}${o.source.value}` : "", true],
        ["tags", (o.tags || []).join(" / ")],
      ]);
      const edges = (data.edges || []).filter((e) => e.from === o.id || e.to === o.id);
      businessDetailSubhead(container, `关系（${edges.length}）`);
      if (!edges.length) container.appendChild(el("p", "muted", "没有解析出边。"));
      else {
        const box = el("div");
        for (const e of edges) box.appendChild(businessEdgeRow(data, e, o.id));
        container.appendChild(box);
      }
      const actions = (data.actions || []).filter((a) => (a.appliesTo || []).includes(o.type));
      if (actions.length) {
        businessDetailSubhead(container, `动作（${actions.length}）`);
        const box = el("div");
        for (const a of actions) {
          const line = el("div", "business-edge");
          line.appendChild(businessLink(a.name || a.id, () => selectBusinessItem("actions", a.id)));
          if (a.risk) line.appendChild(el("span", "badge", a.risk));
          box.appendChild(line);
        }
        container.appendChild(box);
      }
      const terms = (data.terms || []).filter((t) => t.objectId === o.id);
      if (terms.length) {
        businessDetailSubhead(container, `术语（${terms.length}）`);
        const box = el("div");
        for (const t of terms) {
          const line = el("div", "business-edge");
          line.appendChild(el("span", "", t.term));
          if (t.note) line.appendChild(el("span", "muted", t.note));
          box.appendChild(line);
        }
        container.appendChild(box);
      }
      return;
    }
    if (sel.kind === "relations") {
      const r = (data.relations || []).find((x) => x.id === sel.id);
      if (!r) { container.appendChild(el("p", "business-hint", `关系 ${sel.id} 不存在。`)); return; }
      businessDetailHead(container, `${typeName(r.fromType)} → ${typeName(r.toType)}`, r.risk || "", r.risk === "high" ? "warn" : r.risk === "medium" ? "info" : "");
      businessDetailBody(container, r.semantics);
      businessDetailRows(container, [
        ["id", r.id, true],
        ["name", r.name],
        ["from", `${typeName(r.fromType)}（${r.fromType}）`],
        ["to", `${typeName(r.toType)}（${r.toType}）`],
        ["cardinality", r.cardinality],
        ["direction", r.direction],
        ["mapping", r.mapping?.kind ? `${r.mapping.kind}${r.mapping.file ? ` · ${r.mapping.file}` : ""}` : "", true],
      ]);
      const edges = (data.edges || []).filter((e) => e.relation === r.id);
      businessDetailSubhead(container, `实际边（${edges.length}）`);
      if (!edges.length) container.appendChild(el("p", "muted", "没有解析出边：可能是 file mapping 缺数据。"));
      else {
        const box = el("div");
        for (const e of edges) {
          const line = el("div", "business-edge");
          line.appendChild(businessLink(objName(e.from), () => selectBusinessItem("objects", e.from)));
          line.appendChild(el("span", "edge-arrow", "→"));
          line.appendChild(businessLink(objName(e.to), () => selectBusinessItem("objects", e.to)));
          box.appendChild(line);
        }
        container.appendChild(box);
      }
      return;
    }
    if (sel.kind === "actions") {
      const a = (data.actions || []).find((x) => x.id === sel.id);
      if (!a) { container.appendChild(el("p", "business-hint", `动作 ${sel.id} 不存在。`)); return; }
      businessDetailHead(container, a.name || a.id, a.risk || "", a.risk === "high" ? "warn" : a.risk === "medium" ? "info" : "");
      businessDetailBody(container, a.description);
      businessDetailRows(container, [
        ["id", a.id, true],
        ["appliesTo", (a.appliesTo || []).map((t) => typeName(t)).join(" / ")],
        ["requiresRelations", (a.requiresRelations || []).map((id) => `${relName(id)}（${id}）`).join(" / ")],
      ]);
      return;
    }
    if (sel.kind === "terms") {
      const t = (data.terms || []).find((x) => x.term === sel.id);
      if (!t) { container.appendChild(el("p", "business-hint", `术语 ${sel.id} 不存在。`)); return; }
      businessDetailHead(container, t.term, objName(t.objectId));
      businessDetailBody(container, t.note);
      businessDetailRows(container, [["objectId", t.objectId, true]]);
      container.appendChild(businessLink("查看对象详情", () => selectBusinessItem("objects", t.objectId)));
      return;
    }
    const t = (data.types || []).find((x) => x.id === sel.id);
    if (!t) { container.appendChild(el("p", "business-hint", `类型 ${sel.id} 不存在。`)); return; }
    const objects = (data.objects || []).filter((o) => o.type === t.id);
    const relations = (data.relations || []).filter((r) => r.fromType === t.id || r.toType === t.id);
    businessDetailHead(container, t.name || t.id, `${objects.length} 个对象`);
    businessDetailBody(container, t.description);
    businessDetailRows(container, [["id", t.id, true], ["relations", String(relations.length)]]);
    if (objects.length) {
      businessDetailSubhead(container, `对象（${objects.length}）`);
      const box = el("div");
      for (const o of objects) box.appendChild(businessLink(o.name || o.id, () => selectBusinessItem("objects", o.id)));
      container.appendChild(box);
    }
    if (relations.length) {
      businessDetailSubhead(container, `关系（${relations.length}）`);
      const box = el("div");
      for (const r of relations) {
        const line = el("div", "business-edge");
        line.appendChild(businessLink(`${typeName(r.fromType)} → ${typeName(r.toType)}（${r.name || r.id}）`, () => selectBusinessItem("relations", r.id)));
        box.appendChild(line);
      }
      container.appendChild(box);
    }
  }

  function svgNode(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  const BUSINESS_TYPE_COLORS = [
    "#2563eb", "#16a34a", "#db2777", "#f59e0b", "#7c3aed",
    "#0891b2", "#dc2626", "#4d7c0f", "#b45309", "#0f766e",
  ];

  function businessTypeColor(data, typeId) {
    const idx = (data.types || []).findIndex((t) => t.id === typeId);
    return BUSINESS_TYPE_COLORS[(idx >= 0 ? idx : 0) % BUSINESS_TYPE_COLORS.length];
  }

  function layoutBusinessGraph(nodes, edges, width, height) {
    const n = nodes.length;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.34;
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / Math.max(1, n);
      nodes[i].x = cx + Math.cos(angle) * radius;
      nodes[i].y = cy + Math.sin(angle) * radius;
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links = edges.map((e) => ({ a: byId.get(e.from), b: byId.get(e.to) })).filter((l) => l.a && l.b && l.a !== l.b);
    const ideal = Math.max(90, radius * 0.8);
    for (let iter = 0; iter < 180; iter++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy) || 1;
          const force = 2600 / (dist * dist);
          dx /= dist;
          dy /= dist;
          a.x -= dx * force;
          a.y -= dy * force;
          b.x += dx * force;
          b.y += dy * force;
        }
      }
      for (const link of links) {
        const dx = link.b.x - link.a.x;
        const dy = link.b.y - link.a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const force = (dist - ideal) * 0.02;
        const ux = dx / dist;
        const uy = dy / dist;
        link.a.x += ux * force;
        link.a.y += uy * force;
        link.b.x -= ux * force;
        link.b.y -= uy * force;
      }
      for (const node of nodes) {
        node.x += (cx - node.x) * 0.002;
        node.y += (cy - node.y) * 0.002;
      }
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }
    const pad = 46;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY, 1.3);
    for (const node of nodes) {
      node.x = pad + (node.x - minX) * scale + (width - pad * 2 - spanX * scale) / 2;
      node.y = pad + (node.y - minY) * scale + (height - pad * 2 - spanY * scale) / 2;
    }
  }

  function renderBusinessGraph(data) {
    const box = $("#business-graph");
    const note = $("#business-graph-note");
    box.replaceChildren();
    const objects = (data.objects || []).slice(0, 160);
    const byId = new Map(objects.map((o) => [o.id, o]));
    const edges = (data.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to));
    if (!objects.length) {
      box.appendChild(el("p", "empty", "没有可画的对象。"));
      note.textContent = "";
      return;
    }
    const width = Math.max(620, box.clientWidth || 720);
    const height = 480;
    const nodes = objects.map((o) => ({
      id: o.id,
      name: o.name || o.id,
      type: o.type,
      search: [o.id, o.type, o.name, ...(o.aliases || []), ...(o.tags || [])].join(" ").toLowerCase(),
    }));
    layoutBusinessGraph(nodes, edges, width, height);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const q = businessQuery();
    const selectedId = state.businessSelected?.kind === "objects" ? state.businessSelected.id : null;

    const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "业务关系图" });
    const defs = svgNode("defs");
    const marker = svgNode("marker", { id: "business-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
    const arrow = svgNode("path", { d: "M 0 0 L 10 5 L 0 10 z" });
    arrow.style.fill = "var(--muted)";
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const edgeLayer = svgNode("g");
    for (const e of edges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) continue;
      const group = svgNode("g", { class: "business-edge" });
      if (selectedId && (e.from === selectedId || e.to === selectedId)) group.classList.add("hot");
      if (q && !(a.search.includes(q) || b.search.includes(q))) group.classList.add("dim");
      group.appendChild(svgNode("line", {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "business-edge-line", "marker-end": "url(#business-arrow)",
      }));
      if (edges.length <= 28) {
        const label = svgNode("text", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4, class: "business-edge-label", "text-anchor": "middle" });
        label.textContent = e.relation_name || e.relation;
        group.appendChild(label);
      }
      edgeLayer.appendChild(group);
    }
    svg.appendChild(edgeLayer);

    const nodeLayer = svgNode("g");
    for (const node of nodes) {
      const group = svgNode("g", { class: "business-node", tabindex: 0, role: "button", "aria-label": node.name });
      if (q && !node.search.includes(q)) group.classList.add("dim");
      if (selectedId === node.id) group.classList.add("selected");
      const title = svgNode("title");
      title.textContent = `${node.name}（${businessTypeName(data, node.type)}）`;
      group.appendChild(title);
      group.appendChild(svgNode("circle", { cx: node.x, cy: node.y, r: 18, fill: businessTypeColor(data, node.type) }));
      const label = svgNode("text", { x: node.x, y: node.y + 33, "text-anchor": "middle" });
      label.textContent = node.name.length > 16 ? `${node.name.slice(0, 16)}…` : node.name;
      group.appendChild(label);
      group.addEventListener("click", () => selectBusinessItem("objects", node.id));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectBusinessItem("objects", node.id);
        }
      });
      nodeLayer.appendChild(group);
    }
    svg.appendChild(nodeLayer);
    box.appendChild(svg);
    const truncated = data.edges_truncated || objects.length < (data.objects || []).length;
    note.textContent = `${objects.length} 个对象 · ${edges.length} 条边${truncated ? "（已截断）" : ""} · 点节点看详情；颜色按对象类型区分。`;
  }


  // ---------- 用量 ----------

  const USAGE_RANGES = {
    hour: [["24h", "最近 24 小时"], ["7d", "7 天"], ["30d", "30 天"]],
    day: [["7d", "7 天"], ["30d", "30 天"], ["90d", "90 天"]],
  };

  function usageRangeMs(range) {
    if (range === "7d") return 7 * 86400e3;
    if (range === "30d") return 30 * 86400e3;
    if (range === "90d") return 90 * 86400e3;
    return 24 * 3600e3;
  }

  function syncUsageRangeOptions() {
    const select = $("#usage-range");
    const options = USAGE_RANGES[state.usageBucket] || USAGE_RANGES.hour;
    const values = options.map((o) => o[0]);
    if (!values.includes(state.usageRange)) state.usageRange = values[0];
    select.replaceChildren(...options.map(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      return option;
    }));
    select.value = state.usageRange;
  }

  async function loadUsage() {
    setPanelStatus("#usage-status", "加载中…");
    const bucket = state.usageBucket;
    const to = Date.now();
    const from = to - usageRangeMs(state.usageRange);
    try {
      const [stats, detail] = await Promise.all([
        api(`/v1/usage?bucket=${bucket}&from=${from}&to=${to}`),
        api(`/v1/usage/calls?from=${from}&to=${to}&limit=200`),
      ]);
      renderUsageSummary(stats.summary);
      renderUsageChart(Array.isArray(stats.series) ? stats.series : []);
      const calls = Array.isArray(detail.calls) ? detail.calls : [];
      renderUsageCalls(calls);
      setPanelStatus("#usage-status", `共 ${calls.length} 条明细 · 最近更新 ${new Date().toLocaleTimeString("zh-CN")}`);
    } catch (e) {
      setPanelStatus("#usage-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  function renderUsageSummary(summary) {
    const box = $("#usage-summary");
    box.replaceChildren();
    const s = summary || {};
    const cards = [
      ["总 token", Number(s.tokens || 0).toLocaleString()],
      ["调用次数", Number(s.calls || 0).toLocaleString()],
      ["成本", `$${Number(s.costUsd || 0).toFixed(4)}`],
      ["缓存命中率", `${(Number(s.hitRate || 0) * 100).toFixed(1)}%`],
    ];
    for (const [label, value] of cards) {
      const card = el("div", "usage-card");
      card.appendChild(el("span", "usage-label", label));
      card.appendChild(el("strong", "usage-value", value));
      box.appendChild(card);
    }
  }

  function renderUsageChart(series) {
    const box = $("#usage-chart");
    box.replaceChildren();
    if (!series.length) {
      box.appendChild(el("p", "empty", "这个时间段还没有用量记录。"));
      return;
    }
    const NS = "http://www.w3.org/2000/svg";
    const W = 800, H = 240, baseY = 206, chartH = 170;
    const n = series.length;
    const maxTokens = series.reduce((m, p) => Math.max(m, Number(p.tokens) || 0), 0);
    const step = W / n;
    const barW = Math.max(1, Math.min(48, step * 0.66));
    const labelEvery = Math.max(1, Math.ceil(n / 8));

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "token 用量柱状图");
    const axis = document.createElementNS(NS, "line");
    axis.setAttribute("x1", "0");
    axis.setAttribute("x2", String(W));
    axis.setAttribute("y1", String(baseY));
    axis.setAttribute("y2", String(baseY));
    axis.setAttribute("class", "usage-axis");
    svg.appendChild(axis);

    series.forEach((p, i) => {
      const tokens = Number(p.tokens) || 0;
      const height = maxTokens > 0 ? (tokens / maxTokens) * chartH : 0;
      const x = step * i + (step - barW) / 2;
      const y = baseY - height;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", x.toFixed(1));
      rect.setAttribute("y", y.toFixed(1));
      rect.setAttribute("width", barW.toFixed(1));
      rect.setAttribute("height", Math.max(0, height).toFixed(1));
      rect.setAttribute("class", "usage-bar");
      const title = document.createElementNS(NS, "title");
      title.textContent = `${p.key} · ${tokens.toLocaleString()} tokens · ${Number(p.calls) || 0} 次 · $${Number(p.costUsd || 0).toFixed(4)}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (i % labelEvery === 0) {
        const label = document.createElementNS(NS, "text");
        label.setAttribute("x", (step * i + step / 2).toFixed(1));
        label.setAttribute("y", "228");
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "usage-axis-label");
        label.textContent = p.label;
        svg.appendChild(label);
      }
    });
    box.appendChild(svg);
  }

  function renderUsageCalls(calls) {
    const box = $("#usage-calls");
    box.replaceChildren();
    if (!calls.length) return;
    const table = el("table", "usage-table");
    const thead = el("thead");
    const headRow = el("tr");
    for (const label of ["时间", "来源", "模型", "调用", "缓存命中", "未命中", "输出", "合计", "成本"]) {
      headRow.appendChild(el("th", "", label));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const c of calls) {
      const row = el("tr");
      row.appendChild(el("td", "", c.ts_local || formatTs(c.ts)));
      row.appendChild(el("td", "", c.source === "llm" ? "模型调用" : c.source === "wake" ? "历史唤醒" : (c.source || "—")));
      row.appendChild(el("td", "", c.model || "—"));
      row.appendChild(el("td", "num", Number(c.calls || 0).toLocaleString()));
      row.appendChild(el("td", "num", Number(c.cacheHit || 0).toLocaleString()));
      row.appendChild(el("td", "num", Number(c.cacheMiss || 0).toLocaleString()));
      row.appendChild(el("td", "num", Number(c.outTokens || 0).toLocaleString()));
      row.appendChild(el("td", "num", Number(c.totalTokens || 0).toLocaleString()));
      row.appendChild(el("td", "num", `$${Number(c.costUsd || 0).toFixed(4)}`));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }

  // ---------- 调度设置 ----------

  async function loadScheduler() {
    setPanelStatus("#scheduler-status", "加载中…");
    try {
      const s = await api("/v1/scheduler");
      $("#scheduler-private").value = String(Math.round(Number(s.privateWakeMs) / 1000));
      $("#scheduler-group").value = String(Math.round(Number(s.groupWakeMs) / 1000));
      $("#scheduler-task").value = String(Math.round(Number(s.taskWakeMs) / 1000));
      setPanelStatus("#scheduler-status", "");
    } catch (e) {
      setPanelStatus("#scheduler-status", `加载失败：${friendlyError(e) || "未登录"}`, true);
    }
  }

  async function saveScheduler() {
    const fields = [
      ["privateWakeMs", "#scheduler-private", "私聊唤醒间隔"],
      ["groupWakeMs", "#scheduler-group", "群聊唤醒间隔"],
      ["taskWakeMs", "#scheduler-task", "任务群唤醒间隔"],
    ];
    const body = {};
    for (const [key, selector, label] of fields) {
      const seconds = Number($(selector).value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        setPanelStatus("#scheduler-status", `${label}必须大于 0 秒`, true);
        return;
      }
      body[key] = Math.round(seconds * 1000);
    }

    const btn = $("#save-scheduler");
    btn.disabled = true;
    setPanelStatus("#scheduler-status", "保存中…");
    try {
      const saved = await api("/v1/scheduler", { method: "PUT", body });
      $("#scheduler-private").value = String(Math.round(Number(saved.privateWakeMs) / 1000));
      $("#scheduler-group").value = String(Math.round(Number(saved.groupWakeMs) / 1000));
      $("#scheduler-task").value = String(Math.round(Number(saved.taskWakeMs) / 1000));
      setPanelStatus("#scheduler-status", "已保存并生效");
    } catch (e) {
      setPanelStatus("#scheduler-status", `保存失败：${friendlyError(e) || "未登录"}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- URL 状态 ----------

  function readLocationState() {
    const params = new URLSearchParams(location.search);
    let tab = params.get("tab");
    let view = params.get("view");
    if (tab && LEGACY_TAB_VIEW[tab]) {
      view = LEGACY_TAB_VIEW[tab];
      tab = "manage";
    }
    if (tab === "manage" && view === "business") {
      tab = "business";
      view = null;
    }
    if (!tab || !TAB_NAMES.has(tab)) tab = "chat";
    if (tab === "manage") {
      if (!view || !MANAGE_VIEWS.has(view)) view = "workers";
    } else {
      view = null;
    }
    return { tab, view };
  }

  function writeLocationState(tab, view, opts = {}) {
    const params = new URLSearchParams(location.search);
    params.set("tab", tab);
    if (tab === "manage") params.set("view", view || state.manageView);
    else params.delete("view");
    const search = params.toString();
    const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (url === current) return;
    if (opts.replace) history.replaceState({ tab }, "", url);
    else history.pushState({ tab }, "", url);
  }

  // ---------- 页签 ----------

  function updateFooter() {
    const foot = $("#app-foot");
    if (!foot) return;
    let hint = "";
    if (state.tab === "business") {
      hint = state.business?.dir
        ? `业务地图：${state.business.dir}`
        : (document.querySelector("#tab-business")?.dataset.hint || "");
    } else if (state.tab === "manage") {
      hint = document.querySelector(".manage-view.active")?.dataset.hint || "";
    } else {
      hint = document.querySelector(`#tab-${state.tab}`)?.dataset.hint || "";
    }
    foot.textContent = hint;
    foot.hidden = !hint;
  }

  function switchManageView(view, opts = {}) {
    if (!MANAGE_VIEWS.has(view)) view = "workers";
    state.manageView = view;
    $$(".manage-menu button").forEach((b) => b.classList.toggle("active", b.dataset.manage === view));
    $$(".manage-view").forEach((v) => v.classList.toggle("active", v.id === `manage-${view}`));
    updateFooter();
    if (view === "workers") {
      void loadWorkers();
    } else if (view === "users") {
      void loadUsers();
    } else if (view === "persona") {
      void loadEditors();
    } else if (view === "settings") {
      void loadScheduler();
    } else if (view === "usage") {
      void loadUsage();
    } else if (view === "skills") {
      void loadSkills();
    }
    if (!opts.skipUrl && state.tab === "manage") {
      writeLocationState("manage", view, { replace: !!opts.replace });
    }
  }

  function switchTab(name, opts = {}) {
    if (LEGACY_TAB_VIEW[name]) {
      state.manageView = LEGACY_TAB_VIEW[name];
      name = "manage";
    }
    if (!TAB_NAMES.has(name)) name = "chat";
    state.tab = name;
    $$(".tabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    updateFooter();
    if (name === "manage") {
      switchManageView(state.manageView, { skipUrl: true });
    } else if (name === "chat") {
      if (state.current) void loadLatestMessages(true).catch(() => {});
    } else if (name === "tasks") {
      void loadTasks();
    } else if (name === "approvals") {
      void loadApprovals();
    } else if (name === "plans") {
      void loadPlans();
    } else if (name === "memories") {
      void loadMemories();
    } else if (name === "business") {
      void loadBusiness();
    }
    if (!opts.skipUrl) writeLocationState(name, state.manageView, { replace: !!opts.replace });
  }

  function applyLocationState(opts = {}) {
    const { tab, view } = readLocationState();
    if (view) state.manageView = view;
    switchTab(tab, { skipUrl: true });
    if (opts.replace) writeLocationState(tab, state.manageView, { replace: true });
  }

  // ---------- 初始化 ----------

  async function refreshCurrent() {
    const btn = $("#reload-current");
    if (btn?.disabled) return;
    btn.disabled = true;
    try {
      if (state.tab === "chat") {
        await loadPools(false);
        if (state.current) await loadLatestMessages(false);
      } else if (state.tab === "tasks") {
        await loadTasks();
      } else if (state.tab === "approvals") {
        await loadApprovals();
      } else if (state.tab === "plans") {
        await loadPlans();
      } else if (state.tab === "memories") {
        await loadMemories();
      } else if (state.tab === "business") {
        await loadBusiness();
      } else if (state.tab === "manage") {
        if (state.manageView === "workers") await loadWorkers();
        else if (state.manageView === "users") await loadUsers();
        else if (state.manageView === "persona") await loadEditors(true);
        else if (state.manageView === "settings") await loadScheduler();
        else if (state.manageView === "usage") await loadUsage();
        else if (state.manageView === "skills") await loadSkills();
      }
    } catch (e) {
      const msg = friendlyError(e);
      if (msg) setHealth(false, "刷新失败");
    } finally {
      btn.disabled = false;
    }
  }

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

    $$(".tabs button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $$(".manage-menu button").forEach((btn) => {
      btn.addEventListener("click", () => switchManageView(btn.dataset.manage));
    });

    window.addEventListener("popstate", () => applyLocationState({ replace: false, fromPop: true }));

    $("#back-to-pools").addEventListener("click", () => {
      $("#tab-chat").classList.remove("reading");
      $(".pool.active")?.focus();
    });
    $("#jump-latest").addEventListener("click", () => {
      const box = $("#messages");
      box.scrollTop = box.scrollHeight;
    });
    $("#reload-current").addEventListener("click", () => void refreshCurrent());
    $("#save-persona").addEventListener("click", () => void savePersona());
    $("#save-prompt").addEventListener("click", () => void saveSystemPrompt());
    $("#save-scheduler").addEventListener("click", () => void saveScheduler());
    $("#business-search").addEventListener("input", () => {
      if (!state.business) return;
      ensureBusinessSelection(state.business);
      renderBusiness();
    });
    $$("#business-view-switch button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.businessView = btn.dataset.businessView === "graph" ? "graph" : "list";
        renderBusiness();
      });
    });
    $("#usage-bucket").addEventListener("change", (e) => {
      state.usageBucket = e.target.value === "day" ? "day" : "hour";
      syncUsageRangeOptions();
      void loadUsage();
    });
    $("#usage-range").addEventListener("change", (e) => {
      state.usageRange = e.target.value;
      void loadUsage();
    });
    syncUsageRangeOptions();

    $("#task-status-filter").addEventListener("change", (e) => {
      state.taskStatus = e.target.value;
      state.taskPage = 1;
      void loadTasks();
    });
    $("#task-executor-filter").addEventListener("change", (e) => {
      state.taskExecutor = e.target.value;
      state.taskPage = 1;
      renderTasks();
    });
    $("#task-search").addEventListener("input", (e) => {
      state.taskSearch = e.target.value;
      state.taskPage = 1;
      renderTasks();
    });
    $("#tasks-pager").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-task-page]");
      if (!btn || btn.disabled) return;
      state.taskPage = Number(btn.dataset.taskPage);
      renderTasks();
    });
    $("#tasks-pager").addEventListener("change", (e) => {
      if (e.target.id !== "task-page-size") return;
      state.taskPageSize = Number(e.target.value) || 20;
      state.taskPage = 1;
      renderTasks();
    });
    $("#task-modal-close").addEventListener("click", closeTaskModal);
    $("[data-close-task-modal]").addEventListener("click", closeTaskModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.taskModalId !== null) closeTaskModal();
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
