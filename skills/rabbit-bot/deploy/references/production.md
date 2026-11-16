# 生产常驻（Docker + pm2 + 备份）

先完成 L1-Web 或 L1-Feishu，再按本文件做。顺序不要变：先有隔离，再收紧入口，最后才开放端口。

## 1. Docker 必须是 Linux 容器

```bash
docker info --format '{{.OSType}}'
```

期望 `linux`。不是 `linux` 就先解决 Docker：

- macOS：Docker Desktop 或 Colima。
- Linux：Docker Engine。
- Windows：在 WSL2 内装 Docker Desktop 的 WSL2 backend，并在 Docker Desktop 里给目标发行版打开 WSL Integration；进入 WSL 后 `docker info` 能连上 daemon 才算完成。

这套沙盒依赖 `--read-only`、`--tmpfs`、`--cap-drop ALL`、`--pids-limit`、`no-new-privileges`，Windows 容器模式跑不了。

## 2. 构建沙盒镜像

```bash
cd <repo>/app
docker build -t rabbit-bot-sandbox:latest -f docker/sandbox.Dockerfile docker/
```

期望：构建成功，`docker images | grep rabbit-bot-sandbox` 能看到镜像。

## 3. 切回 Docker 模式

编辑 `<repo>/app/config/local.json`，把：

```json
{ "exec": { "shell": { "mode": "docker" } } }
```

保留其他已有键。旧配置里的 `sandbox` 会被自动搬到 `exec`，但新写一律用 `exec`。

```bash
npm run build && pm2 restart rabbit-bot
cd <repo>/app && npm run doctor
```

期望：`doctor` 的「沙盒 shell」显示 `mode: docker`，不再「读取失败」；容器 `rabbit-bot-sbx` 在跑。

## 4. 先收紧入口，再开放端口

默认 `api.host` 是 `0.0.0.0`，管理台第一次打开会引导设密码。公网部署前必须二选一：

- 预置密码：`config/local.json` 写 `webChat.password`，或环境变量 `RABBIT_BOT_WEB_PASSWORD`（优先）。
- 只绑回环：`api.host: "127.0.0.1"`，前面放反向代理，由代理做 TLS 和访问控制。

硬规则：

- 不要把 3738 直接裸奔到公网；浏览器登录会话等同管理员。
- `RABBIT_BOT_INJECT_TOKEN` 只应监听回环，不要发出去。
- 按需在 `config/local.json` 的 `limits` 里调日调用、token、花费上限；不要当无限用。
- 沙盒默认有网，能把拿到的内容发出去；不需要外网就设 `exec.shell.network: "none"`。
- 任务执行器能看到工作目录；不要给它不必要的密钥和宿主权限。

## 5. pm2 常驻与开机自启

```bash
cd <repo>/app
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # 按输出提示执行它给的那条命令
pm2 save
```

平台差异：

- macOS：`pm2 startup` 生成 LaunchAgent（`~/Library/LaunchAgents/pm2.<user>.plist`）。`launchctl load` 在新系统已移除，按提示用 `launchctl bootstrap gui/$(id -u) <plist>`。加载/重载要在外部终端做，Agent 终端可能被拦截。
- Linux：`pm2 startup systemd`，执行输出的 sudo 命令，再 `pm2 save`。
- WSL2：在 WSL 内用 systemd 或登录脚本执行 `pm2 resurrect`；不要用 Windows 计划任务直接拉 WSL 里的 pm2。

验证：

```bash
pm2 list
pm2 describe rabbit-bot | grep -E "status|restarts|script path"
```

期望 `status: online`，进程数 1。

## 6. 备份

先停服务，避免 SQLite WAL 复制到一半：

```bash
cd <repo>/app
pm2 stop rabbit-bot
BACKUP="$HOME/rabbit-bot-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a data/rabbit-bot.db data/rabbit-bot.db-wal data/rabbit-bot.db-shm "$BACKUP"/ 2>/dev/null || true
cp -a "$HOME/.config/rabbit-bot/runtime" "$BACKUP/runtime"
cp -a "$HOME/.config/rabbit-bot/env" "$BACKUP/env"
chmod 700 "$BACKUP"
pm2 start rabbit-bot
```

说明：

- `-wal` / `-shm` 不存在就忽略。
- runtime 里有 shared 汇报、files、media、prompt/persona，按需保留或排除大文件。
- env 含密钥，备份目录权限 700，不要上传公共网盘。

恢复：停服务，替换 `data/rabbit-bot.db*` 和 `runtime/`，再 `pm2 start rabbit-bot`。

## 7. 升级

```bash
cd <repo>
git pull --ff-only
cd app
npm install --no-audit --no-fund
npm run build
npm run web:build       # 只有前端有改动才需要
pm2 restart rabbit-bot
```

验收：

```bash
curl -s http://127.0.0.1:3738/health
npm run doctor
```

回滚代码：

```bash
cd <repo>
git checkout <上一个稳定 commit> -- app/src app/webapp app/web
cd app
npm run build
pm2 restart rabbit-bot
```

回滚数据：停服务，替换备份里的 SQLite（含 WAL/SHM），重启。回滚沙盒：`docker rm -f rabbit-bot-sbx`，下次 terminal 按当前配置重建。

## 8. 生产验收清单

- [ ] `docker info --format '{{.OSType}}'` = `linux`
- [ ] `exec.shell.mode=docker`，容器在跑
- [ ] `/work` 可写（容器里 `echo ok > /work/.probe && cat /work/.probe`）
- [ ] 管理台只绑回环或已预置密码
- [ ] 进程数 = 1，`pm2 save` + 开机自启已配置
- [ ] 备份目录已生成且权限 700
- [ ] 升级/回滚至少演练一次
- [ ] 聊天往返验证通过（网页直聊或飞书）
- [ ] 日志无连续报错

## 9. 边界

- 单实例：同一时间只允许一个 rabbit-bot 进程。
- 单机 SQLite：不是多租户、高并发客服系统。
- 沙盒不是 VM：它限制文件、网络、进程能力，但不等于完整安全隔离；不要在里面放宿主密钥。
- 平台命令以本机实际版本为准；Linux/WSL2 的 systemd 细节可能因发行版不同，按 `pm2 startup` 的输出执行。
