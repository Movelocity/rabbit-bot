# AstrBot Web 管理端调研 → rabbit-bot 池管理设计参考

> 参考仓库：`/Users/viking/projects/pub-repos/AstrBot`（只读，未改动）。
> 目标：给 `app/web/` 原生控制台补「聊天池的新增/编辑/删除/管理」。
> 所有路径均为绝对路径；AstrBot 侧结论都带文件与行号，rabbit-bot 侧建议都落到具体文件。

---

## 1. AstrBot dashboard 的技术栈、入口、路由、目录

### 1.1 技术栈（证据在 `dashboard/package.json`）

| 项 | 结论 | 位置 |
|---|---|---|
| 框架 | Vue **3.3.4**，全部 `<script setup>` | `dashboard/package.json` L46 |
| 构建 | Vite **6.4.1** + TS 5.1.6 + `vue-tsc --noEmit` 类检 | `package.json` L9-L11；`vite.config.ts` L76-86（`vue()` + `vuetify({autoImport:true})`）、L99 alias `@ → src`、L117-127 dev 端口 3000 且 `proxy '/api' → 127.0.0.1:6185` |
| 组件库 | **Vuetify 3.7.11**，主题 `PurpleTheme` / `PurpleThemeDark` | `package.json` L51；`src/plugins/vuetify.ts` L11-17 |
| 状态管理 | **Pinia 2.1.6**，9 个 store | `src/stores/`：`auth.ts`、`customizer.ts`、`toast.js`、`mobileDrawer.ts`、`routerLoading.ts`、`personaStore.ts`、`chatHeader.ts`、`headerContext.ts`、`common.js` |
| 路由 | vue-router 4.2.4，**hash 模式** + 登录守卫 | `src/router/index.ts` L8-15 `createWebHashHistory`；L30-54 `beforeEach`（`meta.requiresAuth` → `/auth/login`） |
| 请求封装 | 双层：① axios/fetch 拦截器 ② OpenAPI 生成 SDK | ① `src/api/http.ts` L14 `axios.create({ baseURL: '/api/v1' })`，L36-56 `attachAxiosHeaders` 注入 `Bearer` + `Accept-Language`（同源才带凭证），L58-115 `normalizeAxiosError`（401 清 localStorage 并跳登录），L122-158 `fetchWithAuth` 连 `window.fetch` 一起包；② `package.json` L13 `generate:api` 用 `@hey-api/openapi-ts` 从 `../openspec/openapi-v1.yaml` 生成到 `src/api/generated/openapi-v1/` |
| API 组织 | `src/api/v1.ts`（1936 行）按域分组的对象门面，`typed<T>()` 统一包成 `ApiEnvelope<T> = {status:'ok'\|'error', message?, data}` | `v1.ts` L72-76；L67-70 `openApiV1Client.setConfig({axios, throwOnError:true})`；分组如 `botApi` L453、`knowledgeApi` L1511、`personaApi` L1701、`sessionApi` L1036 |
| i18n | 自研封装，页面级 `useModuleI18n('features/xxx')` 取 `tm` | `src/i18n/composables.ts` L12/L42；用法见 `PlatformPage.vue` L335 |
| 样式 | SCSS + scoped style + Vuetify 主题变量 | `src/main.ts` L8 `import '@/scss/style.scss'` |

补充两点，避免误判：
- `yup` / `vee-validate` 虽在 `package.json` L44/L52，**实际只有登录页用**（全库唯一引用 `views/authentication/authForms/AuthSetup.vue`）。业务表单清一色是 Vuetify 的 `:rules` 函数数组（见 §2.4）。
- `src/config.ts` 只是主题配置（`resolveUiTheme` L31-38），不是业务配置。

### 1.2 入口与目录

链路：`dashboard/index.html` → `/src/main.ts` → `setupI18n().then` 内 `createApp(App)` + `app.use(pinia/router/vuetify/confirmPlugin)` + `await router.isReady()` + `app.mount('#app')`（`src/main.ts` L78-91）。`src/App.vue` 只有 `<RouterView>` + 全局 `v-snackbar`。

`src/` 目录职责：

```
api/        http.ts（拦截器）、v1.ts（按域门面）、generated/openapi-v1/（生成物）
components/ 按域分组：chat/ platform/ provider/ conversation/ shared/ …（shared/ 是跨页复用件）
layouts/    full/FullLayout.vue（主壳）、blank/BlankLayout.vue（登录/弹窗聊天）
router/     index.ts、MainRoutes.ts、AuthRoutes.ts、ChatBoxRoutes.ts
stores/     Pinia
views/      页面，按域一个目录或一个文件（PlatformPage.vue、knowledge-base/、persona/ …）
```

### 1.3 路由表（`src/router/MainRoutes.ts`，父级 `path:'/main'` → `FullLayout.vue` L13-19）

| path | name | 组件文件 |
|---|---|---|
| `/platforms` | Platforms | `src/views/PlatformPage.vue`（L141-145） |
| `/providers` | Providers | `src/views/ProviderPage.vue`（L146-150） |
| `/session-management` | SessionManagement | `src/views/SessionManagementPage.vue`（L164-168） |
| `/persona` | Persona | `src/views/PersonaPage.vue`（L169-173） |
| `/knowledge-base` | NativeKBList | `src/views/knowledge-base/KBList.vue`（L252-257）；子路由 `:kbId` → `KBDetail.vue`、`:kbId/document/:docId` → `DocumentDetail.vue` |
| `/data/conversations` | Conversation | `src/views/conversation/ConversationWorkspacePage.vue`（L192-197） |
| `/auth/login`、`/auth/setup` | — | `AuthRoutes.ts` → `BlankLayout.vue` |

### 1.4 侧栏导航

导航是**纯数据数组**，不是散在模板里：`src/layouts/full/vertical-sidebar/sidebarItem.ts`
- `interface menu`（L15-39）：`header / title / icon / to / children / chip / collapsible`；
- 数组 L47-106，`title` 全是 i18n key，icon 用 `markRaw(Lucide组件)`，例如 L56-60 `{ title:'core.navigation.platforms', icon: markRaw(Bot), to:'/platforms' }`；
- `VerticalSidebar.vue` L198-212 用 `v-navigation-drawer` 渲染；`NavItem.vue` L21-33 `isItemActive` 用 `route.path.startsWith(targetPath + '/')` 前缀匹配。

---

## 2. 实体的列表/详情/新建/编辑/删除/校验/三态

AstrBot 里有三套代表性实现，**池管理只需要抄第一套的骨架 + 第三套的删除设计**。

### 2.1 模式 A：单文件列表 + 共用对话框增改 + 删除确认（最值得抄）

文件：`/Users/viking/projects/pub-repos/AstrBot/dashboard/src/views/knowledge-base/KBList.vue`（606 行，一个文件闭环）

**三态分支（模板最前面三个 `v-if`）**：
- 加载：L3-6 `v-if="loading && kbList.length === 0"` → `v-progress-circular indeterminate`；
- 错误+重试：L8-15 `loadError && kbList.length === 0` → 错误图标 + 「重试」按钮 `@click="loadKnowledgeBases()"`；
- 列表：L17-100；空状态：L102-110 大图标 + 文案 + **主按钮「新建」直接开对话框**（空状态自带 CTA，不是死胡同）。

**新建/编辑共用一个对话框**：
- 模板 L143-211 `<v-dialog v-model="showCreateDialog" persistent>` 内含 `<v-form ref="formRef" @submit.prevent="submitForm">`（L155）；
- 状态（L277-297）：`showCreateDialog` / `showDeleteDialog` / `editingKB` / `deleteTarget` / `formData`；
- `editKB(kb)` L353-364 把实体灌进 `formData` 再开同一个 dialog；`submitForm()` L408-410 先 `await formRef.value.validate()` 判 `valid`，再按 `editingKB` 分流 `knowledgeApi.create/update`（L422-430）；
- 提交按钮 `:loading="saving"`（L206），失败走 `showSnackbar(msg,'error')`。

**删除**：`confirmDelete(kb)` L367 设 `deleteTarget` → 独立删除对话框 L214-235（含 `v-alert type="error"` 影响警告 L220-222）→ `deleteKB()` L379-405 调 `knowledgeApi.delete`，成功后 snackbar、**若删空当前页则 `page -= 1`**（L390-392）、重载列表。

**分页**：`v-pagination` L92-99，`page/pageSize/total` 状态 L266-268。

### 2.2 模式 B：独立表单组件 + Promise 型全局确认

- 列表页：`src/views/persona/PersonaManager.vue`，`openCreatePersonaDialog()` L628-629、`editPersona()` L633、`confirmDeletePersona()` L660：
  ```ts
  if (!(await askForConfirmationDialog(this.tm("messages.deleteConfirm", { id: persona.persona_id }), this.confirmDialog))) return;
  await this.deletePersona(persona.persona_id);
  ```
- 表单组件：`src/components/shared/PersonaForm.vue`（新建/编辑同一组件，`defineEmits(["update:modelValue","saved","error","deleted"])` L207）；
- 确认底座：`src/components/ConfirmDialog.vue` — `open(options)` 返回 Promise（L26-34），`defineExpose({open})`（L46），由 `src/utils/confirmDialog.ts` 的 `useConfirmDialog()` 注入成 `$confirm`，无插件时降级 `window.confirm`；
- 骨架屏防闪：`PersonaManager.vue` L92-104 + watch L573-595 — loading 后**延迟 150ms** 才显示 skeleton，加载完成立即隐藏（快请求不闪一下）。

### 2.3 模式 C：级联清理式删除（删池最该抄这个）

文件：`/Users/viking/projects/pub-repos/AstrBot/dashboard/src/components/platform/DeletePlatformDialog.vue`（190 行）

- 受控对话框：`:model-value="!!platform"`（L3），父组件 `PlatformPage.vue` L181-184 传 `v-model:platform` + `@deleted`；
- **删除时让用户勾选清理范围**：`defaultCleanup = ['custom_rules','preferences','routing','cron_jobs']`、`historyTargets = ['conversations','message_history','traces','stats']`（L113-126），每项 `v-checkbox` + tooltip 描述 + 历史项「全选/反选」（`allHistorySelected` computed L129-137）；
- 错误显示在对话框内联 `v-if="error"`（L78-80），按钮 `:loading="deleting"`（L94）；提交 `deletePlatform()` L147-161 → `botApi.delete(id, cleanup.value)`，成功 `emit('deleted', id)`。

注意：AstrBot 的清理是**类型级勾选，没有「会影响 N 条消息」的计数**（后端不返回计数）。rabbit-bot 若要计数，需要在 `app/src/ops/pools.ts` 自己算（`store.poolSpan(pool_id).total` 已有）。

### 2.4 表单校验写法

Vuetify `:rules` 函数数组（返回 `true | 字符串`），不用 yup/zod：

`src/components/shared/PersonaForm.vue` L238-251：
```ts
const personaIdRules = computed(() => [
  (value) => Boolean(value) || tm("validation.required"),
  (value) => (value && value.length >= 1) || tm("validation.minLength", { min: 1 }),
  (value) => props.editingPersona?.persona_id === value ||
    !existingPersonaIds.value.includes(value) || tm("validation.personaIdExists"),
]);
```
唯一性靠**预取已有 id 列表**做同步检查（`existingPersonaIds`）。`KBList.vue` L158 是内联写法：`:rules="[v => !!v || t('create.nameRequired')]"`；L171 展示「新建必填、编辑锁定」的条件规则：`v => editingKB !== null || !!v || ...`。

### 2.5 请求层与 API 门面

- 拦截器统一注入 Bearer + 401 跳登录（`src/api/http.ts` L36-56、L58-115），**没有统一 toast**，错误由调用方 catch 后自己 `showSnackbar`；
- 业务调用一律 `xxxApi.method()`（`src/api/v1.ts`），内部 `typed<T>()` 包 `ApiEnvelope`，调用方判 `response.data.status === 'ok'`；
- 典型签名：`knowledgeApi.list/create/update/delete`（L1511-1580）、`personaApi.create/update/delete`（L1701-1756）、`botApi.delete(botId, cleanup[])`（L495）、`sessionApi.deleteRules({umos})`（L1060）。

### 2.6 大列表页（参考即可）

`src/views/SessionManagementPage.vue`：`v-data-table-server` + `:loading`（L36-39）、服务端搜索、多选批量删除（`selectedItems` + `batchDeleteRules()` L1277）、删除/批量删除两个对话框（L494、L511）、顶部 snackbar（L533）。池数量级远小于此，**不需要表格化**。

---

## 3. 信息架构与布局（只挑与池管理相关的）

### 3.1 详情的三种模式，选哪个

| 模式 | AstrBot 例子 | 适配 rabbit-bot？ |
|---|---|---|
| 独立子路由 + 面包屑 | KB：`KBList.vue` L349 `router.push({name:'NativeKBDetail'})`，外壳 `knowledge-base/index.vue` 用 `isDetailRoute` 渲染返回按钮 | 否。rabbit-bot 没有路由库，页签即路由（`app/web/app.js` `switchTab()` L594-607） |
| 单页左右分栏 workbench | `PlatformPage.vue` L6 左 `aside` 列表 + L146 右编辑器，选中靠 `selectedPlatformId` ref（L35），移动端把列表降级成 `v-select`（L31-80） | **是**。`app/web/index.html` L52-77 已经是这个结构（`.pools` 侧栏 + `.conversation` 主区） |
| 独立对话框增删改 | Persona 的 `v-dialog`、Session 的 `ruleDialog` | **是**。新建/编辑/删除都用对话框，不动现有页签结构 |

**结论：rabbit-bot 池管理 = 现有左右分栏 + 三个对话框（新建/编辑/删除），不引入新页面、不引入路由。**

### 3.2 值得直接抄的布局细节

1. **空状态带 CTA**：`KBList.vue` L102-110 空状态里直接放「新建」主按钮。对应 `app/web/app.js` `renderPools()` L192-194 现在只有一行 `还没有会话池。`，应加按钮开新建对话框。
2. **侧栏头部放动作**：`app/web/index.html` L54-57 `.pools-head` 已有「会话池 + 刷新」，照 AstrBot 的 `KBList` FAB 组（L112-140）再加一个「+ 新建」按钮即可，无需 FAB 悬浮。
3. **移动端**：AstrBot 用 `stores/mobileDrawer.ts`（`open/SET/TOGGLE`）+ `v-navigation-drawer :temporary="isMobile"`（`VerticalSidebar.vue` L198-203），路由切换时强制关抽屉（`FullLayout.vue` L57-61）。rabbit-bot 已有更简单的等价物：`app/web/style.css` L438-455 `@media (max-width: 820px)` 把 `.chat-layout` 从两列 grid 改成上下两行（池列表占 32vh）。**池管理对话框只需补一条：`max-width` 超过 480px 时全屏化**，参考 `style.css` L457-460 的 480px 断点。
4. **滚动锁定**：AstrBot 对 workbench 页加 `page-content--locked`（`FullLayout.vue` L31-38、L146）。rabbit-bot 对话框打开时给 `body` 加类即可（`app/web/style.css` 已有 `.hidden` L49 的先例）。
5. **操作反馈**：AstrBot 统一 `v-snackbar`。rabbit-bot 已有等价物 `setPanelStatus()`（`app.js` L91-95）与 `#send-status`；池管理建议复用顶栏 `#health-text` 做瞬时成功提示，或在池列表上方加一行 `.status`（`style.css` L368-369 已有 `.status` / `.status.error` 样式）。

### 3.3 不要抄的布局

- 全局侧栏 + 二级分组菜单（`sidebarItem.ts` 的 `header/children/collapsible`）——rabbit-bot 只有 4 个页签（`index.html` L44-49），加一个「池管理」页签或直接在会话页操作即可；
- 独立详情路由 + query 同步选中（`ConversationWorkspacePage.vue` L424-431 `route.query.umo`）——没有路由库，且 3s 轮询（`app.js` `startPolling()` L153-164）已经承担刷新；
- `isViewportLockedRoute` 这类按路由锁滚动的机制——对话框级 `overflow:hidden` 足够。

---

## 4. rabbit-bot 升级方案：两套

现状基线（都要在此之上改）：
- `app/web/index.html` 153 行、`app.js` 666 行（IIFE + `state` 对象 + `el()` 手搓 DOM）、`style.css` 460 行；
- 请求封装已有：`rawFetch()`（`app.js` L47-57）+ `api()`（L59-71，解 `{ok,data}`、401 弹登录）；
- 写操作范式已有：计划「标记完成」（L422-434，PATCH + 重载 + 失败恢复 disabled）、记忆「新增/关闭」（L493-505、L523-559）；
- 静态服务：`app/src/api.ts` `serveStatic()` L55-80（只认 `/` 和 `/ui/*`，路径穿越拦截），`WEB_ROOT = APP_ROOT/web` L38。

### 方案 A：继续原生 HTML/CSS/JS（推荐先做）

**改动清单（6 个文件：3 个 web + 3 个后端）**：

| 文件 | 改什么 |
|---|---|
| `app/web/index.html` | ① `.pools-head`（L54-57）加 `<button id="new-pool">新建</button>`；② 文件尾部加三个 `<dialog>`（或 `.modal.hidden` div）：新建池、编辑池、删除确认；③ 复用现有 `.field`/`.muted`/`.error` 类 |
| `app/web/app.js` | ① `state` 加 `poolDialog: null \| {mode:'create'\|'edit', form:{...}}`；② 新增 `openCreatePool()/openEditPool(pool)/confirmDeletePool(pool)`；③ 新增 `createPool()/updatePool()/deletePool()`，内部只调已有 `api()`；④ `renderPools()`（L189-213）每行加编辑/删除两个小按钮（照 `renderPlans()` L419-434 的 `card-actions` 写法）；⑤ 空状态（L192-194）加「新建池」按钮 |
| `app/web/style.css` | 新增 `.modal`、`.modal-card`、`.pool-actions` 约 60 行；`@media (max-width: 480px)` 里让 `.modal-card` 全屏 |
| `app/src/api.ts` | `case "pools"`（L164-209）加 POST/PATCH/DELETE 三个分支 |
| `app/src/ops/pools.ts` | 新增 `createPool/updatePool/deletePool`（现在整个文件是只读的，L1 注释要改） |
| `app/src/core/db.ts` | 新增 `Store.deletePool()` 事务方法 |

**成本**：0 构建链、0 新依赖；估计 `app.js` +150~200 行、`style.css` +60 行、后端 +120 行。改完刷新页面即生效（`serveStatic` 已设 `cache-control: no-cache`，`api.ts` L76）。

**风险**：
1. `app.js` 从 666 行涨到 ~850 行，IIFE 内手搓 DOM 的模式继续膨胀——但池管理只有 4 个字段、3 个对话框，仍在可控范围；
2. 表单校验必须手写（没有 `:rules`），要自己写 `validatePoolForm()` 并保证和 `ops/pools.ts` 的服务端校验**一致**（参照 `ops/common.ts` 的 `resolvePool`/`clampInt`：校验逻辑放 ops 层，前端只做即时反馈）；
3. 对话框的焦点管理/ESC 关闭/无障碍要手写（AstrBot 白拿 Vuetify `v-dialog`）。

**适用判断**：池管理是 4 字段 CRUD，方案 A 够用。**建议先做 A**，把 API 和数据层（`db.ts`/`ops/pools.ts`/`api.ts`）先定型——这部分与前端选型无关，两套方案共用。

### 方案 B：引入轻量框架 + 构建链

**具体形态**：`app/web/` 变成 Vue 3 + Vite 源码目录（AstrBot 同栈但**不带 Vuetify**），构建产物到 `app/web/dist/`，`api.ts` `serveStatic()` 改为优先服务 `dist/`。

**改动清单**：
- 新增 `app/web/package.json`（vue、vite、@vitejs/plugin-vue）+ `app/web/vite.config.ts`（`base: '/ui/'`，因为静态服务挂在 `/ui/*`，见 `api.ts` L56-59）；
- `index.html`/`app.js` 拆成 `src/App.vue` + `src/components/{PoolList,PoolFormDialog,DeletePoolDialog}.vue` + `src/api.ts`（把现有 `rawFetch/api` 平移）；
- `app/src/api.ts` `serveStatic()` L55-80 改指向 `web/dist`（或 `WEB_ROOT` 双路径回退）；
- 部署脚本 `app/scripts/`、`app/ecosystem.config.cjs`、`app/docker/` 加 `npm run build` 步骤。

**成本**：
- 一次性：新增 2 个配置文件 + 拆分 666 行 `app.js`（约 1~2 天），`serveStatic` 与部署链各改一处；
- 长期：每次改前端要 `vite build`，开发要起 `vite dev` + proxy 到 3738 端口（AstrBot 的做法，`vite.config.ts` L117-127）；
- 若再上 Vuetify（AstrBot 全套）：+1 依赖树、主题系统要和 `style.css` 现有 CSS 变量（`--border/--muted/--bad` 等）二选一，**不建议**。

**风险**：
1. `serveStatic` 是安全敏感路径（`api.ts` L63-64 路径穿越检查），改 `WEB_ROOT` 要重测；
2. 双份前端（源码 + 产物）进 git 的取舍（产物提交 or CI 构建）；
3. 项目现有 `app/package.json` 是后端依赖，web 构建链要么进同一个 package.json（依赖污染），要么开 workspace/子包（复杂度上升）；
4. 引入构建链是**项目级决策**：`app/package.json` 目前只服务后端，`app/web/` 从「零构建、改完刷新即生效」变成「必须先 build」，部署（`app/DEPLOY.local.md`、`app/ecosystem.config.cjs`）和 Docker 流程都要跟着加一步。

**适用判断**：只有当池管理之后还要继续做「计划编辑器」「记忆管理页」「日志查看器」等多轮 UI 扩张时才值。单次池管理功能不值。

**中间形态（不计入两套方案，仅备忘）**：不建构建链，用浏览器原生 `<dialog>` 元素 + 现有 `el()` 工厂函数。方案 A 已包含此意，`<dialog>` 的 `showModal()` 免费给到 ESC 关闭和焦点陷阱。

### 两套方案对照

| | A 继续原生 | B Vue3+Vite（不带组件库） |
|---|---|---|
| 新依赖 | 0 | vue、vite、@vitejs/plugin-vue |
| 构建步骤 | 无 | `vite build`（`base:'/ui/'`） |
| 改动文件 | 现有 3 个 web 文件 + 3 个后端文件 | 拆成 ~6 个 Vue 文件 + 2 配置 + `serveStatic` + 部署链 |
| 校验 | 手写 `validatePoolForm()`，与 ops 层重复 | 组件内 rules，仍需 ops 层兜底 |
| 后端（db/ops/api） | **完全相同** | **完全相同** |
| 主要风险 | `app.js` 膨胀、对话框体验要手搓 | 构建/部署链改造、`serveStatic` 安全路径回归 |

**推荐路径**：先按方案 A 落地 API + 原生 UI；若后续 UI 需求连续超过 2~3 轮，再把 `app/web/` 整体迁到方案 B（届时 A 里写的 `createPool/updatePool/deletePool` 与对话框结构可原样平移）。

---

## 5. 对照 rabbit-bot 数据模型：字段、接口、校验、API 形状

### 5.1 现有 pools 表（`app/src/core/db.ts` SCHEMA L9-13）

```sql
pools(pool_id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, last_msg_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(platform, external_id))
```

- `pool_id` 由 `Store.poolIdFor(platform, externalId)` 拼接生成（L137）：`` `${platform}:${externalId}` ``。**前端不许传 pool_id**。
- **无外键、无 `ON DELETE`**（构造函数 L94-97 只设 `journal_mode=WAL` 和 `busy_timeout`，未开 `pragma foreign_keys`）。
- 别名不是列：`poolAlias()` L149-152 用 `p<rowid>` 动态生成；`resolvePool(ref)` L154-158 同时接受 `p3` 和完整 pool_id（`ops/common.ts` `resolvePool()` L5-10 负责报错文案）。
- `listPools()` L159-161 返回 `pool_id, platform, external_id, kind, title, last_msg_at`；`ops/pools.ts` `listPools()` L6-16 再补 `alias/last_msg_local/total`，**但把 platform/external_id 丢了**——UI 要展示就得在 `ops/pools.ts` L7-15 的 map 里补上这两个字段（`pool_id` 里虽可拆，但不该让前端拆）。

### 5.2 引用 pool 的 8 张表（删除时全部会变孤儿）

| 表 | 字段 | 行号 | 索引 |
|---|---|---|---|
| messages | `pool_id TEXT NOT NULL` | L15 | `idx_messages_pool(pool_id,seq)` L21 |
| cursors | `pool_id TEXT PRIMARY KEY`, `last_seq` | L23 | 无 |
| memories | `source_pool_id TEXT NOT NULL` | L57 | `idx_memories_user` L63 |
| plans | `pool_id TEXT`（可空） | L30 | 无 |
| tide_events | `pool_id TEXT`（可空） | L35 | `idx_tide_day` L40 |
| reflections | `pool_id TEXT NOT NULL` | L42 | `idx_reflections_pool` L47 |
| proactive_log | `pool_id TEXT NOT NULL` | L49 | `idx_proactive_ts` L53 |
| topics | `pool_id TEXT`（可空） | L66 | `idx_topics_pick` L70 |

### 5.3 新建池需要哪些字段

| 字段 | 必填 | 怎么填 | 依据 |
|---|---|---|---|
| `platform` | 是 | 下拉，枚举 `feishu \| mock \| matrix`（`app/src/types.ts` L1 `Platform`）。**必须提示**：该 platform 需要有已注册适配器，否则 `hub.send()` 会报「平台 X 没有可用的适配器」（`app/src/core/hub.ts` L130-131）。适配器注册点：`app/src/main.ts` L60（feishu）、L63（matrix）、L79（mock，**恒注册**） | `types.ts` L1；`hub.ts` L130 |
| `external_id` | 是（可为空串） | 文本框。**空串 = 纯本地流**，只落库不出池（`docs/pool-model.md` L16）；非空时须是平台真实会话 id（飞书 chat_id 等），否则消息发不出去（`hub.ts` L158-161 把它直接传给 `adapter.sendText`）。空串时给 hint「本地池，不会向 IM 发送」 | `docs/pool-model.md` L16；`hub.ts` L158-171 |
| `kind` | 是 | 单选 `private \| group`（`types.ts` L2）。语义只影响节奏不影响内容（`docs/pool-model.md` L17-19），label 直接写「私聊/群聊」——`app.js` `kindLabel()` L31-33 已有现成映射 | `types.ts` L2；`docs/pool-model.md` L17-19 |
| `title` | 否 | 文本框，默认空；`upsertPool` 只在非空时更新（`db.ts` L141 `CASE WHEN excluded.title<>''`） | `db.ts` L141 |

`pool_id`、`created_at`、`last_msg_at`、`alias` 全部服务端生成，**不出现在表单里**。

### 5.4 别名怎么生成

- 生成：`Store.poolAlias()`（`db.ts` L149-152）——查 rowid 拼 `p${rowid}`，**不是持久化列，不能自定义、不能改**；
- 解析：`Store.resolvePool()` L154-158 正则 `/^p(\d+)$/`；
- **删除的隐藏坑**：SQLite rowid 可复用。删掉 `p3` 后新池可能拿到 rowid=3，旧文档/旧计划里写的 `p3` 会**静默指向新池**。因此：① 删除对话框必须展示被删池的 `pool_id`（完整串）和 `alias`，提示「别名 p3 将失效且可能被复用」；② 服务端 `deletePool` 里若想根治，可 `PRAGMA` 不行就改用 `alias` 持久化列——**本期不做**，只在 UI 提示（改动落在 `app/web/app.js` 删除对话框文案）。
- 注意 `app/src/core/alias.ts` 是**另一回事**（记忆里的「说法 → 指向」，存 `memories.kind='alias'`，L7 注释），与池别名无关，别混。

### 5.5 删除池的影响（必须在 UI 和 API 两层说清）

代码里**目前不存在任何删池逻辑**（全库无 `DELETE FROM pools`）。若实现时只删 pools 行：

1. **8 张表全留孤儿**（§5.2），`messages`/`cursors`/`reflections`/`proactive_log`/`memories.source_pool_id` 都是 `NOT NULL` 文本，无级联；
2. **别名漂移**（§5.4）；
3. **同 external_id 会被重建**：下一条平台消息进来 `insertMessage()` L190 → `upsertPool()` L138 会按同样的 `pool_id` 插入全新一行（旧行已删，走 INSERT 而非 `ON CONFLICT`），池「复活」且 `created_at` 变成新值；
4. **游标**：`cursors` 行残留无害（查不到池就不读），但若池重建，旧 `last_seq` 可能高于新消息 seq，导致 `unread()` L254-256 漏读——**删池必须同事务删 cursors**；
5. **记忆**：`scope='pool'` 且 `source_pool_id=被删池` 的记忆在 `visibleMemories()`（`db.ts` L615-641，L621 `scope='pool' AND source_pool_id=?`）里从此不可见（变成死数据）；`scope='private'/'group'` 的记忆**不受影响**，仍会在同类池里可见——删除对话框要区分说明；
6. **计划**：`plans.pool_id` 指向被删池的计划，到点 `resolvePrimaryPool()`（`core/primary-pool.ts` L17-19 L18 `plan?.pool_id`）会返回一个不存在的池 id，`hub.send()` L128-129 返回 `未知的池`——**删池前应把该池的 pending 计划置为 cancelled 或置空 pool_id**；
7. **主池兜底**：`resolvePrimaryPool()` L24-27 纯 tick 时取「最近有消息的池」，删光后返回 `null`，上层已有 `null` 处理，不崩。

**建议的删除策略（写进 API 与对话框）**：事务内删 `pools + cursors + messages`（历史消息默认删，参照 AstrBot `DeletePlatformDialog` 的勾选式），`memories/plans/topics/tide_events/reflections/proactive_log` **默认保留**（记忆是跨池资产，计划可选「一并取消」）。实现位置：`app/src/core/db.ts` 新增 `Store.deletePool(poolId, opts)` 用 `this.db.transaction()`。

### 5.6 建议的 API 形状

沿用 `app/src/api.ts` 现有惯例：`reply(200, data)` 包 `{ok:true,data}`、`fail` 包 `{ok:false,error}`、`HttpError(status, msg)`（L82-84）、非 `HttpError` 默认 400（L306-311）、Bearer 鉴权（L155-157）、`case "pools"` 内加分支（L164-209）。

| 方法 | 路径 | 请求 | 响应 | 落点 |
|---|---|---|---|---|
| GET | `/v1/pools` | — | 200 `{ok,data:[{alias,pool_id,platform,external_id,kind,title,last_msg_at,last_msg_local,total}]}`（**补 platform/external_id**） | `api.ts` L165 改 `ops/pools.ts` `listPools()` L7-15 的 map |
| GET | `/v1/pools/:ref` | — | 200 单池详情（同上字段 + `created_at` + 消息数） | `api.ts` `case "pools"` 新增；`ops/pools.ts` 新增 `getPool()` |
| POST | `/v1/pools` | `{platform, external_id, kind, title?}` | 201 `{ok,data:Pool}`；409 若 `UNIQUE(platform,external_id)` 冲突 | `api.ts` 新增分支；`ops/pools.ts` 新增 `createPool()`（内部调 `store.upsertPool` 但先做校验） |
| PATCH | `/v1/pools/:ref` | `{title?, kind?}` | 200 `{ok,data:Pool}` | `api.ts` 新增；`ops/pools.ts` 新增 `updatePool()` |
| DELETE | `/v1/pools/:ref` | query `?messages=1&cancel_plans=1`（勾选项） | 200 `{ok,data:{deleted:pool_id, messages:N, plans_cancelled:M}}` | `api.ts` 新增；`ops/pools.ts` 新增 `deletePool()`；`db.ts` 新增事务方法 |
| GET/POST | `/v1/pools/:ref/messages` | 已有 | 已有 | `api.ts` L166-201，不动 |
| GET | `/v1/pools/:ref/search` | 已有 | 已有 | `api.ts` L202-207，不动 |

**PATCH 为什么不允许改 `platform/external_id`**：二者共同决定 `pool_id`（`db.ts` L137），改了等于换池 id，8 张关联表全部要迁移。要「换绑」应走删+建，对话框里明说（文案落在 `app/web/index.html` 编辑对话框）。

**校验规则（服务端为准，`ops/pools.ts` 新增 `validatePoolInput()`；前端 `app.js` `validatePoolForm()` 只做即时反馈）**：

1. `platform` ∈ `{"feishu","mock","matrix"}`（对齐 `types.ts` L1；若运行时未注册该适配器，POST 返回 201 但响应带 `warning: "本进程没有 <platform> 适配器，池只能收本地消息"`——适配器是否注册可从 `hub.ts` 暴露一个 `hasAdapter(platform)`）；
2. `external_id`：字符串、去首尾空白、**长度 ≤ 128**、允许为空串（本地池）；含 `\r\n` 拒绝（会破坏 `msg_id` 拼接）；
3. `kind` ∈ `{"private","group"}`；
4. `title`：可选，`trim` 后 ≤ 100 字符；
5. `:ref` 解析复用 `ops/common.ts` `resolvePool()`（L5-10），解析失败 404；
6. DELETE：`messages`/`cancel_plans` 只接受 `1|0`；若 `GET /v1/pools` 显示该池 `total > 0` 且请求未带 `messages=1`，返回 409 `"该池有 N 条消息，确认删除请带 messages=1"`（计数用 `store.poolSpan()`，`db.ts` L222-227）。

**文档同步**：`app/docs/sandbox-api.md` 路由表（L36 起，pools 行在 L40-43）要加这 5 行。

### 5.7 落到 rabbit-bot 文件的总清单

| 文件 | 新增/修改 |
|---|---|
| `app/src/core/db.ts` | `Store.deletePool(poolId, opts)` 事务（删 pools/cursors/messages，按 opts 处理 plans）；`Store.updatePool()`；`getPool` 补 `created_at` |
| `app/src/ops/pools.ts` | `createPool()` `updatePool()` `deletePool()` `getPool()` `validatePoolInput()`；`listPools()` 补 `platform/external_id`；L1 注释从「只读查询」改掉 |
| `app/src/ops/common.ts` | 若需要，加 `requirePoolField()` 之类共用校验小件（与 `clampInt` 同风格） |
| `app/src/api.ts` | `case "pools"`（L164-209）加 GET 详情 / POST / PATCH / DELETE 四个分支；404 用法文案（L208）同步更新 |
| `app/docs/sandbox-api.md` | 接口表补 5 行 |
| `app/web/index.html` | `.pools-head` 加「新建」按钮；新增 3 个对话框 DOM（新建/编辑/删除） |
| `app/web/app.js` | `validatePoolForm()`、`openCreatePool/openEditPool/confirmDeletePool`、`createPool/updatePool/deletePool`；`renderPools()` L189-213 加行内操作按钮；空状态 L192-194 加 CTA |
| `app/web/style.css` | `.modal`/`.modal-card`/`.pool-actions` + 480px 断点全屏规则 |

---

## 6. AstrBot 里不适合直接照搬的地方

| 不照搬 | 原因（落到 rabbit-bot 的事实） |
|---|---|
| **多租户登录体系**：用户名/密码 + TOTP + 恢复码（`src/stores/auth.ts`、`views/authentication/authForms/stages/AuthStageTotp.vue`、`shared/DashboardTotpManager.vue`、路由守卫 `router/index.ts` L30-54） | rabbit-bot 是单用户本地服务，鉴权只有一个 Bearer token（`app/src/api.ts` L155-157，`safeEqual` L86-90 恒时比较），token 存在 `app/data/run/api.token`。前端登录页已存在（`index.html` L12-27），照抄 AstrBot 的账号体系是引入一个新子系统 |
| **插件市场 / 扩展工作台**：`views/extension/{MarketPluginsTab,InstalledPluginsTab,PluginWorkspacePage,PluginDetailPage}.vue`、`components/extension/MarketPluginCard.vue`、`api/v1.ts` `pluginApi` L1278 | rabbit-bot 没有插件系统；它的「扩展点」是 `app/data/sandbox/skills/` 下的 SKILL.md 文件，已有只读技能页（`app/web/index.html` L139-149 + `api.ts` `case "skills"` L278-289）。插件市场 UI 无对应实体 |
| **OpenAPI 代码生成链**：`@hey-api/openapi-ts` 从 `../openspec/openapi-v1.yaml` 生成 `src/api/generated/`（`package.json` L13），再在 `v1.ts` 用 `typed<>()` 包一层 | rabbit-bot 没有 openapi spec，`api.ts` 是手写 `switch(parts[1])`（L163-305），接口不到 10 个。引入 codegen 要先维护一份 yaml + 生成步骤 + 构建依赖，成本远超收益。**手写 `case "pools"` 分支即可** |
| **Vuetify 全家桶 + 主题系统**：`plugins/vuetify.ts`、`stores/customizer.ts`（`uiTheme/fontTheme/mini_sidebar/inputBg`）、`main.ts` L25-75 `setupThemeSync` | 与 `app/web/style.css` 已有的 CSS 变量体系（`--border/--muted/--bad/--accent` 等，L1-32）直接冲突，二选一意味着重写全部样式。池管理只需 `style.css` +60 行 |
| **9 个 Pinia store + 路由级 loading store**：`stores/routerLoading.ts`（`beforeEach` L31-34 启动、`afterEach` L56-59 结束） | rabbit-bot 全局状态就是一个 `state` 对象（`app.js` L8-22），页签切换 `switchTab()` L594 已够。为 4 字段 CRUD 引入 store 层是过度设计 |
| **i18n 模块系统**：`useModuleI18n('features/xxx')` + 按需 locale + `i18n:check` 脚本（`package.json` L16） | rabbit-bot 界面是单语言中文，硬编码字符串即可（现有 `app.js` 全是中文硬编码，如 L193 `还没有会话池。`） |
| **`AddNewPlatform.vue` 的 8 步向导**（1861 行） | 池只有 4 个字段（§5.3），一个对话框 + 4 个输入框是正确粒度；向导式是为 OAuth/QR code/Webhook 配置服务的，rabbit-bot 没有这些 |
| **`ConversationWorkspacePage.vue` 的 URL query 同步选中**（L424-431）与 `v-data-table-server` | 没有路由库；池列表 ≤ 几十个，`renderPools()` 的 button 列表足够，不需要服务端分页表格 |
| **Chat 组件族**：`components/chat/{Chat,ChatMessageList,LiveMode,ThreadPanel,ReasoningSidebar}.vue` 等 30+ 文件 | rabbit-bot 的会话 UI 已经是自洽的一套（`index.html` L52-77 + `app.js` `renderMessages()` L302-347），且与 3s 轮询、`hub.ingest` 发消息（`api.ts` L172-201）深度绑定。池管理不碰会话渲染 |
| **`DeletePlatformDialog` 的 8 类清理勾选** | rabbit-bot 删池的级联面是 §5.2 的 8 张表，语义不同；**只抄它的「勾选式影响范围 + 内联错误 + loading 按钮」交互骨架**（`DeletePlatformDialog.vue` L113-160），不抄具体选项集 |

---

## 附：一句话结论

AstrBot 最值得抄的是 **`KBList.vue` 的单文件三态列表 + 共用增改对话框** 和 **`DeletePlatformDialog.vue` 的勾选式删除**；rabbit-bot 侧用**方案 A（原生）**，把新逻辑集中落在 `app/src/ops/pools.ts`（写操作，现在是只读）+ `app/src/api.ts` `case "pools"` + `app/web/{index.html,app.js,style.css}` 三个前端文件；数据层必须自己实现事务级联删除（无外键）并处理别名 rowid 漂移，API 形状沿用 `{ok,data}/{ok,error}` 与 `HttpError` 惯例，补 `sandbox-api.md` 文档。
