/**
 * 2026-11-10 界面版本号回归（用户要求：每次发版都要同步 Web 左下角版本号）。
 *
 * 版本号不是硬编码在页面里，而是运行时读 /api/meta → APP_META.version → package.json。
 * 本测试从 public/index.html 抽出真实的 loadMeta() 在 vm 中执行，验证：
 *   ① 左下角与登录页都显示运行时版本；
 *   ② 页面初始占位符是 '-'，没有写死任何版本号；
 *   ③ /api/meta 请求显式禁缓存，升级镜像后刷新一定拿到新版本；
 *   ④ src/html.js 生成物与源码同步。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeAll } from 'vitest';
import pkg from '../../package.json';

type ElementStub = { textContent: string; title?: string; href?: string; hidden?: boolean };

let source = '';
let generated = '';

function sliceLoadMeta(): string {
  const start = source.indexOf('let metaLoaded = false;');
  const end = source.indexOf('// ============ Init ============');
  if (start < 0 || end < 0 || end <= start) throw new Error('loadMeta 区段定位失败');
  return source.slice(start, end);
}

beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
  generated = readFileSync(resolve(process.cwd(), 'src/html.js'), 'utf8');
});

describe('界面版本号显示', () => {
  it('侧栏与登录页版本号占位符不硬编码，生成物同步', () => {
    // v2.47 起侧栏是固定字标 SUB·Aggregation + 独立的版本行
    expect(source).toContain('<div class="vc-ver">v<span id="appVersion">-</span></div>');
    expect(source).toContain('<span>v<span id="loginVersion">-</span></span>');
    // 占位符里不能出现写死的数字版本
    expect(source).not.toMatch(/<span id="appVersion">\d+\.\d+\.\d+<\/span>/);
    expect(source).not.toMatch(/<span id="loginVersion">\d+\.\d+\.\d+<\/span>/);
    expect(generated).toContain('<div class="vc-ver">v<span id="appVersion">-</span></div>');
    expect(generated).toContain("api('/meta', { cache: 'no-store' })");
  });

  it('loadMeta() 把 /api/meta 的运行时版本写入左下角与登录页', async () => {
    const elements: Record<string, ElementStub> = {
      appVersion: { textContent: '-' },
      loginVersion: { textContent: '-' },
      sidebarLogo: { textContent: '' },
      loginTitle: { textContent: '' },
      sidebarVersion: { textContent: '', title: '', href: '' },
      upgradeDot: { textContent: '', hidden: true },
    };
    const calls: Array<{ path: string; options: unknown }> = [];
    const sandbox: Record<string, unknown> = {
      document: {
        title: '',
        getElementById: (id: string) => elements[id] ?? null,
      },
      api: async (path: string, options: unknown) => {
        calls.push({ path, options });
        if (path === '/meta') {
          return { data: { meta: { name: 'SUB-Aggregation', version: pkg.version }, app_name: 'SUB-Aggregation' } };
        }
        return { data: { checked: false } };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(sliceLoadMeta() + '\n', sandbox);
    if (typeof sandbox.loadMeta !== 'function') throw new Error('loadMeta 未能从页面中加载');

    await (sandbox.loadMeta as () => Promise<void>)();

    expect(elements.appVersion.textContent).toBe(pkg.version);
    expect(elements.loginVersion.textContent).toBe(pkg.version);
    expect(calls[0].path).toBe('/meta');
    expect(calls[0].options).toMatchObject({ cache: 'no-store' });
  });
});
