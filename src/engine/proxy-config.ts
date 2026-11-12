/**
 * 代理设置模型（v2.46.0：三态目标策略）
 *
 * 设计原则：
 *   1. 代理只有一个配置来源 —— 设置页。运行时不读任何环境变量。
 *   2. 代理是否启用 = proxy_url 是否为空。地址留空即全部直连，不再有独立的「代理模式」。
 *   3. 每个出网目标（target）独立三态：
 *        auto ：先直连（3 秒探测），不通再走代理
 *        on   ：直接走代理，不试直连
 *        off  ：只走直连，失败即报错
 *   4. bypass 一票否决：命中绕过列表的主机永远直连，任何目标策略都改不了。
 *      理由：内网地址走代理不但更慢，多数情况下根本不通。
 *
 * 受策略控制的 5 个出网目标：
 *   - subscription：订阅 URL 抓取
 *   - rules       ：GitHub 规则目录 Trees API
 *   - version     ：GitHub releases.atom 升级检测
 *   - dns         ：DoH 域名解析（dns.google / cloudflare-dns.com）
 *   - geo         ：ip-api IP 归属查询
 *
 * 不经过本模块（永远直连）：
 *   - 节点测活/测速（裸 net.connect / tls.connect，必须反映节点真实可达性）
 *   - 容器 healthcheck（本机回环）
 *   - 「测试代理」按钮（永远走代理，用它验证代理本身）
 */

export type ProxyTargetMode = 'auto' | 'on' | 'off';

export type ProxyTarget = 'subscription' | 'rules' | 'version' | 'dns' | 'geo';

export const PROXY_TARGETS: readonly ProxyTarget[] = [
  'subscription',
  'rules',
  'version',
  'dns',
  'geo',
];

/** 界面显示用的短名，与 PROXY_TARGETS 一一对应 */
export const PROXY_TARGET_LABELS: Record<ProxyTarget, string> = {
  subscription: '订阅拉取',
  rules: '规则目录同步',
  version: '版本检查',
  dns: '域名解析',
  geo: 'IP 归属',
};

/** 每个目标的三态代价说明，直接用于设置页提示 */
export const PROXY_TARGET_HINTS: Record<ProxyTarget, string> = {
  subscription: '所有订阅共用此设置；需按订阅自适应请选「自动」',
  rules: '每月 1 号自动同步一次，失败只写日志',
  version: '打开页面查更新时触发',
  dns: 'DoH 解析节点域名，结果缓存 6 小时',
  geo: 'ip-api 查询节点归属地，结果缓存 30 天',
};

export const DEFAULT_PROXY_TARGET_MODE: ProxyTargetMode = 'auto';

/** auto 模式下直连探测的时限：只用于「握手 + 收到响应头」，不含内容下载 */
export const PROXY_PROBE_TIMEOUT_MS = 3_000;

export const DEFAULT_PROXY_BYPASS =
  'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,.local';

/** 设置页 bypass 输入框旁的快捷标签 */
export const PROXY_BYPASS_PRESETS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '192.168.0.0/16',
  '192.168.2.0/24',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '.local',
];

export const PROXY_SETTING_KEYS = {
  url: 'proxy_url',
  bypass: 'proxy_bypass',
  targets: 'proxy_targets',
  /** 以下为 v2.45.x 及更早版本的键，仅用于一次性迁移 */
  legacyMode: 'proxy_mode',
  legacyScope: 'proxy_scope',
  legacyFallback: 'proxy_fallback',
} as const;

export interface SettingsReader {
  get(key: string): Promise<string | null>;
}

/** 迁移旧配置时需要写回设置，故比 SettingsReader 多一个 set */
export interface SettingsStore extends SettingsReader {
  set(key: string, value: string): Promise<void>;
}

export type EnvLike = Record<string, string | undefined>;

export interface EffectiveProxyConfig {
  /** 代理地址；null = 未配置，全部直连 */
  proxyUrl: string | null;
  /** 5 个目标各自的策略（已补默认值，总是完整） */
  targets: Record<ProxyTarget, ProxyTargetMode>;
  /** 已合并内置默认的绕过列表（小写、去重） */
  bypass: string[];
}

// ============ 基础判定 ============

export function isProxyTarget(value: unknown): value is ProxyTarget {
  return typeof value === 'string' && (PROXY_TARGETS as readonly string[]).includes(value);
}

export function isProxyTargetMode(value: unknown): value is ProxyTargetMode {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** 拆分逗号/空白分隔的列表（bypass、targets 共用） */
export function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ============ 目标策略的序列化 / 解析 ============

/** 把 5 项策略序列化为 `subscription=auto,rules=on,...` */
export function serializeProxyTargets(
  targets: Partial<Record<ProxyTarget, ProxyTargetMode>>
): string {
  return PROXY_TARGETS
    .map((target) => `${target}=${targets[target] ?? DEFAULT_PROXY_TARGET_MODE}`)
    .join(',');
}

/**
 * 解析 `proxy_targets`。
 * 返回 null 表示「从未保存过」，让调用方可以区分「没配过 → 用默认」与「显式保存 → 用存值」。
 */
export function parseProxyTargets(
  raw: string | null | undefined
): Partial<Record<ProxyTarget, ProxyTargetMode>> | null {
  if (raw === null || raw === undefined) return null;
  const parsed: Partial<Record<ProxyTarget, ProxyTargetMode>> = {};
  for (const entry of splitList(raw)) {
    const [key, value] = entry.split('=');
    if (!isProxyTarget(key) || !isProxyTargetMode(value)) continue;
    parsed[key] = value;
  }
  return parsed;
}

/** 把任意（可能不完整的）策略补成完整 5 项 */
export function resolveProxyTargets(
  parsed: Partial<Record<ProxyTarget, ProxyTargetMode>> | null | undefined
): Record<ProxyTarget, ProxyTargetMode> {
  const resolved = {} as Record<ProxyTarget, ProxyTargetMode>;
  for (const target of PROXY_TARGETS) {
    resolved[target] = parsed?.[target] ?? DEFAULT_PROXY_TARGET_MODE;
  }
  return resolved;
}

// ============ 代理地址 ============

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
 * 三段式输入拼装：`http://1.2.3.4:7893`。
 * host 为空时返回空字符串（= 不使用代理）。
 */
export function buildProxyUrl(protocol: string, host: string, port: string): string {
  const scheme = protocol === 'https' ? 'https' : 'http';
  const trimmedHost = host.trim();
  if (!trimmedHost) return '';
  const trimmedPort = port.trim();
  return trimmedPort ? `${scheme}://${trimmedHost}:${trimmedPort}` : `${scheme}://${trimmedHost}`;
}

export interface ProxyUrlParts {
  protocol: 'http' | 'https';
  host: string;
  port: string;
  /** 地址里还有三段式装不下的内容（账号密码 / 路径 / 查询），需要走「高级」编辑 */
  advanced: boolean;
}

/** 把已存地址拆回三段，供表单回显 */
export function splitProxyUrl(url: string | null): ProxyUrlParts {
  const empty: ProxyUrlParts = { protocol: 'http', host: '', port: '', advanced: false };
  if (!url) return empty;
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
    const hasExtra = !!parsed.username || !!parsed.password
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || !!parsed.search;
    return {
      protocol,
      host: parsed.hostname,
      port: parsed.port,
      advanced: hasExtra,
    };
  } catch {
    return empty;
  }
}

export function readLegacyEnvProxyUrl(env: EnvLike = process.env): string | null {
  const candidates = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.ALL_PROXY,
    env.all_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed && isValidProxyUrl(trimmed)) return trimmed;
  }
  return null;
}

// ============ 旧配置迁移 ============

const LEGACY_SCOPE_MAP: Record<string, ProxyTarget[]> = {
  subscription: ['subscription'],
  github: ['rules', 'version'],
  geo: ['dns', 'geo'],
};

/**
 * 把 v2.45.x 及更早的 `proxy_mode` + `proxy_scope` 迁移为 `proxy_targets`。
 *
 * 映射规则：
 *   - proxy_targets 已存在            → 不动（已迁移或用户保存过）
 *   - 两个旧键都不存在（全新安装）     → 不动
 *   - proxy_mode = off                → 5 项全部 off（旧语义「全部直连」）
 *   - proxy_scope 从未保存            → 5 项全部 auto（新的零配置默认）
 *   - proxy_scope 保存过（含空串）     → 勾选的 on，未勾选的 off
 *                                       （旧语义里「勾选」就是允许且默认走代理，等价 on）
 *
 * 迁完不删除旧键：万一要回滚旧版本，旧配置还在。旧键从此不再被读取。
 */
export async function migrateLegacyProxyConfig(
  settings: SettingsStore
): Promise<'migrated' | 'none'> {
  const existing = await settings.get(PROXY_SETTING_KEYS.targets);
  if (existing !== null) return 'none';

  const [modeRaw, scopeRaw] = await Promise.all([
    settings.get(PROXY_SETTING_KEYS.legacyMode),
    settings.get(PROXY_SETTING_KEYS.legacyScope),
  ]);
  if (modeRaw === null && scopeRaw === null) return 'none';

  const targets: Record<ProxyTarget, ProxyTargetMode> = resolveProxyTargets(null);

  if (modeRaw === 'off') {
    for (const target of PROXY_TARGETS) targets[target] = 'off';
  } else if (scopeRaw !== null) {
    const enabled = new Set<ProxyTarget>();
    for (const raw of splitList(scopeRaw)) {
      for (const target of LEGACY_SCOPE_MAP[raw] ?? []) enabled.add(target);
    }
    for (const target of PROXY_TARGETS) {
      targets[target] = enabled.has(target) ? 'on' : 'off';
    }
  }

  await settings.set(PROXY_SETTING_KEYS.targets, serializeProxyTargets(targets));
  return 'migrated';
}

/**
 * v2.44.3 迁移：把更早期「依赖环境变量代理」的部署一次性导入为手动地址。
 * 现在没有 mode 概念，只要 proxy_url 为空且环境里有代理才导入。
 */
export async function migrateLegacyEnvProxy(
  settings: SettingsStore,
  env: EnvLike = process.env
): Promise<'imported' | 'none'> {
  const existingUrl = (await settings.get(PROXY_SETTING_KEYS.url))?.trim();
  if (existingUrl) return 'none';
  const envUrl = readLegacyEnvProxyUrl(env);
  if (!envUrl) return 'none';
  await settings.set(PROXY_SETTING_KEYS.url, envUrl);
  return 'imported';
}

// ============ 读取配置 ============

/** 合并内置默认 bypass 与设置项，去重 */
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
  const [urlRaw, targetsRaw, bypassRaw] = await Promise.all([
    settings.get(PROXY_SETTING_KEYS.url),
    settings.get(PROXY_SETTING_KEYS.targets),
    settings.get(PROXY_SETTING_KEYS.bypass),
  ]);

  const proxyUrl = urlRaw?.trim() || null;
  return {
    proxyUrl,
    targets: resolveProxyTargets(parseProxyTargets(targetsRaw)),
    bypass: mergeBypassList(bypassRaw),
  };
}

/** 设置页表单用：用户真正保存过的原始值（null = 从未保存），不含推断 / 合并 */
export interface RawProxyConfig {
  url: string | null;
  targets: Partial<Record<ProxyTarget, ProxyTargetMode>> | null;
  bypass: string | null;
}

export async function readRawProxyConfig(settings: SettingsReader): Promise<RawProxyConfig> {
  const [urlRaw, targetsRaw, bypassRaw] = await Promise.all([
    settings.get(PROXY_SETTING_KEYS.url),
    settings.get(PROXY_SETTING_KEYS.targets),
    settings.get(PROXY_SETTING_KEYS.bypass),
  ]);
  return {
    url: urlRaw?.trim() || null,
    targets: parseProxyTargets(targetsRaw),
    bypass: bypassRaw ?? null,
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
