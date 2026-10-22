/** 必须最先 import：在加载 pi 之前设置进程级默认值（不涉及密钥）。 */
process.env.PI_OFFLINE ??= "1"; // 不做自动网络活动（模型目录刷新等）
process.env.PI_TELEMETRY ??= "0"; // 关闭 pi 安装/更新遥测
export {};
