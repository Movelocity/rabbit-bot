// pm2 托管（本机 macOS；launchctl bootstrap 在 Hermes 网关内被拦，用 pm2 做持久化）
//   pm2 start ecosystem.config.cjs && pm2 save
// 环境变量由 scripts/run.sh 在 preflight 里 source ~/.config/poolchat/env，本文件不写密钥。
module.exports = {
  apps: [{
    name: "poolchat",
    cwd: __dirname,
    script: "scripts/run.sh",
    args: "fg",
    interpreter: "/bin/bash",
    autorestart: true,
    stop_exit_codes: [2, 3],
    kill_timeout: 30000,
    max_restarts: 50,
    exp_backoff_restart_delay: 5000,
    merge_logs: true,
    time: true,
    out_file: __dirname + "/logs/pm2.out.log",
    error_file: __dirname + "/logs/pm2.err.log",
  }],
};
