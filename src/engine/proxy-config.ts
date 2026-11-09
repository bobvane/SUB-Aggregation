/**
 * 代理设置模型（v2.44.0）
 *
 * 目标：把「进程级、全量接管」的环境变量代理，改成「可配置、按用途区分」：
 *   - off    ：全部直连
 *   - env    ：沿用 HTTP_PROXY / HTTPS_PROXY / NO_PROXY（兼容旧部署）
 *   - manual ：使用设置页保存的 proxy_url
 *
 * 用途（purpose）：
 *   - subscription：订阅抓取
 *   - github      ：升级检测 + 规则目录同步
 *   - geo         ：DoH 域名解析 + ip-api 归属查询
 *
 * 节点测活/测速永远直连（net.connect / tls.connect），不经过本模块。
 */

export type ProxyMode = 'off' | 'env' | 'manual';
export type ProxyPurpose = 'subscription' | 'github' | 'geo';
export type ProxyChoice = 'auto' | 'on' | 'off';

export interface SettingsReader {
  get(key: string): Promise<string | null>;
}

export type EnvLike = Record<string, string | undefined>;

export interface EffectiveProxyConfig {
  mode: ProxyMode;
  /** 供界面展示的代理地址（env 模式为 HTTPS_PROXY 优先） */
  proxyUrl: string | null;
  scope: ProxyPurpose[];
  bypass: string[];
  /** 首选通道失败时是否自动尝试另一条通道（仅 auto 生效） */
  fallback: boolean;
}

export const PROXY_PURPOSES: readonly ProxyPurpose[] = ['subscription', 'github', 'geo'];

export const DEFAULT_PROXY_BYPASS =
  'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,.local';

export const PROXY_SETTING_KEYS = {
  mode: 'proxy_mode',
  url: 'proxy_url',
  scope: 'proxy_scope',
  bypass: 'proxy_bypass',
  fallback: 'proxy_fallback',
} as const;

function envValue(env: EnvLike, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'off' || value === 'env' || value === 'manual';
}

export function isProxyPurpose(value: unknown): value is ProxyPurpose {
  return value === 'subscription' || value === 'github' || value === 'geo';
}

export function isProxyChoice(value: unknown): value is ProxyChoice {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** 拆分逗号/空白分隔的列表（bypass、NO_PROXY、scope 共用） */
export function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseProxyScope(raw: string | null | undefined): ProxyPurpose[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const scope = splitList(raw).filter(isProxyPurpose);
  return [...new Set(scope)];
}

export function serializeProxyScope(scope: readonly ProxyPurpose[]): string {
  return PROXY_PURPOSES.filter((purpose) => scope.includes(purpose)).join(',');
}

/** 手动代理地址只接受 http/https，且必须是合法主机名 */
export function isValidProxyUrl(url: string): boolean {
  if (!url || /\s/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

/** 界面脱敏：密码替换为 ***，其余保持原样 */
export function maskProxyUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 把界面上脱敏后的地址还原为真实地址。
 * 用户没有改密码（仍是 ***）时沿用 existing；否则按新值处理。
 */
export function mergeMaskedProxyUrl(existing: string | null, incoming: string): string {
  const value = incoming.trim();
  if (!value) return '';
  if (!value.includes('***')) return value;
  if (existing && maskProxyUrl(existing) === value) return existing;
  throw new Error('代理地址中的密码占位符无法还原，请重新输入完整地址');
}

export function hasEnvProxy(env: EnvLike = process.env): boolean {
  return !!(envValue(env, 'HTTPS_PROXY') || envValue(env, 'HTTP_PROXY') || envValue(env, 'ALL_PROXY')
    || envValue(env, 'https_proxy') || envValue(env, 'http_proxy') || envValue(env, 'all_proxy'));
}

/**
 * env 模式下按目标协议选择代理：
 *   https -> HTTPS_PROXY / ALL_PROXY
 *   http  -> HTTP_PROXY / ALL_PROXY
 */
export function envProxyUrlFor(targetUrl: string, env: EnvLike = process.env): string | null {
  let protocol = 'https:';
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    // 非法 URL 交给后续 fetch 报错
  }
  const https = envValue(env, 'HTTPS_PROXY') ?? envValue(env, 'https_proxy');
  const http = envValue(env, 'HTTP_PROXY') ?? envValue(env, 'http_proxy');
  const all = envValue(env, 'ALL_PROXY') ?? envValue(env, 'all_proxy');
  return protocol === 'https:' ? (https ?? all ?? http) : (http ?? all ?? https);
}

/** 按当前配置解析目标 URL 应使用的代理（null = 直连） */
export function proxyUrlForTarget(
  config: EffectiveProxyConfig,
  targetUrl: string,
  env: EnvLike = process.env
): string | null {
  if (config.mode === 'off') return null;
  if (config.mode === 'manual') return config.proxyUrl;
  return envProxyUrlFor(targetUrl, env);
}

/** 合并默认 bypass、设置项、env NO_PROXY，去重 */
export function mergeBypassList(stored: string | null, env: EnvLike = process.env): string[] {
  const items = [
    ...splitList(DEFAULT_PROXY_BYPASS),
    ...splitList(stored),
    ...splitList(envValue(env, 'NO_PROXY') ?? envValue(env, 'no_proxy')),
  ];
  return [...new Set(items.map((item) => item.toLowerCase()))];
}

export async function readEffectiveProxyConfig(
  settings: SettingsReader,
  env: EnvLike = process.env
): Promise<EffectiveProxyConfig> {
  const rawMode = await settings.get(PROXY_SETTING_KEYS.mode);
  const mode: ProxyMode = isProxyMode(rawMode)
    ? rawMode
    : hasEnvProxy(env) ? 'env' : 'off';

  const storedUrl = (await settings.get(PROXY_SETTING_KEYS.url))?.trim() || null;
  const envUrl = envProxyUrlFor('https://example.invalid', env);
  const proxyUrl = mode === 'manual' ? storedUrl : mode === 'env' ? envUrl : null;

  // env 模式无法按用途区分（环境变量没有「只代理某类请求」的语义）→ 固定全部用途。
  // manual 模式：未设置过 = 全部用途；显式保存为空 = 全部直连。
  const rawScope = await settings.get(PROXY_SETTING_KEYS.scope);
  const scope = mode === 'env' || rawScope === null
    ? [...PROXY_PURPOSES]
    : parseProxyScope(rawScope) ?? [];

  const fallbackRaw = await settings.get(PROXY_SETTING_KEYS.fallback);

  return {
    mode,
    proxyUrl,
    scope,
    bypass: mergeBypassList(await settings.get(PROXY_SETTING_KEYS.bypass), env),
    fallback: fallbackRaw === null ? true : fallbackRaw === '1',
  };
}

// ============ bypass 匹配 ============

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function matchesIpv4Cidr(host: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const hostInt = ipv4ToInt(host);
  const baseInt = ipv4ToInt(base);
  if (hostInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (hostInt & mask) === (baseInt & mask);
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * 判断主机是否应绕过代理。
 * 支持：`*`、精确主机、`.suffix` / `suffix` 后缀、IPv4 CIDR、IPv6 字面量。
 * 端口不参与匹配（NO_PROXY 常见写法也不带端口）。
 */
export function shouldBypass(hostname: string, bypass: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  for (const rawEntry of bypass) {
    let entry = normalizeHost(rawEntry);
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry.includes('/')) {
      if (!host.includes(':') && matchesIpv4Cidr(host, entry)) return true;
      continue;
    }
    // 去掉 host:port 写法里的端口（IPv6 冒号较多，不处理）
    if (!host.includes(':') && entry.split(':').length === 2) {
      entry = entry.split(':')[0];
    }
    if (entry.startsWith('.')) entry = entry.slice(1);
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}
