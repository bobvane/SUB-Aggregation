/**
 * 家宽实验服务（v2.50.9，独立模块）
 *
 * 目标：拉取 VPN Gate 的免费中继列表，做「端口连通」+「是否住宅 IP」评分，
 * 在独立页面展示。与节点列表、输出配置、健康数据、WARP 实验页完全隔离。
 *
 * 隔离约定：
 *   - 只读写 home_lab:*；
 *   - 不 import config.service / node-probe / models/node；
 *   - 不写 nodes:* / health:* / settings:*。
 *
 * 重要口径：
 *   - VPN Gate 是志愿者网络，很多中继确实是家庭宽带，但不是全部；
 *   - 「住宅」是 ip-api + ipapi.is 多信号评分，不是 100% 证明；
 *   - v1 只做 TCP 端口可达测试；真正的 OpenVPN 隧道/测速后续再加。
 */

import net from 'node:net';
import type { FetchFn } from '@/engine/http-client';
import type { KVStorage } from '@/storage/kv';

export const HOME_LAB_SETTINGS_KEY = 'home_lab:settings';
export const HOME_LAB_NODES_KEY = 'home_lab:nodes';
export const HOME_LAB_INTEL_PREFIX = 'home_lab:intel:';

export const HOME_LAB_DEFAULT_SOURCE_URL = 'https://www.vpngate.net/api/iphone/';
export const HOME_LAB_DEFAULT_INTERVAL_HOURS = 12;
export const HOME_LAB_MAX_NODES = 300;
export const HOME_LAB_MAX_CSV_BYTES = 8 * 1024 * 1024;
export const HOME_LAB_INTEL_TTL_SECONDS = 7 * 24 * 3600;
/** 单次刷新最多对多少个 IP 调 ipapi.is（免费额度有限，其余只走 ip-api 批量） */
export const HOME_LAB_IPAPIIS_MAX = 60;

export interface HomeLabSettings {
  enabled: boolean;
  sourceUrl: string;
  intervalHours: number;
  /** 上次成功拉取 */
  lastFetchAt: number | null;
  /** 上次尝试（成功或失败），用于避免失败后每分钟重试 */
  lastAttemptAt: number | null;
  lastError: string | null;
  lastCount: number;
}

export type HomeLabClass =
  | 'residential'
  | 'likely_residential'
  | 'datacenter'
  | 'proxy'
  | 'unknown';

export interface HomeLabIntel {
  country?: string;
  isp?: string;
  org?: string;
  as?: string;
  asname?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
  isDatacenter?: boolean;
  isVpn?: boolean;
  isProxy?: boolean;
  isTor?: boolean;
  companyType?: string;
  asnType?: string;
  source: 'ip-api' | 'ipapi.is' | 'both';
  checkedAt: number;
}

export interface HomeLabTcpState {
  reachable: boolean | null;
  latencyMs: number | null;
  checkedAt: number | null;
}

export interface HomeLabNode {
  id: string;
  ip: string;
  port: number;
  proto: 'tcp' | 'udp' | 'unknown';
  countryShort: string;
  countryLong: string;
  operator: string;
  hostName: string;
  score: number;
  pingMs: number | null;
  speedBps: number | null;
  sessions: number | null;
  uptime: number | null;
  class: HomeLabClass;
  confidence: number;
  reasons: string[];
  intel: HomeLabIntel | null;
  tcp: HomeLabTcpState;
  lastSeenAt: number;
}

export interface HomeLabRefreshResult {
  fetched: number;
  parsed: number;
  skipped: number;
  residential: number;
  likelyResidential: number;
  datacenter: number;
  proxy: number;
  unknown: number;
  fetchedAt: number;
}

function defaultSettings(): HomeLabSettings {
  return {
    enabled: false,
    sourceUrl: HOME_LAB_DEFAULT_SOURCE_URL,
    intervalHours: HOME_LAB_DEFAULT_INTERVAL_HOURS,
    lastFetchAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastCount: 0,
  };
}

function normalizeSettings(raw: Partial<HomeLabSettings> | null | undefined): HomeLabSettings {
  const d = defaultSettings();
  const interval = Number(raw?.intervalHours);
  const url = typeof raw?.sourceUrl === 'string' ? raw.sourceUrl.trim() : '';
  return {
    enabled: raw?.enabled === true,
    sourceUrl: /^https?:\/\//i.test(url) ? url : d.sourceUrl,
    intervalHours:
      Number.isInteger(interval) && interval >= 1 && interval <= 168
        ? interval
        : d.intervalHours,
    lastFetchAt:
      typeof raw?.lastFetchAt === 'number' && raw.lastFetchAt > 0 ? raw.lastFetchAt : null,
    lastAttemptAt:
      typeof raw?.lastAttemptAt === 'number' && raw.lastAttemptAt > 0
        ? raw.lastAttemptAt
        : null,
    lastError: typeof raw?.lastError === 'string' && raw.lastError ? raw.lastError : null,
    lastCount:
      typeof raw?.lastCount === 'number' && raw.lastCount >= 0 ? raw.lastCount : 0,
  };
}

export async function readHomeLabSettings(kv: KVStorage): Promise<HomeLabSettings> {
  try {
    const raw = await kv.get(HOME_LAB_SETTINGS_KEY);
    if (!raw) return defaultSettings();
    return normalizeSettings(JSON.parse(raw) as Partial<HomeLabSettings>);
  } catch {
    return defaultSettings();
  }
}

export async function saveHomeLabSettings(
  kv: KVStorage,
  settings: Partial<HomeLabSettings>
): Promise<HomeLabSettings> {
  const current = await readHomeLabSettings(kv);
  const next = normalizeSettings({ ...current, ...settings });
  await kv.put(HOME_LAB_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function readHomeLabNodes(kv: KVStorage): Promise<HomeLabNode[]> {
  try {
    const raw = await kv.get(HOME_LAB_NODES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HomeLabNode[]) : [];
  } catch {
    return [];
  }
}

export async function saveHomeLabNodes(kv: KVStorage, nodes: HomeLabNode[]): Promise<void> {
  await kv.put(HOME_LAB_NODES_KEY, JSON.stringify(nodes));
}

export async function clearHomeLab(kv: KVStorage): Promise<void> {
  await kv.delete(HOME_LAB_SETTINGS_KEY);
  await kv.delete(HOME_LAB_NODES_KEY);
  try {
    const intel = await kv.list(HOME_LAB_INTEL_PREFIX);
    await Promise.all(intel.map((x) => kv.delete(x.key)));
  } catch {
    // 缓存清理失败不影响主数据
  }
}

// ===== VPN Gate CSV =====

interface RawVpnGateNode {
  id: string;
  ip: string;
  port: number;
  proto: 'tcp' | 'udp' | 'unknown';
  countryShort: string;
  countryLong: string;
  operator: string;
  hostName: string;
  score: number;
  pingMs: number | null;
  speedBps: number | null;
  sessions: number | null;
  uptime: number | null;
  lastSeenAt: number;
}

/** 解析一行 CSV，支持双引号包裹与 "" 转义（国家/运营商里可能有逗号） */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function decodeBase64Text(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const text = Buffer.from(s, 'base64').toString('utf8');
    return text.includes('client') || text.includes('remote') ? text : null;
  } catch {
    return null;
  }
}

export function extractOpenVpnRemote(profile: string): {
  ip: string | null;
  port: number | null;
  proto: 'tcp' | 'udp' | 'unknown';
} {
  const remote = /^\s*remote\s+(\S+)\s+(\d+)/m.exec(profile);
  const protoMatch = /^\s*proto\s+(tcp|udp)/im.exec(profile);
  return {
    ip: remote ? remote[1] : null,
    port: remote ? Number(remote[2]) : null,
    proto: protoMatch ? (protoMatch[1].toLowerCase() as 'tcp' | 'udp') : 'unknown',
  };
}

/**
 * 解析 VPN Gate 的 CSV。
 * 表头：HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,
 *       Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64
 */
export function parseVpnGateCsv(text: string): { nodes: RawVpnGateNode[]; skipped: number } {
  const nodes: RawVpnGateNode[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
    const fields = parseCsvLine(trimmed);
    if (fields.length < 15) {
      skipped++;
      continue;
    }
    const [
      hostName,
      csvIp,
      score,
      ping,
      speed,
      countryLong,
      countryShort,
      sessions,
      uptime,
      ,
      ,
      ,
      operator,
      ,
      profileB64,
    ] = fields;

    const profile = decodeBase64Text(profileB64 ?? '');
    const remote = profile ? extractOpenVpnRemote(profile) : { ip: null, port: null, proto: 'unknown' as const };
    const ip = (csvIp || remote.ip || '').trim();
    const port = remote.port ?? 0;
    if (!ip || !port) {
      skipped++;
      continue;
    }
    const cc = (countryShort || '').trim().toUpperCase();
    const id = `${cc.toLowerCase() || 'xx'}-${ip}-${port}`;
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      ip,
      port,
      proto: remote.proto,
      countryShort: cc,
      countryLong: (countryLong || '').trim(),
      operator: (operator || '').trim(),
      hostName: (hostName || '').trim(),
      score: toIntOrNull(score) ?? 0,
      pingMs: toIntOrNull(ping),
      speedBps: toIntOrNull(speed),
      sessions: toIntOrNull(sessions),
      uptime: toIntOrNull(uptime),
      lastSeenAt: Date.now(),
    });
  }
  return { nodes, skipped };
}

// ===== IP 情报（ip-api + ipapi.is） =====

interface IpApiRow {
  status?: string;
  country?: string;
  countryCode?: string;
  isp?: string;
  org?: string;
  as?: string;
  asname?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
  query?: string;
}

interface IpApiIsRow {
  ip?: string;
  is_datacenter?: boolean;
  is_vpn?: boolean;
  is_proxy?: boolean;
  is_tor?: boolean;
  company?: { name?: string; type?: string };
  asn?: { asn?: number; org?: string; type?: string };
  location?: { country_code?: string };
}

async function fetchIpApiBatch(
  ips: string[],
  fetchFn: FetchFn
): Promise<Map<string, IpApiRow>> {
  const out = new Map<string, IpApiRow>();
  for (let i = 0; i < ips.length; i += 100) {
    const batch = ips.slice(i, i + 100);
    try {
      const res = await fetchFn(
        'http://ip-api.com/batch?fields=status,country,countryCode,isp,org,as,asname,mobile,proxy,hosting,query',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!res.ok) continue;
      const rows = (await res.json()) as IpApiRow[];
      for (const row of rows) {
        if (row && row.query) out.set(row.query, row);
      }
    } catch {
      // 单批失败不阻塞其余批次
    }
  }
  return out;
}

async function fetchIpApiIs(ip: string, fetchFn: FetchFn): Promise<IpApiIsRow | null> {
  try {
    const res = await fetchFn(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return (await res.json()) as IpApiIsRow;
  } catch {
    return null;
  }
}

async function readIntelCache(kv: KVStorage, ip: string): Promise<HomeLabIntel | null> {
  try {
    const raw = await kv.get(HOME_LAB_INTEL_PREFIX + ip);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomeLabIntel;
    return parsed && typeof parsed.checkedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeIntelCache(kv: KVStorage, ip: string, intel: HomeLabIntel): Promise<void> {
  try {
    await kv.put(HOME_LAB_INTEL_PREFIX + ip, JSON.stringify(intel), {
      expirationTtl: HOME_LAB_INTEL_TTL_SECONDS,
    });
  } catch {
    // 缓存写失败不影响本次结果
  }
}

function mergeIntel(ipApi: IpApiRow | undefined, ipApiIs: IpApiIsRow | null): HomeLabIntel | null {
  if (!ipApi && !ipApiIs) return null;
  const intel: HomeLabIntel = {
    source: ipApiIs ? 'both' : 'ip-api',
    checkedAt: Date.now(),
  };
  if (ipApi) {
    intel.country = ipApi.countryCode;
    intel.isp = ipApi.isp;
    intel.org = ipApi.org;
    intel.as = ipApi.as;
    intel.asname = ipApi.asname;
    intel.mobile = ipApi.mobile;
    intel.proxy = ipApi.proxy;
    intel.hosting = ipApi.hosting;
  }
  if (ipApiIs) {
    intel.isDatacenter = ipApiIs.is_datacenter;
    intel.isVpn = ipApiIs.is_vpn;
    intel.isProxy = ipApiIs.is_proxy;
    intel.isTor = ipApiIs.is_tor;
    intel.companyType = ipApiIs.company?.type;
    intel.asnType = ipApiIs.asn?.type;
    if (!intel.country && ipApiIs.location?.country_code) {
      intel.country = ipApiIs.location.country_code;
    }
  }
  return intel;
}

// 常见机房 ASN：命中即判 datacenter
const DATACENTER_ASNS = new Set([
  9009, 13335, 16509, 15169, 14061, 16276, 24940, 20473, 63949, 60781, 41378,
  45102, 31898, 132203, 37963, 45090, 26496, 36351, 199524, 51167,
]);

const DATACENTER_WORDS = [
  'hosting', 'datacenter', 'data center', 'cloud', 'vps', 'server',
  'digitalocean', 'amazon', 'aws', 'google', 'microsoft', 'azure',
  'hetzner', 'ovh', 'linode', 'vultr', 'contabo', 'm247', 'choopa',
  'leaseweb', 'oracle', 'alibaba', 'tencent', 'cloudflare', 'kamatera',
];

const RESIDENTIAL_WORDS = [
  'telecom', 'communications', 'cable', 'broadband', 'fiber', 'dsl',
  'mobile', 'wireless', 'comcast', 'at&t', 'verizon', 'vodafone',
  'ntt', 'kddi', 'softbank', 'china telecom', 'china unicom', 'china mobile',
  'korea telecom', 'sk broadband', 'lg u+', 'chunghwa', 'hinet',
  'singtel', 'starhub', 'rogers', 'bell canada', 'telstra',
];

function parseAsnNumber(as: string | undefined): number | null {
  if (!as) return null;
  const m = /^AS(\d+)/i.exec(as.trim());
  return m ? Number(m[1]) : null;
}

function hasWord(haystack: string, words: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const w of words) {
    if (lower.includes(w)) return w;
  }
  return null;
}

export interface HomeLabClassification {
  class: HomeLabClass;
  confidence: number;
  reasons: string[];
}

/**
 * 住宅判断：多信号评分。
 * 与 xehn 的区别：没有信号时判 unknown，而不是默认 residential。
 */
export function classifyHomeLabNode(
  hostName: string,
  intel: HomeLabIntel | null
): HomeLabClassification {
  const reasons: string[] = [];
  const ispText = [intel?.isp, intel?.org, intel?.asname, intel?.as].filter(Boolean).join(' ');

  if (intel?.isDatacenter === true) {
    reasons.push('ipapi.is: is_datacenter');
    return { class: 'datacenter', confidence: 92, reasons };
  }
  if (intel?.hosting === true) {
    reasons.push('ip-api: hosting=true');
    return { class: 'datacenter', confidence: 90, reasons };
  }
  if (intel?.companyType === 'hosting' || intel?.asnType === 'hosting') {
    reasons.push(`ipapi.is: type=${intel.companyType ?? intel.asnType}`);
    return { class: 'datacenter', confidence: 88, reasons };
  }
  if (intel?.isVpn === true || intel?.isProxy === true || intel?.proxy === true) {
    if (intel.isVpn) reasons.push('ipapi.is: is_vpn');
    if (intel.isProxy) reasons.push('ipapi.is: is_proxy');
    if (intel.proxy) reasons.push('ip-api: proxy=true');
    return { class: 'proxy', confidence: 85, reasons };
  }
  if (intel?.mobile === true) {
    reasons.push('ip-api: mobile=true');
    return { class: 'residential', confidence: 80, reasons };
  }
  if (/^public-vpn/i.test(hostName)) {
    reasons.push('hostname: public-vpn-*');
    return { class: 'datacenter', confidence: 70, reasons };
  }

  const asn = parseAsnNumber(intel?.as);
  if (asn !== null && DATACENTER_ASNS.has(asn)) {
    reasons.push(`ASN AS${asn} 属于常见机房`);
    return { class: 'datacenter', confidence: 75, reasons };
  }

  const dcWord = hasWord(ispText, DATACENTER_WORDS);
  if (dcWord) {
    reasons.push(`ISP/AS 命中机房关键词: ${dcWord}`);
    return { class: 'datacenter', confidence: 72, reasons };
  }

  // VPN Gate 的 vpn* 志愿者中继（非 public-vpn）大多是家庭宽带；
  // 这是弱信号，标成「疑似住宅」而不是「住宅」。
  if (/^vpn\d/i.test(hostName)) {
    reasons.push('hostname: vpn*（VPN Gate 志愿者中继）');
    return { class: 'likely_residential', confidence: 55, reasons };
  }

  const resWord = hasWord(ispText, RESIDENTIAL_WORDS);
  if (resWord) {
    reasons.push(`ISP/AS 命中家宽关键词: ${resWord}`);
    return { class: 'likely_residential', confidence: 65, reasons };
  }

  if (intel?.isp || intel?.org) {
    reasons.push('有 ISP/ORG 信息，但无明确住宅/机房信号');
    return { class: 'unknown', confidence: 25, reasons };
  }
  reasons.push('无足够 IP 情报');
  return { class: 'unknown', confidence: 0, reasons };
}

async function enrichIntel(
  kv: KVStorage,
  ips: string[],
  intelFetch: FetchFn
): Promise<Map<string, HomeLabIntel>> {
  const out = new Map<string, HomeLabIntel>();
  const uncached: string[] = [];
  for (const ip of ips) {
    const cached = await readIntelCache(kv, ip);
    if (cached) out.set(ip, cached);
    else uncached.push(ip);
  }
  if (uncached.length === 0) return out;

  const ipApi = await fetchIpApiBatch(uncached, intelFetch);
  // ipapi.is 免费额度有限：只对前 N 个未缓存 IP 做二次确认
  const secondary = uncached.slice(0, HOME_LAB_IPAPIIS_MAX);
  const ipApiIs = new Map<string, IpApiIsRow>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < secondary.length) {
      const ip = secondary[cursor++];
      const row = await fetchIpApiIs(ip, intelFetch);
      if (row) ipApiIs.set(ip, row);
    }
  };
  await Promise.all([worker(), worker()]);

  for (const ip of uncached) {
    const merged = mergeIntel(ipApi.get(ip), ipApiIs.get(ip) ?? null);
    if (!merged) continue;
    out.set(ip, merged);
    await writeIntelCache(kv, ip, merged);
  }
  return out;
}

// ===== 拉取与刷新 =====

let refreshInFlight = false;

export function isHomeLabRefreshInFlight(): boolean {
  return refreshInFlight;
}

export async function refreshHomeLab(
  kv: KVStorage,
  sourceFetch: FetchFn,
  intelFetch: FetchFn
): Promise<HomeLabRefreshResult> {
  if (refreshInFlight) throw new Error('家宽实验正在拉取中，请稍候');
  refreshInFlight = true;
  const settings = await readHomeLabSettings(kv);
  const now = Date.now();
  try {
    const res = await sourceFetch(settings.sourceUrl, {
      headers: { 'User-Agent': 'SUB-Aggregation-HomeLab/1.0' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`VPN Gate HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > HOME_LAB_MAX_CSV_BYTES) {
      throw new Error(`VPN Gate 响应过大（${text.length} 字节）`);
    }
    const { nodes: raw, skipped } = parseVpnGateCsv(text);
    if (raw.length === 0) throw new Error('VPN Gate 返回 0 个可用中继');

    const clipped = raw
      .sort((a, b) => b.score - a.score)
      .slice(0, HOME_LAB_MAX_NODES);
    const ips = [...new Set(clipped.map((n) => n.ip))];
    const intel = await enrichIntel(kv, ips, intelFetch);

    const nodes: HomeLabNode[] = clipped.map((n) => {
      const nodeIntel = intel.get(n.ip) ?? null;
      const c = classifyHomeLabNode(n.hostName, nodeIntel);
      return {
        ...n,
        class: c.class,
        confidence: c.confidence,
        reasons: c.reasons,
        intel: nodeIntel,
        tcp: { reachable: null, latencyMs: null, checkedAt: null },
      };
    });
    // 住宅优先展示：同类内按 VPN Gate Score 降序
    const classRank: Record<HomeLabClass, number> = {
      residential: 0,
      likely_residential: 1,
      datacenter: 2,
      proxy: 3,
      unknown: 4,
    };
    nodes.sort(
      (a, b) => classRank[a.class] - classRank[b.class] || b.score - a.score
    );

    await saveHomeLabNodes(kv, nodes);
    await saveHomeLabSettings(kv, {
      lastFetchAt: now,
      lastAttemptAt: now,
      lastError: null,
      lastCount: nodes.length,
    });

    return {
      fetched: raw.length,
      parsed: nodes.length,
      skipped,
      residential: nodes.filter((n) => n.class === 'residential').length,
      likelyResidential: nodes.filter((n) => n.class === 'likely_residential').length,
      datacenter: nodes.filter((n) => n.class === 'datacenter').length,
      proxy: nodes.filter((n) => n.class === 'proxy').length,
      unknown: nodes.filter((n) => n.class === 'unknown').length,
      fetchedAt: now,
    };
  } catch (e) {
    await saveHomeLabSettings(kv, { lastAttemptAt: now, lastError: (e as Error).message });
    throw e;
  } finally {
    refreshInFlight = false;
  }
}

/** 每分钟 cron 调用：总开关关闭直接短路；未到间隔直接返回 */
export async function maybeFetchHomeLab(
  kv: KVStorage,
  sourceFetch: FetchFn,
  intelFetch: FetchFn
): Promise<HomeLabRefreshResult | null> {
  const settings = await readHomeLabSettings(kv);
  if (!settings.enabled) return null;
  const now = Date.now();
  const anchor = settings.lastAttemptAt ?? 0;
  if (anchor > 0 && now - anchor < settings.intervalHours * 3_600_000 - 60_000) {
    return null;
  }
  try {
    return await refreshHomeLab(kv, sourceFetch, intelFetch);
  } catch (e) {
    console.warn(`[HomeLab] 自动拉取失败: ${(e as Error).message}`);
    return null;
  }
}

// ===== 端口联通测试 =====

export function testTcpReachable(
  ip: string,
  port: number,
  timeoutMs = 6000
): Promise<{ reachable: boolean; latencyMs: number | null }> {
  return new Promise((resolve) => {
    if (!ip || !port) {
      resolve({ reachable: false, latencyMs: null });
      return;
    }
    const started = Date.now();
    const socket = net.connect({ host: ip, port, timeout: timeoutMs });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable,
        latencyMs: reachable ? Math.max(1, Date.now() - started) : null,
      });
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function testHomeLabNode(
  kv: KVStorage,
  id: string
): Promise<HomeLabNode | null> {
  const nodes = await readHomeLabNodes(kv);
  const index = nodes.findIndex((n) => n.id === id);
  if (index < 0) return null;
  const node = nodes[index];
  // v1 只做 TCP 端口测试；UDP 中继要等 OpenVPN 隧道测试，不能用 TCP 误判
  if (node.proto === 'udp') return node;
  const result = await testTcpReachable(node.ip, node.port);
  node.tcp = {
    reachable: result.reachable,
    latencyMs: result.latencyMs,
    checkedAt: Date.now(),
  };
  nodes[index] = node;
  await saveHomeLabNodes(kv, nodes);
  return node;
}

export async function testAllHomeLabNodes(
  kv: KVStorage,
  concurrency = 8,
  ids?: string[]
): Promise<{ total: number; reachable: number; failed: number }> {
  const nodes = await readHomeLabNodes(kv);
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  // v1 只测 TCP；UDP 中继留给 OpenVPN 隧道测试
  const targets = (wanted ? nodes.filter((n) => wanted.has(n.id)) : nodes).filter(
    (n) => n.proto !== 'udp'
  );
  const limit = Math.max(1, Math.min(32, concurrency));
  let cursor = 0;
  let reachable = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const node = targets[cursor++];
      const result = await testTcpReachable(node.ip, node.port);
      node.tcp = {
        reachable: result.reachable,
        latencyMs: result.latencyMs,
        checkedAt: Date.now(),
      };
      if (result.reachable) reachable++;
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  await saveHomeLabNodes(kv, nodes);
  return { total: targets.length, reachable, failed: targets.length - reachable };
}
