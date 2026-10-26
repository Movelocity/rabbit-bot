/**
 * 单实例锁：原子占锁 + 身份校验 + stale 自愈。
 *
 * 为什么不用「读 pid → kill -0 活着就退出」那套：
 *   1. 读/判/写三步没有排他，两个进程同时启动都能过关；
 *   2. `kill -0` 只能证明这个 pid 存在，不能证明它是 rabbit-bot。旧进程退出后
 *      pid 被系统复用（比如被 launchd 的子进程拿走），就会误判成「已有实例」，
 *      服务永久起不来，还得人工删文件；
 *   3. `kill -9` 不触发 exit 钩子，锁文件必然残留。
 *
 * 身份怎么认：存 pid + 进程启动时间（`ps -o lstart=`）。同一个 pid 被复用时启动时间
 * 必然不同，所以「pid 活着 + 启动时间一致」才是「就是那个进程」。
 * 不要用命令行关键词判断——换了启动方式（--experimental-strip-types / 不同 cwd）就认不出
 * 自己人，锁会被当成残锁删掉，两个进程都能起（这是并发测试抓到的）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface LockPayload {
  pid: number;
  /** `ps -o lstart=` 的原样输出，用来区分 pid 复用 */
  boot: string;
  startedAt: number;
  cmd: string;
}

export type AcquireResult = { ok: true; tookOver: boolean; samePidReentry: boolean } | { ok: false; holder: LockPayload };

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 进程启动时间（原样字符串，只用来比对）。拿不到返回 null。 */
export function procStartTime(pid: number): string | null {
  try {
    const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 锁的持有者还是「那个进程」吗？
 *
 * 判定顺序在「误判占用」和「误判可用」之间选了保守的那边：
 *   - 误判占用 → 服务起不来，人手动删锁一次能救回来；
 *   - 误判可用 → 两个进程同时连飞书、各推各的游标，数据错乱，没人当场发现。
 * 所以只有**确证**已经不在了才接管：
 *   1. pid 不活着 → 接管；
 *   2. pid 活着但拿不到启动时间（刚 spawn 的进程 ps 可能还没准备好）→ 当它活着；
 *   3. 锁是旧格式没记启动时间 → 当它活着；
 *   4. 启动时间明确对不上 → pid 被复用了 → 接管。
 */
export function stillHolder(h: LockPayload): boolean {
  if (!processAlive(h.pid)) return false;
  const boot = procStartTime(h.pid);
  if (!boot) return true;
  if (!h.boot) return true;
  return boot === h.boot;
}

export function readLock(file: string): LockPayload | null {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const o = JSON.parse(raw) as Partial<LockPayload>;
      if (typeof o.pid !== "number" || o.pid <= 0) return null;
      return {
        pid: o.pid,
        boot: typeof o.boot === "string" ? o.boot : "",
        startedAt: o.startedAt ?? 0,
        cmd: typeof o.cmd === "string" ? o.cmd : "",
      };
    }
    const pid = Number(raw); // 更早的格式：纯 pid
    return Number.isInteger(pid) && pid > 0 ? { pid, boot: "", startedAt: 0, cmd: "" } : null;
  } catch {
    return null;
  }
}

/**
 * 拿锁。成功返回 ok:true（tookOver 表示接了别人的残锁）；
 * 真的有人占着就返回 ok:false + 持有者信息，调用方据此 exit 3。
 */
export function acquireLock(file: string, tries = 3): AcquireResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: LockPayload = {
    pid: process.pid,
    boot: procStartTime(process.pid) ?? "",
    startedAt: Date.now(),
    cmd: process.argv.slice(1).join(" "),
  };

  for (let i = 0; i < tries; i++) {
    // 先写临时文件再 link：link 是原子的，且链接成功时内容已完整。
    // 直接用 writeFileSync(flag:"wx") 会留下「文件已创建、内容还没写完」的窗口，
    // 另一个进程在这个窗口里读到空文件，会误判成残锁删掉重占（并发测试抓到的）。
    const tmp = `${file}.${process.pid}.${i}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o644 });
    try {
      fs.linkSync(tmp, file); // 失败 = 已经有人占了
      return { ok: true, tookOver: i > 0, samePidReentry: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }

    const holder = readLock(file);
    if (holder?.pid === process.pid) return { ok: true, tookOver: false, samePidReentry: true }; // 同进程重入
    if (holder && stillHolder(holder)) return { ok: false, holder };

    // 死了 / pid 被别人复用了 / 空文件 → 清掉重试
    try {
      fs.unlinkSync(file);
    } catch {
      /* 别的进程先删了 */
    }
  }
  return { ok: false, holder: readLock(file) ?? { pid: 0, boot: "", startedAt: 0, cmd: "" } };
}

/** 只删自己写的锁，别把别人刚接手的删掉。 */
export function releaseLock(file: string): void {
  const holder = readLock(file);
  if (holder && holder.pid === process.pid) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}
