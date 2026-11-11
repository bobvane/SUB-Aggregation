import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROXY_BYPASS,
  DEFAULT_PROXY_SCOPE,
  PROXY_PURPOSES,
  isProxyChoice,
  isProxyMode,
  isProxyPurpose,
  isValidProxyUrl,
  maskProxyUrl,
  mergeBypassList,
  mergeMaskedProxyUrl,
  migrateLegacyEnvProxy,
  parseProxyScope,
  proxyUrlForTarget,
  readEffectiveProxyConfig,
  readLegacyEnvProxyUrl,
  readRawProxyConfig,
  serializeProxyScope,
  shouldBypass,
  splitList,
  type EffectiveProxyConfig,
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

describe('proxy-config 模式与用途', () => {
  it('未保存模式时直连；manual 使用保存的地址', async () => {
    expect((await readEffectiveProxyConfig(emptyReader)).mode).toBe('off');
    expect((await readEffectiveProxyConfig(emptyReader)).proxyUrl).toBeNull();

    const manual = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'manual', proxy_url: 'http://10.0.0.2:8080' })
    );
    expect(manual.mode).toBe('manual');
    expect(manual.proxyUrl).toBe('http://10.0.0.2:8080');
  });

  it('旧 env 模式不再被接受，退回直连', async () => {
    const legacy = await readEffectiveProxyConfig(reader({ proxy_mode: 'env' }));
    expect(legacy.mode).toBe('off');
    expect(legacy.proxyUrl).toBeNull();
    expect(isProxyMode('env')).toBe(false);
  });

  it('scope 缺省只含 github + geo（订阅默认直连），并按固定顺序序列化', async () => {
    expect((await readEffectiveProxyConfig(emptyReader)).scope).toEqual([...DEFAULT_PROXY_SCOPE]);
    expect(DEFAULT_PROXY_SCOPE).not.toContain('subscription');
    expect(PROXY_PURPOSES).toContain('subscription'); // 仍可显式勾选 / 单订阅强制走代理
    expect(parseProxyScope('geo,subscription,geo,unknown')).toEqual(['geo', 'subscription']);
    expect(parseProxyScope('')).toBeNull();
    expect(serializeProxyScope(['geo', 'subscription'])).toBe('subscription,geo');
  });

  it('显式保存为空 scope = 全部直连', async () => {
    const empty = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:7890', proxy_scope: '' })
    );
    expect(empty.scope).toEqual([]);
  });

  it('readRawProxyConfig 只返回存储值，不推断 mode / 不合并 bypass', async () => {
    expect(await readRawProxyConfig(emptyReader)).toEqual({
      mode: null, url: null, scope: null, bypass: null, fallback: null,
    });

    const raw = await readRawProxyConfig(reader({
      proxy_mode: 'manual',
      proxy_url: 'http://user:secret@127.0.0.1:7890',
      proxy_scope: 'github,geo',
      proxy_bypass: 'corp.example.com',
      proxy_fallback: '0',
    }));
    expect(raw).toEqual({
      mode: 'manual',
      url: 'http://user:secret@127.0.0.1:7890',
      scope: ['github', 'geo'],
      bypass: 'corp.example.com',
      fallback: false,
    });

    // 生效值会补内置默认 bypass，原始值不应包含这些
    const effective = await readEffectiveProxyConfig(reader({ proxy_bypass: 'corp.example.com' }));
    expect(effective.bypass).toContain('localhost');
    expect(effective.bypass.length).toBeGreaterThan(1);
    expect((await readRawProxyConfig(reader({ proxy_bypass: 'corp.example.com' }))).bypass)
      .toBe('corp.example.com');
  });

  it('fallback 默认开启，存 0 时关闭', async () => {
    expect((await readEffectiveProxyConfig(emptyReader)).fallback).toBe(true);
    expect((await readEffectiveProxyConfig(reader({ proxy_fallback: '0' }))).fallback).toBe(false);
  });

  it('类型守卫只接受约定值', () => {
    expect(isProxyMode('manual')).toBe(true);
    expect(isProxyMode('off')).toBe(true);
    expect(isProxyMode('env')).toBe(false);
    expect(isProxyMode('auto')).toBe(false);
    expect(isProxyPurpose('geo')).toBe(true);
    expect(isProxyPurpose('other')).toBe(false);
    expect(isProxyChoice('auto')).toBe(true);
    expect(isProxyChoice('yes')).toBe(false);
  });
});

describe('v2.44.3 旧环境变量代理迁移', () => {
  it('读取旧环境变量时优先 HTTPS_PROXY，拒绝非 http(s) 地址', () => {
    expect(readLegacyEnvProxyUrl({
      HTTP_PROXY: 'http://http-proxy:8080',
      HTTPS_PROXY: 'http://https-proxy:8443',
    })).toBe('http://https-proxy:8443');
    expect(readLegacyEnvProxyUrl({ ALL_PROXY: 'http://all-proxy:1080' })).toBe('http://all-proxy:1080');
    expect(readLegacyEnvProxyUrl({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toBeNull();
    expect(readLegacyEnvProxyUrl({ HTTPS_PROXY: '   ' })).toBeNull();
    expect(readLegacyEnvProxyUrl({})).toBeNull();
  });

  it('未保存模式但存在环境变量代理：导入为 manual', async () => {
    const s = store();
    expect(await migrateLegacyEnvProxy(s, { HTTPS_PROXY: 'http://env-proxy:8080' })).toBe('imported');
    expect(s.map.get('proxy_mode')).toBe('manual');
    expect(s.map.get('proxy_url')).toBe('http://env-proxy:8080');
  });

  it('未保存模式且没有环境变量代理：不写入任何值', async () => {
    const s = store();
    expect(await migrateLegacyEnvProxy(s, {})).toBe('none');
    expect(s.map.get('proxy_mode')).toBeUndefined();
    expect(s.map.get('proxy_url')).toBeUndefined();
  });

  it('已保存 env 模式：有地址则导入，无地址则退回直连', async () => {
    const withUrl = store({ proxy_mode: 'env' });
    expect(await migrateLegacyEnvProxy(withUrl, { HTTPS_PROXY: 'http://env-proxy:8080' })).toBe('imported');
    expect(withUrl.map.get('proxy_mode')).toBe('manual');

    const withoutUrl = store({ proxy_mode: 'env' });
    expect(await migrateLegacyEnvProxy(withoutUrl, {})).toBe('disabled');
    expect(withoutUrl.map.get('proxy_mode')).toBe('off');
  });

  it('已保存 manual / off 时不做迁移', async () => {
    const manual = store({ proxy_mode: 'manual', proxy_url: 'http://10.0.0.2:8080' });
    expect(await migrateLegacyEnvProxy(manual, { HTTPS_PROXY: 'http://env-proxy:8080' })).toBe('none');
    expect(manual.map.get('proxy_url')).toBe('http://10.0.0.2:8080');

    const off = store({ proxy_mode: 'off' });
    expect(await migrateLegacyEnvProxy(off, { HTTPS_PROXY: 'http://env-proxy:8080' })).toBe('none');
    expect(off.map.get('proxy_mode')).toBe('off');
  });
});

describe('proxy-config 地址校验与脱敏', () => {
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
});

describe('proxy-config 决定目标是否走代理', () => {
  const config: EffectiveProxyConfig = {
    mode: 'manual',
    proxyUrl: 'http://127.0.0.1:7890',
    scope: ['subscription', 'github'],
    bypass: splitList(DEFAULT_PROXY_BYPASS),
    fallback: true,
  };

  it('off 模式始终直连，manual 模式返回代理地址', () => {
    expect(proxyUrlForTarget({ ...config, mode: 'off' })).toBeNull();
    expect(proxyUrlForTarget(config)).toBe('http://127.0.0.1:7890');
  });

  it('bypass 支持精确主机、域名后缀、通配符与 IPv4 CIDR', () => {
    expect(shouldBypass('localhost', config.bypass)).toBe(true);
    expect(shouldBypass('127.0.0.1', config.bypass)).toBe(true);
    expect(shouldBypass('192.168.2.5', config.bypass)).toBe(true);
    expect(shouldBypass('printer.local', config.bypass)).toBe(true);
    expect(shouldBypass('example.com', config.bypass)).toBe(false);
    expect(shouldBypass('sub.example.com', ['example.com'])).toBe(true);
    expect(shouldBypass('anything.test', ['*'])).toBe(true);
    expect(shouldBypass('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(shouldBypass('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('bypass 合并内置默认值与设置值并去重', () => {
    const merged = mergeBypassList('example.com, localhost');
    expect(merged).toContain('localhost');
    expect(merged).toContain('example.com');
    expect(merged.filter((item) => item === 'example.com')).toHaveLength(1);
  });
});
