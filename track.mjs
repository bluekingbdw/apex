#!/usr/bin/env node
/**
 * Apex Legends 个人战绩采集器  v1.0
 *
 * 数据源：**tracker.gg**（默认，无需 API Key）。
 *   走「浏览器采集落盘」的通路 —— tracker.gg 全站由 Cloudflare 防护，
 *   服务端请求一律 403，只有过了 JS 挑战的真实浏览器能拿到数据。
 *   采集脚本在本项目网页的「数据对比」页签里一键复制。
 *
 *   --provider trn    默认。读本地采集数据（不联网、瞬时），或官方 API（需 TRN_API_KEY）
 *   --provider als    Apex Legends Status 公开档案页（免费，但**对局历史严重滞后**）
 *   --provider both   两者都取并做交叉对比
 *
 * 用法：
 *   node track.mjs --name bluekinger              # 默认：读本地 tracker.gg 数据
 *   node track.mjs --uid 1010918821212 --json     # 输出 JSON（机器可读）
 *   node track.mjs --provider als --name xxx      # 可选：改用 ALS
 *
 * 常用参数：
 *   --name       EA ID（PC）/ PSN ID / Xbox Gamertag
 *   --uid        直接按 UID 查询，最稳定（改名不影响）
 *   --platform   PC | PS4 | X1   （tracker.gg 用 origin | psn | xbl）
 *   --provider   trn | als | both
 *   --matches-source  trn | als | both   对局数据来源（默认 trn）
 *   --out        数据目录，默认 ./data
 *   --quiet      只输出一行摘要
 *
 * 其他：
 *   --note [路径]     生成/更新 Obsidian 笔记，默认 ./Apex 战绩.md
 *   --no-note         关闭笔记生成
 *   --report [路径]   生成自包含 HTML 图表，默认 ./apex-report.html
 *   --no-report       关闭 HTML 报告
 *   --html-raw        原始 HTML 以明文保存（默认 gzip 压缩，省 ~90% 空间）
 *   --prune <天数>    删除超过 N 天的旧快照目录
 *   --history <N>     笔记里展示最近 N 条记录，默认 30
 *
 * 数据落地：
 *   data/trn-sessions.json          浏览器采集的 tracker.gg 数据（会话 + 账号档案）
 *   data/snapshots/<时间戳>/...     原始响应存档
 *   data/history.jsonl              每次运行一行摘要，可做趋势
 *
 * 环境变量：
 *   TRN_API_KEY            可选。配了就改用 tracker.gg 官方 API（作为备选通路）
 *   APEX_HTTP_TIMEOUT_MS   单个上游请求超时，默认 15000
 *   TRN_WEB_RPM            tracker.gg 站点每分钟请求上限，默认 18（站点限额 20）
 */

import { mkdir, writeFile, appendFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// 管道/子进程场景下 stdout 可能提前关闭，避免无谓的 EPIPE 崩溃
process.stdout.on('error', () => {});

/* 自动加载项目根目录的 .env（Node >=20.12 的 process.loadEnvFile）。
   这样配置 TRN_API_KEY 只需要建一个 .env 文件再正常启动，不必手动 export，
   也不必给 node 加 --env-file 参数。.env 已在 .gitignore 里，密钥不会被提交。 */
try {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    // 不覆盖已存在的环境变量：显式 export 的值优先
    const before = { ...process.env };
    process.loadEnvFile(envPath);
    for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
  }
} catch {
  // 老版本 Node 没有 loadEnvFile，或 .env 格式异常 —— 都不该影响主流程
}

// ───────────────────────── 参数 ─────────────────────────

/** 取「可选值」参数：下一个 token 若不以 -- 开头就当作它的值 */
function optionalValue(argv, i, fallback) {
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) return { value: next, skip: 1 };
  return { value: fallback, skip: 0 };
}

function parseArgs(argv) {
  const o = {
    platform: 'PC',
    /* 默认数据源：**只用 tracker.gg**（用户明确要求不用 ALS）。
       走浏览器采集落盘的数据，无需 API Key、无需联网。
       ALS 仍需显式 `--provider als` 才会用到。 */
    provider: 'trn',
    out: './data',
    quiet: false,
    note: './Apex 战绩.md',
    noNote: false,
    report: null,
    noReport: false,
    htmlRaw: false,
    prune: null,
    historyLimit: 30,
    json: false,
    noSave: false,
    matches: 0,
    /* 对局数据的来源：
       · trn（默认）—— 只用 tracker.gg。理由：**ALS 的对局历史严重滞后**
         （实测最新只到 07-18，而 tracker.gg 有 09-11），用它当来源等于看不到近期战绩。
         而且省掉 ALS 的 gameHistory 请求（每次查询少 1~3 个）。
       · als  —— 只用 ALS（有逐场明细，但滞后）
       · both —— 两者都抓，供交叉对比 */
    matchesSource: 'trn',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') o.name = argv[++i];
    else if (a === '--uid') o.uid = argv[++i];
    else if (a === '--platform') o.platform = argv[++i];
    else if (a === '--provider') o.provider = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--matches-source') {
      const v = String(argv[++i] ?? '').toLowerCase();
      o.matchesSource = ['trn', 'als', 'both'].includes(v) ? v : 'trn';
    }
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--note') { const r = optionalValue(argv, i, './Apex 战绩.md'); o.note = r.value; i += r.skip; }
    else if (a === '--no-note') o.noNote = true;
    else if (a === '--report') { const r = optionalValue(argv, i, './apex-report.html'); o.report = r.value; i += r.skip; }
    else if (a === '--no-report') o.noReport = true;
    else if (a === '--html-raw') o.htmlRaw = true;
    else if (a === '--prune') o.prune = Number(argv[++i]);
    else if (a === '--history') o.historyLimit = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--no-save') o.noSave = true;
    else if (a === '--matches') {
      // 支持 `--matches all` = 翻完所有赛季、拉取全部历史。
      // 目前前端只请求 10 场；「全量」这条路径是留给**将来的数据库采集**用的，
      // 现在就能跑通，只是没有落库（见 fetchMatches 的注释）。
      const r = optionalValue(argv, i, '20');
      o.matches = /^all$/i.test(r.value) ? Infinity : Number(r.value) || 0;
      i += r.skip;
    }
    else if (a === '--help' || a === '-h') o.help = true;
  }
  // --report 未显式给出路径时，用默认路径
  if (!o.noReport && o.report === null) o.report = './apex-report.html';
  // 纯查询模式：不落盘，自然也不需要笔记和报告
  if (o.noSave) {
    o.noNote = true;
    o.noReport = true;
    o.prune = null;
  }
  return o;
}

const args = parseArgs(process.argv);

if (args.help || (!args.name && !args.uid)) {
  console.log(`用法:
  node track.mjs --name <EA_ID>                     # 默认：读本地 tracker.gg 采集数据
  node track.mjs --uid <UID>                        # 最稳，改名不影响
  node track.mjs --provider als --name <EA_ID>      # 可选：改用 ALS（免费，但对局滞后）
  node track.mjs --provider both --name <EA_ID>     # 两者都取 + 交叉对比

查询模式（只看结果，不写任何文件）:
  node track.mjs --uid <UID> --json --no-save       # 输出 JSON，方便管道/程序调用

可选:
  --platform PC|PS4|X1     --out ./data       --quiet
  --provider trn|als|both  trn（默认，tracker.gg）| als | both = 两源交叉对比
  --matches-source <src>   对局来源：trn（默认，最新）| als（滞后但有逐场明细）| both
  --note [路径]            生成 Obsidian 笔记（默认 ./Apex 战绩.md）
  --no-note                关闭笔记
  --report [路径]          生成 HTML 图表（默认 ./apex-report.html）
  --no-report              关闭报告
  --html-raw               原始 HTML 不压缩（默认 gzip）
  --prune <天数>           清理 N 天前的快照
  --history <N>            笔记里展示最近 N 条（默认 30）
  --json                   只输出一行 JSON（含全部战绩，机器可读）
  --no-save                不写任何文件（快照 / history / 笔记 / 报告全跳过）
  --matches [N|all]        额外抓取最近 N 场对局记录（默认 20，免费无需 Key）
                           all = 翻完所有赛季拉全部历史（给将来的入库采集用）
  --matches-source <src>   对局数据来源：trn(默认，最新) | als(滞后但有逐场明细) | both
  --matches-source <src>   对局数据来源：trn（默认，最新） | als（滞后但有逐场明细） | both`);
  process.exit(args.help ? 0 : 1);
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// ───────────────────────── 工具 ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 滑动窗口限流 ──
   保证**任意 60 秒内不超过 max 次请求**（而不是固定间隔），
   这样正常的突发调用（一次跑 3 个请求）不会被无谓拖慢，
   但连续反复运行也不会越过窗口上限。

   两个不同的配额，不要混用：
   · 官方开发者 API（public-api.tracker.gg）：**10 次/分钟**，超了会被封 Key
   · 网站页面（apex.tracker.gg）：**20 次/分钟** */
function makeLimiter(max, windowMs = 60_000) {
  const hits = [];
  return async function limit() {
    for (;;) {
      const now = Date.now();
      while (hits.length && now - hits[0] > windowMs) hits.shift();
      if (hits.length < max) {
        hits.push(now);
        return;
      }
      // 等到最早那次请求滑出窗口
      await sleep(hits[0] + windowMs - now + 50);
    }
  };
}

/** 官方开发者 API 限流：配额 10 次/分钟，只用 8 次留安全余量 */
const TRN_API_LIMITER = makeLimiter(8);

/** 网站页面限流：配额 20 次/分钟。默认 18 留一点余量，
 *  可用环境变量 TRN_WEB_RPM 覆盖（例如调试时调小）。 */
const TRN_WEB_LIMITER = makeLimiter(
  Math.max(1, Number(process.env.TRN_WEB_RPM) || 18)
);

/* 单次 HTTP 请求的超时（毫秒）。
   ⚠️ 必须显式设：Node 的 fetch（undici）只在「建连」阶段有超时，
   一旦连上但对方不返回，可能挂到 headers timeout（默认 300s）。
   网络不通时 4 次重试 × 长时间挂起 ⇒ 一次查询能卡好几分钟，
   而 server.mjs 的 busy 标志会被一直占住（实测踩到过）。 */
const HTTP_TIMEOUT_MS = Number(process.env.APEX_HTTP_TIMEOUT_MS) || 15_000;

async function fetchWithRetry(url, opts = {}, tries = 4, timeoutMs = HTTP_TIMEOUT_MS) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;

      /* 区分两类失败，重试策略不同：
         · 「连不通 / 超时」——整站不可达，重试基本没用，最多再试一次就放弃
           （否则 4 次 × 十几秒会把一次查询拖到一分钟以上）
         · 「429 / 5xx」——对方在限流或抖动，值得按退避多试几次 */
      const msg = String(e?.cause?.code || e?.name || e?.message || e);
      const unreachable = /TimeoutError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(msg);
      if (unreachable && i >= 2) break;

      if (i < tries) await sleep(800 * i);
    }
  }
  // 把底层错误翻译成可操作的说明，不要只丢一句 "fetch failed"
  const code = lastErr?.cause?.code || lastErr?.name || '';
  if (/TimeoutError|CONNECT_TIMEOUT/i.test(String(code))) {
    throw new Error(`连接 ${new URL(url).host} 超时（${timeoutMs / 1000}s）。请检查网络后重试。`);
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(String(code))) {
    throw new Error(`无法解析 ${new URL(url).host}（DNS 失败）。请检查网络或代理设置。`);
  }
  throw lastErr;
}

function num(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 只保留指纹，不落盘原始值 —— 用于 CSRF token 这类会话凭据 */
function fingerprint(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** 解码 HTML 实体 —— 采集到的指标名里会出现 Spotter&#039;s Lens 这种 */
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SPARK = '▁▂▃▄▅▆▇█';

/** 把一串数字画成单行 sparkline，任何终端/编辑器都能看 */
function sparkline(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return '';
  if (v.length === 1) return SPARK[4];
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max === min) return SPARK[4].repeat(v.length);
  return v.map((x) => SPARK[Math.round(((x - min) / (max - min)) * (SPARK.length - 1))]).join('');
}

// ─────────────────── ALS（无需 Key）───────────────────

/** 从 HTML 里抓 CSRF token 和 cookie，然后请求内部数据接口 */
async function fetchAls({ name, uid, platform }) {
  const path0 = uid
    ? `/profile/uid/${platform}/${uid}`
    : `/profile/name/${platform}/${encodeURIComponent(name)}`;
  const pageUrl = `https://apexlegendsstatus.com${path0}`;

  const pageRes = await fetchWithRetry(pageUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const pageHtml = await pageRes.text();

  // 收集 cookie
  let cookie = '';
  try {
    const raw = pageRes.headers.getSetCookie?.() ?? [];
    cookie = raw.map((c) => c.split(';')[0]).join('; ');
  } catch {}

  const tok =
    pageHtml.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)/)?.[1] ?? null;

  const qs = uid
    ? `platform=${platform}&uid=${encodeURIComponent(uid)}`
    : `platform=${platform}&player=${encodeURIComponent(name)}`;

  const dataRes = await fetchWithRetry(`https://apexlegendsstatus.com/core/interface-v2?${qs}`, {
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: pageUrl,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const html = await dataRes.text();
  if (html.includes('No profile found')) {
    throw new Error(`查不到玩家「${uid ?? name}」。检查 EA ID 拼写 / 平台 / EA 账号可见性是否 public。`);
  }
  return { html, pageUrl, csrf: tok, cookie };
}

/** 解析 ALS 档案页 HTML */
function parseAls(html) {
  const text = (re) => html.match(re)?.[1]?.trim() ?? null;
  const unesc = (s) => (s ? s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : s);

  const player = {
    uid: text(/value="(\d+)" id="puid"/),
    name: text(/<h1 class="player-name">([^<]*)<\/h1>/),
    platform: text(/value="([^"]*)" id="pplat"/),
    level: num(text(/v2-sb-stat--level[\s\S]{0,400}?v2-sb-stat__value">([\d,]+)</)),
    prestige: text(/v2-sb-stat__pill--prestige">([^<]*)</),
    rankScore: num(text(/v2-sb-stat--rank[\s\S]{0,600}?v2-sb-stat__value">([\d,]+)/)),
    rankTier: text(/assets\/ranks\/([a-z0-9]+)\.png/),
    status: text(/v2-status[^>]*>[\s\S]{0,80}?<\/i>\s*([^<]+)</)?.trim(),
  };

  // 排名百分位（BR Rank 的 tooltip 里）。position=0 / 100% 是「无数据」的占位值
  const rankTip = unesc(text(/v2-sb-stat__pill--rank[^>]*title="([^"]*)"/));
  player.rankPercentile = rankTip?.match(/top[\s\S]{0,80}?<b>([\d.]+)%/)?.[1] ?? null;
  player.rankPosition = rankTip?.match(/#<b>([\d,]+)<\/b>/)?.[1] ?? null;
  if (player.rankPosition === '0' || player.rankPercentile === '100') {
    player.rankPosition = null;
    player.rankPercentile = null;
  }

  // 各传奇分段：按 <div class="v2-stat profile-stats"> 切块，逐块提取
  const legends = [];
  const blocks = html.split(/<h2 class="profile-legend__name">/).slice(1);
  for (const b of blocks) {
    const h2End = b.indexOf('</h2>');
    if (h2End < 0) continue;
    const legend = b.slice(0, h2End).trim();
    let body = b.slice(h2End);
    const next = body.indexOf('v2-legend item');
    if (next > 0) body = body.slice(0, next);

    const stats = {};
    for (const chunk of body.split('<div class="v2-stat profile-stats">').slice(1)) {
      const label = chunk.match(/<span class="v2-stat__label" title="([^"]+)"/)?.[1];
      const value = chunk.match(/<span class="amount__total">([^<]*)<\/span>/)?.[1];
      if (!label) continue;
      const tip = unesc(chunk.match(/class="v2-rank"[^>]*title="([^"]*)"/)?.[1]);
      const pos = tip?.match(/#<b>([\d,]+)<\/b>/)?.[1] ?? null;
      const pct = tip?.match(/top[\s\S]{0,80}?<b>([\d.]+)%/)?.[1] ?? null;
      stats[label] = {
        value: num(value),
        displayValue: (value ?? '').trim(),
        percentile: pos === '0' || pct === '100' ? null : pct,
        position: pos === '0' ? null : pos,
      };
    }
    if (Object.keys(stats).length) legends.push({ legend, stats });
  }

  // 游戏内设置的追踪器
  const trackers = text(/v2-sb-note__trackers">([^<]*)</);

  return { player, legends, trackers };
}

// ───────────── 对局历史（ALS 免费接口，无需 Key）─────────────
//
// 档案页里那个「Tier 2+ Patrons 才能下载」限制的是**导出/复盘**，
// 对局列表本身走 /core/gameHistory，任何人都能拿到。
// 返回的是一段 HTML，按「赛季 split」分段，每段含若干场对局。

/** 从 interface-v2 的 HTML 里取赛季列表，并反转成「新 → 旧」 */
function parseSplits(html) {
  const out = [...html.matchAll(/<option value="(s\d+_s\d+)"/g)].map((m) => m[1]);
  return out.reverse();
}

/** 拉取某个赛季的对局历史（HTML 片段） */
async function fetchGameHistory({ uid, name, platform, split, pageUrl, cookie }) {
  const id = uid ?? name;
  const url =
    `https://apexlegendsstatus.com/core/gameHistory?split=${encodeURIComponent(split)}` +
    `&uid=${encodeURIComponent(id)}&screenWidth=1440`;
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: pageUrl,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  return res.text();
}

/** "16m 9s" / "1h 2m 3s" → 秒 */
function durToSec(s) {
  if (!s) return null;
  const h = Number(/(\d+)\s*h/.exec(s)?.[1] ?? 0);
  const m = Number(/(\d+)\s*m/.exec(s)?.[1] ?? 0);
  const sec = Number(/(\d+)\s*s/.exec(s)?.[1] ?? 0);
  return h * 3600 + m * 60 + sec || null;
}

const KNOWN_MODES = /^(BR|Ranked|Arenas|LTM|Mixtape|Control|Gun Run|TDM|Domination)$/i;

/** 解析 gameHistory 返回的 HTML → 对局数组（含真实时间戳） */
function parseGameHistory(html, split) {
  if (!html || /no games have been recorded/i.test(html)) return [];

  // ── 1. 摘出 mmChartv3JsonPayload：[{timestamp, rankScore}, ...]（新 → 旧）
  //     ⚠️ 这个隐藏 div 位于整个响应末尾、恰好落在最后一个 session 块内。
  //     必须先从 HTML 中移除，否则会被当作那个 session 的时间戳，
  //     让「最旧的会话」拿到「最新的时间」而排到最前面。
  const chartJson = html.match(/id="mmChartv3JsonPayload">(\[[\s\S]*?\])<\/div>/)?.[1];
  let chart = [];
  if (chartJson) {
    try {
      chart = JSON.parse(chartJson);
    } catch {}
    html = html.replace(chartJson, '');
  }

  const out = [];

  // ── 2. 每个 <div class="v2-mh-session"> 是一「段」对局（同一时段的连续几局）
  const sessions = html.split('<div class="v2-mh-session">').slice(1);
  for (let si = 0; si < sessions.length; si++) {
    const s = sessions[si];
    const when = s.match(/Game session<\/p>\s*<p[^>]*>([^<]*)</)?.[1]?.trim() ?? null;

    for (const g of s.split('<div class="row equal v2-mh-session__game"').slice(1)) {
      // 详情块（Tier2 复盘）是 game 行之后的兄弟节点，把它切出去，
      // 免得「详情」里的字段混进 stats
      const dIdx = g.search(/<div[^>]*id="MMv2-/);
      const main = dIdx > 0 ? g.slice(0, dIdx) : g;
      const detail = dIdx > 0 ? g.slice(dIdx) : '';

      const legend = main.match(/<span style="font-weight: bold; color: white;">([^<]+)<\/span>/)?.[1]?.trim();
      if (!legend) continue;

      /** 取 <p 粗体>LABEL</p><p>VALUE</p> 形式的键值对 */
      const pairs = (src) => {
        const o = {};
        for (const m of src.matchAll(
          /<p style="[^"]*font-weight: bold[^"]*">\s*([^<]+?)\s*<\/p>\s*<p style="[^"]*">\s*([^<]*?)\s*<\/p>/g
        )) {
          o[m[1].trim()] = m[2].trim();
        }
        return o;
      };

      const bold = [...main.matchAll(/<span style="font-weight: bold; color: white;">([^<]+)<\/span>/g)]
        .map((m) => m[1].trim());
      const duration = main.match(/Lasted ([^<]*)</)?.[1]?.trim() ?? null;
      const chg = main.match(/<span style="color: (green|red);">[▲▼]<\/span>(\d+)/);
      const details = pairs(detail);
      const mainStats = pairs(main);

      const rp = num(main.match(/([\d,]+)\s*RP/)?.[1]);
      /* ALS 自带 split（如 s29_s2）→ 直接解析出赛季与上下半段，
         比按时间戳推断更准（用的是它的口径） */
      const sp = /^s(\d+)_s(\d+)$/.exec(String(split ?? ''));
      const alsSeason = sp ? Number(sp[1]) : null;
      const alsSplit = sp ? Number(sp[2]) : null;

      /* ── 排位 / 匹配 的区分 ──
         ALS **不直接标注** playlist，它把排位赛也写成 mode="BR"（那只是游戏模式）。
         可靠的判据是：**Apex 只有排位赛才产生 RP**。
           有 rp 字段 → 排位；没有 → 匹配（pubs）。
         实测交叉验证（s29_s2 / s29_s1）：
           · 有 RP：221 / 193 场，且 bold 均含 "BR"
           · 无 RP：  9 /  53 场，且 bold **全都不含** "BR"
         两个信号完全一致，所以这里用语义更明确的「有无 RP」。 */
      const playlist = rp != null ? 'ranked' : 'pubs';

      out.push({
        split,
        // 赛季归属：ALS 的 split 字段（如 s29_s2）是权威口径，直接解析
        season: alsSeason,
        seasonName: SEASON_STARTS.find((x) => x.s === alsSeason)?.name ?? null,
        seasonStart: SEASON_STARTS.find((x) => x.s === alsSeason)?.start ?? null,
        seasonSplit: alsSplit,
        session: si, // 会话序号（同一 session 的对局是连续打的）
        timestamp: null, // 稍后由 chart 归并配对填入
        when,
        legend,
        legendImg: main.match(/<img src="(\/assets\/legends-select\/[^"]+)"/)?.[1] ?? null,
        duration,
        durationSec: durToSec(duration),
        // 游戏模式（BR / Mixtape…），注意它**不区分排位与匹配**
        mode: bold.find((x) => x !== legend && KNOWN_MODES.test(x)) ?? mainStats['Game mode'] ?? null,
        // 排位 / 匹配（见上面的推导）
        playlist,
        rank: main.match(/ranks\/([a-z0-9]+)\.png/)?.[1] ?? null,
        rp,
        rpChange: chg ? (chg[1] === 'green' ? 1 : -1) * Number(chg[2]) : null,
        stats: mainStats,
        map: details['Map played'] ?? null,
        level: num(details['Level']),
        xp: num(details['Estimated XP progress']),
      });
    }
  }

  // ── 3. 归并配对：两边都是「新 → 旧」，按 rankScore 顺序匹配即得真实时间。
  //     实测 s29_s2 的 221 场有 RP 的对局全部命中，且时间戳严格单调递减。
  let ci = 0;
  for (const g of out) {
    if (g.rp == null) continue;
    while (ci < chart.length && chart[ci].rankScore !== g.rp) ci++;
    if (ci >= chart.length) break; // 后面的对局没有对应时间了
    g.timestamp = chart[ci].timestamp ?? null;
    ci++;
  }

  return out;
}

/** 从最近的赛季往前翻，直到凑够 limit 场。
 *  maxSplits 不传时自适应：
 *   · limit 有限 → 最多翻 4 个赛季（控住请求数）
 *   · limit = Infinity（`--matches all`）→ 翻完所有赛季，不设上限
 *  ⚠️ 全量拉取会有几十个请求，**当前只回内存、不落盘**。
 *    将来建了数据库，就在这里把每场写库（或把 games 交给调用方持久化）。 */
async function fetchMatches({ profileHtml, uid, name, platform, pageUrl, cookie, limit, maxSplits }) {
  if (!limit || limit <= 0) return [];
  const cap = maxSplits ?? (Number.isFinite(limit) ? 4 : Infinity);
  const games = [];
  const splits = parseSplits(profileHtml);
  let tried = 0;

  for (const split of splits) {
    if (games.length >= limit || tried >= cap) break;
    tried++;
    // 礼貌间隔：`--matches all` 会连续翻好几个赛季，别把 ALS 打成一串突发请求。
    // 只对第 2 个及之后的赛季生效，单次查询不受影响。
    if (tried > 1) await sleep(600);
    let html;
    try {
      html = await fetchGameHistory({ uid, name, platform, split, pageUrl, cookie });
    } catch {
      continue; // 某个赛季拉失败不影响整体
    }
    // 记下所属赛季的新旧次序与原位置，作为无时间戳时的排序回退依据
    parseGameHistory(html, split).forEach((g, i) => {
      games.push({ ...g, __splitIdx: splits.indexOf(split), __idx: i });
    });
  }

  // 新 → 旧：有时间戳的按时间排；没有的（如 ALS 未记录的模式）退回
  // 「赛季越新越靠前 + 同赛季内 HTML 原顺序」，避免它们乱插到列表中间
  games.sort((a, b) => {
    if (a.timestamp != null && b.timestamp != null) return b.timestamp - a.timestamp;
    if (a.timestamp != null) return -1;
    if (b.timestamp != null) return 1;
    return a.__splitIdx - b.__splitIdx || a.__idx - b.__idx;
  });

  return games.slice(0, limit).map(({ __splitIdx, __idx, ...g }) => g);
}

/* ═══════════════ 赛季时间表 ═══════════════
   ⚠️ **tracker.gg 不提供赛季起止时间**（实测其数据里只有 `currentSeason` 数字）。
   要按赛季分组对局，只能内置一份开始日期表。
   数据来源：维基百科中文版《Apex 英雄》的赛季表（2026-09-14 抓取核对）。
   赛季时长通常约 3 个月，所以「某赛季的区间」= 本季开始 → 下一季开始。 */
const SEASONS = [
  { s: 1, start: '2019-03-20', name: '狂野边境' },
  { s: 2, start: '2019-07-03', name: '冲锋陷阵' },
  { s: 3, start: '2019-10-02', name: '瓦解冰消' },
  { s: 4, start: '2020-02-04', name: '同化' },
  { s: 5, start: '2020-05-12', name: '时来运转' },
  { s: 6, start: '2020-08-18', name: '马力全开' },
  { s: 7, start: '2020-11-04', name: '直上云霄' },
  { s: 8, start: '2021-02-02', name: '死斗' },
  { s: 9, start: '2021-05-04', name: '流传千古' },
  { s: 10, start: '2021-08-03', name: '羽化重生' },
  { s: 11, start: '2021-11-02', name: '逃脱隐世' },
  { s: 12, start: '2022-02-08', name: '违逆不从' },
  { s: 13, start: '2022-05-11', name: '救世英雄' },
  { s: 14, start: '2022-08-09', name: '猎物' },
  { s: 15, start: '2022-11-01', name: '日蚀' },
  { s: 16, start: '2023-02-14', name: '狂欢' },
  { s: 17, start: '2023-05-09', name: '军火库' },
  { s: 18, start: '2023-08-09', name: '复活' },
  { s: 19, start: '2023-10-31', name: '点燃' },
  { s: 20, start: '2024-02-08', name: '突破' },
  { s: 21, start: '2024-05-07', name: '剧变' },
  { s: 22, start: '2024-08-06', name: '震撼波动' },
  { s: 23, start: '2024-11-05', name: '源自裂缝' },
  { s: 24, start: '2025-02-11', name: '侵略' },
  { s: 25, start: '2025-05-06', name: '金童降世' },
  { s: 26, start: '2025-08-06', name: '巅峰对决' },
  { s: 27, start: '2025-11-04', name: '无限增幅' },
  { s: 28, start: '2026-02-11', name: '全面击破' },
  { s: 29, start: '2026-05-06', name: '超频风暴' },
  { s: 30, start: '2026-08-05', name: '诸神烙印' },
];

const SEASON_STARTS = SEASONS.map((x) => ({ ...x, t: Date.parse(`${x.start}T00:00:00Z`) / 1000 }));

/** unix 秒 → 所属赛季 { season, name, start, split }
 *  Apex 赛季约 3 个月，中点为上下 split 的分界（ALS 用 s29_s1 / s29_s2 这种口径）。 */
function seasonOf(ts) {
  if (!Number.isFinite(ts)) return null;
  for (let i = SEASON_STARTS.length - 1; i >= 0; i--) {
    const cur = SEASON_STARTS[i];
    if (ts < cur.t) continue;
    const next = SEASON_STARTS[i + 1] ?? null;
    const end = next ? next.t : null;
    // 中点之后算 s2（下半段）；赛季未结束时按中点推
    const mid = end ? cur.t + (end - cur.t) / 2 : cur.t + 45 * 86400;
    return {
      season: cur.s,
      name: cur.name,
      start: cur.start,
      end: next ? next.start : null,
      split: ts >= mid ? 2 : 1,
    };
  }
  return null;
}

/** 赛季标签：S30 · 诸神烙印 · 2026-08-05 起 */
function seasonLabel(ts) {
  const s = seasonOf(ts);
  if (!s) return '未知赛季';
  return `S${s.season}${s.name ? ` · ${s.name}` : ''}`;
}

/* 内置赛季表覆盖到哪。赛季约 90 天，所以最后一项 + 100 天之后
   这个表就不可信了 —— 该提醒去更新 SEASONS。 */
const SEASON_TABLE_STALE_AFTER = (() => {
  const last = SEASON_STARTS.at(-1);
  return last ? last.t + 100 * 86400 : 0;
})();

/**
 * 按**当前系统时间**判断现在属于哪个赛季。
 *
 * 为什么需要：内置赛季表是硬编码的，会随时间过期；
 * 而且「当前赛季」是个动态值，不能靠对局数据反推（玩家可能一周没打）。
 *
 * `trackerSays` 是 tracker.gg 自己报的 `metadata.currentSeason`，
 * 用作**交叉验证** —— 两边不一致说明我的表该更新了，这是最有价值的信号。
 */
function currentSeasonInfo(trackerSays, at = Math.floor(Date.now() / 1000)) {
  const s = seasonOf(at);
  const stale = at > SEASON_TABLE_STALE_AFTER;
  const says = trackerSays == null ? null : Number(trackerSays);
  return {
    at: new Date(at * 1000).toISOString(),
    season: s?.season ?? null,
    name: s?.name ?? null,
    start: s?.start ?? null,
    split: s?.split ?? null,
    // 与 tracker.gg 报的对比：null = 对方没给（例如纯本地无 profile）
    trackerSays: Number.isFinite(says) ? says : null,
    consistent: Number.isFinite(says) && s ? s.season === says : null,
    /* 表已过期：当前时间超出表覆盖范围。此时 seasonOf 会把最后一项当答案返回，
       实际可能已经有新赛季了 —— 必须提示而不是默默给个可能错的答案。 */
    stale,
  };
}

// ───────────────── Tracker Network ─────────────────

const TRN_SLUG = { PC: 'origin', PS4: 'psn', X1: 'xbl' };

/* ═══════════════ 免 Key 方案：直接抓 tracker.gg 页面 ═══════════════
   为什么不需要 Key：tracker.gg 的页面是 **Vue 服务端渲染**，
   首屏数据以 `window.__INITIAL_STATE__ = {...}` 的形式**直接嵌在 HTML 里**。
   证据：浏览器里打开该页时，控制台报 `api.tracker.gg ... blocked by CORS policy`
   + `net::ERR_FAILED`（客户端 API 调用**全部失败**），但 Recent Matches 依然完整显示
   —— 说明数据来自 HTML 本身，不是浏览器另发的 API 请求。
   所以只要 GET 一次页面 HTML、解析出那段状态即可，无需任何 Key。

   限额：**20 次/分钟**（见 TRN_WEB_LIMITER），一次查询只发 1 个请求。 */

/**
 * 从 HTML 里抽出 `window.__INITIAL_STATE__` 的 JSON。
 * 不能简单用正则 —— 这段 JSON 有 300KB+、含大量嵌套与转义，
 * 必须按括号配对扫描（同时正确处理字符串内的 {} 与转义引号）。
 */
function extractInitialState(html) {
  const at = html.indexOf('__INITIAL_STATE__');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 抓 tracker.gg 的 matches 页面并取出会话数据（无需 Key） */
async function fetchTrnPage({ name, uid, platform }) {
  const slug = TRN_SLUG[platform] ?? platform;
  const id = encodeURIComponent(uid ?? name);
  const url = `https://apex.tracker.gg/apex/profile/${slug}/${id}/matches`;

  await TRN_WEB_LIMITER(); // ⚠️ 20 次/分钟，必须过限速
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (res.status === 404) throw new Error(`404 tracker.gg 上找不到玩家「${uid ?? name}」`);
  if (!res.ok) throw new Error(`tracker.gg 返回 HTTP ${res.status}`);
  const html = await res.text();

  const state = extractInitialState(html);
  if (!state) {
    throw new Error(
      '未能在页面里解析出 __INITIAL_STATE__（可能是 Cloudflare 验证页或页面结构变了）'
    );
  }

  const s = state?.stats?.standardSessions;
  // 形状：standardSessions = [ { items: [...] } ] 或直接就是数组
  const items = Array.isArray(s?.[0]?.items) ? s[0].items
    : Array.isArray(s?.items) ? s.items
    : Array.isArray(s) && s[0]?.matches ? s
    : [];

  return {
    pageUrl: url,
    htmlLength: html.length,
    // 复用官方 API 那条路径的归一化函数，保持下游一致
    sessions: { data: { items } },
    raw: state,
  };
}

/** 读取「浏览器采集」落盘的 tracker.gg 数据（data/trn-sessions.json）。
 *  tracker.gg 有 Cloudflare，服务端抓不到（403 挑战页），
 *  所以浏览器采集后由 server.mjs 落盘，这里读回来用。
 *  返回 { items, profile, collectedAt, player }。 */
async function readTrnSessionsFile(outDir) {
  const f = path.join(path.resolve(outDir), 'trn-sessions.json');
  if (!existsSync(f)) return null;
  try {
    const rec = JSON.parse(await readFile(f, 'utf8'));
    const items = rec?.data?.items ?? rec?.items;
    if (!Array.isArray(items) || !items.length) return null;
    return {
      items,
      profile: rec?.data?.profile ?? rec?.profile ?? null,
      collectedAt: rec.collectedAt ?? null,
      player: rec.player ?? null,
      platform: rec.platform ?? null,
    };
  } catch {
    return null;
  }
}

/* ═══════════════ 只用 tracker.gg 构建完整战绩 ═══════════════
   数据源：tracker.gg 页面的 `standardProfiles[0]`（浏览器采集落盘）。
   有了它就不需要 ALS —— 聚合战绩、传奇分段、对局全都有。 */

/* Apex 段位的大段起点（RP）。用于把 rankScore 换算成段位名。
   实测校准（tracker.gg 自己的 rankScoreInfo 给出的对应关系）：
     3573 → Silver 3 · 6449 → Gold 3 · 8878 → Platinum 4
     11028 → Platinum 1 · 12119 → Diamond 4 · 24879 → Master */
const TIER_FLOOR = [
  [15000, 'Master'],
  [12000, 'Diamond'],
  [8400, 'Platinum'],
  [4000, 'Gold'],
  [2000, 'Silver'],
  [1000, 'Bronze'],
  [0, 'Rookie'],
];
const TIER_ROMAN = ['IV', 'III', 'II', 'I'];

/** 纯阈值兜底：把 RP 换算成段位名（精度略低于会话映射，用于超范围的分数） */
function tierFromScoreFallback(score) {
  const s = Number(String(score ?? '').replace(/,/g, ''));
  if (!Number.isFinite(s)) return null;
  for (let i = 0; i < TIER_FLOOR.length; i++) {
    const [floor, name] = TIER_FLOOR[i];
    if (s < floor) continue;
    // 大段内按均匀 4 小段；Master 以上没有小段
    const ceil = i === 0 ? null : TIER_FLOOR[i - 1][0];
    if (name === 'Master') return 'Master';
    const span = (ceil - floor) / 4;
    const idx = Math.min(3, Math.max(0, Math.floor((s - floor) / span)));
    return `${name} ${TIER_ROMAN[idx]}`;
  }
  return null;
}

/** 会话里藏着精确的 (RP → 段位名) 映射，优先用它（最近邻匹配） */
function makeTierLookup(sessions) {
  const pts = [];
  for (const s of sessions ?? []) {
    const rp = trnVal(s.stats?.rankScore);
    const info = s.matches?.[0]?.stats?.rankScore?.metadata?.rankScoreInfo
      ?? s.stats?.rankScore?.metadata?.rankScoreInfo;
    // 过滤异常点：会话聚合 RP 与 match 段位偶尔会错位（实测有 24055→Diamond 4 这种）
    if (rp != null && info?.name) pts.push([rp, info.name, info.image ?? null]);
  }
  return (score) => {
    const s = Number(String(score ?? '').replace(/,/g, ''));
    if (!Number.isFinite(s)) return null;
    let best = null;
    for (const [rp, name, img] of pts) {
      const d = Math.abs(rp - s);
      if (Math.abs(rp - s) > 1200) continue; // 太远就不是同段位了
      if (!best || d < best.d) best = { d, name, img };
    }
    if (best) return { name: best.name, img: best.img, exact: best.d < 300 };
    const guess = tierFromScoreFallback(s);
    return guess ? { name: guess, img: null, exact: false } : null;
  };
}

/** 等级绝对值 → 转生 + 等级（tracker.gg 给 1147，ALS 口径是 Prestige 2 + Lv147） */
function splitLevel(absLevel) {
  const n = Number(absLevel);
  if (!Number.isFinite(n) || n <= 0) return { prestige: null, level: null };
  if (n < 1000) return { prestige: null, level: n };
  return { prestige: `Prestige ${Math.floor(n / 1000) + 1}`, level: n % 1000 };
}

const segVal = (seg, key) => trnVal(seg?.stats?.[key]);

/** 用 tracker.gg 的 profile + sessions 构建与 ALS 同构的 result */
function buildFromTrn({ profile, sessions, seedPlayer, sessionItems }) {
  const segs = profile?.segments ?? [];
  const overview = segs.find((s) => s.type === 'overview') ?? {};
  const legendSegs = segs.filter((s) => s.type === 'legend');

  /* 生涯总览 → 一个 Global 项 —— 上层的 record.global['Career Kills'] 等逻辑可直接复用 */
  const globalStats = {};
  const put = (label, v) => {
    if (v != null) globalStats[label] = { value: v, displayValue: String(v) };
  };
  put('Career Kills', segVal(overview, 'kills'));
  put('Career Wins', segVal(overview, 'wins'));
  put('Career Damage', segVal(overview, 'damage'));
  put('Matches Played', segVal(overview, 'matchesPlayed'));
  put('Kills / Match', segVal(overview, 'killsPerMatch'));
  put('Damage / Match', segVal(overview, 'damagePerMatch'));
  put('Finishers', segVal(overview, 'finishers'));

  const lookupTier = makeTierLookup(sessionItems ?? []);
  const rankScore = segVal(overview, 'rankScore');
  const tier = lookupTier(rankScore);
  const { prestige, level } = splitLevel(segVal(overview, 'level'));

  /* 对局用时序：TRN 是会话级聚合，字段名与 ALS 不同，这里统一成前端期望的键 */
  const sessionsNorm = (sessions ?? []).map((s, i) => {
    const m0 = s.matches?.[0] ?? null;
    const st = s.stats ?? m0?.stats ?? {};
    const start = s.metadata?.startDate?.value ?? null;
    // RP 优先取 match 级（会话级有脏值，详见 normalizeTrnSessions 的注释）
    const rp = trnVal(m0?.stats?.rankScore) ?? trnVal(st.rankScore);
    const t = lookupTier(rp);
    const rpChange = trnVal(m0?.stats?.rankScoreChange) ?? trnVal(st.rankScoreChange);
    const rankInfo = m0?.stats?.rankScore?.metadata?.rankScoreInfo ?? null;
    const ts = start ? Math.floor(Date.parse(start) / 1000) : null;
    const season = seasonOf(ts);
    return {
      source: 'trn',
      granularity: 'session',
      playlist: rpChange == null ? null : rpChange !== 0 ? 'ranked' : 'unknown',
      session: i,
      when: start,
      timestamp: ts,
      // 赛季归属（由内置赛季表推导，见 SEASONS 的注释）
      season: season?.season ?? null,
      seasonName: season?.name ?? null,
      seasonStart: season?.start ?? null,
      seasonSplit: season?.split ?? null,
      legend: m0?.metadata?.legend?.displayValue ?? null,
      matchCount: s.matches?.length ?? 0,
      level: trnVal(m0?.stats?.level),
      kills: trnVal(st.kills),
      damage: trnVal(st.damage),
      rp,
      rpChange,
      rankName: rankInfo?.name ?? t?.name ?? null,
      rankImg: rankInfo?.image ?? t?.img ?? null,
      rankColor: rankInfo?.color ?? null,
      wins: trnVal(st.wins),
      duration: null,
    };
  });

  return {
    player: {
      /* 名字：tracker.gg 的 platformUserHandle 是 **EA ID**（bluekinger），
         玩家自己看到的是 Steam 别名（L-icet），两者都保留。 */
      name: profile?.metadata?.steamInfo?.displayName
        ?? profile?.platformInfo?.platformUserHandle ?? seedPlayer ?? null,
      eaId: profile?.platformInfo?.platformUserHandle ?? seedPlayer ?? null,
      uid: profile?.platformInfo?.platformUserId
        ?? profile?.platformInfo?.platformUserIdentifier ?? null,
      platform: profile?.platformInfo?.platformSlug ?? 'origin',
      avatar: profile?.platformInfo?.avatarUrl ?? null,
      level,
      prestige,
      levelAbsolute: segVal(overview, 'level'),
      rankScore,
      rankTier: tier?.name ?? null,
      rankTierImg: tier?.img ?? null,
      rankTierExact: tier?.exact ?? false,
      peakRankScore: segVal(overview, 'peakRankScore'),
      lifetimePeakRankScore: segVal(overview, 'lifetimePeakRankScore'),
      season: profile?.metadata?.currentSeason ?? null,
      activeLegend: profile?.metadata?.activeLegendName ?? null,
      rankPercentile: null, // tracker.gg 的聚合接口不提供
      rankPosition: null,
      status: null,
      /* tracker.gg 的「当前传奇追踪器」名称（如 Kills, Wins, Damage），
         可作为 Account 卡里「追踪器」那一栏的数据 */
      trackers: (profile?.metadata?.activeLegendStats ?? []).join(', ') || null,
    },
    /* 传奇分段 → 与 ALS 的 legends 同构（stats 用 BR Kills 等命名） */
    legends: [
      ...legendSegs.map((s) => ({
        legend: s.metadata?.name ?? null,
        legendColor: s.metadata?.legendColor ?? null,
        legendImg: s.metadata?.portraitImageUrl ?? null,
        stats: {
          ...(segVal(s, 'kills') != null
            ? { 'BR Kills': { value: segVal(s, 'kills'), displayValue: String(segVal(s, 'kills')) } } : {}),
          ...(segVal(s, 'damage') != null
            ? { 'BR Damage': { value: segVal(s, 'damage'), displayValue: String(segVal(s, 'damage')) } } : {}),
          ...(segVal(s, 'wins') != null
            ? { 'BR Wins': { value: segVal(s, 'wins'), displayValue: String(segVal(s, 'wins')) } } : {}),
        },
      })),
      { legend: 'Global', stats: globalStats },
    ],
    sessions: sessionsNorm,
    legendCount: legendSegs.length,
  };
}

async function fetchTrn({ name, uid, platform }) {
  const key = process.env.TRN_API_KEY;
  if (!key) throw new Error('缺少 TRN_API_KEY 环境变量（https://tracker.gg/developers/apps）');
  const slug = TRN_SLUG[platform] ?? platform;
  const id = encodeURIComponent(uid ?? name);
  const base = `https://public-api.tracker.gg/v2/apex/standard/profile/${slug}/${id}`;
  const h = { 'TRN-Api-Key': key, Accept: 'application/json', 'User-Agent': UA };

  const get = async (u) => {
    // ⚠️ 官方 API 限 10 次/分钟，所有 TRN 请求都必须过这个限流器。
    //   不要绕过它直接 fetch —— 被限流轻则 429，重则封 Key。
    await TRN_API_LIMITER();
    const r = await fetchWithRetry(u, { headers: h });
    if (r.status === 401) throw new Error('401 API Key 无效或已被封禁');
    if (r.status === 404) throw new Error(`404 找不到玩家「${uid ?? name}」`);
    if (r.status === 429) throw new Error('429 触发 tracker.gg 限流（10 次/分钟），请稍后再试');
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const profile = await get(base);
  const legend = await get(`${base}/segments/legend`).catch(() => null);
  const sessions = await get(`${base}/sessions`).catch(() => null);

  const seg = profile?.data?.segments?.find((s) => s.type === 'overview') ?? profile?.data?.segments?.[0] ?? {};
  const flat = {};
  const walk = (node, prefix = '', d = 0) => {
    if (!node || typeof node !== 'object' || d > 6) return;
    for (const [k, v] of Object.entries(node)) {
      if (['metadata', 'expiryDate', 'updateDate'].includes(k)) continue;
      const key2 = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v)
        flat[key2] = { value: v.value, displayValue: v.displayValue ?? String(v.value) };
      else if (v && typeof v === 'object') walk(v, key2, d + 1);
    }
  };
  walk({ attributes: seg.attributes, stats: seg.stats });

  const find = (...needles) => {
    for (const [k, v] of Object.entries(flat)) {
      const lk = k.toLowerCase();
      if (needles.some((n) => lk.endsWith(n) || lk.includes(n))) return v;
    }
    return null;
  };

  const legends = (Array.isArray(legend?.data) ? legend.data : legend?.data?.segments ?? []).map((s) => ({
    legend: s.attributes?.legendName ?? s.metadata?.legendName ?? s.type,
    stats: Object.fromEntries(
      Object.entries(s.stats ?? {}).map(([k, v]) => [k, { value: v.value, displayValue: v.displayValue ?? String(v.value) }])
    ),
  }));

  return {
    player: {
      name: profile?.data?.platformInfo?.platformUserHandle ?? null,
      uid: profile?.data?.platformInfo?.platformUserIdentifier ?? null,
      platform: slug,
      level: find('.level', 'level'),
      rankScore: find('rankscore', 'rank_score', 'rp'),
      kills: find('.kills', 'kills'),
      damage: find('.damage', 'damage'),
      wins: find('.wins', 'wins'),
      matches: find('matchesplayed', 'matches'),
    },
    legends,
    sessions,
    raw: { profile, legend, sessions },
  };
}

// ───────────────────── 数据加工 ─────────────────────

/* ═══════════════ 跨数据源对比（ALS vs TRN） ═══════════════
   为什么要对比：ALS 免费且逐场明细丰富，但**对局历史滞后**（实测该玩家滞后约 2 个月）；
   TRN 数据新，但免费档只给**会话级聚合**、没有逐场明细，且需要 Key。
   两者互补，所以先做事实核对，再决定用哪个。 */

/** 从 TRN 的 {value, displayValue} 包装里取裸值 */
const trnVal = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : null);

/**
 * TRN `/sessions` → 与 ALS 对局同构的条目，便于前端复用渲染。
 *
 * ⚠️ **TRN 给的是「会话级聚合」，不是逐场值。** 依据（实测，见
 *    `data/fixtures/trn-sessions.sample.json`）：
 *    · `items[].stats` 与 `items[].matches[].stats` **恒等**（allSame = true）；
 *    · 量级明显不是单场：单会话 254 杀 / 82,760 伤害；
 *    · `duration` 恒为 `"00:10:00"`，不可信。
 *    因此打上 `granularity: 'session'`，前端必须区别展示，**不要冒充逐场数据**。
 */
function normalizeTrnSessions(sessions) {
  // 兼容两种形状：tracker.gg 内部状态用 items[]，公开 API 历史上用过 segments[]
  const items = sessions?.data?.items ?? sessions?.data?.segments ?? [];
  return items.map((s, i) => {
    const m0 = s.matches?.[0] ?? null;
    const st = s.stats ?? m0?.stats ?? {};
    const start = s.metadata?.startDate?.value ?? null;
    /* ⚠️ **RP 优先取 match 级的**。会话级的 `stats.rankScore` 实测有脏值：
       同一个会话 match 级是 12410（Diamond 4），会话级却是 24055；
       另一个 match 级 11553（Platinum 1），会话级 57571。
       这类脏值会把 RP 走势图拉出一个尖峰，并让段位推导出错。
       kills/damage/wins 则相反 —— 会话级是时段合计、match 级常为 null，所以用会话级。 */
    const rp = trnVal(m0?.stats?.rankScore) ?? trnVal(st.rankScore);
    const rpChange = trnVal(m0?.stats?.rankScoreChange) ?? trnVal(st.rankScoreChange);
    /* 段位信息藏在 `stats.rankScore.metadata.rankScoreInfo` 里：
         { name: "Diamond 4", image: ".../ranks/diamond4.png", color: "#4DD0E1" }
       ⚠️ **只有 match 级有**（会话级的 metadata 是空的）。
          实测 87 个会话里 83 个能取到，4 个缺失 —— 所以要做兜底。 */
    const rankInfo = m0?.stats?.rankScore?.metadata?.rankScoreInfo
      ?? s.stats?.rankScore?.metadata?.rankScoreInfo
      ?? null;
    /* 排位 / 匹配：TRN 同样**不直接标注**。
       用「RP 是否变动」判断 —— 只有排位才会改变 RP。
       实测 `前值 + change == 当前值` 在 8/8 个非零样本上成立，
       证明 rankScoreChange 是真实增量。
       ⚠️ 但 `change === 0` 是**歧义**的：既可能是匹配（根本不涉及 RP），
          也可能是净变化为 0 的排位。所以只能标成「确定排位 / 未定」，
          不要反过来断言 chg==0 就是匹配。
          （87 个会话里 chg==0 有 35 个，占比 40% —— 从概率看多半是匹配，
            但这是统计推断，不作为确定结论。） */
    const playlist = rpChange == null ? null : rpChange !== 0 ? 'ranked' : 'unknown';
    return {
      source: 'trn',
      granularity: 'session',
      playlist,
      session: i,
      when: start,
      timestamp: start ? Math.floor(Date.parse(start) / 1000) : null,
      legend: m0?.metadata?.legend?.displayValue ?? m0?.metadata?.character?.displayValue ?? null,
      legendColor: m0?.metadata?.legendColor?.value ?? null,
      matchCount: s.matches?.length ?? 0,
      // ↓ 会话级聚合（不是逐场）
      level: trnVal(m0?.stats?.level),
      kills: trnVal(st.kills),
      damage: trnVal(st.damage),
      rp: trnVal(st.rankScore),
      rpChange,
      // 段位：名 + 徽章图 + 主题色（tracker.gg 的 CDN 直链）
      rankName: rankInfo?.name ?? null,
      rankImg: rankInfo?.image ?? null,
      rankColor: rankInfo?.color ?? null,
      wins: trnVal(st.wins),
      duration: null, // TRN 的 duration 恒为默认值，不采信
    };
  });
}

/** ALS 的等级是「等级 + 转生」两段，TRN 给的是绝对等级，需要对齐才可比。
 *  Prestige 2 + Lv147 → 147 + (2-1)*1000 = 1147，实测与 TRN 的 1,147 一致。 */
function alsAbsoluteLevel(record) {
  const lv = Number(String(record?.level ?? '').replace(/,/g, ''));
  if (!Number.isFinite(lv)) return null;
  const pn = Number(/(\d+)/.exec(String(record?.prestige ?? ''))?.[1]);
  return Number.isFinite(pn) && pn > 1 ? lv + (pn - 1) * 1000 : lv;
}

const toNumOrNull = (v) => {
  if (v == null || v === '') return null;
  const x = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
};

const DAY = 86_400;
const daysBetween = (a, b) => (a && b ? Math.round(Math.abs(a - b) / DAY) : null);

/**
 * 生成对比分析。只输出**能被证据支撑**的结论，缺数据就明确标注缺失。
 */
function buildComparison({ alsAgg, alsMatches, trnAgg, trnSessions, trnErr, trnSource, trnCollectedAt }) {
  const alsNewest = (alsMatches ?? []).reduce((a, m) => Math.max(a, m.timestamp ?? 0), 0) || null;
  const trnNewest = (trnSessions ?? []).reduce((a, s) => Math.max(a, s.timestamp ?? 0), 0) || null;
  const alsNew = alsNewest ? alsMatches.find((m) => m.timestamp === alsNewest) ?? null : null;
  const trnNew = trnNewest ? trnSessions.find((s) => s.timestamp === trnNewest) ?? null : null;

  /* 交叉验证：两个源都能给、且口径可对齐的字段 */
  const alsLevelAbs = alsAbsoluteLevel(alsAgg?.player);
    const trnLevel = (trnSessions ?? []).find((s) => s.level != null)?.level ?? null;
    const crossCheck = [
      {
        field: '当前 RP',
        als: toNumOrNull(alsAgg?.player?.rankScore),
        // 免 Key 抓网页时拿不到账号级 RP，用最新会话的 rankScore 代替
        trn: toNumOrNull(trnAgg?.player?.rankScore)
          ?? (trnSessions ?? []).find((s) => s.rp != null)?.rp ?? null,
        unit: 'RP',
      },
    {
      field: '等级（绝对值）',
      als: alsLevelAbs,
      trn: trnLevel,
      note: alsLevelAbs != null ? `ALS 原始：Lv${alsAgg.player.level} + ${alsAgg.player.prestige ?? '—'}` : null,
    },
  ].map((x) => ({ ...x, same: x.als != null && x.trn != null && x.als === x.trn }));

  /* 逐场明细的「首场英雄」对比 —— 这正是用户困惑的点 */
  const legendCheck = {
    als: alsNew ? { legend: alsNew.legend, at: alsNew.timestamp } : null,
    trn: trnNew ? { legend: trnNew.legend, at: trnNew.timestamp } : null,
  };

  /* 能力/粒度差异：说明为什么不能简单合并两个源 */
  const capabilities = [
    { item: '逐场明细（击杀/伤害/地图/时长）', als: true, trn: false },
    { item: '逐场 RP 变化', als: true, trn: false },
    { item: '会话级聚合', als: false, trn: true },
    { item: '对局新鲜度', als: false, trn: true },
    { item: '地图信息', als: true, trn: false },
    { item: '需要 API Key', als: false, trn: false, note: '抓网页即可，Key 仅是可选项' },
  ];

  const gapDays = daysBetween(alsNewest, trnNewest);

  return {
    generatedAt: new Date().toISOString(),
    trnError: trnErr ?? null,
    trnSource: trnSource ?? null,
    trnCollectedAt: trnCollectedAt ?? null,
    freshness: {
      als: alsNewest, trn: trnNewest, gapDays,
      alsNewestLegend: alsNew?.legend ?? null,
      trnNewestLegend: trnNew?.legend ?? null,
    },
    crossCheck,
    legendCheck,
    capabilities,
    coverage: {
      alsMatchCount: (alsMatches ?? []).length,
      trnSessionCount: (trnSessions ?? []).length,
      alsGranularity: 'match',
      trnGranularity: 'session',
    },
    /* 汇总结论（前端直接展示，避免各自解读） */
    verdict: buildVerdict({ gapDays, crossCheck, trnErr }),
  };
}

function buildVerdict({ gapDays, crossCheck, trnErr }) {
  if (trnErr) {
    return {
      level: 'warn',
      text: `TRN 数据不可用（${trnErr}），当前只能展示 ALS。` +
        (gapDays ? ` ALS 的对局历史比 TRN 旧约 ${gapDays} 天。` : ''),
    };
  }
  const mismatch = crossCheck.filter((c) => c.als != null && c.trn != null && !c.same);
  const same = crossCheck.filter((c) => c.same);
  const bits = [];
  if (gapDays != null && gapDays > 0) bits.push(`TRN 的对局比 ALS 新约 ${gapDays} 天`);
  if (same.length) bits.push(`${same.map((c) => c.field).join('、')}两源一致`);
  if (mismatch.length) bits.push(`${mismatch.map((c) => c.field).join('、')}两源不一致，需人工核对`);
  return {
    level: mismatch.length ? 'warn' : 'ok',
    text: bits.length ? bits.join('；') + '。' : '两源数据未发现冲突。',
  };
}

/** 每个传奇取一个「主指标」用于长期趋势。
 *  优先精确匹配 BR Kills（23/27 个传奇都有，是唯一可横向比较的指标）；
 *  没有的降级取其它指标，并标记 isKills=false，排行榜里不会混排。
 */
function legendPrimaryStats(legends) {
  const out = {};
  for (const l of legends ?? []) {
    if (l.legend === 'Global') continue;
    const entries = Object.entries(l.stats ?? {}).filter(([, v]) => v?.value != null);
    if (!entries.length) continue;
    const exact = entries.find(([k]) => k === 'BR Kills');
    const killsLike = entries.find(([k]) => /kill/i.test(k));
    const picked = exact ?? killsLike ?? entries[0];
    out[l.legend] = {
      label: decodeEntities(picked[0]),
      value: picked[1].value,
      isKills: picked[0] === 'BR Kills',
    };
  }
  return out;
}

const fmt = (v) => (v && typeof v === 'object' ? v.displayValue ?? String(v.value ?? '—') : v ?? '—');

const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

/** diamond4 → Diamond IV, apexpredator → Apex Predator */
function prettyTier(tier) {
  if (!tier) return '—';
  const m = tier.match(/^([a-z]+?)([1-4])$/);
  const base = (m ? m[1] : tier).replace(/([a-z])([A-Z])/g, '$1 $2');
  const name = base
    .replace(/apexpredator/i, 'Apex Predator')
    .replace(/^([a-z])/, (c) => c.toUpperCase());
  return m ? `${name} ${ROMAN[m[2]]}` : name;
}

function diff(label, prev, curr) {
  const p = typeof prev === 'object' ? prev?.value : prev;
  const c = typeof curr === 'object' ? curr?.value : curr;
  if (p == null || c == null || p === c) return null;
  const d = c - p;
  return `${d > 0 ? '📈' : '📉'} ${label}: ${p} → ${c} (${d > 0 ? '+' : ''}${d})`;
}

// ───────────────────── 快照清理 ─────────────────────

async function pruneSnapshots(outDir, days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const dir = path.join(outDir, 'snapshots');
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory() && s.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

// ───────────────────── Obsidian 笔记 ─────────────────────

/** xychart 需要至少 2 个点才有意义 */
function mermaidChart(title, labels, values, yLabel) {
  if (values.length < 2) return null;
  const min = Math.floor(Math.min(...values) * 0.98);
  const max = Math.ceil(Math.max(...values) * 1.02);
  return [
    '```mermaid',
    'xychart-beta',
    `    title "${title}"`,
    `    x-axis [${labels.map((l) => `"${l}"`).join(', ')}]`,
    `    y-axis "${yLabel}" ${min} --> ${max}`,
    `    line [${values.join(', ')}]`,
    '```',
  ].join('\n');
}

function recentRecords(history, limit) {
  return history.slice(-limit);
}

async function writeNote(notePath, { record, prev, history, snapDir, trackers }) {
  const recs = recentRecords(history, args.historyLimit);
  const labels = recs.map((r) => {
    const d = new Date(r.ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const rpSeries = recs.map((r) => r.rankScore).filter(Number.isFinite);
  const killSeries = recs.map((r) => r.global?.['Career Kills']?.value).filter(Number.isFinite);

  const L = [];
  L.push('---');
  L.push('tags:');
  L.push('  - apex');
  L.push('  - 战绩');
  L.push(`updated: ${new Date().toISOString()}`);
  L.push(`player: ${record.name ?? record.queried}`);
  L.push('---');
  L.push('');
  L.push(`# Apex 战绩 · ${record.name ?? record.queried}`);
  L.push('');
  L.push(`> 🤖 本文件由 \`track.mjs\` 自动生成，手动修改会在下次采集时被覆盖。`);
  L.push(`> 最后更新：**${fmtTime(record.ts)}**　·　共 ${history.length} 次采集`);
  L.push('');

  // ── 当前状态
  L.push('## 当前状态');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 玩家 | ${record.name ?? '—'} |`);
  if (record.uid) L.push(`| UID | \`${record.uid}\` |`);
  L.push(`| 平台 | ${record.platform} |`);
  L.push(`| 等级 | **${record.level ?? '—'}**${record.prestige ? `（${record.prestige}）` : ''} |`);
  L.push(
    `| 段位 | **${prettyTier(record.rankTier)}**${record.rankPercentile ? `　Top ${record.rankPercentile}%` : ''} |`
  );
  L.push(`| RP | **${record.rankScore?.toLocaleString('en-US') ?? '—'}** |`);
  if (trackers) L.push(`| 追踪器 | ${trackers} |`);
  L.push('');

  // ── 与上次对比
  if (prev) {
    const lines = [
      diff('等级', prev.level, record.level),
      diff('RP', prev.rankScore, record.rankScore),
      diff('Career Kills', prev.global?.['Career Kills'], record.global?.['Career Kills']),
      diff('Career Wins', prev.global?.['Career Wins'], record.global?.['Career Wins']),
    ].filter(Boolean);
    L.push('## 与上次对比');
    L.push('');
    if (lines.length) lines.forEach((x) => L.push(`- ${x}`));
    else L.push('- （无变化）');
    L.push('');
  }

  // ── 趋势
  L.push('## 趋势');
  L.push('');
  if (rpSeries.length >= 2) {
    L.push(`**RP**　\`${sparkline(rpSeries)}\`　${rpSeries.at(-1).toLocaleString('en-US')}`);
    L.push('');
    const c = mermaidChart('RP 走势', labels.slice(-rpSeries.length), rpSeries, 'RP');
    if (c) { L.push(c); L.push(''); }
  } else {
    L.push('_采集满 2 次后这里会出现 RP 走势图。_');
    L.push('');
  }
  if (killSeries.length >= 2) {
    L.push(`**Career Kills**　\`${sparkline(killSeries)}\`　${killSeries.at(-1).toLocaleString('en-US')}`);
    L.push('');
  }

  // ── 生涯数据
  if (record.global) {
    L.push('## 生涯数据');
    L.push('');
    L.push('| 指标 | 数值 | 服务器排名 |');
    L.push('| --- | ---: | --- |');
    for (const [k, v] of Object.entries(record.global)) {
      L.push(`| ${k} | ${v.displayValue} | ${v.percentile ? `Top ${v.percentile}%` : '—'} |`);
    }
    L.push('');
  }

  // ── 传奇击杀排行（只排 BR Kills，其余单独说明，避免不同单位混排）
  const lk = record.legendPrimaryStats;
  if (lk && Object.keys(lk).length) {
    const ranked = Object.entries(lk).filter(([, v]) => v.isKills).sort((a, b) => b[1].value - a[1].value);
    const others = Object.entries(lk).filter(([, v]) => !v.isKills);
    if (ranked.length) {
      L.push('## 传奇击杀排行');
      L.push('');
      L.push('| # | 传奇 | BR Kills |');
      L.push('| ---: | --- | ---: |');
      ranked.forEach(([name, v], i) => {
        L.push(`| ${i + 1} | ${name} | ${v.value.toLocaleString('en-US')} |`);
      });
      L.push('');
    }
    if (others.length) {
      L.push(`> 另有 ${others.length} 个传奇游戏内未挂 BR Kills 追踪器，无法与上面横向比较：`);
      L.push(`> ${others.map(([n, v]) => `${n}（${v.label} ${v.value.toLocaleString('en-US')}）`).join('　·　')}`);
      L.push('');
    }
  }

  // ── 最近记录
  L.push(`## 最近记录`);
  L.push('');
  L.push('| 时间 | 等级 | 段位 | RP | Top |');
  L.push('| --- | ---: | --- | ---: | --- |');
  for (const r of [...recs].reverse()) {
    L.push(
      `| ${fmtTime(r.ts)} | ${r.level ?? '—'} | ${prettyTier(r.rankTier)} | ${r.rankScore?.toLocaleString('en-US') ?? '—'} | ${r.rankPercentile ? r.rankPercentile + '%' : '—'} |`
    );
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(`_存档目录：\`${path.relative(process.cwd(), snapDir) || snapDir}\`_`);
  L.push('');

  await writeFile(notePath, L.join('\n'));
}

// ───────────────────── 自包含 HTML 报告 ─────────────────────

/** 手写 SVG 折线图 —— 零依赖、离线可用 */
function svgLineChart(points, { width = 760, height = 240, color = '#4f8cff', label = '' } = {}) {
  if (points.length < 2) return '';
  const pad = { t: 28, r: 20, b: 34, l: 64 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const xs = points.map((_, i) => pad.l + (i / (points.length - 1)) * iw);
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const lo = min - span * 0.1;
  const hi = max + span * 0.1;
  const ys = points.map((p) => pad.t + ih - ((p.v - lo) / (hi - lo)) * ih);

  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const area = `${line} L${xs.at(-1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${xs[0].toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = pad.t + ih * f;
    const val = Math.round(hi - (hi - lo) * f);
    return `<line x1="${pad.l}" y1="${y}" x2="${pad.l + iw}" y2="${y}" stroke="#ffffff14" stroke-width="1"/>
<text x="${pad.l - 10}" y="${y + 4}" fill="#8892a6" font-size="11" text-anchor="end">${val.toLocaleString('en-US')}</text>`;
  }).join('\n');

  const step = Math.max(1, Math.ceil(points.length / 6));
  const xLabels = points.map((p, i) => {
    if (i % step !== 0 && i !== points.length - 1) return '';
    return `<text x="${xs[i]}" y="${height - 12}" fill="#8892a6" font-size="11" text-anchor="middle">${p.t}</text>`;
  }).join('');

  const dots = points.map((p, i) =>
    `<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.5" fill="${color}"><title>${p.t}: ${p.v.toLocaleString('en-US')}</title></circle>`
  ).join('');

  const gid = `g${color.replace('#', '')}`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px">
<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${color}" stop-opacity="0.35"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
</linearGradient></defs>
<text x="${pad.l}" y="16" fill="#e6ebf5" font-size="13" font-weight="600">${label}</text>
${grid}
<path d="${area}" fill="url(#${gid})"/>
<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
${dots}${xLabels}
</svg>`;
}

async function writeReport(reportPath, { record, history, snapDir }) {
  const recs = history;
  const tsLabels = recs.map((r) => {
    const d = new Date(r.ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

  const rpPts = recs.map((r, i) => ({ t: tsLabels[i], v: r.rankScore })).filter((p) => Number.isFinite(p.v));
  const killPts = recs.map((r, i) => ({ t: tsLabels[i], v: r.global?.['Career Kills']?.value })).filter((p) => Number.isFinite(p.v));
  const winPts = recs.map((r, i) => ({ t: tsLabels[i], v: r.global?.['Career Wins']?.value })).filter((p) => Number.isFinite(p.v));

  const legendRanking = (() => {
    const last = record.legendPrimaryStats;
    if (!last) return [];
    // 只排 BR Kills —— 单位一致才有可比性
    return Object.entries(last)
      .filter(([, v]) => v.isKills)
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 12);
  })();
  const maxLegend = legendRanking[0]?.[1].value ?? 1;

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apex 战绩 · ${record.name ?? ''}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 24px;background:#0e1218;color:#e6ebf5;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:#8892a6;font-size:13px;margin-bottom:28px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:32px}
  .card{background:#161c26;border:1px solid #ffffff10;border-radius:12px;padding:16px}
  .card .k{color:#8892a6;font-size:12px;margin-bottom:6px}
  .card .v{font-size:22px;font-weight:650;letter-spacing:-.02em}
  .card .x{color:#6ee7a8;font-size:12px;margin-top:4px}
  section{background:#161c26;border:1px solid #ffffff10;border-radius:12px;padding:20px;margin-bottom:16px}
  h2{font-size:15px;margin:0 0 16px;color:#b9c2d4;font-weight:600}
  .bar{display:flex;align-items:center;gap:12px;margin-bottom:9px;font-size:13px}
  .bar .n{width:110px;color:#b9c2d4;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar .t{flex:1;height:8px;background:#ffffff0d;border-radius:4px;overflow:hidden}
  .bar .f{height:100%;background:linear-gradient(90deg,#4f8cff,#7c5cff);border-radius:4px}
  .bar .v{width:70px;text-align:right;font-variant-numeric:tabular-nums;color:#e6ebf5}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:#8892a6;font-weight:500;padding:6px 8px;border-bottom:1px solid #ffffff12}
  td{padding:6px 8px;border-bottom:1px solid #ffffff08;font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  .num{text-align:right}
  footer{color:#5c6678;font-size:12px;text-align:center;margin-top:28px}
</style></head><body><div class="wrap">
<h1>Apex 战绩 · ${record.name ?? record.queried ?? ''}</h1>
<div class="sub">更新于 ${fmtTime(record.ts)}　·　共 ${recs.length} 次采集　·　由 track.mjs 生成</div>

<div class="cards">
  <div class="card"><div class="k">等级</div><div class="v">${record.level ?? '—'}</div>${record.prestige ? `<div class="x">${record.prestige}</div>` : ''}</div>
  <div class="card"><div class="k">段位</div><div class="v" style="font-size:17px">${prettyTier(record.rankTier)}</div>${record.rankPercentile ? `<div class="x">Top ${record.rankPercentile}%</div>` : ''}</div>
  <div class="card"><div class="k">RP</div><div class="v">${record.rankScore?.toLocaleString('en-US') ?? '—'}</div></div>
  ${record.global?.['Career Kills'] ? `<div class="card"><div class="k">生涯击杀</div><div class="v">${record.global['Career Kills'].displayValue}</div>${record.global['Career Kills'].percentile ? `<div class="x">Top ${record.global['Career Kills'].percentile}%</div>` : ''}</div>` : ''}
</div>

<section><h2>RP 走势</h2>${svgLineChart(rpPts, { color: '#4f8cff', label: 'Rank Score' }) || '<div class="sub">数据点不足，再采集几次</div>'}</section>
<section><h2>生涯击杀</h2>${svgLineChart(killPts, { color: '#7c5cff', label: 'Career Kills' }) || '<div class="sub">数据点不足</div>'}</section>
<section><h2>生涯胜场</h2>${svgLineChart(winPts, { color: '#6ee7a8', label: 'Career Wins' }) || '<div class="sub">数据点不足</div>'}</section>

${legendRanking.length ? `<section><h2>传奇击杀排行 · Top ${legendRanking.length}</h2>
${legendRanking.map(([n, v]) => `<div class="bar"><span class="n">${n}</span><span class="t"><span class="f" style="width:${((v.value / maxLegend) * 100).toFixed(1)}%"></span></span><span class="v">${v.value.toLocaleString('en-US')}</span></div>`).join('\n')}
</section>` : ''}

<section><h2>最近记录</h2>
<table><thead><tr><th>时间</th><th class="num">等级</th><th>段位</th><th class="num">RP</th><th class="num">Top</th></tr></thead><tbody>
${[...recs].reverse().slice(0, 40).map((r) => `<tr><td>${fmtTime(r.ts)}</td><td class="num">${r.level ?? '—'}</td><td>${prettyTier(r.rankTier)}</td><td class="num">${r.rankScore?.toLocaleString('en-US') ?? '—'}</td><td class="num">${r.rankPercentile ? r.rankPercentile + '%' : '—'}</td></tr>`).join('\n')}
</tbody></table></section>

<footer>数据来源：Apex Legends Status 公开档案页　·　本地生成，无外部依赖</footer>
</div></body></html>`;

  await writeFile(reportPath, html);
}

// ───────────────────── 对局列表输出 ─────────────────────

/** Unix 秒 → "07-18 19:21" */
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 按「会话」分组打印对局，风格对齐 tracker.gg 的 Session Overview */
function printMatches(matches) {
  if (!matches.length) return;
  console.log(`\n─── 最近对局（${matches.length} 场）───`);

  const groups = new Map();
  for (const m of matches) {
    const key = `${m.split}#${m.session}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  for (const [, list] of groups) {
    const mins = Math.round(list.reduce((a, m) => a + (m.durationSec ?? 0), 0) / 60);
    const net = list.reduce((a, m) => a + (m.rpChange ?? 0), 0);
    const head = list[0].timestamp ? fmtTs(list[0].timestamp) : (list[0].when ?? list[0].split);
    console.log(`\n  ┌ ${head}　${list.length} 场　${mins} 分钟　净 RP ${net > 0 ? '+' + net : net}`);

    for (const m of list) {
      const chg = m.rpChange == null ? '  ·' : (m.rpChange > 0 ? `+${m.rpChange}` : `${m.rpChange}`).padStart(4);
      const s = m.stats ?? {};
      const pick = (re) => {
        const k = Object.keys(s).find((x) => re.test(x));
        return k ? s[k] : '—';
      };
      console.log(
        `  │ ${(m.legend ?? '?').padEnd(12)} ${String(m.mode ?? '').padEnd(4)} ${chg} RP ` +
          `${String(m.rp ?? '—').padStart(7)}  ${(m.duration ?? '').padEnd(8)} ` +
          `K ${pick(/^Kills$/i).padStart(3)}  D ${pick(/damage/i).padStart(7)}` +
          (m.map ? `  ${m.map}` : '')
      );
    }
  }
  console.log();
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  const save = !args.noSave; // 查询模式：完全不碰磁盘
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out);
  const snapDir = path.join(outDir, 'snapshots', stamp);
  if (save) await mkdir(snapDir, { recursive: true });

  let result;
  let matches = [];
  let compare = null;
  /* TRN 的会话（仅 `both` 模式填充）。代理 result 始终是 ALS —— 聚合数据以 ALS 为准：
     它来自游戏官方接口、实时，而 TRN 的聚合是它自己采集的。 */
  let trnSessions = null;
  let trnAgg = null;
  let trnSource = null; // 'page'（免 Key 抓网页）| 'api'（官方 API）| 'browser'（浏览器采集落盘）
  let trnCollectedAt = null;

  if (args.provider === 'both') {
    /* 聚合数据一律用 ALS —— 它来自游戏官方接口、实时且免费；
       TRN 的聚合是它自己采集的，不如 ALS 权威。
       **对局数据**则按 --matches-source 决定来源（默认 trn，因为 ALS 的对局历史滞后）。 */
    const { html, pageUrl, csrf, cookie } = await fetchAls(args);
    result = parseAls(html);

    const wantAlsMatches = args.matchesSource === 'als' || args.matchesSource === 'both';
    if (wantAlsMatches && args.matches > 0 && result.player.uid) {
      matches = await fetchMatches({
        profileHtml: html,
        uid: result.player.uid,
        name: args.name,
        platform: args.platform,
        pageUrl,
        cookie,
        limit: args.matches,
      }).catch(() => []);
    }

    let trnErr = null;
    /* 优先用**免 Key 的网页抓取**（只要 1 个请求）；
       只有在用户显式配了 TRN_API_KEY 时才走官方 API（结构更完整，多 2 个请求）。 */
    if (process.env.TRN_API_KEY) {
      try {
        trnAgg = await fetchTrn(args);
        trnSessions = normalizeTrnSessions(trnAgg.sessions);
        trnSource = 'api';
      } catch (e) {
        trnErr = `官方 API 失败（${e.message || e}），已回退到网页抓取`;
      }
    }
    if (!trnSessions || !trnSessions.length) {
      // ① 先试直接抓网页（若网络/CF 放行就能拿到最新）
      try {
        const page = await fetchTrnPage(args);
        trnSessions = normalizeTrnSessions(page.sessions);
        trnSource = 'page';
      } catch (e) {
        trnErr = (trnErr ? trnErr + '；' : '') + `网页抓取失败：${e.message || e}`;
      }
    }
    if (!trnSessions || !trnSessions.length) {
      // ② 回退到「浏览器采集落盘」的数据（免 Key 的可行通路，见 server.mjs）
      const local = await readTrnSessionsFile(args.out);
      if (local) {
        trnSessions = normalizeTrnSessions({ data: { items: local.items } });
        trnSource = 'browser';
        trnCollectedAt = local.collectedAt;
        trnErr = null; // 有可用数据就不算错误了
      }
    }
    compare = buildComparison({
      alsAgg: result, alsMatches: matches, trnAgg, trnSessions, trnErr, trnSource, trnCollectedAt,
    });

    if (save) {
      if (args.htmlRaw) await writeFile(path.join(snapDir, 'als.html'), html);
      else await writeFile(path.join(snapDir, 'als.html.gz'), gzipSync(html, { level: 9 }));
      if (matches.length) {
        await writeFile(path.join(snapDir, 'matches.json'), JSON.stringify(matches, null, 2));
      }
      if (trnSessions?.length) {
        await writeFile(path.join(snapDir, 'trn-sessions.json'), JSON.stringify(trnSessions, null, 2));
      }
      await writeFile(
        path.join(snapDir, 'meta.json'),
        JSON.stringify(
          {
            pageUrl,
            csrfTokenFingerprint: fingerprint(csrf),
            csrfTokenPresent: Boolean(csrf),
            queried: args.uid ?? args.name,
            platform: args.platform,
            provider: 'both',
            matchCount: matches.length,
            trnSessionCount: trnSessions?.length ?? 0,
            trnSource,
            trnError: trnErr,
          },
          null,
          2
        )
      );
    }
  } else if (args.provider === 'trn') {
    /* 只用 tracker.gg。**优先读浏览器采集落盘的数据** —— 这样：
         · 不需要 ALS（用户明确要求不用）
         · 不需要 TRN_API_KEY
         · 不联网、瞬时出结果（tracker.gg 有 Cloudflare，服务端也抓不到）
       只有本地没有数据时，才退回官方 API（需要 Key）。 */
    const local = await readTrnSessionsFile(args.out);
    if (local?.profile) {
      const built = buildFromTrn({
        profile: local.profile,
        sessions: local.items, // 原始会话数组 → 归一化为对局列表
        sessionItems: local.items, // 同一份，用于建立 RP→段位 的映射表
        seedPlayer: local.player,
      });
      result = {
        player: built.player,
        legends: built.legends,
        // Account 卡的「追踪器」栏：TRN 给的是当前传奇挂的追踪器名
        trackers: built.player.trackers,
        collectedAt: local.collectedAt,
      };
      // TRN 只有会话级聚合，交给 trnSessions（前端按会话渲染）
      trnSessions = built.sessions;
      trnSource = 'local';
      trnCollectedAt = local.collectedAt;
    } else if (local && !local.profile) {
      throw new Error(
        '本地 tracker.gg 数据缺少「账号档案」（profile），无法得到等级 / RP / 段位。\n' +
          '请在「数据对比」页用**新版采集脚本**重新采集一次（会同时发送 standardProfiles）。'
      );
    } else {
      throw new Error(
        '本地还没有 tracker.gg 数据。请到本项目的「数据对比」页签，\n' +
          '按指引在浏览器里做一次采集（免费、无需 API Key），然后再查询。'
      );
    }
  } else if (args.provider === 'als') {
    const { html, pageUrl, csrf, cookie } = await fetchAls(args);
    result = parseAls(html);
    // 对局历史（免费接口）：从最近赛季往前翻，凑够 args.matches 场
    if (args.matches > 0 && result.player.uid) {
      matches = await fetchMatches({
        profileHtml: html,
        uid: result.player.uid,
        name: args.name,
        platform: args.platform,
        pageUrl,
        cookie,
        limit: args.matches,
      }).catch(() => []); // 对局抓取失败不该让整次查询失败
    }
    // 原始 HTML 默认 gzip —— 230KB → 约 25KB，保留可回溯能力的同时省 90% 空间
    if (save) {
      if (args.htmlRaw) {
        await writeFile(path.join(snapDir, 'als.html'), html);
      } else {
        await writeFile(path.join(snapDir, 'als.html.gz'), gzipSync(html, { level: 9 }));
      }
      if (matches.length) {
        await writeFile(path.join(snapDir, 'matches.json'), JSON.stringify(matches, null, 2));
      }
      await writeFile(
        path.join(snapDir, 'meta.json'),
        JSON.stringify(
          {
            pageUrl,
            // 只存指纹，不落盘 token 原文
            csrfTokenFingerprint: fingerprint(csrf),
            csrfTokenPresent: Boolean(csrf),
            queried: args.uid ?? args.name,
            platform: args.platform,
            matchCount: matches.length,
          },
          null,
          2
        )
      );
    }
  } else {
    throw new Error(`未知 provider: ${args.provider}（可选 als | trn | both）`);
  }

  if (save) await writeFile(path.join(snapDir, 'parsed.json'), JSON.stringify(result, null, 2));

  const p = result.player;
  // ALS 的 legends 里混着一个 "Global" 聚合项，不算真实传奇
  const realLegends = (result.legends ?? []).filter((l) => l.legend !== 'Global');
  const record = {
    ts: new Date().toISOString(),
    provider: args.provider,
    queried: args.uid ?? args.name,
    platform: args.platform,
    name: p.name,
    uid: p.uid,
    level: p.level ?? null,
    prestige: p.prestige ?? null,
    rankScore: p.rankScore ?? null,
    rankTier: p.rankTier ?? null,
    rankPercentile: p.rankPercentile ?? null,
    /* tracker.gg 独有：段位徽章图与「是否精确」（段位名由会话映射推导还是阈值兜底） */
    rankTierImg: p.rankTierImg ?? null,
    rankTierExact: p.rankTierExact ?? null,
    peakRankScore: p.peakRankScore ?? null,
    lifetimePeakRankScore: p.lifetimePeakRankScore ?? null,
    global: result.legends?.find((l) => l.legend === 'Global')?.stats ?? null,
    legendCount: realLegends.length,
    legendPrimaryStats: legendPrimaryStats(result.legends),
    /* 按**当前日期**判断现在属于哪个赛季（动态值，不能靠对局数据反推 ——
       玩家可能一段时间没打）。同时与 tracker.gg 报的 currentSeason 交叉验证。 */
    seasonInfo: currentSeasonInfo(p.season),
  };

  // ── 查询模式：只吐 JSON，直接返回，什么都不写
  if (args.json) {
    console.log(
      JSON.stringify({
        ok: true,
        record,
        status: p.status ?? null,
        trackers: result.trackers ?? null,
        rankPosition: p.rankPosition ?? null,
        legends: realLegends.map((l) => ({ legend: l.legend, stats: l.stats })),
        matches,
        // 告诉调用方这两份数据各是什么、来自哪 —— 前端据此决定拿哪个渲染
        matchesSource: args.matchesSource,
        matchesGranularity: 'match',       // matches 恒为逐场（ALS）
        /* tracker.gg 独有、ALS 没有的字段（有就带上，前端可选用） */
        trn: trnSource
          ? {
              source: trnSource,           // 'local' | 'browser' | 'page' | 'api'
              collectedAt: trnCollectedAt,
              levelAbsolute: p.levelAbsolute ?? null,
              avatar: p.avatar ?? null,
              peakRankScore: p.peakRankScore ?? null,
              lifetimePeakRankScore: p.lifetimePeakRankScore ?? null,
              rankTierImg: p.rankTierImg ?? null,
              rankTierExact: p.rankTierExact ?? null,
              season: p.season ?? null,
              activeLegend: p.activeLegend ?? null,
            }
          : null,
        // TRN 的会话（会话级聚合，granularity:'session'）与跨源对比结果
        trnSessions,
        compare,
      })
    );
    return;
  }

  const histFile = path.join(outDir, 'history.jsonl');
  const history = [];
  let prev = null;
  if (save) {
    if (existsSync(histFile)) {
      for (const line of (await readFile(histFile, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          history.push(JSON.parse(line));
        } catch {}
      }
    }
    prev = history.at(-1) ?? null;
    history.push(record);
    await appendFile(histFile, JSON.stringify(record) + '\n');
  }

  // 生成笔记与报告
  let notePath = null;
  if (!args.noNote) {
    notePath = path.resolve(args.note);
    await writeNote(notePath, { record, prev, history, snapDir, trackers: result.trackers });
  }
  let reportPath = null;
  if (!args.noReport) {
    reportPath = path.resolve(args.report);
    await writeReport(reportPath, { record, history, snapDir });
  }

  // 清理旧快照
  let pruned = 0;
  if (args.prune != null) pruned = await pruneSnapshots(outDir, args.prune);

  if (args.quiet) {
    console.log(`${record.ts} ${record.name} Lv${record.level ?? '?'} ${record.rankScore ?? '?'}RP`);
    return;
  }

  console.log(`\n═══ Apex 战绩采集 (${args.provider}) ═══`);
  console.log(`玩家      ${record.name ?? record.queried}${record.uid ? `  [UID ${record.uid}]` : ''}`);
  console.log(`平台      ${record.platform}`);
  console.log(`等级      ${record.level ?? '—'}${p.prestige ? `  (${p.prestige})` : ''}`);
  console.log(
    `段位      ${prettyTier(record.rankTier)}  ${record.rankScore ?? '—'} RP${record.rankPercentile ? `  Top ${record.rankPercentile}%` : ''}`
  );
  if (p.status) console.log(`状态      ${p.status}`);
  if (result.trackers) console.log(`追踪器    ${result.trackers}`);

  const g = record.global;
  if (g) {
    console.log(`\n─── Global ───`);
    for (const [k, v] of Object.entries(g)) {
      console.log(`  ${k.padEnd(24)} ${String(v.displayValue).padStart(10)}${v.percentile ? `   Top ${v.percentile}%` : ''}`);
    }
  }
  if (realLegends.length) console.log(`\n传奇分段  ${realLegends.length} 个：${realLegends.map((l) => l.legend).join(', ')}`);

  if (matches.length) printMatches(matches.slice(0, 20));

  if (save) {
    if (prev) {
      const lines = [
        diff('等级', prev.level, record.level),
        diff('RP', prev.rankScore, record.rankScore),
        diff('Career Kills', prev.global?.['Career Kills'], record.global?.['Career Kills']),
      ].filter(Boolean);
      console.log(`\n─── 与上次对比（${prev.ts}）───`);
      console.log(lines.length ? lines.join('\n') : '（无变化）');
    } else {
      console.log(`\n（首次采集，已建立基线）`);
    }

    const rpSeries = history.map((r) => r.rankScore).filter(Number.isFinite);
    if (rpSeries.length >= 2) console.log(`\nRP 趋势   ${sparkline(rpSeries)}`);

    console.log(`\n存档  ${snapDir}`);
    console.log(`趋势  ${histFile}`);
    if (notePath) console.log(`笔记  ${notePath}`);
    if (reportPath) console.log(`报告  ${reportPath}`);
    if (pruned) console.log(`清理  已删除 ${pruned} 个过期快照`);
  }
  console.log();
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
});
