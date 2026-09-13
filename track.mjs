#!/usr/bin/env node
/**
 * Apex Legends 个人战绩采集器
 *
 * 支持两个数据源：
 *   --provider als   默认。Apex Legends Status 公开档案页，**无需 API Key**，立刻可用
 *   --provider trn   Tracker Network 官方开发者 API，需要 TRN_API_KEY
 *
 * 用法：
 *   node track.mjs --name bluekinger
 *   node track.mjs --uid 1010918821212
 *   node track.mjs --name bluekinger --platform psn
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
 * 数据落地：
 *   data/snapshots/<时间戳>/...     原始响应存档
 *   data/history.jsonl              每次运行一行摘要，可做趋势
 */

import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ───────────────────────── 参数 ─────────────────────────

function parseArgs(argv) {
  const o = { platform: 'PC', provider: 'als', out: './data', quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') o.name = argv[++i];
    else if (a === '--uid') o.uid = argv[++i];
    else if (a === '--platform') o.platform = argv[++i];
    else if (a === '--provider') o.provider = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const args = parseArgs(process.argv);

if (args.help || (!args.name && !args.uid)) {
  console.log(`用法:
  node track.mjs --name <EA_ID>                     # ALS，无需 Key
  node track.mjs --uid <UID>                        # 最稳，改名不影响
  node track.mjs --provider trn --name <EA_ID>      # Tracker.gg，需 TRN_API_KEY

可选: --platform PC|PS4|X1   --out ./data   --quiet`);
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
    pageHtml.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)/)?.[1] ?? 'CSRF_PRE_PROD';

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

// ───────────────────────── 输出 ─────────────────────────

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
    await writeFile(path.join(snapDir, 'als.html'), html);
    await writeFile(
      path.join(snapDir, 'meta.json'),
      JSON.stringify({ pageUrl, csrfTokenUsed: csrf, queried: args.uid ?? args.name, platform: args.platform }, null, 2)
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
    rankScore: p.rankScore ?? null,
    rankTier: p.rankTier ?? null,
    rankPercentile: p.rankPercentile ?? null,
    global: result.legends?.find((l) => l.legend === 'Global')?.stats ?? null,
    legendCount: result.legends?.length ?? 0,
  };

  const histFile = path.join(outDir, 'history.jsonl');
  let prev = null;
  if (existsSync(histFile)) {
    const lines = (await readFile(histFile, 'utf8')).trim().split('\n').filter(Boolean);
    if (lines.length) {
      try {
        prev = JSON.parse(lines[lines.length - 1]);
      } catch {}
    }
  }
  await appendFile(histFile, JSON.stringify(record) + '\n');

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
    const lines = [diff('等级', prev.level, record.level), diff('RP', prev.rankScore, record.rankScore)].filter(Boolean);
    console.log(`\n─── 与上次对比（${prev.ts}）───`);
    console.log(lines.length ? lines.join('\n') : '（无变化）');
  } else {
    console.log(`\n（首次采集，已建立基线）`);
  }

  console.log(`\n存档  ${snapDir}`);
  console.log(`趋势  ${histFile}\n`);
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
});
