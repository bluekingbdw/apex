// 离线验证 normalizeTrnSessions 的排位/匹配分类（用真实落盘的 data/trn-sessions.json）
// 从 track.mjs 里抽取真实实现，避免测「副本」而非「代码」
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../track.mjs', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`未找到 ${name}`);
  const end = src.indexOf('\n}', i);
  if (end < 0) throw new Error(`${name} 未找到顶层收尾 }`);
  return src.slice(i, end + 2);
};
const normalizeTrnSessions = new Function(
  `${grab('normalizeTrnSessions')}\nconst trnVal=(o)=>(o&&typeof o==='object'&&'value' in o?o.value:null);\nreturn normalizeTrnSessions;`
)();

const rec = JSON.parse(readFileSync(new URL('../../data/trn-sessions.json', import.meta.url), 'utf8'));
const norm = normalizeTrnSessions({ data: { items: rec.data.items } });

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  ✅', name, extra); pass++; }
  else { console.log('  ❌', name, extra); fail++; }
};

console.log('=== 基本信息 ===');
check('会话数 = 87', norm.length === 87, `(实际 ${norm.length})`);
check('全部标记 granularity=session', norm.every((s) => s.granularity === 'session'));
check('duration 全部弃用(null)', norm.every((s) => s.duration === null));

console.log('\n=== 排位/匹配分类 ===');
const byPl = {};
norm.forEach((s) => { byPl[s.playlist ?? '(null)'] = (byPl[s.playlist ?? '(null)'] || 0) + 1; });
console.log('  分布:', JSON.stringify(byPl));
check('分类取值只在 {ranked, unknown} 内',
  norm.every((s) => ['ranked', 'unknown'].includes(s.playlist)),
  `(实际 ${[...new Set(norm.map((s) => s.playlist))].join(',')})`);

// 核心不变式：playlist 必须与 rpChange 一致
const mismatch = norm.filter((s) =>
  (s.playlist === 'ranked') !== (s.rpChange != null && s.rpChange !== 0));
check('playlist 与 rpChange 严格一致', mismatch.length === 0, `(不一致 ${mismatch.length})`);

// ranked 一律有非零 RP 变动
const ranked = norm.filter((s) => s.playlist === 'ranked');
check('ranked 均有非零 rpChange', ranked.every((s) => s.rpChange !== 0), `(${ranked.length} 个)`);

// unknown 一律 rpChange === 0
const unknown = norm.filter((s) => s.playlist === 'unknown');
check('unknown 一律 rpChange === 0', unknown.every((s) => s.rpChange === 0), `(${unknown.length} 个)`);

console.log('\n=== 抽样（ranked）===');
ranked.slice(0, 5).forEach((s) => console.log(`  ${s.legend.padEnd(12)} chg=${String(s.rpChange).padStart(5)} rp=${s.rp} kills=${s.kills}`));
console.log('=== 抽样（unknown / 疑似匹配）===');
unknown.slice(0, 5).forEach((s) => console.log(`  ${s.legend.padEnd(12)} chg=${String(s.rpChange).padStart(5)} rp=${s.rp} kills=${s.kills}`));

console.log('\n=== 边界用例（构造）===');
const mk = (chg) => ({ metadata: { startDate: { value: '2026-01-01T00:00:00Z' } },
  matches: [{ metadata: { legend: { displayValue: 'Wraith' } }, stats: { level: { value: 1 }, rankScore: { value: 100 } } }],
  stats: { rankScoreChange: { value: chg } } });
const cases = [
  ['chg>0 → ranked', normalizeTrnSessions({ data: { items: [mk(50)] } })[0].playlist, 'ranked'],
  ['chg<0 → ranked', normalizeTrnSessions({ data: { items: [mk(-50)] } })[0].playlist, 'ranked'],
  ['chg=0 → unknown', normalizeTrnSessions({ data: { items: [mk(0)] } })[0].playlist, 'unknown'],
  ['chg 缺失 → null', normalizeTrnSessions({ data: { items: [{ metadata: {}, matches: [], stats: {} }] } })[0].playlist, null],
];
for (const [name, got, want] of cases) {
  check(name, got === want, `(得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)})`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
