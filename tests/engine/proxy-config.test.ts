import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROXY_BYPASS,
  PROXY_BYPASS_PRESETS,
  PROXY_PROBE_TIMEOUT_MS,
  PROXY_TARGETS,
  PROXY_TARGET_HINTS,
  PROXY_TARGET_LABELS,
  buildProxyUrl,
  isProxyTarget,
  isProxyTargetMode,
  isValidProxyUrl,
  maskProxyUrl,
  mergeBypassList,
  mergeMaskedProxyUrl,
  migrateLegacyEnvProxy,
  migrateLegacyProxyConfig,
  parseProxyTargets,
  readEffectiveProxyConfig,
  readLegacyEnvProxyUrl,
  readRawProxyConfig,
  resolveProxyTargets,
  serializeProxyTargets,
  shouldBypass,
  splitList,
  splitProxyUrl,
  type SettingsReader,
  type SettingsStore,
} from '@/engine/proxy-config';

const reader = (entries: Record<string, string>): SettingsReader => ({
  get: async (key) => entries[key] ?? null,
});

const emptyReader: SettingsReader = { get: async () => null };

const store = (entries: Record<string, string> = {}): SettingsStore & { map: Map<string, string> } => {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
  };
};

describe('5 个项目目标', () => {
  it('目标清单与短名、提示一一对应', () => {
    expect(PROXY_TARGETS).toEqual(['subscription', 'rules', 'version', 'dns', 'geo']);
    for (const target of PROXY_TARGETS) {
      expect(PROXY_TARGET_LABELS[target]).toBeTruthy();
      expect(PROXY_TARGET_HINTS[target]).toBeTruthy();
    }
    expect(PROXY_TARGET_LABELS.subscription).toBe('订阅拉取');
  });

  it('类型守卫只接受约定值', () => {
    expect(isProxyTarget('dns')).toBe(true);
    expect(isProxyTarget('github')).toBe(false);   // 旧的合并用途已拆成 rules / version
    expect(isProxyTargetMode('auto')).toBe(true);
    expect(isProxyTargetMode('on')).toBe(true);
    expect(isProxyTargetMode('off')).toBe(true);
    expect(isProxyTargetMode('yes')).toBe(false);
  });

  it('探测时限默认 3 秒', () => {
    expect(PROXY_PROBE_TIMEOUT_MS).toBe(3_000);
  });
});

describe('目标策略的解析与序列化', () => {
  it('从未保存时返回 null，便于区分「没配过」与「显式保存」', () => {
    expect(parseProxyTargets(null)).toBeNull();
    expect(parseProxyTargets(undefined)).toBeNull();
    expect(parseProxyTargets('')).toEqual({});
  });

  it('解析时忽略未知目标与非法取值', () => {
    expect(parseProxyTargets('subscription=on,unknown=auto,geo=bad,rules=off'))
      .toEqual({ subscription: 'on', rules: 'off' });
  });

  it('序列化按固定顺序输出全部 5 项', () => {
    expect(serializeProxyTargets({ geo: 'off', subscription: 'on' }))
      .toBe('subscription=on,rules=auto,version=auto,dns=auto,geo=off');
  });

  it('补默认值时缺失项一律 auto', () => {
    const resolved = resolveProxyTargets({ dns: 'off' });
    expect(resolved).toEqual({
      subscription: 'auto', rules: 'auto', version: 'auto', dns: 'off', geo: 'auto',
    });
    expect(resolveProxyTargets(null).subscription).toBe('auto');
  });
});

describe('读取配置', () => {
  it('未保存任何值时：无代理地址 + 全部 auto', async () => {
    const config = await readEffectiveProxyConfig(emptyReader);
    expect(config.proxyUrl).toBeNull();
    expect(Object.values(config.targets).every((mode) => mode === 'auto')).toBe(true);
  });

  it('地址即开关：存了地址就用，删掉就全部直连', async () => {
    const withUrl = await readEffectiveProxyConfig(reader({ proxy_url: 'http://10.0.0.2:8080' }));
    expect(withUrl.proxyUrl).toBe('http://10.0.0.2:8080');
    expect((await readEffectiveProxyConfig(reader({ proxy_url: '   ' }))).proxyUrl).toBeNull();
  });

  it('readRawProxyConfig 只返回存储值，不合并 bypass', async () => {
    expect(await readRawProxyConfig(emptyReader)).toEqual({ url: null, targets: null, bypass: null });

    const raw = await readRawProxyConfig(reader({
      proxy_url: 'http://user:secret@127.0.0.1:7890',
      proxy_targets: 'subscription=on,geo=off',
      proxy_bypass: 'corp.example.com',
    }));
    expect(raw).toEqual({
      url: 'http://user:secret@127.0.0.1:7890',
      targets: { subscription: 'on', geo: 'off' },
      bypass: 'corp.example.com',
    });

    // 生效值会补内置默认 bypass，原始值不应包含这些
    const effective = await readEffectiveProxyConfig(reader({ proxy_bypass: 'corp.example.com' }));
    expect(effective.bypass).toContain('localhost');
    expect(effective.bypass.length).toBeGreaterThan(1);
  });
});

describe('v2.46.0 旧用途配置迁移', () => {
  it('已存在 proxy_targets 时不动', async () => {
    const s = store({ proxy_targets: 'subscription=off', proxy_mode: 'manual' });
    expect(await migrateLegacyProxyConfig(s)).toBe('none');
    expect(s.map.get('proxy_targets')).toBe('subscription=off');
  });

  it('全新安装（两个旧键都没有）不写入', async () => {
    const s = store();
    expect(await migrateLegacyProxyConfig(s)).toBe('none');
    expect(s.map.get('proxy_targets')).toBeUndefined();
  });

  it('旧 proxy_mode=off → 5 项全部 off', async () => {
    const s = store({ proxy_mode: 'off', proxy_url: 'http://10.0.0.2:8080' });
    expect(await migrateLegacyProxyConfig(s)).toBe('migrated');
    expect(parseProxyTargets(s.map.get('proxy_targets') ?? null)).toEqual({
      subscription: 'off', rules: 'off', version: 'off', dns: 'off', geo: 'off',
    });
  });

  it('保存过 proxy_scope：勾选的 on、未勾的 off（github 拆 rules+version，geo 拆 dns+geo）', async () => {
    const s = store({ proxy_mode: 'manual', proxy_scope: 'github,geo' });
    expect(await migrateLegacyProxyConfig(s)).toBe('migrated');
    expect(parseProxyTargets(s.map.get('proxy_targets') ?? null)).toEqual({
      subscription: 'off', rules: 'on', version: 'on', dns: 'on', geo: 'on',
    });
  });

  it('proxy_scope 保存为空串（旧的「全部直连」）→ 全部 off', async () => {
    const s = store({ proxy_mode: 'manual', proxy_scope: '' });
    await migrateLegacyProxyConfig(s);
    expect(Object.values(parseProxyTargets(s.map.get('proxy_targets') ?? null) ?? {}))
      .toEqual(['off', 'off', 'off', 'off', 'off']);
  });

  it('只有 proxy_mode=manual 没有 scope → 全部 auto（新的零配置默认）', async () => {
    const s = store({ proxy_mode: 'manual', proxy_url: 'http://10.0.0.2:8080' });
    await migrateLegacyProxyConfig(s);
    expect(Object.values(parseProxyTargets(s.map.get('proxy_targets') ?? null) ?? {}))
      .toEqual(['auto', 'auto', 'auto', 'auto', 'auto']);
  });

  it('迁移后保留旧键，便于回滚', async () => {
    const s = store({ proxy_mode: 'manual', proxy_scope: 'subscription' });
    await migrateLegacyProxyConfig(s);
    expect(s.map.get('proxy_mode')).toBe('manual');
    expect(s.map.get('proxy_scope')).toBe('subscription');
  });
});

describe('更早期环境变量代理的导入', () => {
  it('读取环境变量时优先 HTTPS_PROXY，拒绝非 http(s) 地址', () => {
    expect(readLegacyEnvProxyUrl({
      HTTP_PROXY: 'http://http-proxy:8080',
      HTTPS_PROXY: 'http://https-proxy:8443',
    })).toBe('http://https-proxy:8443');
    expect(readLegacyEnvProxyUrl({ ALL_PROXY: 'http://all-proxy:1080' })).toBe('http://all-proxy:1080');
    expect(readLegacyEnvProxyUrl({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toBeNull();
    expect(readLegacyEnvProxyUrl({ HTTPS_PROXY: '   ' })).toBeNull();
    expect(readLegacyEnvProxyUrl({})).toBeNull();
  });

  it('地址为空且环境里有代理时导入', async () => {
    const s = store();
    expect(await migrateLegacyEnvProxy(s, { HTTPS_PROXY: 'http://env-proxy:8080' })).toBe('imported');
    expect(s.map.get('proxy_url')).toBe('http://env-proxy:8080');
  });

  it('地址已有值时不再覆盖', async () => {
    const s = store({ proxy_url: 'http://10.0.0.2:8080' });
    expect(await migrateLegacyEnvProxy(s, { HTTPS_PROXY: 'http://env-proxy:8080' })).toBe('none');
    expect(s.map.get('proxy_url')).toBe('http://10.0.0.2:8080');
  });

  it('环境里没有代理时不写入任何值', async () => {
    const s = store();
    expect(await migrateLegacyEnvProxy(s, {})).toBe('none');
    expect(s.map.get('proxy_url')).toBeUndefined();
  });
});

describe('地址校验、脱敏与三段式拼装', () => {
  it('只接受 http/https 且带主机名的地址', () => {
    expect(isValidProxyUrl('http://127.0.0.1:7890')).toBe(true);
    expect(isValidProxyUrl('https://proxy.example.com:8443')).toBe(true);
    expect(isValidProxyUrl('socks5://127.0.0.1:1080')).toBe(false);
    expect(isValidProxyUrl('http://')).toBe(false);
    expect(isValidProxyUrl('http://bad host:7890')).toBe(false);
  });

  it('脱敏保留用户名、隐藏密码', () => {
    const masked = maskProxyUrl('http://user:secret@127.0.0.1:7890');
    expect(masked).toContain('user');
    expect(masked).not.toContain('secret');
    expect(masked).toContain('***');
  });

  it('未改动密码占位符时还原原值，篡改占位符报错', () => {
    const existing = 'http://user:secret@127.0.0.1:7890';
    expect(mergeMaskedProxyUrl(existing, maskProxyUrl(existing) ?? '')).toBe(existing);
    expect(mergeMaskedProxyUrl(existing, 'http://user:newpass@127.0.0.1:7890'))
      .toBe('http://user:newpass@127.0.0.1:7890');
    expect(() => mergeMaskedProxyUrl(existing, 'http://user:***@other:7890')).toThrow();
  });

  it('三段式拼装：主机为空即不使用代理', () => {
    expect(buildProxyUrl('http', '192.168.2.5', '7893')).toBe('http://192.168.2.5:7893');
    expect(buildProxyUrl('https', 'proxy.example.com', '8443')).toBe('https://proxy.example.com:8443');
    expect(buildProxyUrl('socks5', '1.2.3.4', '1080')).toBe('http://1.2.3.4:1080'); // 非 https 一律按 http
    expect(buildProxyUrl('http', '', '7893')).toBe('');
    expect(buildProxyUrl('http', '1.2.3.4', '')).toBe('http://1.2.3.4');
  });

  it('已存地址拆回三段；带账号密码或路径时标记 advanced', () => {
    expect(splitProxyUrl('http://192.168.2.5:7893')).toEqual({
      protocol: 'http', host: '192.168.2.5', port: '7893', advanced: false,
    });
    expect(splitProxyUrl('https://proxy.example.com:8443')).toEqual({
      protocol: 'https', host: 'proxy.example.com', port: '8443', advanced: false,
    });
    expect(splitProxyUrl('http://user:pass@127.0.0.1:7890').advanced).toBe(true);
    expect(splitProxyUrl('http://127.0.0.1:7890/proxy').advanced).toBe(true);
    expect(splitProxyUrl(null)).toEqual({ protocol: 'http', host: '', port: '', advanced: false });
  });
});

describe('bypass 匹配', () => {
  const bypass = splitList(DEFAULT_PROXY_BYPASS);

  it('支持精确主机、域名后缀、通配符与 IPv4 CIDR', () => {
    expect(shouldBypass('localhost', bypass)).toBe(true);
    expect(shouldBypass('127.0.0.1', bypass)).toBe(true);
    expect(shouldBypass('192.168.2.5', bypass)).toBe(true);
    expect(shouldBypass('printer.local', bypass)).toBe(true);
    expect(shouldBypass('example.com', bypass)).toBe(false);
    expect(shouldBypass('sub.example.com', ['example.com'])).toBe(true);
    expect(shouldBypass('anything.test', ['*'])).toBe(true);
    expect(shouldBypass('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(shouldBypass('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('合并内置默认值与设置值并去重', () => {
    const merged = mergeBypassList('example.com, localhost');
    expect(merged).toContain('localhost');
    expect(merged).toContain('example.com');
    expect(merged.filter((item) => item === 'example.com')).toHaveLength(1);
  });

  it('界面预设标签都落在内置默认里，点了只是显式化', () => {
    for (const preset of PROXY_BYPASS_PRESETS) {
      const covered = preset === '192.168.2.0/24' // 该子网已被 192.168.0.0/16 覆盖
        || DEFAULT_PROXY_BYPASS.includes(preset);
      expect(covered, `预设 ${preset} 未被内置默认覆盖`).toBe(true);
    }
  });
});
