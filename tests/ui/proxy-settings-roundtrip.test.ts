/**
 * 2026-11-12 设置页「网络代理」GET→PUT 回环回归（v2.46.0）。
 *
 * 从 public/index.html 抽出真实的 loadSettings / saveSettings 及其代理表单辅助函数，
 * 在 vm 中执行，验证三件事：
 *   1. 零配置（未填地址）时表单呈「自动」，保存不写入任何 proxy_* 字段；
 *   2. 已存地址能被拆回「协议 + IP + 端口」三段，带账号密码时自动进高级模式且不被改写；
 *   3. 保存只提交用户真正改动过的字段（脏字段），脱敏地址不会被回存成真实配置。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeAll } from 'vitest';

type ElementStub = {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  title: string;
  /** 滑杆填充用 el.style.setProperty('--pct', ...)，纯对象不够用 */
  style: Record<string, string> & {
    setProperty: (k: string, v: string) => void;
    removeProperty: (k: string) => void;
    getPropertyValue: (k: string) => string;
  };
  /** bindSettingsControls 会写 dataset.bound，并挂 input 监听 */
  dataset: Record<string, string>;
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  addEventListener: () => void;
};

type SettingsPayload = Record<string, unknown>;

let source = '';
let generated = '';

/** 设置页函数区段：Settings 标记 → testProxy 之前，加上 saveSettings → 账号安全之前 */
function sliceSettingsFunctions(): string {
  const start = source.indexOf('// ============ Settings ============');
  const proxyTest = source.indexOf('async function testProxy()');
  const saveStart = source.indexOf('async function saveSettings()');
  const accountStart = source.indexOf('// ============ 账号安全');
  if (start < 0 || proxyTest < 0 || saveStart < 0 || accountStart < 0) {
    throw new Error('设置页函数区段定位失败');
  }
  return source.slice(start, proxyTest) + '\n' + source.slice(saveStart, accountStart);
}

const ELEMENT_IDS = [
  'settingAppName', 'settingSubUpdateInterval', 'settingNodeDropLatency',
  'proxyProtocol', 'proxyHost', 'proxyPort', 'proxyAdvanced', 'settingProxyUrl',
  'proxyUrlPreview', 'proxyTargetsList', 'proxyTestResult',
  'settingProxyBypass', 'bypassPresets', 'bypassHint',
  'sidebarLogo', 'loginTitle',
];

function createHarness(payload: SettingsPayload) {
  const elements: Record<string, ElementStub> = {};
  for (const id of ELEMENT_IDS) {
    const style = {
      setProperty(k: string, v: string) { (style as Record<string, string>)[k] = v; },
      removeProperty(k: string) { delete (style as Record<string, string>)[k]; },
      getPropertyValue(k: string) { return (style as Record<string, string>)[k] ?? ''; },
    } as ElementStub['style'];
    elements[id] = {
      value: '', checked: false, disabled: false, hidden: false,
      textContent: '', innerHTML: '', title: '', style, dataset: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      addEventListener: () => {},
    };
  }
  elements.settingAppName.value = 'SUB-Aggregation';
  elements.settingSubUpdateInterval.value = '24';
  elements.settingNodeDropLatency.value = '2000';

  /**
   * v2.47 起代理目标改成三段按钮（`.segmented[data-key]` 内一组 `button[data-val]`，
   * 选中项带 `class="active"`），不再是 radio。这里按新标记读出当前选中值。
   */
  function checkedTarget(key: string): string | null {
    const html = elements.proxyTargetsList.innerHTML;
    const seg = new RegExp(`data-key="${key}"[^>]*>([\\s\\S]*?)</div>`).exec(html);
    if (!seg) return null;
    const re = /<button[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg[1])) !== null) {
      const tag = m[0].replace(/\s+/g, ' ');
      const val = /data-val="(\w+)"/.exec(tag);
      if (val && /class="[^"]*active/.test(tag)) return val[1];
    }
    return null;
  }

  /** 模拟用户点选某个目标的模式：把 active 类挪到目标按钮上 */
  function selectTarget(key: string, mode: string) {
    const html = elements.proxyTargetsList.innerHTML;
    const re = new RegExp(`(data-key="${key}"[^>]*>)([\\s\\S]*?)(</div>)`);
    elements.proxyTargetsList.innerHTML = html.replace(re, (_all, head: string, body: string, tail: string) => {
      const next = body.replace(/<button([^>]*)>/g, (_tag, attrs: string) => {
        const clean = attrs.replace(/\s*class="[^"]*active[^"]*"/, '');
        const val = /data-val="(\w+)"/.exec(clean);
        return val && val[1] === mode ? `<button${clean} class="active">` : `<button${clean}>`;
      });
      return head + next + tail;
    });
  }

  const puts: Array<Record<string, unknown>> = [];
  const toasts: string[] = [];
  const sandbox: Record<string, unknown> = {
    // vm 的新 context 只有 ECMAScript 内建，URL 需要显式注入
    URL,
    document: {
      title: '',
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: (selector: string) => {
        // readProxyTargets 通过 `#proxyTargetsList .segmented[data-key="x"]` 找选中项
        const m = /^#proxyTargetsList \.segmented\[data-key="(\w+)"\]$/.exec(selector);
        if (!m) return null;
        const mode = checkedTarget(m[1]);
        return {
          querySelector: (sel: string) =>
            sel === 'button[data-val].active' && mode ? { dataset: { val: mode } } : null,
        };
      },
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
  return { elements, puts, toasts, sandbox, checkedTarget, selectTarget };
}

const TARGETS = [
  { key: 'subscription', label: '订阅拉取', hint: '最常出网' },
  { key: 'rules', label: '规则目录同步', hint: '每月一次' },
  { key: 'version', label: '版本检查', hint: '每日一次' },
  { key: 'dns', label: '域名解析', hint: 'DoH 查询' },
  { key: 'geo', label: 'IP 归属', hint: '批量查询' },
];

const payload = (overrides: SettingsPayload = {}): SettingsPayload => ({
  app_name: 'SUB-Aggregation',
  sub_update_interval: 24,
  node_drop_latency_ms: 2000,
  proxy_url: '',
  proxy_targets: { subscription: 'auto', rules: 'auto', version: 'auto', dns: 'auto', geo: 'auto' },
  proxy_bypass: '',
  proxy_meta: {
    targets: TARGETS,
    bypassPresets: ['localhost', '127.0.0.1', '192.168.0.0/16', '192.168.2.0/24', '10.0.0.0/8', '172.16.0.0/12', '.local'],
    bypassDefaults: 'localhost,127.0.0.1,::1',
    probeTimeoutMs: 3000,
  },
  ...overrides,
});

beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
  generated = readFileSync(resolve(process.cwd(), 'src/html.js'), 'utf8');
});

describe('设置页代理配置回环（v2.46.0）', () => {
  it('零配置：地址三段为空、5 项全为自动，保存不提交任何 proxy 字段', async () => {
    const h = createHarness(payload());
    await (h.sandbox.loadSettings as () => Promise<void>)();

    expect(h.elements.proxyHost.value).toBe('');
    expect(h.elements.settingProxyUrl.value).toBe('');
    expect(String(h.elements.proxyUrlPreview.textContent)).toContain('不使用代理');
    for (const t of TARGETS) expect(h.checkedTarget(t.key)).toBe('auto');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts).toHaveLength(1);
    const body = h.puts[0];
    for (const key of ['proxy_url', 'proxy_targets', 'proxy_bypass', 'proxy_mode', 'proxy_scope']) {
      expect(body[key]).toBeUndefined();
    }
    expect(h.toasts).toContain('设置已保存');
  });

  it('已存地址拆回三段，未改动时保存不提交 proxy_url', async () => {
    const h = createHarness(payload({ proxy_url: 'http://127.0.0.1:7890/' }));
    await (h.sandbox.loadSettings as () => Promise<void>)();

    expect(h.elements.proxyProtocol.value).toBe('http');
    expect(h.elements.proxyHost.value).toBe('127.0.0.1');
    expect(h.elements.proxyPort.value).toBe('7890');
    expect(h.elements.proxyAdvanced.checked).toBe(false);
    expect(String(h.elements.proxyUrlPreview.textContent)).toContain('http://127.0.0.1:7890');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_url).toBeUndefined();
  });

  it('脱敏地址（带账号密码）自动进高级模式，回存时不会把 *** 写成真实配置', async () => {
    const h = createHarness(payload({ proxy_url: 'http://user:***@proxy.example:8080/' }));
    await (h.sandbox.loadSettings as () => Promise<void>)();

    expect(h.elements.proxyAdvanced.checked).toBe(true);
    expect(h.elements.settingProxyUrl.value).toBe('http://user:***@proxy.example:8080/');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_url).toBeUndefined();
  });

  it('只改某项目标的策略时，PUT 只带 proxy_targets', async () => {
    const h = createHarness(payload({ proxy_url: 'http://127.0.0.1:7890/' }));
    await (h.sandbox.loadSettings as () => Promise<void>)();
    h.selectTarget('version', 'on');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_targets).toEqual({
      subscription: 'auto', rules: 'auto', version: 'on', dns: 'auto', geo: 'auto',
    });
    expect(h.puts[0].proxy_url).toBeUndefined();
    expect(h.puts[0].proxy_bypass).toBeUndefined();
  });

  it('只改地址时，PUT 提交由三段拼装出的完整地址', async () => {
    const h = createHarness(payload());
    await (h.sandbox.loadSettings as () => Promise<void>)();
    h.elements.proxyProtocol.value = 'https';
    h.elements.proxyHost.value = '10.0.0.2';
    h.elements.proxyPort.value = '7893';

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_url).toBe('https://10.0.0.2:7893');
    expect(h.puts[0].proxy_targets).toBeUndefined();
    expect(h.puts[0].proxy_bypass).toBeUndefined();
  });

  it('点击 bypass 预设标签可加入与移除，改动后只提交 proxy_bypass', async () => {
    const h = createHarness(payload());
    await (h.sandbox.loadSettings as () => Promise<void>)();

    (h.sandbox.toggleBypassPreset as (p: string) => void)('10.0.0.0/8');
    (h.sandbox.toggleBypassPreset as (p: string) => void)('.local');
    expect(h.elements.settingProxyBypass.value).toBe('10.0.0.0/8,.local');

    (h.sandbox.toggleBypassPreset as (p: string) => void)('10.0.0.0/8');
    expect(h.elements.settingProxyBypass.value).toBe('.local');

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts[0].proxy_bypass).toBe('.local');
    expect(h.puts[0].proxy_url).toBeUndefined();
  });

  it('地址格式非法时前端拦下，不发 PUT', async () => {
    const h = createHarness(payload());
    await (h.sandbox.loadSettings as () => Promise<void>)();
    h.elements.proxyAdvanced.checked = true;
    h.elements.settingProxyUrl.value = 'ftp://127.0.0.1:21';

    await (h.sandbox.saveSettings as () => Promise<void>)();
    expect(h.puts).toHaveLength(0);
    expect(h.toasts.some((t) => t.includes('代理地址格式不对'))).toBe(true);
  });

  it('生成物 src/html.js 与源码同步', () => {
    expect(generated).toContain('proxyTargetsList');
    expect(generated).toContain('bypassPresets');
    expect(generated).toContain('d.proxy_meta');
  });
});
