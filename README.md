# Apex 个人战绩采集器

定时抓取自己的 Apex 战绩并本地存档。**默认模式不需要任何 API Key，开箱即用。**

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

---

## 2. 数据落地

```
data/
├── history.jsonl                    # 每次运行一行摘要，做趋势用
├── snapshots/
│   └── 2026-09-09T16-25-51-817Z/
│       ├── als.html                 # 原始响应（可回溯、可重新解析）
│       ├── parsed.json              # 解析后的结构化数据
│       └── meta.json                # 查询参数、CSRF token
```

`history.jsonl` 每行：

```json
{"ts":"2026-09-09T16:25:51.817Z","provider":"als","name":"L-icet","uid":"1010918821212",
 "level":147,"rankScore":12368,"rankTier":"diamond4","rankPercentile":"8.26",
 "global":{"Career Kills":{"value":9164,...}},"legendCount":28}
```

看趋势（需 `jq`）：

```bash
# 最近 10 次的等级 / RP
tail -10 data/history.jsonl | jq -r '[.ts, .level, .rankScore] | @tsv'

# Career Kills 变化
jq -r 'select(.global) | [.ts, .global["Career Kills"].value] | @tsv' data/history.jsonl
```

---

## 3. 定时跑（每小时 2 次）

### 方式 A：cron

```bash
crontab -e
```

加一行：

```
0,30 * * * * cd /Users/licet/Desktop/apex && /Users/licet/.workbuddy/binaries/node/versions/22.22.2-2/bin/node track.mjs --uid 1010918821212 --quiet >> data/cron.log 2>&1
```

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
