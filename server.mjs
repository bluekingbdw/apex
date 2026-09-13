#!/usr/bin/env node
/**
 * Apex 战绩采集器 · 本地 Web 控制台  v1.0
 *
 * 一个零依赖的本地网页：查询战绩、看 RP 走势、按赛季筛选对局、触发 tracker.gg 采集。
 * 查询时后台调用 track.mjs（完整复用既有逻辑），所以 CLI 行为完全不受影响。
 *
 * 启动：
 *   node server.mjs
 *   浏览器打开  http://127.0.0.1:8787
 *
 * 环境变量：
 *   PORT                    端口，默认 8787
 *   HOST                    监听地址，默认 127.0.0.1（仅本机可访问）
 *   APEX_TRACK_TIMEOUT_MS   单次查询的硬超时，默认 60000（超时强杀子进程，保证 busy 释放）
 *
 * 接口：
 *   GET  /                    网页（单文件前端，含全部 CSS/JS）
 *   POST /api/query           { uid?, name?, platform?, matches?, provider?, matchesSource? }
 *                             → 查询战绩（走 --json --no-save，不写盘）
 *   GET  /api/history         读取 data/history.jsonl（本地存档记录）
 *   POST /api/collect         { uid?, name?, platform? } → 采集并存档
 *   POST /api/ingest/trn      接收浏览器在 tracker.gg 页面采集的数据
 *                             （免 Key 通路；body = { player, platform, data: { items, profile } }）
 *   GET  /api/trn-sessions    读回上面采集的数据
 *   GET  /apex-report.html    查看 track.mjs 生成的静态报告
 */

import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const TRACK = path.join(ROOT, 'track.mjs');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const TRN_FILE = path.join(DATA_DIR, 'trn-sessions.json');
const WEB_FILE = path.join(ROOT, 'web', 'index.html');

// ───────────────────────── 与 track.mjs 一致的小工具 ─────────────────────────

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

// ───────────────────────── HTTP 小工具 ─────────────────────────

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, obj) {
  // 服务只监听 127.0.0.1，所以放开 CORS 不会把接口暴露到局域网。
  // 之所以需要它：免 Key 采集要由**浏览器在 tracker.gg 页面上**把数据 POST 回来，
  // 那是跨源请求（https://apex.tracker.gg → http://127.0.0.1:8787）。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      // TRN 的原始页面数据可能好几 MB，采集接口单独放宽上限（见调用处）
      if (b.length > max) req.destroy();
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// ───────────────────────── 业务 ─────────────────────────

async function getHistory() {
  const history = [];
  if (existsSync(HISTORY_FILE)) {
    const txt = await readFile(HISTORY_FILE, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        r.tier = prettyTier(r.rankTier);
        history.push(r);
      } catch {}
    }
  }
  let snapshots = [];
  try {
    if (existsSync(SNAP_DIR)) snapshots = (await readdir(SNAP_DIR)).sort().reverse();
  } catch {}
  return { history, snapshots, count: history.length, player: history.at(-1) ?? null };
}

let busy = false;

/* ───────────────── TRN 浏览器采集：接收与读取 ─────────────────
   背景：tracker.gg 由 Cloudflare 防护，**服务端请求一律 403**（实测挑战页），
   只有真实浏览器能过。因此免 Key 的采集流程是：

     ① 浏览器打开 tracker.gg 的 matches 页（人已通过 Cloudflare 挑战）
     ② 在页面控制台跑一段脚本，把 __INITIAL_STATE__ 里的会话数据 POST 到这里
     ③ 本服务落盘到 data/trn-sessions.json
     ④ track.mjs 的 --provider both 在抓不到网页时读取它作为回退

   这样零依赖、无需 Key，也不在服务端做浏览器自动化。 */

/** 写入浏览器采集来的 TRN 会话数据 */
async function ingestTrn(payload) {
  const items = payload?.data?.items ?? payload?.items;
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: '缺少 data.items（应为 tracker.gg 的 standardSessions[0].items）' };
  }
  /* profiles：tracker.gg 的 standardProfiles[0]，含聚合战绩 + 传奇分段。
     有了它，本项目的**全部数据来源都只需 tracker.gg**，不必再依赖 ALS。
     注意它在 data.profile 下（与 data.items 同级），也兼容顶层写法。 */
  const profile = payload?.data?.profile ?? payload?.profile ?? null;
  if (!profile) {
    // 不报错，只是没有聚合数据 —— 前端会提示重新采集
    console.warn('[ingest] 未收到 profile，聚合数据将缺失（请用新版采集脚本重新采集）');
  }
  const rec = {
    player: String(payload.player ?? '').trim() || null,
    platform: String(payload.platform ?? '').trim() || null,
    source: 'browser-scrape',
    sourceUrl: payload.sourceUrl ?? null,
    collectedAt: new Date().toISOString(),
    sessionCount: items.length,
    hasProfile: Boolean(profile),
    data: { items, profile },
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TRN_FILE, JSON.stringify(rec, null, 2));

  // 摘要：最新会话的时间与英雄，便于前端立刻反馈
  const first = items[0];
  const pv = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : null);
  // legend 的 value 是数字 ID，名字在 displayValue —— 摘要要用名字
  const legendName = (m) => m?.metadata?.legend?.displayValue ?? m?.metadata?.character?.displayValue ?? null;
  const segs = profile?.segments ?? [];
  const overview = segs.find((s) => s.type === 'overview');
  return {
    ok: true,
    player: rec.player,
    platform: rec.platform,
    sessionCount: rec.sessionCount,
    newest: pv(first?.metadata?.startDate),
    newestLegend: legendName(first?.matches?.[0]),
    hasProfile: rec.hasProfile,
    level: pv(overview?.stats?.level),
    legendCount: segs.filter((s) => s.type === 'legend').length,
    file: 'data/trn-sessions.json',
  };
}

/** 读回已采集的 TRN 会话数据 */
async function readTrnSessions() {
  if (!existsSync(TRN_FILE)) {
    return { ok: true, present: false, data: null };
  }
  try {
    const rec = JSON.parse(await readFile(TRN_FILE, 'utf8'));
    return { ok: true, present: true, ...rec };
  } catch (e) {
    return { ok: false, error: `读取失败：${e?.message ?? e}` };
  }
}

/** 跑一次 track.mjs，把 stdout/stderr 和退出码带回来。
 *
 *  ⚠️ **必须带硬超时**：track.mjs 要访问外网，网络不通时它会重试若干次，
 *  一次查询可能卡好几分钟；而 `busy` 标志在此期间一直是 true，
 *  后续查询全部被「上一个查询还在进行中」挡住（实测踩到过）。
 *  超时后强杀子进程，保证 busy 一定会释放。 */
const TRACK_TIMEOUT_MS = Number(process.env.APEX_TRACK_TIMEOUT_MS) || 60_000;

function runTrack(extraArgs, timeoutMs = TRACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TRACK, ...extraArgs], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({
        code: -1,
        stdout,
        stderr: `${stderr}\n（超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已终止。通常是网络不通或被限流）`.trim(),
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ code: -1, stdout, stderr: String(e.message) }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** 查询模式：--json --no-save，不写任何文件，直接把战绩 JSON 返回 */
async function query({ uid, name, platform, matches, provider, matchesSource }) {
  if (busy) return { ok: false, error: '上一个查询还在进行中，请稍候…' };

  const cleanUid = String(uid ?? '').trim();
  const cleanName = String(name ?? '').trim();
  if (!cleanUid && !cleanName) return { ok: false, error: '请填写 UID 或玩家名' };

  const argv = ['--json', '--no-save'];
  if (cleanUid) argv.push('--uid', cleanUid);
  else argv.push('--name', cleanName);
  if (platform && platform !== 'PC') argv.push('--platform', platform);
  // 数据源：als（默认）/ trn / both。both = ALS 聚合 + TRN 对局 + 交叉对比。
  // TRN 需要 TRN_API_KEY；缺 Key 时 track.mjs 会降级为纯 ALS 并在 compare 里说明。
  if (provider === 'trn' || provider === 'both') argv.push('--provider', provider);
  // 对局来源：trn（默认，最新）/ als（滞后但有逐场明细）/ both
  if (['trn', 'als', 'both'].includes(matchesSource)) argv.push('--matches-source', matchesSource);

  // 对局记录：额外的若干请求，按需开启。
  // 注意这里只是**单次查询的上限**，不是对局总数的上限；
  // 想要全部历史就走 `--matches all`（CLI 直接调，或将来接数据库的采集任务）。
  const n = Number(matches);
  if (matches === 'all') argv.push('--matches', 'all');
  else if (Number.isFinite(n) && n > 0) argv.push('--matches', String(Math.min(n, 2000)));

  busy = true;
  try {
    const r = await runTrack(argv);
    const line = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    if (r.code !== 0 || !line) {
      return { ok: false, error: (r.stderr || r.stdout || '查询失败').replace(/^❌\s*/, '').trim() };
    }
    try {
      const data = JSON.parse(line);
      // 补一个人类可读的段位（diamond4 → Diamond IV），前端直接用
      if (data?.record) data.record.tier = prettyTier(data.record.rankTier);
      return data;
    } catch {
      return { ok: false, error: `无法解析返回结果：${line.slice(0, 200)}` };
    }
  } finally {
    busy = false;
  }
}

/** 采集模式：完整跑一遍，落盘 + 生成笔记/报告（可选功能） */
async function collect({ uid, name, platform }) {
  if (busy) return { ok: false, error: '已有一次采集正在进行，请稍候…' };

  const cleanUid = String(uid ?? '').trim();
  const cleanName = String(name ?? '').trim();
  if (!cleanUid && !cleanName) return { ok: false, error: '请填写 UID 或玩家名' };

  const argv = [];
  if (cleanUid) argv.push('--uid', cleanUid);
  else argv.push('--name', cleanName);
  if (platform && platform !== 'PC') argv.push('--platform', platform);

  busy = true;
  try {
    const r = await runTrack(argv);
    const { history } = await getHistory();
    return {
      ok: r.code === 0,
      code: r.code,
      stdout: r.stdout.trim(),
      stderr: r.stderr.trim(),
      record: history.at(-1) ?? null,
      count: history.length,
    };
  } finally {
    busy = false;
  }
}

// ───────────────────────── 路由 ─────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    // CORS 预检：浏览器在 tracker.gg 页面里跨源 POST 前会先发 OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!existsSync(WEB_FILE)) return send(res, 500, '缺少 web/index.html');
      return send(res, 200, await readFile(WEB_FILE, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      return sendJson(res, 200, await getHistory());
    }

    if (req.method === 'GET' && url.pathname === '/apex-report.html') {
      const f = path.join(ROOT, 'apex-report.html');
      if (!existsSync(f)) return send(res, 404, '还没生成报告，先采集一次');
      return send(res, 200, await readFile(f, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/query') {
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {}
      return sendJson(res, 200, await query(payload));
    }

    if (req.method === 'POST' && url.pathname === '/api/collect') {
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {}
      return sendJson(res, 200, await collect(payload));
    }

    /* ── TRN 数据接收（免 Key 的采集通路）──
       为什么需要它：tracker.gg 全站由 Cloudflare 防护，
       **服务端裸请求一律 403**（实测「Just a moment...」挑战页 / You've Been Blocked），
       只有真实浏览器能过挑战。所以采集由**浏览器**完成：
       在 tracker.gg 页面里跑一段脚本，把页面已渲染好的数据 POST 到这里落盘。
       这样既不需要 API Key，也不需要在服务端做浏览器自动化（保住零依赖）。 */
    if (req.method === 'POST' && url.pathname === '/api/ingest/trn') {
      let payload = {};
      try {
        // 原始页面数据可能好几 MB（87 个会话实测 ~200KB，但不同玩家会更多）
        payload = JSON.parse((await readBody(req, 16_000_000)) || '{}');
      } catch {}
      return sendJson(res, 200, await ingestTrn(payload));
    }

    if (req.method === 'GET' && url.pathname === '/api/trn-sessions') {
      return sendJson(res, 200, await readTrnSessions());
    }

    send(res, 404, 'Not Found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🏔  Apex 战绩查询已启动`);
  console.log(`    打开  http://${HOST}:${PORT}\n`);
  console.log(`    停止服务  Ctrl+C\n`);
});
