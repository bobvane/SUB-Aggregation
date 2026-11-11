/**
 * 代理设置模型（v2.44.0，v2.44.3 收敛为「直连 / 手动」两态）
 *
 * 目标：代理只有一个配置来源 —— 设置页。
 *   - off    ：全部直连
 *   - manual ：使用设置页保存的 proxy_url
 *
 * v2.44.3：移除 `env` 模式。Docker Compose 只把 `environment:` 里声明的变量
 * 传进容器，保留「跟随环境变量」必然要求 compose 继续传递 HTTP_PROXY/HTTPS_PROXY，
 * 等于保留第二个配置入口。老部署的环境变量代理在启动时一次性导入为 manual。
 *
 * 用途（purpose）：
 *   - subscription：订阅抓取（默认不代理，保留单条订阅强制代理的逃生口）
 *   - github      ：升级检测 + 规则目录同步
 *   - geo         ：DoH 域名解析 + ip-api 归属查询
 *
 * 节点测活/测速永远直连（net.connect / tls.connect），不经过本模块。
 */

export type ProxyMode = 'off' | 'manual';
export type ProxyPurpose = 'subscription' | 'github' | 'geo';
export type ProxyChoice = 'auto' | 'on' | 'off';

export interface SettingsReader {
  get(key: string): Promise<string | null>;
}

/** 迁移旧配置时需要写回设置，故比 SettingsReader 多一个 set */
export interface SettingsStore extends SettingsReader {
  set(key: string, value: string): Promise<void>;
}

export type EnvLike = Record<string, string | undefined>;

export interface EffectiveProxyConfig {
  mode: ProxyMode;
  /** 供界面展示的代理地址（仅 manual 模式有值） */
  proxyUrl: string | null;
  scope: ProxyPurpose[];
  bypass: string[];
  /** 首选通道失败时是否自动尝试另一条通道（仅 auto 生效） */
  fallback: boolean;
}

export const PROXY_PURPOSES: readonly ProxyPurpose[] = ['subscription', 'github', 'geo'];

/**
 * 从未保存过 proxy_scope 时的默认用途。
 * 订阅抓取默认直连：订阅 URL 必须能在没有代理的手机 / App 里直接拉取，
 * 用代理抓取会掩盖其真实可达性，且代理超时会被记成「Fetch timeout」。
 * 用户仍可对单条订阅显式选择「强制走代理」作为逃生口。
 */
export const DEFAULT_PROXY_SCOPE: readonly ProxyPurpose[] = ['github', 'geo'];

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
  return value === 'off' || value === 'manual';
}

export function isProxyPurpose(value: unknown): value is ProxyPurpose {
  return value === 'subscription' || value === 'github' || value === 'geo';
}

export function isProxyChoice(value: unknown): value is ProxyChoice {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** 拆分逗号/空白分隔的列表（bypass、scope 共用） */
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

/**
 * 读取旧版部署遗留的代理环境变量。仅用于 v2.44.3 的一次性迁移，
 * 运行时的代理选择不再读取任何环境变量。
 */
export function readLegacyEnvProxyUrl(env: EnvLike = process.env): string | null {
  const candidates = [
    envValue(env, 'HTTPS_PROXY'),
    envValue(env, 'https_proxy'),
    envValue(env, 'ALL_PROXY'),
    envValue(env, 'all_proxy'),
    envValue(env, 'HTTP_PROXY'),
    envValue(env, 'http_proxy'),
  ];
  for (const candidate of candidates) {
    if (candidate && isValidProxyUrl(candidate)) return candidate;
  }
  return null;
}

/**
 * v2.44.3 迁移：把旧的 env 模式 / 未保存模式但存在环境变量代理的部署，
 * 一次性导入为 manual 模式，避免升级后代理静默失效。
 *
 * 返回值：
 *   - imported：已把环境变量代理写入 manual
 *   - disabled：旧 env 模式已停用（且没有可导入的地址），当前直连
 *   - none    ：无需处理
 */
export async function migrateLegacyEnvProxy(
  settings: SettingsStore,
  env: EnvLike = process.env
): Promise<'imported' | 'disabled' | 'none'> {
  const rawMode = await settings.get(PROXY_SETTING_KEYS.mode);
  if (rawMode === 'manual' || rawMode === 'off') return 'none';

  const envUrl = readLegacyEnvProxyUrl(env);

  // 显式保存过 env：能导入就导入，否则退回直连
  if (rawMode === 'env') {
    if (envUrl) {
      await settings.set(PROXY_SETTING_KEYS.mode, 'manual');
      await settings.set(PROXY_SETTING_KEYS.url, envUrl);
      return 'imported';
    }
    await settings.set(PROXY_SETTING_KEYS.mode, 'off');
    return 'disabled';
  }

  // 从未保存过模式：旧行为是「有环境变量代理就自动 env」，这里保持等价
  if (!envUrl) return 'none';
  await settings.set(PROXY_SETTING_KEYS.mode, 'manual');
  await settings.set(PROXY_SETTING_KEYS.url, envUrl);
  return 'imported';
}

/** 按当前配置解析目标应使用的代理（null = 直连） */
export function proxyUrlForTarget(config: EffectiveProxyConfig): string | null {
  return config.mode === 'manual' ? config.proxyUrl : null;
}

/** 合并内置默认 bypass 与设置项，去重（v2.44.3 起不再读 NO_PROXY） */
export function mergeBypassList(stored: string | null): string[] {
  const items = [
    ...splitList(DEFAULT_PROXY_BYPASS),
    ...splitList(stored),
  ];
  return [...new Set(items.map((item) => item.toLowerCase()))];
}

export async function readEffectiveProxyConfig(
  settings: SettingsReader
): Promise<EffectiveProxyConfig> {
  const rawMode = await settings.get(PROXY_SETTING_KEYS.mode);
  const mode: ProxyMode = isProxyMode(rawMode) ? rawMode : 'off';

  const storedUrl = (await settings.get(PROXY_SETTING_KEYS.url))?.trim() || null;
  const proxyUrl = mode === 'manual' ? storedUrl : null;

  // 未设置过 = 默认 github + geo（订阅直连）；显式保存为空字符串 = 全部直连。
  const rawScope = await settings.get(PROXY_SETTING_KEYS.scope);
  const scope = rawScope === null
    ? [...DEFAULT_PROXY_SCOPE]
    : parseProxyScope(rawScope) ?? [];

  const fallbackRaw = await settings.get(PROXY_SETTING_KEYS.fallback);

  return {
    mode,
    proxyUrl,
    scope,
    bypass: mergeBypassList(await settings.get(PROXY_SETTING_KEYS.bypass)),
    fallback: fallbackRaw === null ? true : fallbackRaw === '1',
  };
}

/** 设置页表单用：原始存储值（null = 从未保存），不含任何推断 / 合并 */
export interface RawProxyConfig {
  mode: ProxyMode | null;
  url: string | null;
  scope: ProxyPurpose[] | null;
  bypass: string | null;
  fallback: boolean | null;
}

/**
 * 与 readEffectiveProxyConfig 区分开：那里返回的是「生效值」（推断 mode、
 * 合并 bypass），适合运行时使用；这里返回的是「用户配置值」，适合回显到表单。
 * 把生效值直接回存会把推断结果固化，v2.44.2 前设置页因此产生过 400 与配置漂移。
 */
export async function readRawProxyConfig(settings: SettingsReader): Promise<RawProxyConfig> {
  const [modeRaw, urlRaw, scopeRaw, bypassRaw, fallbackRaw] = await Promise.all([
    settings.get(PROXY_SETTING_KEYS.mode),
    settings.get(PROXY_SETTING_KEYS.url),
    settings.get(PROXY_SETTING_KEYS.scope),
    settings.get(PROXY_SETTING_KEYS.bypass),
    settings.get(PROXY_SETTING_KEYS.fallback),
  ]);
  return {
    mode: isProxyMode(modeRaw) ? modeRaw : null,
    url: urlRaw?.trim() || null,
    scope: scopeRaw === null ? null : parseProxyScope(scopeRaw) ?? [],
    bypass: bypassRaw ?? null,
    fallback: fallbackRaw === null ? null : fallbackRaw === '1',
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
 * 端口不参与匹配。
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
