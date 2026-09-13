// 验证 extractInitialState：用真实结构的 state 造一个「像 tracker.gg 页面」的 HTML
// 重点测：300KB 级嵌套 JSON、字符串里含 {}、含转义引号、后面还有别的 script
import { readFileSync } from 'node:fs';

// 从 track.mjs 里取出两个函数（避免复制实现导致测试失真）
const src = readFileSync(new URL('../../track.mjs', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`未找到 ${name}`);
  // 不能用括号配对 —— 函数体内有字符串形式的 '{' / '}'（如 c === '{'）。
  // 改为找**行首的顶层 }**（函数体缩进，收尾的 } 在第 0 列）。
  const end = src.indexOf('\n}', i);
  if (end < 0) throw new Error(`${name} 未找到顶层收尾 }`);
  return src.slice(i, end + 2);
};
const extractInitialState = new Function(`${grab('extractInitialState')}; return extractInitialState;`)();

const fixture = JSON.parse(readFileSync(new URL('./trn-sessions.sample.json', import.meta.url), 'utf8'));
const state = { stats: { standardSessions: [fixture.data] }, titles: { currentTitleSlug: 'apex' } };

// 造 HTML：首屏状态 + 干扰内容（字符串里含花括号、转义引号、后续 script）
const asJson = JSON.stringify(state);
const noisy = `<!DOCTYPE html><html><head><title>x</title>
<script>window.__INITIAL_STATE__ = ${asJson};
// 干扰：字符串里含 {} 与转义引号
var tricky = "a { b } c \\"d\\" e";
</script>
<script>window.__OTHER__ = {"nested":{"deep":[1,2,3]}};</script>
</body></html>`;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  ✅', name, extra); pass++; }
  else { console.log('  ❌', name, extra); fail++; }
};

console.log('=== extractInitialState ===');
const got = extractInitialState(noisy);
check('能解析出对象', got && typeof got === 'object');
check('stats.standardSessions 可达', Array.isArray(got?.stats?.standardSessions));
check('items 数量 = 3', got?.stats?.standardSessions?.[0]?.items?.length === 3,
  `(实际 ${got?.stats?.standardSessions?.[0]?.items?.length})`);
check('首个会话英雄 = Octane',
  got?.stats?.standardSessions?.[0]?.items?.[0]?.matches?.[0]?.metadata?.legend?.displayValue === 'Octane');
check('顶点字段正确', got?.titles?.currentTitleSlug === 'apex');

// 负例
console.log('\n=== 边界 ===');
check('无状态段 → null', extractInitialState('<html><body>hi</body></html>') === null);
check('状态被截断 → null（不能抛出）', extractInitialState('window.__INITIAL_STATE__ = {"a":{"b":1') === null);
check('空字符串 → null', extractInitialState('') === null);

// 压力：真实规模（约 300KB）
console.log('\n=== 规模验证 ===');
const big = { stats: { standardSessions: [
  { items: Array.from({ length: 87 }, (_, i) => ({
    metadata: { startDate: { value: new Date(Date.UTC(2026, 8, 1, i)).toISOString() } },
    matches: [{ id: `m${i}`, metadata: { legend: { value: 9, displayValue: 'Octane' } },
      stats: { kills: { value: i * 3, displayValue: String(i * 3) } } }],
    stats: { kills: { value: i * 3, displayValue: String(i * 3) } },
  })) },
] } };
const bigHtml = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(big)};</script>`;
const t0 = Date.now();
const gotBig = extractInitialState(bigHtml);
const ms = Date.now() - t0;
check('大 payload 解析成功', gotBig?.stats?.standardSessions?.[0]?.items?.length === 87);
console.log(`  规模: HTML ${Math.round(bigHtml.length / 1024)}KB，耗时 ${ms}ms`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
