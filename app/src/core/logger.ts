/** 极简日志：控制台 + JSONL 文件（唤醒日志另写 wakes.jsonl 与 SQLite wake_log）。 */
import fs from "node:fs";
import path from "node:path";
import { fmtLocal } from "./time.ts";

export class Logger {
  private appFile: string | null;
  private wakeFile: string | null;
  constructor(dir: string | null, private quiet = false) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
    this.appFile = dir ? path.join(dir, "app.log") : null;
    this.wakeFile = dir ? path.join(dir, "wakes.jsonl") : null;
  }
  info(msg: string) { this.write("INFO", msg); }
  warn(msg: string) { this.write("WARN", msg); }
  error(msg: string, e?: unknown) { this.write("ERROR", msg + (e ? ` :: ${(e as Error)?.stack ?? String(e)}` : "")); }
  wake(entry: unknown) { if (this.wakeFile) fs.appendFileSync(this.wakeFile, JSON.stringify(entry) + "\n"); }
  private write(level: string, msg: string) {
    const line = `${fmtLocal(Date.now())} +08:00 ${level} ${msg}`;
    if (!this.quiet || level !== "INFO") (level === "ERROR" ? console.error : console.log)(line);
    if (this.appFile) fs.appendFileSync(this.appFile, line + "\n");
  }
}
