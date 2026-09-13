#!/usr/bin/env node
/**
 * Apex Legends 个人战绩采集器  v1.1
 *
 * 支持两个数据源：
 *   --provider als   默认。Apex Legends Status 公开档案页，**无需 API Key**，立刻可用
 *   --provider trn   Tracker Network 官方开发者 API，需要 TRN_API_KEY
 *
 * 用法：
 *   node track.mjs --name bluekinger
 *   node track.mjs --uid 1010918821212
 *   node track.mjs --name bluekinger --platform PS4
 *   TRN_API_KEY=xxx node track.mjs --provider trn --name bluekinger
 *
 * 常用参数：
 *   --name       EA ID（PC）/ PSN ID / Xbox Gamertag
 *   --uid        直接按 UID 查询，最稳定（改名不影响）
 *   --platform   PC | PS4 | X1   （Tracker.gg 用 origin | psn | xbl）
 *   --provider   als | trn
 *   --out        数据目录，默认 ./data
 *   --quiet      只输出一行摘要
 *
 * v1.1 新增：
 *   --note [路径]     生成/更新 Obsidian 笔记，默认 ./Apex 战绩.md
 *   --no-note         关闭笔记生成
 *   --report [路径]   生成自包含 HTML 图表，默认 ./apex-report.html
 *   --no-report       关闭 HTML 报告
 *   --html-raw        原始 HTML 以明文保存（默认 gzip 压缩，省 ~90% 空间）
 *   --prune <天数>    删除超过 N 天的旧快照目录
 *   --history <N>     笔记里展示最近 N 条记录，默认 30
 *
 * 数据落地：
 *   data/snapshots/<时间戳>/...     原始响应存档
 *   data/history.jsonl              每次运行一行摘要，可做趋势
 */

import { mkdir, writeFile, appendFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

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
    provider: 'als',
    out: './data',
    quiet: false,
    note: './Apex 战绩.md',
    noNote: false,
    report: null,
    noReport: false,
    htmlRaw: false,
    prune: null,
    historyLimit: 30,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') o.name = argv[++i];
    else if (a === '--uid') o.uid = argv[++i];
    else if (a === '--platform') o.platform = argv[++i];
    else if (a === '--provider') o.provider = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--note') { const r = optionalValue(argv, i, './Apex 战绩.md'); o.note = r.value; i += r.skip; }
    else if (a === '--no-note') o.noNote = true;
    else if (a === '--report') { const r = optionalValue(argv, i, './apex-report.html'); o.report = r.value; i += r.skip; }
    else if (a === '--no-report') o.noReport = true;
    else if (a === '--html-raw') o.htmlRaw = true;
    else if (a === '--prune') o.prune = Number(argv[++i]);
    else if (a === '--history') o.historyLimit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  // --report 未显式给出路径时，用默认路径
  if (!o.noReport && o.report === null) o.report = './apex-report.html';
  return o;
}

const args = parseArgs(process.argv);

if (args.help || (!args.name && !args.uid)) {
  console.log(`用法:
  node track.mjs --name <EA_ID>                     # ALS，无需 Key
  node track.mjs --uid <UID>                        # 最稳，改名不影响
  node track.mjs --provider trn --name <EA_ID>      # Tracker.gg，需 TRN_API_KEY

可选:
  --platform PC|PS4|X1     --out ./data       --quiet
  --note [路径]            生成 Obsidian 笔记（默认 ./Apex 战绩.md）
  --no-note                关闭笔记
  --report [路径]          生成 HTML 图表（默认 ./apex-report.html）
  --no-report              关闭报告
  --html-raw               原始 HTML 不压缩（默认 gzip）
  --prune <天数>           清理 N 天前的快照
  --history <N>            笔记里展示最近 N 条（默认 30）`);
  process.exit(args.help ? 0 : 1);
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// ───────────────────────── 工具 ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(2000 * i);
    }
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
  return { html, pageUrl, csrf: tok };
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

// ───────────────── Tracker Network（需 Key）─────────────────

const TRN_SLUG = { PC: 'origin', PS4: 'psn', X1: 'xbl' };

async function fetchTrn({ name, uid, platform }) {
  const key = process.env.TRN_API_KEY;
  if (!key) throw new Error('缺少 TRN_API_KEY 环境变量（https://tracker.gg/developers/apps）');
  const slug = TRN_SLUG[platform] ?? platform;
  const id = encodeURIComponent(uid ?? name);
  const base = `https://public-api.tracker.gg/v2/apex/standard/profile/${slug}/${id}`;
  const h = { 'TRN-Api-Key': key, Accept: 'application/json', 'User-Agent': UA };

  const get = async (u) => {
    const r = await fetchWithRetry(u, { headers: h });
    if (r.status === 401) throw new Error('401 API Key 无效或已被封禁');
    if (r.status === 404) throw new Error(`404 找不到玩家「${uid ?? name}」`);
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

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out);
  const snapDir = path.join(outDir, 'snapshots', stamp);
  await mkdir(snapDir, { recursive: true });

  let result;
  if (args.provider === 'trn') {
    result = await fetchTrn(args);
    await writeFile(path.join(snapDir, 'trn.json'), JSON.stringify(result.raw, null, 2));
  } else if (args.provider === 'als') {
    const { html, pageUrl, csrf } = await fetchAls(args);
    result = parseAls(html);
    // 原始 HTML 默认 gzip —— 230KB → 约 25KB，保留可回溯能力的同时省 90% 空间
    if (args.htmlRaw) {
      await writeFile(path.join(snapDir, 'als.html'), html);
    } else {
      await writeFile(path.join(snapDir, 'als.html.gz'), gzipSync(html, { level: 9 }));
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
        },
        null,
        2
      )
    );
  } else {
    throw new Error(`未知 provider: ${args.provider}（可选 als | trn）`);
  }

  await writeFile(path.join(snapDir, 'parsed.json'), JSON.stringify(result, null, 2));

  const p = result.player;
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
    global: result.legends?.find((l) => l.legend === 'Global')?.stats ?? null,
    legendCount: result.legends?.length ?? 0,
    legendPrimaryStats: legendPrimaryStats(result.legends),
  };

  const histFile = path.join(outDir, 'history.jsonl');
  const history = [];
  if (existsSync(histFile)) {
    for (const line of (await readFile(histFile, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        history.push(JSON.parse(line));
      } catch {}
    }
  }
  const prev = history.at(-1) ?? null;
  history.push(record);
  await appendFile(histFile, JSON.stringify(record) + '\n');

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
  if (result.legends?.length) console.log(`\n传奇分段  ${result.legends.length} 个：${result.legends.map((l) => l.legend).join(', ')}`);

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
  console.log();
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
});
