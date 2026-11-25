/**
 * 输出国家组 UI 回归（v2.48.2）：
 * - 默认排序：锁定置顶 → 可进配置 → 地区未启用/手动移出 → 已抛弃
 * - 弹窗：显示全部已知国家在搜索框之前，文字在前、复选框在后
 * - 复选框固定 16px（不再被全局 input{width:100%} 撑满），国家名占剩余宽度
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeAll } from 'vitest';

let source = '';
let generated = '';

function sliceFunction(name: string): string {
  const anchor = 'function ' + name + '(';
  const from = source.indexOf(anchor);
  if (from < 0) throw new Error('MISSING ' + name);
  const brace = source.indexOf('{', from);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error('UNBALANCED ' + name);
}

beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
  generated = readFileSync(resolve(process.cwd(), 'src/html.js'), 'utf8');
});

describe('节点默认排序', () => {
  it('锁定 → 可进配置 → 地区未启用/移出 → 已抛弃', () => {
    const sandbox: Record<string, unknown> = { nodeLatency: () => 10 };
    vm.createContext(sandbox);
    vm.runInContext(
      sliceFunction('nodeSortRank') + '\n' + sliceFunction('defaultNodeOrder') + '\n',
      sandbox
    );
    const compare = sandbox.defaultNodeOrder as (a: unknown, b: unknown) => number;
    const nodes = [
      { name: 'dropped', locked: false, dropped: true, countryExcluded: false, excluded: false },
      { name: 'country', locked: false, dropped: false, countryExcluded: true, excluded: false },
      { name: 'eligible', locked: false, dropped: false, countryExcluded: false, excluded: false },
      { name: 'locked', locked: true, dropped: true, countryExcluded: true, excluded: false },
      { name: 'manual', locked: false, dropped: false, countryExcluded: false, excluded: true },
    ];
    const sorted = [...nodes].sort(compare).map((n) => n.name);

    // 锁定恒置顶
    expect(sorted[0]).toBe('locked');
    // 可进配置在「地区未启用 / 手动移出」之前
    expect(sorted.indexOf('eligible')).toBeLessThan(sorted.indexOf('country'));
    expect(sorted.indexOf('eligible')).toBeLessThan(sorted.indexOf('manual'));
    // 已抛弃恒在最后
    expect(sorted[sorted.length - 1]).toBe('dropped');
    // 地区未启用/移出也在已抛弃之前
    expect(sorted.indexOf('country')).toBeLessThan(sorted.indexOf('dropped'));
    expect(sorted.indexOf('manual')).toBeLessThan(sorted.indexOf('dropped'));
  });
});

describe('国家组弹窗排版', () => {
  it('「显示全部已知国家」在搜索框之前，且文字在前、复选框在后', () => {
    const showAllIdx = source.indexOf('class="country-group-showall"');
    const searchIdx = source.indexOf('id="countryGroupSearch"');
    expect(showAllIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(showAllIdx).toBeLessThan(searchIdx);

    const labelStart = source.lastIndexOf('<label', showAllIdx);
    const labelEnd = source.indexOf('</label>', showAllIdx);
    const block = source.slice(labelStart, labelEnd);
    expect(block.indexOf('显示全部已知国家')).toBeLessThan(block.indexOf('<input'));
  });

  it('复选框固定 16px，国家名占剩余宽度', () => {
    expect(source).toMatch(/#countryGroupsModal input\[type="checkbox"\]\s*\{[^}]*width:\s*16px/);
    expect(source).toMatch(/\.country-group-name\s*\{[^}]*flex:\s*1 1 auto/);
    expect(source).toMatch(/\.country-group-count\s*\{[^}]*margin-left:\s*auto/);
    // 行模板使用新 class，不再用内联 flex 样式
    expect(source).toContain('class="country-group-row"');
  });

  it('生成物 src/html.js 与源码同步', () => {
    for (const marker of ['country-group-showall', 'country-group-row', 'nodeSortRank']) {
      expect(generated).toContain(marker);
    }
  });
});
