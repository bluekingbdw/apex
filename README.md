# Apex 个人战绩采集器

**v1.0** ｜ 第一阶段完成

个人 Apex 战绩的本地查看器。**数据全部来自 tracker.gg，无需任何 API Key。**

## 功能一览（v1.0）

| 区块 | 内容 |
|---|---|
| **Current Rating** | 段位徽章、RP、Top 百分位、排名，**本赛季峰值 / 历史峰值 RP** |
| **Account** | 等级 / 转生 / 传奇数 / 追踪器 |
| **最近表现** | RP 走势图（手写 SVG），**按赛季分段**，赛季选择器（默认最新赛季） |
| **常用传奇** | 按出场数统计的传奇使用排行（独立页签） |
| **对局记录** | 会话列表，**相对时间 + 绝对日期**、排位/匹配、**按赛季分组与筛选** |
| **数据对比** | 与 tracker.gg 的采集指引 + 一致性校验（独立页签） |

**界面特性**：战术 HUD 视觉风格、桌面版优先布局、零外部依赖（字体/SVG/图表全部自绘）。

## 0. 快速开始

```bash
node server.mjs          # 起本地网页
# 打开 http://127.0.0.1:8787
```

第一次打开会提示「还没有 tracker.gg 数据」。到「**数据对比**」页签按三步做一次采集
（详情见第 2 节），之后每次查询都是**瞬时**的 —— 因为数据已在本地。

## 1. 数据从哪来

全部来自 **tracker.gg**（`apex.tracker.gg`），通过**浏览器采集**获得：

| 数据 | 来源字段 | 说明 |
|---|---|---|
| 等级 / RP / 段位 / 峰值 | `standardProfiles[0].segments[0]` | 含本赛季与历史峰值 RP |
| 26 个传奇的击杀 / 伤害 / 胜场 | `standardProfiles[0].segments[1..26]` | 每个传奇一个分段 |
| 对局记录 | `standardSessions[0].items` | **会话级聚合**（见下方说明）|

> **为什么必须用浏览器采集**：tracker.gg 全站由 Cloudflare 防护，
> 服务端请求（含完整浏览器指纹头）一律返回 **403** 挑战页，只有过了 JS 挑战的真实浏览器能拿到数据。
> 采集脚本已内置，一键复制，一次请求（站点限额 20 次/分钟）。

> ⚠️ **对局是「会话级聚合」，不是逐场**：每个「会话」是一次连续游戏的合计
> （所以单会话可能显示 254 杀），**没有地图与逐场时长**。
> 界面已明确标注，避免误读。

## 2. 采集步骤

打开本站「**数据对比**」页签，那里有完整指引和**一键复制的脚本**。概要：

1. 访问 `apex.tracker.gg/apex/profile/origin/<你的ID>/matches`
2. 按 **F12** 打开控制台，粘贴脚本回车
3. 回到本站刷新

脚本会把页面里的 `__INITIAL_STATE__` 数据 POST 到本地 `POST /api/ingest/trn`，
落盘到 `data/trn-sessions.json`。**一次请求，远低于站点 20 次/分钟的限额。**

## 3. 排位 / 匹配 怎么区分

Apex **只有排位赛才产生 RP**，所以：

| 数据 | 判定 |
|---|---|
| tracker.gg 会话 | RP **有变动** → 排位；**变动为 0** → **未定** |

> 为什么不用「匹配」这个词：净变化恰为 0 的**排位**也长这样，无法区分，
> 所以标「未定」而不断言。行内有徽标，顶部可按 `全部 / 排位 / 匹配` 筛选。

## 3.1 赛季分组与赛季时间

对局记录**按赛季分组**，组头显示赛季名、开始日期、会话数、排位/未定分布与净 RP：

```
S30 · 诸神烙印 · 2026-08-05 起 · 14 个会话 · 排位 8 / 未定 6 · 净 RP +567
08-10 12:32 → 09-12 04:15 · 第 1 段
  … 14 行会话
```

顶部有**赛季筛选**（只列出真正有数据的赛季），**可与类型筛选叠加**
（例如「S30 的排位局」）。

> ⚠️ **赛季起止时间来自内置表**（`track.mjs` 的 `SEASONS`，1~30 季，
> 来源维基百科中文版《Apex 英雄》赛季表）—— **tracker.gg 本身不提供赛季时间**，
> 它的数据里只有 `currentSeason` 这个数字。赛季归属按会话时间戳推导，
> 上下半段（split）按赛季中点划分。

## 3.2 tracker.gg 独有：峰值 RP

「Current Rating」卡会显示 **历史峰值 RP** 与**本赛季峰值**（如 `历史峰值 24,879 RP · 本赛季 12,464`）。
这是 tracker.gg 提供、ALS 没有的数据。

## 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 端口 |
| `HOST` | `127.0.0.1` | 监听地址，默认仅本机可访问 |
| `APEX_TRACK_TIMEOUT_MS` | `60000` | 单次查询的硬超时，超时强杀子进程 |
| `APEX_HTTP_TIMEOUT_MS` | `15000` | 单个上游 HTTP 请求的超时 |

## 5. 命令行

```bash
node track.mjs --name bluekinger              # 默认就是 tracker.gg（读本地采集数据，不联网）
node track.mjs --name bluekinger --json       # 输出 JSON
node track.mjs --name bluekinger --provider als   # 可选：改用 ALS（免费但滞后）
```

| 参数 | 说明 |
|---|---|
| `--name` / `--uid` | 玩家名 / UID |
| `--platform` | `PC` / `PS4` / `X1` |
| `--provider` | `trn`（默认，tracker.gg）\| `als` \| `both` |
| `--json` | 只输出一行 JSON（机器可读）|
| `--no-save` | 不写任何文件 |
| `--matches-source` | 对局来源：`trn`（默认）\| `als` \| `both` |

接口：`POST /api/query`（查询）、`POST /api/collect`（采集存档）、
`GET /api/history`（本地历史）、`POST /api/ingest/trn` + `GET /api/trn-sessions`（浏览器采集）、
`GET /apex-report.html`（静态报告）。

---

## 附：ALS 数据源（可选，默认不使用）

ALS（`apexlegendsstatus.com`）免费、无需 Key，**逐场明细更全**（含地图与时长），
但**对局历史严重滞后**（实测最新只到 `07-18`，而 tracker.gg 有 `09-11`，相差约 55 天）。
所以默认不用它；需要逐场明细时用 `--provider als`。

| | tracker.gg（默认）| ALS（可选）|
|---|---|---|
| 聚合数据（等级/RP/段位/峰值） | ✅ 来自 profile | ✅ 官方接口、实时 |
| 逐场明细（地图/时长/逐场 RP） | ❌ 只有会话聚合 | ✅ 有 |
| 对局新鲜度 | ✅ 最新 | ❌ 滞后约 55 天 |
| 需要 API Key | ❌ 不需要 | ❌ 不需要 |



---

## 1. 命令行跑一次

```bash
cd ~/Desktop/apex

# 按 EA ID 查（PC 玩家即使玩 Steam，也填绑定的 EA 账号名）
node track.mjs --name bluekinger

# 按 UID 查（推荐：改名也不会失效）
node track.mjs --uid 1010918821212
```

输出：

```
═══ Apex 战绩采集 (als) ═══
玩家      L-icet  [UID 1010918821212]
平台      PC
等级      147  (Prestige 2)
段位      Diamond IV  12368 RP  Top 8.26%
状态      Offline or invite only
追踪器    Career Kills, Tempest: Damage, BR Kills

─── Global ───
  Career Kills                  9,164   Top 27.21%
  Career Revives                  825   Top 60.96%
  Career Wins                     335   Top 32.46%

传奇分段  28 个：Ballistic, Global, Revenant, Crypto, ...

─── 与上次对比（2026-09-09T16:25:38.866Z）───
📈 Career Kills: 9,164 → 9,201 (+37)
```

### 参数

| 参数 | 说明 |
|---|---|
| `--name` | EA ID / PSN ID / Xbox Gamertag |
| `--uid` | 直接按 UID 查询，最稳定 |
| `--platform` | `PC`（默认）\| `PS4` \| `X1` |
| `--provider` | `als`（默认）\| `trn` |
| `--out` | 数据目录，默认 `./data` |
| `--quiet` | 只输出一行摘要（适合定时任务） |
| `--note [路径]` | 生成 Obsidian 笔记，默认 `./Apex 战绩.md` |
| `--no-note` | 关闭笔记生成 |
| `--report [路径]` | 生成 HTML 图表，默认 `./apex-report.html` |
| `--no-report` | 关闭 HTML 报告 |
| `--html-raw` | 原始 HTML 存明文（默认 gzip 压缩） |
| `--prune <天数>` | 删除 N 天前的旧快照 |
| `--history <N>` | 笔记里展示最近 N 条，默认 30 |

> 只想安静采集、不要文件输出：加 `--no-note --no-report`。
> 定时任务推荐：`--quiet --prune 90`（自动清理 90 天前的快照）。

### 纯查询模式（不写任何文件）

```bash
node track.mjs --name bluekinger --json --no-save
```

- `--json` 输出一行 JSON（含全部战绩与每个传奇的分段数据），方便管道和程序调用
- `--no-save` 跳过一切落盘：不建快照、不追加 `history.jsonl`、不生成笔记与报告

---

## 2. 数据落地

```
data/
├── history.jsonl                    # 每次运行一行摘要，做趋势用
├── snapshots/
│   └── 2026-09-09T16-25-51-817Z/
│       ├── als.html.gz              # 原始响应（gzip，可回溯、可重新解析）
│       ├── parsed.json              # 解析后的结构化数据
│       └── meta.json                # 查询参数 + token 指纹（不存 token 原文）

Apex 战绩.md                          # Obsidian 笔记（自动更新）
apex-report.html                      # 自包含图表报告（双击即可看）
```

想看某次快照的原始 HTML：

```bash
gunzip -c data/snapshots/<时间戳>/als.html.gz | less
```

**关于体积**：原始响应单次约 230 KB，每 30 分钟采集一次 = 一年 4 GB。
v1.1 起默认 gzip 存储（**约 15 KB，省 93%**），实测快照从 256 KB 降到 44 KB。
需要长年运行时，再加 `--prune 90` 自动清理。

**关于凭据**：`meta.json` 只记录 CSRF token 的 **SHA-256 指纹**和是否存在，
绝不写入 token 原文 —— 所以这个仓库可以直接推到 GitHub 而不泄露会话凭据。

`history.jsonl` 每行：

```json
{"ts":"2026-09-09T16:25:51.817Z","provider":"als","name":"L-icet","uid":"1010918821212",
 "level":147,"prestige":"Prestige 2","rankScore":12368,"rankTier":"diamond4","rankPercentile":"8.26",
 "global":{"Career Kills":{"value":9164,...}},"legendCount":28,
 "legendPrimaryStats":{"Valkyrie":{"label":"BR Kills","value":1057,"isKills":true}}}
```

看趋势（需 `jq`）：

```bash
# 最近 10 次的等级 / RP
tail -10 data/history.jsonl | jq -r '[.ts, .level, .rankScore] | @tsv'

# Career Kills 变化
jq -r 'select(.global) | [.ts, .global["Career Kills"].value] | @tsv' data/history.jsonl

# 传奇击杀排行（取最新一条）
tail -1 data/history.jsonl | jq -r '.legendPrimaryStats | to_entries | sort_by(-.value.value) | .[:10][] | "\(.key)\t\(.value.value)"'
```

---

## 2.5 输出：笔记与报告

每次采集会自动产出两个文件（`--no-note` / `--no-report` 可关闭）：

**`Apex 战绩.md`** —— Obsidian 笔记，含：

- 当前状态卡片（等级 / 段位 / RP / 服务器排名）
- 与上次对比（涨跌箭头）
- 趋势：sparkline 单行图 + Mermaid 折线图（Obsidian 原生渲染）
- 生涯数据表、传奇击杀排行、最近 N 次记录

> Obsidian 的 Mermaid 需要 1.4+ 版本；旧版本会自动降级成 sparkline 文本，不会报错。

**`apex-report.html`** —— 零依赖自包含报告，双击用浏览器打开：

- 三张手写 SVG 折线图（RP / 生涯击杀 / 生涯胜场），可离线、无 CDN
- 传奇击杀 Top 12 横向条形图
- 最近 40 次记录表格

整个文件不需要联网、不需要任何前端库 —— 因为里面没有外部引用。

---

## 3. 定时跑（每小时 2 次）

### 方式 A：cron

```bash
crontab -e
```

加一行：

```
0,30 * * * * cd /Users/licet/Desktop/apex && /Users/licet/.workbuddy/binaries/node/versions/22.22.2-2/bin/node track.mjs --uid 1010918821212 --quiet --prune 90 >> data/cron.log 2>&1
```

> `--prune 90` 会自动删除 90 天前的快照目录，防止长期运行把磁盘吃满。

> cron 的环境变量很少，**Node 必须写绝对路径**。

### 方式 B：launchd（macOS 推荐）

`~/Library/LaunchAgents/com.local.apextracker.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.apextracker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/licet/.workbuddy/binaries/node/versions/22.22.2-2/bin/node</string>
    <string>/Users/licet/Desktop/apex/track.mjs</string>
    <string>--uid</string><string>1010918821212</string>
    <string>--quiet</string>
    <string>--prune</string><string>90</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/licet/Desktop/apex</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/Users/licet/Desktop/apex/data/launchd.log</string>
  <key>StandardErrorPath</key><string>/Users/licet/Desktop/apex/data/launchd.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.local.apextracker.plist
```

`StartInterval` 1800 = 每 30 分钟一次。

---

## 4. Tracker.gg 数据（**不需要 API Key**）

### 4.1 为什么不需要 Key

tracker.gg 是 **Vue 服务端渲染**的，首屏数据以 `window.__INITIAL_STATE__` 的形式
**直接嵌在 HTML 里**。证据：浏览器打开该页时控制台报
`api.tracker.gg ... blocked by CORS policy` + `net::ERR_FAILED`
（客户端 API 调用**全部失败**），但 Recent Matches 依然完整显示 —— 数据来自 HTML 本身。

### 4.2 为什么必须在浏览器里采集

tracker.gg 全站由 **Cloudflare 防护**。实测：

| 请求方式 | 结果 |
|---|---|
| Node `fetch` 页面 HTML（含完整浏览器请求头） | **403**，返回 `Just a moment...` 挑战页 |
| Node `fetch` `api.tracker.gg`（网站内部接口） | **403**，返回 `You've Been Blocked` |
| 真实浏览器 | ✅ 正常（已通过 JS 挑战） |

所以**服务端抓不到**，只有过了挑战的浏览器能拿数据。

### 4.3 采集步骤（网页里一键复制脚本）

打开本站的「**数据对比**」页签，那里有完整指引和可复制的脚本。概要：

1. 新开标签页访问 `apex.tracker.gg/apex/profile/origin/<你的ID>/matches`
2. 按 **F12** 打开控制台，粘贴脚本回车
3. 回到本站刷新「数据对比」页签

脚本把页面里已渲染的数据 POST 到 `POST /api/ingest/trn`，落盘到
`data/trn-sessions.json`；`track.mjs --provider both` 会读取它。

**限额**：站点 20 次/分钟，内置限速（默认 18 留余量，可用 `TRN_WEB_RPM` 调整），
一次采集只发 1 个请求。

### 4.4 命令行 / 两源混合

```bash
node track.mjs --provider both --name bluekinger   # ALS 聚合+逐场 + TRN 会话 + 交叉对比
```

**ALS 与 TRN 强项不同，所以「混合」而不是「替换」：**

| | ALS | TRN |
|---|---|---|
| 聚合数据（等级/RP） | ✅ 官方接口、**实时** | ⚠️ 自己采集 |
| 逐场明细（击杀/伤害/地图/时长/逐场 RP 变化） | ✅ 有 | ❌ 无 |
| 对局新鲜度 | ❌ **滞后**（实测该玩家滞后约 55 天） | ✅ 新 |
| 需要 Key | ❌ 不需要 | ❌ **也不需要**（抓网页） |

> ⚠️ TRN 的 `/sessions` 只给**会话级聚合**（一次连续游戏的合计），不是逐场值 ——
> 会话的 `stats` 与其中 match 的 `stats` 恒等，且 `duration` 恒为 `00:10:00`（不可信）。
> 所以它适合「补最新对局」，不适合「取代 ALS」。

TRN 数据源优先级：`官方 API`（配了 `TRN_API_KEY` 时）→ `网页直抓`（Cloudflare 放行时）
→ `浏览器采集落盘`（默认可行）。

### ⚠️ 速率限制：10 次/分钟

tracker.gg 的 API **限制 10 次/分钟**，超了轻则返回 429，重则封 Key。

- 本项目**默认不碰 tracker.gg**：`server.mjs` 不带 `--provider`，走的是
  `als`（`apexlegendsstatus.com`）。只有显式 `--provider trn` + 配了 `TRN_API_KEY`
  才会请求 `public-api.tracker.gg`。
- `track.mjs` 内置**滑动窗口限流器**（`makeLimiter`），所有 TRN 请求都必须经过
  `TRN_LIMITER`（上限设为 **8 次/分钟**，留安全余量）。
  一次 `--provider trn` 运行只发 3 个请求（profile / segments / sessions），
  连续反复运行也不会越过窗口上限。
- **不要为了看数据去浏览器里刷 `apex.tracker.gg` 页面** —— 页面本身也会消耗额度，
  而且它被 Cloudflare 防护，自动化访问没有意义。
- 需要看对局数据请用本项目自己的 `--matches`（走 ALS，免费且无需 Key）。

条款要点：免费、**仅限非商业**、一组织一 Key、滥用封号。
Apex 专属说明：https://apex.tracker.gg/site-api

---

## 5. 已知限制

1. **`als` 模式读的是公开档案页**，属于非官方途径。自用（1 小时 2 次）完全没负担，但站点改版可能失效；脚本已内置重试。
2. **对局历史拿不到**（除非用 `--provider trn`，或给 Apex Legends Status 充 Patreon Tier 2+）。
3. **游戏内追踪器决定可见数据**：Apex 的接口只返回「当前选中传奇 + 游戏内设置的 3 个追踪器」。所以每个传奇的数据项不完整，这是游戏本身的限制。
4. **改名会让 `--name` 失效**，所以推荐固定用 `--uid`。
5. **EA 账号可见性必须 public**，否则任何第三方都拿不到数据。
6. **`--provider trn` 的生涯数据依赖 TRN 自己采集**，你没被追踪过的对局可能缺失；`als` 的生涯数据来自游戏接口，相对更全。

---

## 6. 测试记录（2026-09-09）

| 项 | 结果 |
|---|---|
| 查询 EA ID | `bluekinger` |
| 解析到 | **L-icet**（UID `1010918821212`） |
| 等级 | 147（Prestige 2） |
| 段位 | Diamond IV — 12,368 RP（Top 8.26%） |
| Career Kills | 9,164（Top 27.21%） |
| Career Wins | 335（Top 32.46%） |
| Career Revives | 825（Top 60.96%） |

主力传奇：Valkyrie 1,057 / Pathfinder 942 / Bangalore 605 / Wraith 486 / Alter 473 / Newcastle 457

> **EA ID 与游戏内名称不同是正常的**：查询用 EA ID（`bluekinger`），游戏内显示 `L-icet`。
> 但脚本输出里的 `玩家` 字段显示的是游戏内名，别被吓到。

---

## 7. 版本历史

### v1.1（2026-09-13）

**新增**
- Obsidian 笔记自动生成（`--note`），含 sparkline + Mermaid 折线图 + 排行榜
- 自包含 HTML 图表报告（`--report`），零依赖、未联网也能看
- 传奇数据入库：`history.jsonl` 新增 `legendPrimaryStats`，27 个传奇可做长期对比
- `--prune <天数>` 自动清理旧快照

**优化**
- 原始 HTML 默认 gzip 压缩：单次快照 **256 KB → 44 KB**，省 92%
- `meta.json` 不再写入 CSRF token 原文，改为 SHA-256 指纹（12 位）
- `history.jsonl` 新增 `prestige` 字段
- 终端多输出一行 RP sparkline 趋势

**修复**
- 传奇排行此前会把不同单位的指标混排（如 `BR Damage 238303` 排在 `BR Kills 299` 旁边）。
  现只排 `BR Kills`，其余传奇单独注明，避免误导
- 指标名里的 HTML 实体（`Spotter&#039;s Lens`）现在会正确解码

### v1.0

初版：ALS / Tracker.gg 双数据源，快照存档 + history.jsonl 趋势。
