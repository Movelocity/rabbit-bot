---
name: example
description: 一句话写清楚什么时候该用这个技能（模型靠这句话决定要不要读）。
---

# 示例技能

## 什么时候用

说清楚触发条件，越具体越好：什么信号、什么场景、什么话术出现时用。

## 怎么做

1. 先确认这一轮真的需要这个技能；不确定就跳过。
2. 取数据走 REST API，例如：
   ```bash
   curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_URL/v1/pools"
   ```
3. 中间结果、缓存、下载的文件一律写 `data/`：
   ```bash
   mkdir -p data
   echo "..." > data/state.json
   ```
4. 最终只通过 `chat`（action=send）说话。

## 边界

- 不读写 `SKILL.md` 以外的设计文件来存状态。
- 不假设 `data/` 里已有内容；每次先看有没有。
- API 用法见 `/work/docs/sandbox-api.md`（如果镜像里没有，就看宿主仓库同名文件）。
