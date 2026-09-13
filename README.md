# Apex 个人战绩采集器

定时抓取自己的 Apex 战绩并本地存档。**默认模式不需要任何 API Key，开箱即用。**

跑一次，你会得到三样东西：

1. 终端摘要（段位 / RP / 生涯数据 + 与上次对比）
2. **`Apex 战绩.md`** —— Obsidian 笔记，含趋势图和排行榜，每次自动更新
3. **`apex-report.html`** —— 自包含图表报告，双击就能看

两个数据源：

| provider | 需要 Key | 说明 |
|---|---|---|
| `als`（默认） | ❌ 不需要 | 读 Apex Legends Status 的公开档案页，立刻可用 |
| `trn` | ✅ `TRN_API_KEY` | Tracker Network 官方开发者 API，有对局历史 |

每次运行最多 2 个请求，每小时 2 次远低于任何限流阈值。

---

## 1. 跑一次

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

## 4. 切换到 Tracker.gg（可选）

1. https://tracker.gg/developers/apps → 登录 → **Create an app**
2. 复制 App ID
3. 运行：

```bash
export TRN_API_KEY="你的App ID"
node track.mjs --provider trn --name bluekinger
```

会额外抓取 `/sessions`（对局历史），存进 `data/snapshots/<ts>/trn.json`。

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
