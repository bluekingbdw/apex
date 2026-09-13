// 离线验证 ALS parseGameHistory 的排位/匹配分类（playlist）
// 做法：用结构忠实的 fixture 生成「像 ALS 返回的 HTML」，再喂给 track.mjs 里的真实函数。
// 好处：不依赖网络（ALS 经常连不上），且测的是**真实实现**而不是副本。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../track.mjs', import.meta.url), 'utf8');

// 取顶层函数/常量（函数体的收尾 } 在第 0 列）
const grabFn = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`未找到 function ${name}`);
  const end = src.indexOf('\n}', i);
  if (end < 0) throw new Error(`${name} 未找到顶层收尾 }`);
  return src.slice(i, end + 2);
};
const grabConst = (name) => {
  const i = src.indexOf(`const ${name} =`);
  if (i < 0) throw new Error(`未找到 const ${name}`);
  const end = src.indexOf('\n', i);
  return src.slice(i, end);
};

const deps = [
  grabFn('parseGameHistory'),
  grabFn('durToSec'),
  grabFn('num'),
  grabConst('KNOWN_MODES'),
  /* ⚠️ parseGameHistory 现在会查 SEASON_STARTS 标注赛季。
     它是个多行数组常量，grabConst 只取单行会截断 → 单独处理。 */
  (() => {
    const a = src.indexOf('const SEASONS = [');
    const b = src.indexOf('];', a) + 2;
    const c = src.indexOf('const SEASON_STARTS =');
    const d = src.indexOf('\n', c);
    return src.slice(a, b) + '\n' + src.slice(c, d);
  })(),
].join('\n');

const parseGameHistory = new Function(`${deps}\nreturn parseGameHistory;`)();

// ── 用 fixture 生成「像 ALS 的 HTML」──────────────────────────
const fx = JSON.parse(readFileSync(new URL('./als-gamehistory.sample.json', import.meta.url), 'utf8'));

const gameBlock = (g) => {
  const bolds = [`<span style="font-weight: bold; color: white;">${g.legend}</span>`];
  if (g.boldExtra) bolds.push(`<span style="font-weight: bold; color: white;">${g.boldExtra}</span>`);
  const chg = g.rpChange
    ? `<span style="color: ${g.rpChange.split(':')[0]};">${g.rpChange.startsWith('green') ? '▲' : '▼'}</span>${g.rpChange.split(':')[1]}`
    : '';
  /* ⚠️ 结构与真实 HTML 对齐的两处关键点（第一版 fixture 写错了，导致 3 条断言误报）：
     ① rank 的路径必须含 `ranks/`（正则就是 `ranks\/([a-z0-9]+)\.png`），
        写成 `ranks-new/` 匹配不上。
     ② `Map played` / `Level` 来自**详情块**（紧跟 game 行、以 `<div id="MMv2-` 开头），
        不是 game 块本身。parseGameHistory 会先用这个 id 把详情块切出来。 */
  return `<div class="row equal v2-mh-session__game">
    <div>${bolds.join('')}${chg}</div>
    <div>${g.lasted ? `Lasted ${g.lasted}` : ''}</div>
    ${g.rank ? `<img src="/assets/ranks/${g.rank}.png" />` : ''}
    <div>${g.rp ? `${g.rp} RP` : ''}</div>
    ${g.gameMode ? `<p style="font-weight: bold;">Game mode</p><p style="">${g.gameMode}</p>` : ''}
  </div>
  <div id="MMv2-${g.legend}-${g.rank ?? 'none'}">
    <p style="font-weight: bold;">Map played</p><p style="">${g.map}</p>
    <p style="font-weight: bold;">Level</p><p style="">${g.level}</p>
  </div>`;
};

const html = `<div class="v2-mh-session">
  <p style="font-weight: bold;">Game session</p><p style="">${fx.sessionWhen}</p>
  ${fx.games.map(gameBlock).join('\n')}
</div>`;

// ── 断言 ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  ✅', name, extra); pass++; }
  else { console.log('  ❌', name, extra); fail++; }
};

console.log('=== parseGameHistory 解析 ===');
const out = parseGameHistory(html, fx.split);
check('解析出全部对局', out.length === fx.games.length, `(实际 ${out.length})`);

console.log('\n=== 逐场分类（核心）===');
fx.games.forEach((g, i) => {
  const got = out[i];
  if (!got) { check(`${g.legend} 存在`, false); return; }
  check(
    `${g.legend.padEnd(10)} → ${g.expectPlaylist}`,
    got.playlist === g.expectPlaylist,
    `(实际 ${got.playlist}; rp=${got.rp}, mode=${JSON.stringify(got.mode)})`
  );
});

console.log('\n=== 不变的交叉规则：有 RP ⟺ ranked ⟺ bold 含 BR ===');
const okInv = out.every((m) => (m.playlist === 'ranked') === (m.rp != null));
check('playlist 与「有 RP」一致', okInv, `(${out.filter((m) => m.playlist === 'ranked').length}/${out.length} 为排位)`);

console.log('\n=== 分布汇总 ===');
const c = {};
out.forEach((m) => { c[m.playlist] = (c[m.playlist] || 0) + 1; });
console.log('  ', JSON.stringify(c));

console.log('\n=== 其他字段未被破坏 ===');
check('legend 正确', out[0].legend === 'Valkyrie');
check('duration 正确', out[0].duration === '16m 9s');
check('durationSec 正确', out[0].durationSec === 969);
check('rank 正确', out[0].rank === 'diamond4');
check('rpChange 正负正确', out[0].rpChange === 64 && out[2].rpChange === -43);
check('map 正确', out[0].map === 'Storm Point');
check('level 正确', out[0].level === 1110);
check('mode 保留（BR）', out[0].mode === 'BR');
check('匹配场 mode 回落', out[1].mode === 'Battle Royale');

console.log('\n=== 赛季标注（新功能）===');
// fixture 的 split 是 s29_s2
check('season 解析自 split', out[0].season === 29, `(实际 ${out[0].season})`);
check('seasonSplit 解析自 split', out[0].seasonSplit === 2, `(实际 ${out[0].seasonSplit})`);
check('seasonName 来自内置赛季表', out[0].seasonName === '超频风暴', `(实际 ${out[0].seasonName})`);
check('seasonStart 来自内置赛季表', out[0].seasonStart === '2026-05-06', `(实际 ${out[0].seasonStart})`);
check('全部对局都标了赛季', out.every((m) => m.season === 29));

console.log('\n=== 边界：空/无对局 ===');
check('空字符串 → []', parseGameHistory('', 's1_s1').length === 0);
check('无对局提示 → []', parseGameHistory('no games have been recorded', 's1_s1').length === 0);
check('未知 split → season 为 null', (() => {
  const h = html.replace(/s29_s2/g, 'sX_sY');
  return parseGameHistory(h, 'sX_sY')[0]?.season === null;
})());

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
