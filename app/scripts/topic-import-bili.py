#!/usr/bin/env python3
"""从 B 站收藏夹 CSV 批量导入话题。

用法：
  python3 scripts/topic-import-bili.py --csv ~/Downloads/bili-favorites-all.csv --limit 120
  python3 scripts/topic-import-bili.py --csv ... --limit 120 --dry-run

为什么要议题关键词而不是按播放量排：收藏夹里播放最高的是游戏/搞笑/鬼畜，
那些当不了谈资。按「为什么/本质/制度/心理学」这类词筛，剩下的才是能接话的。

去重按标题前 8 个非空白字，和库里已有内容比对。
"""
import argparse, csv, re, sqlite3, time, os

ISSUE = re.compile(
    r"为什么|为何|如何|怎么|真相|本质|逻辑|原理|经济学|经济|历史|制度|社会|阶层|职场|工作|"
    r"上班|加班|劳动|工资|薪|心理|认知|骗局|揭秘|冷知识|定律|效应|悖论|博弈|通胀|通货膨胀|"
    r"内卷|教育|医疗|房价|税|资本|消费|人口|老龄化|婚姻|恋爱|单身|AI|人工智能|算法|数据|"
    r"学术|论文|政治|哲学|思维|方法|模型|骗|真面目|深度|思考|观察|现象|区别|差别|对比|"
    r"案例|复盘|教训|常识|误区|偏见|陷阱"
)
NOISE = re.compile(
    r"原神|崩坏|星穹|方舟|王者|英雄联盟|LOL|CSGO|吃鸡|鬼畜|MMD|AMV|MAD|手书|宅舞|舞蹈|"
    r"翻跳|cos|漫展|搞笑|沙雕|萌宠|喵|猫猫|狗狗|吃播|美食|探店|vlog|动画短片|PV|OP|ED|"
    r"GMV|混剪|绝区零|碧蓝|少女前线|鸣潮",
    re.I,
)


def pick(rows):
    out = []
    for r in rows:
        try:
            dur, play = int(r["duration"]), int(r["play"] or 0)
        except Exception:
            continue
        t = (r["title"] or "").strip()
        if not (8 <= len(t) <= 42):
            continue
        if dur < 180 or dur > 3000 or play < 30000:
            continue
        if NOISE.search(t) or not ISSUE.search(t):
            continue
        out.append(r)
    seen, uniq = set(), []
    for r in out:
        k = re.sub(r"\W+", "", r["title"])[:18]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    uniq.sort(key=lambda x: -int(x["play"] or 0))
    return uniq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--limit", type=int, default=120)
    ap.add_argument("--db", default=os.path.expanduser("~/projects/rabbit-bot/app/data/rabbit-bot.db"))
    ap.add_argument("--pool", default="feishu:oc_5756b09a832818f7bc22625cb96c7235")
    ap.add_argument("--source", default="他 B 站收藏夹（2026）")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    with open(os.path.expanduser(a.csv), encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.DictReader(f))
    cand = pick(rows)
    print(f"CSV {len(rows)} 条 → 议题候选 {len(cand)} 条")

    con = sqlite3.connect(a.db)
    blob = re.sub(r"\W+", "", " ".join(x[0] for x in con.execute("SELECT content FROM topics")))
    now = int(time.time() * 1000)
    added = 0
    for r in cand:
        if added >= a.limit:
            break
        title = r["title"].strip()
        if re.sub(r"\W+", "", title)[:8] in blob and len(title) > 10:
            continue
        content = f"他收藏过一条：{title}"[:200]
        if a.dry_run:
            print("  +", content[:70])
        else:
            con.execute(
                "INSERT INTO topics (content, kind, pool_id, source, used_count, last_used_at,"
                " cooldown_until, retired, created_at) VALUES (?, 'topic', ?, ?, 0, 0, 0, 0, ?)",
                (content, a.pool, a.source, now),
            )
        added += 1
    if not a.dry_run:
        con.commit()
    total = con.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
    print(f"{'[dry-run] 将' if a.dry_run else '已'}入库 {added} 条 → 共 {total} 条")


if __name__ == "__main__":
    main()
