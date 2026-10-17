/**
 * v2.38.5 回归：任务窗口的结果渲染必须「任务类型 → 对应渲染器」，且国家码结果展示真实数据。
 *
 * 做法：直接从 public/index.html 抽出真实渲染函数（不是复制一份假实现），在 vm 中执行，
 * 断言渲染结果 —— 保证测试覆盖的是真正上线的那份代码。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeAll } from 'vitest';

type Renderer = (res: unknown) => string;

let source = '';
let renderGeoResult: Renderer;
let renderProbeResult: Renderer;

/** 取包含 marker 的那一行 */
function lineOf(marker: string): string {
  const i = source.indexOf(marker);
  if (i < 0) throw new Error('未找到：' + marker);
  const j = source.indexOf('\n', i);
  return source.slice(i, j);
}

/** 取某行内容作为渲染结果中「某个标签对应的值单元格」 */
function cellOf(out: string, label: string): string | null {
  const re = new RegExp('<div class="task-result-row"><span>' + label + '</span><span>([\\s\\S]*?)</span></div>');
  const m = out.match(re);
  return m ? m[1] : null;
}

function labelsOf(out: string): string[] {
  return Array.from(out.matchAll(/<div class="task-result-row"><span>([^<]*)<\/span>/g)).map((m) => m[1]);
}

beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
  const escHtml = lineOf('function escHtml');
  const start = source.indexOf('function taskNum');
  const end = source.indexOf('/** 失败说明');
  if (start < 0 || end < 0 || end <= start) throw new Error('渲染函数区段定位失败');
  const block = source.slice(start, end);

  const sandbox: Record<string, unknown> = { console };
  vm.createContext(sandbox);
  vm.runInContext(escHtml + '\n' + block + '\n', sandbox);
  renderGeoResult = sandbox.renderGeoResult as Renderer;
  renderProbeResult = sandbox.renderProbeResult as Renderer;
  if (typeof renderGeoResult !== 'function' || typeof renderProbeResult !== 'function') {
    throw new Error('渲染函数未能从页面中加载');
  }
});

describe('国家码检测结果渲染（真实业务数据）', () => {
  // 一次真实检测的返回（结构取自 POST /api/nodes/geo-redetect）
  const realPayload = {
    success: true,
    data: {
      serverTotal: 12,
      targets: 5,
      total: 5,
      cached: 2,
      queried: 3,
      resolved: 4,
      failed: 1,
      unresolved: 0,
      unlocatedBefore: 5,
      unlocatedAfter: 1,
      unlocatedServers: ['203.0.113.9'],
    },
  };

  it('展示服务器级与检测级两组真实数据', () => {
    const out = renderGeoResult(realPayload);
    expect(labelsOf(out)).toEqual([
      '服务器总数', '检测前未识别', '本次待检测', '检测后未识别',
      '新识别成功', '仍无法识别', '无法解析、未查询', '缓存命中（IP）', '本次查询（IP）',
    ]);
    expect(cellOf(out, '服务器总数')).toBe('12');
    expect(cellOf(out, '检测前未识别')).toBe('5');
    expect(cellOf(out, '本次待检测')).toBe('5');
    expect(cellOf(out, '检测后未识别')).toBe('1');
    expect(cellOf(out, '新识别成功')).toBe('4');
    expect(cellOf(out, '仍无法识别')).toBe('1');
    expect(cellOf(out, '无法解析、未查询')).toBe('0');
    expect(cellOf(out, '缓存命中（IP）')).toBe('2');
    expect(cellOf(out, '本次查询（IP）')).toBe('3');
    // 仍未识别的服务器要列出来
    expect(out).toContain('203.0.113.9');
  });

  it('条目与「立即测活」完全不同（不套用其模板）', () => {
    const geo = labelsOf(renderGeoResult(realPayload));
    const probe = labelsOf(renderProbeResult({ stats: { total: 3, alive: 2, dead: 1, unknown: 0, suspect: 0, disabled: 0 } }));
    expect(geo).not.toEqual(probe);
    for (const l of probe) expect(geo).not.toContain(l);
    for (const l of geo) expect(probe).not.toContain(l);
  });

  it('没有待检测项时给出明确说明，而不是一排 0', () => {
    const out = renderGeoResult({
      success: true,
      data: { serverTotal: 12, targets: 0, total: 0, cached: 0, queried: 0, resolved: 0, failed: 0, unresolved: 0, unlocatedBefore: 0, unlocatedAfter: 0, unlocatedServers: [] },
    });
    expect(out).toContain('本次没有需要检测的服务器');
    expect(cellOf(out, '服务器总数')).toBe('12'); // 服务器总数仍然是真实值
  });

  it('字段缺失显示「暂无数据」，不得伪装成真实 0', () => {
    const out = renderGeoResult({
      success: true,
      data: { serverTotal: 12, targets: 1, total: 1, cached: 0, queried: 1, resolved: 1, failed: 0, unlocatedBefore: 1, unlocatedAfter: 0, unlocatedServers: [] },
    });
    // 后端是旧版（无 unresolved 字段）时，该行不得显示 0
    const cell = cellOf(out, '无法解析、未查询');
    expect(cell).toContain('暂无数据');
    expect(cell).not.toContain('>0<');
  });

  it('响应结构异常时明确报错，不渲染一排 0', () => {
    const out = renderGeoResult({ success: true });
    expect(out).toContain('结果数据缺失');
    expect(labelsOf(out)).toEqual([]);
  });

  it('仍未识别的服务器名做 HTML 转义（防注入）', () => {
    const out = renderGeoResult({
      success: true,
      data: { serverTotal: 1, targets: 1, total: 1, cached: 0, queried: 0, resolved: 0, failed: 0, unresolved: 1, unlocatedBefore: 1, unlocatedAfter: 1, unlocatedServers: ['<img src=x onerror=alert(1)>'] },
    });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('无法解析/仍无法识别会给出文字解释', () => {
    const out = renderGeoResult({
      success: true,
      data: { serverTotal: 3, targets: 3, total: 3, cached: 0, queried: 1, resolved: 1, failed: 1, unresolved: 1, unlocatedBefore: 3, unlocatedAfter: 2, unlocatedServers: [] },
    });
    expect(out).toContain('无法解析为 IP');
    expect(out).toContain('已查询但仍无国家码');
  });
});

describe('立即测活结果渲染（回归，不允许被国家码改造影响）', () => {
  it('条目与数值保持原样', () => {
    const out = renderProbeResult({
      nodeCount: 8,
      stats: { total: 8, alive: 5, dead: 2, unknown: 1, suspect: 0, disabled: 2, avgLatency: 123, minLatency: 45 },
    });
    expect(labelsOf(out)).toEqual(['总节点', '存活', '不通', '不适用（UDP 等）', '疑似（待复核）', '已抛弃', '平均延迟', '最小延迟']);
    expect(cellOf(out, '总节点')).toBe('8');
    expect(cellOf(out, '存活')).toBe('5');
    expect(cellOf(out, '平均延迟')).toBe('123 ms');
    expect(out).toContain('连通性探测完成');
  });

  it('缺 stats 时回退 nodeCount，不报错', () => {
    const out = renderProbeResult({ nodeCount: 6 });
    expect(cellOf(out, '总节点')).toBe('6');
    expect(cellOf(out, '存活')).toContain('暂无数据');
  });
});

describe('任务窗口按任务类型选择渲染器（防止再次串用模板）', () => {
  it('重新检测国家码 → renderGeoResult；立即测活 → renderProbeResult', () => {
    const geoFn = source.slice(source.indexOf('async function redetectGeo'), source.indexOf('async function redetectGeo') + 900);
    const probeFn = source.slice(source.indexOf('async function probeAllNodes'), source.indexOf('async function probeAllNodes') + 900);
    expect(geoFn).toContain('renderSuccess: renderGeoResult');
    expect(geoFn).not.toContain('renderSuccess: renderProbeResult');
    expect(probeFn).toContain('renderSuccess: renderProbeResult');
    expect(probeFn).not.toContain('renderSuccess: renderGeoResult');
  });
});
