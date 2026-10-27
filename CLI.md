# rb —— rabbit-bot 的命令行

同一个能力三个入口，行为必须一致：agent 的工具、人手动、别的 agent 走 shell。
所以所有逻辑都在 `src/core` 里，`src/cli.ts` 只是薄壳（参数解析 + 输出格式），不重新实现规则。

```bash
rb --help                 # 全部子命令
rb pool list --human      # 人读格式；不加 --human 是 JSON
```

## 命令

| 命令 | 说明 |
|---|---|
| `rb pool list` | 所有池：别名、类型、最后消息、条数 |
| `rb pool read <pool> [--limit 15] [--before-seq N]` | 读历史，不动未读游标 |
| `rb pool search <关键词> --pool <p> [--limit 15]` | 按关键词翻旧账（比一页页读快） |
| `rb plan list [--status pending]` | 待办/已办/已取消 |
| `rb plan add --title X --kind once\|cron\|none [--when V] [--why W]` | 写计划；`--anchor L0\|L1\|L2` 选档位 |
| `rb plan update <id> --status done` | 改状态 |
| `rb mem add --user U --content C --pool P [--kind fact\|topic] [--scope ...]` | 记一条长期记忆 |
| `rb mem search --user U --pool P` | 查这个人在这个池能看到的记忆 |
| `rb img list [--source media\|inbox\|all] [--page N]` | 列能看的图 |
| `rb img view <path>` | 给出真实路径和大小（**读图本身**仍由模型侧的 `view_image` 做） |
| `rb sb list [path]` / `read` / `write` / `run` | 沙盒目录，路径一律相对 |
| `rb web search <查询> [--count 6] [--content]` | 联网搜索 |
| `rb web fetch <url>` | 抓正文 |

## 输出契约

```json
{ "ok": true,  "data": ... }        // 退出码 0
{ "ok": false, "error": "原因" }     // 退出码 1
```

默认 JSON 是给程序读的：模型解析 JSON 比解析表格可靠，字段名不会被「猜」。
`--human` 只是调试方便，**不要在脚本里依赖它的格式**。

## 两个内部参数

- `--db <路径>`：指向哪个库。agent 侧调用时会自动带上自己正在用的库，否则会去开默认库，读写两处。
- `--now <毫秒>`：覆盖「现在」。只给测试用，模拟器的时间是假的，拿真实时钟判「这个时间过没过」会误判。

## 没有做成 CLI 的东西

`send` 和 `stay_silent` 留在工具里，因为它们依赖**正在跑的那个进程**的状态：发送去抖、发送确认、未读游标、`seenPools`。
拆出去要么把状态机复制一份，要么把状态外置——两种都比多两个 schema 贵。

`view_image` 同理：它要把图片字节塞进模型上下文，CLI 只能给出路径。

## 加新命令的规矩

1. 逻辑写进 `src/core`（纯函数或 Store 方法），CLI 只做参数映射。
2. 输出必须是 JSON 可序列化的 `{ok, data}`，不要在 `data` 里塞已经格式化好的中文长文本。
3. 失败一律 `throw`，由 `run()` 统一转成 `{ok:false, error}`；不要 `console.log("出错了")` 然后退出码 0。
4. 加一条 `test/cli.test.ts` 的用例：命令能跑通，加一条失败路径。
