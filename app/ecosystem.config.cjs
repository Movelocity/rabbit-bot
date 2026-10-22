// 可选：如果以后装了 pm2（npm i -g pm2），可以用 `pm2 start ecosystem.config.cjs` 代替 scripts/run.sh。
// 环境变量（FEISHU_APP_ID 等）需在启动 pm2 的 shell 里已 export，这里不写任何密钥。
module.exports = {
  apps: [{
    name: "poolchat",
    cwd: __dirname,
    script: "dist/main.js",
    interpreter: process.env.HOME + "/.local/node22/bin/node",
    autorestart: true,
    stop_exit_codes: [2],
    kill_timeout: 30000,
    max_restarts: 50,
    exp_backoff_restart_delay: 5000,
  }],
};
