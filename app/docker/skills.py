#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

MAX_DESC = 110


def frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        return {}
    lines = text.splitlines()
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}
    out: dict[str, str] = {}
    i = 1
    while i < end:
        line = lines[i]
        m = line.split(":", 1)
        key = m[0].strip() if len(m) == 2 else ""
        if not key:
            i += 1
            continue
        val = m[1].strip()
        if val in (">", ">-", "|", "|-"):
            block, i = [], i + 1
            while i < end and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            out[key] = " ".join(x for x in block if x).strip()
            continue
        out[key] = val.strip("\"'")
        i += 1
    return out


def scan(root: Path, kind: str) -> list[dict]:
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError:
        return []
    out = []
    for entry in entries:
        if entry.name.startswith(("_", ".")):
            continue
        skill = entry / "SKILL.md"
        try:
            if not entry.is_dir() or not skill.is_file():
                continue
            text = skill.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta = frontmatter(text)
        out.append({
            "name": meta.get("name") or entry.name,
            "description": meta.get("description", "").strip(),
            "kind": kind,
            "path": f"{'skills' if kind == 'own' else 'shared-skills'}/{entry.name}/SKILL.md",
            "dir": str(entry),
        })
    return out


def roots() -> list[tuple[Path, str]]:
    env = os.environ.get("SKILLS_DIRS", "").strip()
    if env:
        result = []
        for raw in env.split(":"):
            p = Path(raw.replace("~", str(Path.home()), 1)).expanduser()
            result.append((p, "shared" if "shared" in p.name else "own"))
        return result
    if Path("/work/skills").is_dir() or Path("/work/shared-skills").is_dir():
        return [(Path("/work/skills"), "own"), (Path("/work/shared-skills"), "shared")]
    here = Path(__file__).resolve().parent
    own = here.parent / "data" / "sandbox" / "skills"
    shared = Path.home() / ".agents" / "skills"
    return [(own, "own"), (shared, "shared")]


def main() -> int:
    args = [a for a in sys.argv[1:]]
    want_json = "--json" in args
    full = "--full" in args
    paths_only = "--paths" in args
    if "-h" in args or "--help" in args:
        print("用法: skills [关键词] [--json|--paths|--full]\n\n扫描 /work/skills 和 /work/shared-skills，列出技能名、描述和 SKILL.md 路径。")
        return 0
    query = next((a for a in args if not a.startswith("-")), "").lower()

    seen: dict[str, dict] = {}
    for root, kind in roots():
        for item in scan(root, kind):
            if item["name"] not in seen or (seen[item["name"]]["kind"] == "shared" and kind == "own"):
                seen[item["name"]] = item
    items = sorted(seen.values(), key=lambda x: x["name"].lower())
    if query:
        items = [x for x in items if query in x["name"].lower() or query in x["description"].lower()]

    if want_json:
        print(json.dumps([{k: v for k, v in x.items() if k != "dir"} for x in items], ensure_ascii=False, indent=2))
        return 0
    if paths_only:
        for x in items:
            print(x["path"])
        return 0

    if not items:
        print("（没有技能）" if not query else f"（没有匹配「{query}」的技能）")
        return 0

    for kind, title in (("own", "自己的（可写）"), ("shared", "共享库（只读）")):
        group = [x for x in items if x["kind"] == kind]
        if not group:
            continue
        print(f"{title}:")
        for x in group:
            desc = " ".join(x["description"].split())
            if not full and len(desc) > MAX_DESC:
                desc = desc[:MAX_DESC - 1] + "…"
            print(f"  {x['name']}  {desc}")
        print()
    print(f"{len(items)} 个技能。读全文：cat skills/<name>/SKILL.md 或 cat shared-skills/<name>/SKILL.md")
    print("查路径：skills --paths；机器读：skills --json；长描述：skills --full")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
