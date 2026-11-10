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
  parseProxyScope,
  proxyUrlForTarget,
  readEffectiveProxyConfig,
  readRawProxyConfig,
  serializeProxyScope,
  shouldBypass,
  splitList,
  type EffectiveProxyConfig,
  type SettingsReader,
} from '@/engine/proxy-config';

const reader = (entries: Record<string, string>): SettingsReader => ({
  get: async (key) => entries[key] ?? null,
});

const emptyReader: SettingsReader = { get: async () => null };

describe('proxy-config 模式与用途', () => {
  it('默认无环境变量时直连，有环境变量时跟随 env', async () => {
    expect((await readEffectiveProxyConfig(emptyReader, {})).mode).toBe('off');
    const env = await readEffectiveProxyConfig(emptyReader, { HTTPS_PROXY: 'http://127.0.0.1:7890' });
    expect(env.mode).toBe('env');
    expect(env.proxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('设置项优先于环境变量探测', async () => {
    const manual = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'manual', proxy_url: 'http://10.0.0.2:8080' }),
      { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    );
    expect(manual.mode).toBe('manual');
    expect(manual.proxyUrl).toBe('http://10.0.0.2:8080');
  });

  it('scope 缺省只含 github + geo（订阅默认直连），并按固定顺序序列化', async () => {
    expect((await readEffectiveProxyConfig(emptyReader, {})).scope).toEqual([...DEFAULT_PROXY_SCOPE]);
    expect(DEFAULT_PROXY_SCOPE).not.toContain('subscription');
    expect(PROXY_PURPOSES).toContain('subscription'); // 仍可显式勾选 / 单订阅强制走代理
    expect(parseProxyScope('geo,subscription,geo,unknown')).toEqual(['geo', 'subscription']);
    expect(parseProxyScope('')).toBeNull();
    expect(serializeProxyScope(['geo', 'subscription'])).toBe('subscription,geo');
  });

  it('env 模式也按用途收窄；显式保存为空 = 全部直连', async () => {
    const envDefault = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'env' }),
      { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    );
    expect(envDefault.mode).toBe('env');
    expect(envDefault.scope).toEqual([...DEFAULT_PROXY_SCOPE]);

    const envNarrow = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'env', proxy_scope: 'github' }),
      { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    );
    expect(envNarrow.scope).toEqual(['github']);

    const envEmpty = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'env', proxy_scope: '' }),
      { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    );
    expect(envEmpty.scope).toEqual([]);

    const manualEmpty = await readEffectiveProxyConfig(
      reader({ proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:7890', proxy_scope: '' }),
      {}
    );
    expect(manualEmpty.scope).toEqual([]);
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

    // 生效值会补默认 bypass 与 NO_PROXY，原始值不应包含这些
    const effective = await readEffectiveProxyConfig(reader({ proxy_bypass: 'corp.example.com' }), {
      NO_PROXY: 'foo.test',
    });
    expect(effective.bypass).toContain('foo.test');
    expect(effective.bypass.length).toBeGreaterThan(1);
    expect((await readRawProxyConfig(reader({ proxy_bypass: 'corp.example.com' }))).bypass)
      .toBe('corp.example.com');
  });

  it('fallback 默认开启，存 0 时关闭', async () => {
    expect((await readEffectiveProxyConfig(emptyReader, {})).fallback).toBe(true);
    expect((await readEffectiveProxyConfig(reader({ proxy_fallback: '0' }), {})).fallback).toBe(false);
  });

  it('类型守卫只接受约定值', () => {
    expect(isProxyMode('manual')).toBe(true);
    expect(isProxyMode('auto')).toBe(false);
    expect(isProxyPurpose('geo')).toBe(true);
    expect(isProxyPurpose('other')).toBe(false);
    expect(isProxyChoice('auto')).toBe(true);
    expect(isProxyChoice('yes')).toBe(false);
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
    expect(proxyUrlForTarget({ ...config, mode: 'off' }, 'https://example.com', {})).toBeNull();
    expect(proxyUrlForTarget(config, 'https://example.com', {})).toBe('http://127.0.0.1:7890');
  });

  it('env 模式按目标协议选择 HTTPS_PROXY / HTTP_PROXY', () => {
    const env = {
      HTTP_PROXY: 'http://http-proxy:8080',
      HTTPS_PROXY: 'http://https-proxy:8443',
    };
    expect(proxyUrlForTarget({ ...config, mode: 'env' }, 'https://example.com', env)).toBe('http://https-proxy:8443');
    expect(proxyUrlForTarget({ ...config, mode: 'env' }, 'http://example.com', env)).toBe('http://http-proxy:8080');
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

  it('bypass 合并默认值、设置值与 NO_PROXY 并去重', () => {
    const merged = mergeBypassList('example.com, localhost', { NO_PROXY: 'foo.test,EXAMPLE.com' });
    expect(merged).toContain('localhost');
    expect(merged).toContain('example.com');
    expect(merged).toContain('foo.test');
    expect(merged.filter((item) => item === 'example.com')).toHaveLength(1);
  });
});
