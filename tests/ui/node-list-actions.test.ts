/**
 * 2026-11-10 节点列表操作列回归。
 *
 * 与 task-result-render.test.ts 同思路：直接从 public/index.html 抽出真实的
 * toggleNodeLock / toggleNodeExcluded 在 vm 中执行，保证测的是上线那份代码，
 * 而不是复制一份假实现。同时校验 src/html.js 生成物没有漏重建。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

type NodeRow = { fingerprint: string; enabled: boolean; excluded: boolean; locked: boolean };

let source = '';
let generated = '';
let sandbox: Record<string, unknown>;
let rows: NodeRow[];
let renderCount: number;
let toasts: string[];
let calls: Array<{ path: string; body: unknown }>;
let apiImpl: (path: string, options: { method: string; body: string }) => Promise<unknown>;

const FP = 'a.example.com:443:vless';

function sliceFunctions(): string {
  const start = source.indexOf('// v2.36.9 起：节点锁定');
  const end = source.indexOf('// ============ Output ============');
  if (start < 0 || end < 0 || end <= start) throw new Error('节点操作函数区段定位失败');
  return source.slice(start, end);
}

beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
  generated = readFileSync(resolve(process.cwd(), 'src/html.js'), 'utf8');
  sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(sliceFunctions() + '\n', sandbox);
  if (typeof sandbox.toggleNodeLock !== 'function' || typeof sandbox.toggleNodeExcluded !== 'function') {
    throw new Error('节点操作函数未能从页面中加载');
  }
});

beforeEach(() => {
  rows = [{ fingerprint: FP, enabled: true, excluded: false, locked: true }];
  renderCount = 0;
  toasts = [];
  calls = [];
  apiImpl = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return { success: true, data: {} };
  };
  sandbox.state = { nodes: rows };
  sandbox.renderNodes = () => { renderCount++; };
  sandbox.toast = (msg: string) => { toasts.push(msg); };
  sandbox.api = (path: string, options: { method: string; body: string }) => apiImpl(path, options);
});

const lock = (locked: boolean) =>
  (sandbox.toggleNodeLock as (fp: string, v: boolean) => Promise<void>)(FP, locked);
const exclude = (excluded: boolean) =>
  (sandbox.toggleNodeExcluded as (fp: string, v: boolean) => Promise<void>)(FP, excluded);

describe('节点列表静态结构（源码 + 生成物）', () => {
  it('锁定不再是图标按钮，表头也没有独立的「锁定」列', () => {
    expect(source).not.toContain('>🔒</button>');
    expect(source).not.toContain('>🔓</button>');
    expect(source).toContain('<thead><tr><th>名称</th>');
    expect(source).not.toContain('>锁定</th>');
  });

  it('操作列含锁定/解锁、移出配置/恢复、复制三个文字按钮', () => {
    expect(source).toContain("'解锁' : '锁定'");
    expect(source).toContain("'恢复' : '移出配置'");
    expect(source).toContain('📋 复制');
    expect(source).toContain('toggleNodeExcluded(');
    expect(source).toContain('node-action-wrap');
  });

  it('命名格式说明改为中文国家名，生成物同步重建', () => {
    expect(source).toContain('🇭🇰 香港VLESS-01');
    expect(source).not.toContain('HK VLESS-01');
    expect(generated).toContain('🇭🇰 香港VLESS-01');
    expect(generated).not.toContain('HK VLESS-01');
    expect(generated).toContain('toggleNodeExcluded');
    expect(generated).toContain("'恢复' : '移出配置'");
  });

  it('说明文案解释互斥语义，不再有勾选框残留', () => {
    expect(source).toContain('锁定与移出配置互斥');
    expect(source).not.toContain('💡 勾选 = 该节点会进入输出配置');
  });
});

describe('节点操作函数（真实前端代码）', () => {
  it('移出配置已锁定节点：前端同步清掉 locked/enabled，走单节点接口', async () => {
    await exclude(true);
    expect(calls).toEqual([{ path: '/nodes/excluded', body: { fingerprint: FP, excluded: true } }]);
    expect(rows[0]).toMatchObject({ excluded: true, enabled: false, locked: false });
    expect(renderCount).toBeGreaterThan(0);
  });

  it('恢复节点：不会自动重新锁定', async () => {
    rows[0] = { fingerprint: FP, enabled: false, excluded: true, locked: false };
    await exclude(false);
    expect(rows[0]).toMatchObject({ excluded: false, enabled: true, locked: false });
    expect(calls[0].body).toMatchObject({ excluded: false });
  });

  it('锁定已移出配置的节点：前端同步清掉 excluded', async () => {
    rows[0] = { fingerprint: FP, enabled: false, excluded: true, locked: false };
    await lock(true);
    expect(rows[0]).toMatchObject({ excluded: false, enabled: true, locked: true });
    expect(calls[0].path).toBe('/nodes/locked');
  });

  it('接口失败时完整回滚 excluded/locked/enabled 三个字段', async () => {
    apiImpl = async () => { throw new Error('network down'); };
    await exclude(true);
    expect(rows[0]).toMatchObject({ excluded: false, enabled: true, locked: true });
    expect(toasts.some((t) => t.includes('保存失败'))).toBe(true);
  });

  it('后端返回 unlocked 时提示同时解除锁定', async () => {
    apiImpl = async () => ({ success: true, data: { unlocked: true } });
    await exclude(true);
    expect(toasts.join('\n')).toContain('同时解除锁定');
  });
});
