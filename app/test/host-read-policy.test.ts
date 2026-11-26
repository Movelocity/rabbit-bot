/** 宿主读取判定：纯函数，按「禁区 → 密钥 → 白名单目录 → 类型 → 未登记」的顺序。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideHostRead, secretReason, type HostReadRoot } from "../src/core/host-read-policy.ts";

const HOME = "/home/u";
const roots: HostReadRoot[] = [{ path: "/home/u/proj", source: "web" }];
const decide = (abs: string, unknown: "ask" | "allow" = "ask") => decideHostRead({ abs, home: HOME, roots, unknown });

const cases: Array<[string, "allow" | "ask" | "deny", string]> = [
  ["/home/u/.ssh/id_ed25519", "deny", "deny"],
  ["/home/u/.config/rabbit-bot/env", "deny", "deny"],
  ["/home/u/Library/Keychains/login.keychain-db", "deny", "deny"],
  ["/home/u/.ssh/config", "ask", "secret"],
  ["/home/u/proj/.env", "ask", "secret"],
  ["/home/u/proj/.env.production", "ask", "secret"],
  ["/home/u/proj/prod.env", "ask", "secret"],
  ["/home/u/proj/certs/server.pem", "ask", "secret"],
  ["/home/u/proj/.secrets/token", "ask", "secret"],
  ["/home/u/.aws/credentials", "ask", "secret"],
  ["/srv/x/.npmrc", "ask", "secret"],
  ["/srv/x/config/secrets.yaml", "ask", "secret"],
  ["/srv/x/service-account.json", "ask", "secret"],
  ["/srv/x/main.tfvars", "ask", "secret"],
  ["/srv/x/.env.example", "allow", "template"],
  ["/srv/x/src/tokenizer.ts", "allow", "ext"],
  ["/srv/x/src/app.go", "allow", "ext"],
  ["/srv/x/README.md", "allow", "ext"],
  ["/srv/x/Dockerfile", "allow", "name"],
  ["/srv/x/.data/turns.jsonl", "allow", "ext"],
  ["/home/u/proj/data.sqlite", "allow", "dir"],
  ["/srv/x/data.sqlite", "ask", "unknown"],
  ["/srv/x/bin/tool", "ask", "unknown"],
];

for (const [abs, verdict, rule] of cases) {
  test(`${abs} → ${verdict}`, () => {
    const d = decide(abs);
    assert.equal(d.verdict, verdict, d.why);
    assert.equal(d.rule, rule, d.why);
  });
}

test("unknown=allow 只放开未登记类型，密钥照样问", () => {
  assert.equal(decide("/srv/x/data.sqlite", "allow").verdict, "allow");
  assert.equal(decide("/srv/x/.env", "allow").verdict, "ask");
});

test("密钥目录本身也认（terminal 拿它拦 ls ~/.ssh）", () => {
  assert.ok(secretReason("/home/u/.ssh"));
  assert.equal(secretReason("/srv/x/src"), null);
});

test("额外扩展名可配", () => {
  const d = decideHostRead({ abs: "/srv/x/a.foo", home: HOME, roots: [], unknown: "ask", extraExts: [".foo"] });
  assert.equal(d.verdict, "allow");
});
