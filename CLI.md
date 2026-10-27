# 脚本层 —— rabbit-bot 的能力出口

**一个能力一个文件。** 加新能力 = 在 `scripts/` 下新建一个 `.ts`，不改任何已有文件：
不用改路由表、不用改 agent 的工具列表（agent 侧的白名单是扫目录得来的）。

`bin/rb` 只是个四行转发器：`rb pool-list` → `npx tsx scripts/pool-list.ts`。它不含逻辑，加脚本也不用改它。

```bash
rb                              # 列出所有脚本
rb pool-list                    # 任何目录都能用（已软链到 ~/.local/bin/rb）
npx tsx scripts/pool-list.ts    # 等价的完整写法
```

## 清单

| 脚本 | 干什么 | 例子 |
|---|---|---|
| `pool-list` | 所有聊天池：别名、类型、最后消息、条数 | `rb pool-list` |
| `pool-read` | 读历史（不动未读游标） | `rb pool-read p1 --limit 20` |
| `pool-search` | 按关键词翻旧账（比一页页读快） | `rb pool-search "火锅" --pool p1` |
| `plan-list` | 列计划 | `rb plan-list --status pending` |
| `plan-add` | 写计划 | `rb plan-add --title 问他面试结果 --kind once --when 2026-10-27T22:00 --why "他说今天出结果"` |
| `plan-update` | 改计划状态 | `rb plan-update 12 --status done` |
| `mem-add` | 记一条长期记忆 | `rb mem-add --user u1 --content "他对花生过敏" --pool p1` |
| `mem-search` | 查某人在某池可见的记忆 | `rb mem-search --user u1 --pool p1` |
| `img-list` | 列能看的图 | `rb img-list --source media` |
| `img-view` | 给出图片真实路径（**读图本身**仍由 agent 的 `view_image` 做） | `rb img-view media/om_xxx.jpg` |
| `sb` | 沙盒目录：`list / read / write / run` | `rb sb run "ls -la /work"` |
| `web-search` | 联网搜索 | `rb web-search "DeepSeek v4" --count 5` |
| `web-fetch` | 抓网页正文 | `rb web-fetch https://example.com` |

`wave-*.ts` 是水位场的调参/观测脚本，不接 agent（见 `WAVE.md`）。

## 约定（新脚本照抄）

```ts
import { run, openStore, mustPool, describe, str, num } from "./lib/kit.ts";

describe("npx tsx scripts/xxx.ts <参数>");     // --help 打这一行

await run(({ pos, flags }) => {
  const store = openStore(flags);
  try {
    // ...只做这一件事
    return { some: "data" };                  // 可 JSON 序列化
  } finally { store.close(); }
});
```

**输出契约**

```json
{ "ok": true,  "data": ... }        // 退出码 0
{ "ok": false, "error": "原因" }     // 退出码 1
```

1. 失败一律 `throw`，由 kit 统一转成 `{ok:false,error}` + 退出码 1。不要 `console.log("出错")` 还退 0——调用方分不清「查到了空」和「查挂了」。
2. `data` 里放结构，不放排版好的中文长文本——排版是调用方的事。
3. `--db` / `--now` 由 kit 处理：前者指库，后者是「现在」（模拟器里时钟是假的，不伪造会误判「时间已过」）。
4. 新脚本要能被 agent 用：不用改任何东西，`rb` 工具扫 `scripts/` 拿白名单。
5. 每个脚本配一条 `test/cli.test.ts` 的用例：能跑通 + 一条失败路径。

## 为什么不是一个大 CLI

早先版本是一个 `src/cli.ts`，六组子命令共 500 行，路由表在中间。问题不在行数，在**耦合**：
加能力要动那个文件，所有人的 schema 都跟着它走。

拆成脚本后，每个文件只依赖 `scripts/lib/kit.ts` + `src/core`，彼此不知道对方存在。删一个不带走别的，改一个不碰别的。

## 没有脚本化的东西

`send` / `stay_silent` 留在 agent 工具里：它们依赖**正在跑的那个进程**的状态（发送去抖、发送确认、未读游标、`seenPools`）。
脚本是独立进程，拆出去要么复制状态机，要么把状态外置，两种都比多两个 schema 贵。

`view_image` 同理：它要把图片字节塞进模型上下文，脚本只能给出路径。
