/**
 * 2026-11-10 设置页「网络代理」GET→PUT 回环回归（v2.44.2）。
 *
 * 从 public/index.html 抽出真实的 loadSettings / onProxyModeChange / saveSettings
 * 在 vm 中执行，验证：表单只回显 proxy_raw、只提交用户实际改动的字段。
 * 修复前把生效值全量回存会造成：env 带密码保存 400、scope 被固化成全部用途、
 * bypass 合并值写回存储键、直连模式清空已存地址。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeAll } from 'vitest';

type ElementStub = {
  value: string;
  checked: boolean;
  disabled: boolean;
  textContent: string;
  style: Record<string, string>;
};

type SettingsPayload = Record<string, unknown>;

let source = '';
let generated = '';

function sliceSettingsFunctions(): string {
  const start = source.indexOf('// ============ Settings ============');
  const proxyTest = source.indexOf('async function testProxy()');
  const saveStart = source.indexOf('async function saveSettings()');
  const accountStart = source.indexOf('// ============ 账号安全');
  if (start < 0 || proxyTest < 0 || saveStart < 0 || accountStart < 0) {
    throw new Error('设置页函数区段定位失败');
  }
  // 跳过 testProxy（本测试不需要），拼接 loadSettings 段与 saveSettings 段
  return source.slice(start, proxyTest) + '\n' + source.slice(saveStart, accountStart);
}

function createHarness(payload: SettingsPayload) {
  const ids = [
    'settingAppName', 'settingSubUpdateInterval', 'settingNodeDropLatency',
    'settingProxyMode', 'settingProxyUrl', 'settingProxyBypass', 'settingProxyFallback',
    'proxyScopeSubscription', 'proxyScopeGithub', 'proxyScopeGeo',
    'proxyUrlGroup', 'proxyScopeGroup', 'proxyScopeHint',
    'sidebarLogo', 'loginTitle',
  ];
  const elements: Record<string, ElementStub> = {};
  for (const id of ids) {
    elements[id] = { value: '', checked: false, disabled: false, textContent: '', style: {} };
  }
  elements.settingAppName.value = 'SUB-Aggregation';
  elements.settingSubUpdateInterval.value = '24';
  elements.settingNodeDropLatency.value = '2000';

  const puts: Array<Record<string, unknown>> = [];
  const toasts: string[] = [];
  const sandbox: Record<string, unknown> = {
    document: {
      title: '',
      getElementById: (id: string) => elements[id] ?? null,
    },
    api: async (path: string, options?: { method?: string; body?: string }) => {
      if (options?.method === 'PUT') {
        puts.push(JSON.parse(options.body ?? '{}') as Record<string, unknown>);
        return { success: true };
      }
      if (path === '/settings') return { data: payload };
      return { data: {} };
    },
    toast: (msg: string) => { toasts.push(msg); },
    loadCatalogStatus: () => {},
    searchCatalog: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(sliceSettingsFunctions() + '\n', sandbox);
  return { elements, puts, toasts, sandbox };
}

const payload = (raw: Record<string, unknown>, overrides: SettingsPayload = {}): SettingsPayload => ({
  app_name: 'SUB-Aggregation',
  sub_update_interval: 24,
  node_drop_latency_ms: 2000,
  proxy_mode: 'manual',
  proxy_url: 'http://user:***@proxy.example:8080/',
  proxy_scope: ['subscription', 'github', 'geo'],
  proxy_bypass: 'localhost,127.0.0.1,corp.example.com',
  proxy_fallback: true,
  proxy_raw: raw,
  proxy_effective: {
    mode: 'manual', url: 'http://user:***@proxy.example:8080/',
    scope: ['github', 'geo'], bypass: 'localhost,127.0.0.1,corp.example.com',
    fallback: true,
  },
  ...overrides,
});

beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
  generated = readFileSync(resolve(process.cwd(), 'src/html.js'), 'utf8');
});

describe('设置页代理配置回环', () => {
  it('未保存代理配置时：表单显示空地址，保存不会提交代理字段', async () => {
    const h = createHarness(payload({
      mode: null, url: '', scope: null, bypass: '', fallback: null,
    }, { proxy_mode: 'off' }));
    await (h.sandbox.loadSettings as () => Promise<void>)();
    // 表单回显的是原始值（空地址），不是生效值
    expect(h.elements.settingProxyUrl.value).toBe('');
    expect(h.elements.settingProxyBypass.value).toBe('');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts).toHaveLength(1);
    const body = h.puts[0];
    for (const key of ['proxy_mode', 'proxy_url', 'proxy_scope', 'proxy_bypass', 'proxy_fallback']) {
      expect(body[key]).toBeUndefined();
    }
    expect(h.toasts).toContain('设置已保存');
  });

  it('从未保存 scope 时只默认勾选 github + geo，订阅抓取不勾选', async () => {
    const h = createHarness(payload({ mode: null, url: '', scope: null, bypass: '', fallback: null }));
    await (h.sandbox.loadSettings as () => Promise<void>)();
    expect(h.elements.proxyScopeSubscription.checked).toBe(false);
    expect(h.elements.proxyScopeGithub.checked).toBe(true);
    expect(h.elements.proxyScopeGeo.checked).toBe(true);
  });

  it('只改动用途勾选时，PUT 只带 proxy_scope', async () => {
    const h = createHarness(payload({
      mode: 'manual', url: 'http://127.0.0.1:7890/', scope: ['github', 'geo'],
      bypass: '', fallback: null,
    }, { proxy_mode: 'manual' }));
    await (h.sandbox.loadSettings as () => Promise<void>)();
    h.elements.proxyScopeSubscription.checked = true;

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_scope).toEqual(['subscription', 'github', 'geo']);
    expect(h.puts[0].proxy_mode).toBeUndefined();
    expect(h.puts[0].proxy_url).toBeUndefined();
    expect(h.puts[0].proxy_bypass).toBeUndefined();
    expect(h.puts[0].proxy_fallback).toBeUndefined();
  });

  it('直连模式回显已存地址，保存时不会提交空地址', async () => {
    const h = createHarness(payload({
      mode: 'off', url: 'http://127.0.0.1:7890/', scope: null, bypass: '', fallback: null,
    }, { proxy_mode: 'off', proxy_url: '' }));
    await (h.sandbox.loadSettings as () => Promise<void>)();
    expect(h.elements.settingProxyUrl.value).toBe('http://127.0.0.1:7890/');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_url).toBeUndefined();
  });

  it('manual 模式可编辑用途，直连模式禁用用途', async () => {
    const manualHarness = createHarness(payload({ mode: null, url: '', scope: null, bypass: '', fallback: null }));
    await (manualHarness.sandbox.loadSettings as () => Promise<void>)();
    expect(manualHarness.elements.proxyScopeGithub.disabled).toBe(false);
    expect(String(manualHarness.elements.proxyScopeHint.textContent)).toContain('未勾选的用途始终直连');

    const offHarness = createHarness(payload({
      mode: 'off', url: '', scope: null, bypass: '', fallback: null,
    }, { proxy_mode: 'off', proxy_url: '' }));
    await (offHarness.sandbox.loadSettings as () => Promise<void>)();
    expect(offHarness.elements.proxyScopeGithub.disabled).toBe(true);
  });

  it('生成物 src/html.js 与源码同步', () => {
    expect(generated).toContain('proxyFormSnapshot');
    expect(generated).toContain('d.proxy_raw');
  });
});
