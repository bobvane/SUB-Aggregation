/**
 * IP 地理定位服务（支持域名解析）
 *
 * 用途：节点不具备国家/地区识别能力时，用其 server 查 IP 归属地 → 地区（emoji中文名）或 null。
 * 数据源：ip-api.com（免费，无需 key，支持批量接口，一次 HTTP 最多 100 个 IP）
 * 实现：
 *   - 批量 IP 定位（≤100IP/次），15 次/分钟滑动窗口限流
 *   - 域名 server 先用 DoH（DNS over HTTPS）解析成 IP 再查询（支持 IPv4 回退）
 *   - L1 内存+KV 兜底，失败不写缓存，存量 __NULL__ 视为过期重查
 */

import { countryDisplayName } from '@/data/country-codes';

const IP_GEO_KEY_PREFIX = 'ip_geo:';
const IP_API_URL = 'http://ip-api.com/batch';
const IP_API_JSON_URL = 'http://ip-api.com/json/';
// GeoRetry 任务门闩状态 key（v2.25.0：active 门闩哨兵，正常态 0 KV 写）
// 存 { ts, count, active }：active=true 时 cron 每分钟重试；false 时 cron 直接短路不写 KV
export const GEO_PENDING_RETRY_KEY = 'geo_pending_retry';
// 连续重试上限：超过则停止并置 active=false，提示检查节点正确性
export const GEO_RETRY_MAX = 10;
// Batch 限额：一次最多 100 个 IP，15 次/分钟滑动窗口
const BATCH_LIMIT = 100;
const MAX_BATCHES = 5; // 单次触发最多 5 批（500 个 IP）
const RATE_LIMIT_REQUESTS = 15;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 分钟
const IP_GEO_CACHE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天缓存
// v2.38.6：域名 → IP 解析结果缓存（6 小时）。此前每次预填充都对所有域名重新 DoH，
// 订阅更新/手动重检/每分钟 cron 重试会重复消耗 Google/Cloudflare DoH 配额。
const DNS_CACHE_KEY_PREFIX = 'dns_ip:';
const DNS_CACHE_MS = 6 * 60 * 60 * 1000; // 6 小时

// DoH 端点：Google + Cloudflare 双选，任一成功即可
const DOH_ENDPOINTS = [
  { url: 'https://dns.google/resolve', param: 'name' },
  { url: 'https://cloudflare-dns.com/dns-query', param: 'name' },
];

/** IPv4 正则：4段点分十进制，每段1-3位数字 */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 判断 server 是否为纯 IP（IPv4）。每段需 ≤255，且必须是点分十进制
 * （v2.23.0：补段值校验，避免 999.1.1.1 / 2130706433 十进制等非标准写法被当作域名去真解析） */
function isPureIP(server: string): boolean {
  if (!IPV4_RE.test(server)) return false;
  return server.split('.').every((octet) => parseInt(octet, 10) <= 255);
}

/**
 * DNS over HTTPS（DoH）解析域名 → IPv4
 * 依次尝试 Google + Cloudflare，任一成功即返回首个 IPv4；全部失败返回 null。
 * 若 server 本身已是纯 IP 则直接返回（短路）。
 */
export async function resolveDomainToIP(
  server: string,
  fetchFn: typeof fetch = fetch,
  opts?: { cache?: IpGeoCache; stats?: GeoRequestStats }
): Promise<string | null> {
  if (!server) return null;
  // 已经是纯 IP，无需 DNS
  if (isPureIP(server)) return server;

  const cache = opts?.cache;
  const stats = opts?.stats;
  const cacheKey = DNS_CACHE_KEY_PREFIX + server;

  // 0. DNS 缓存（v2.38.6）：6 小时内同一 server 不重复发 DoH
  if (cache) {
    try {
      const raw = await cache.get(cacheKey);
      if (raw) {
        const [ts, ip] = raw.split('|');
        if (ts && ip && Date.now() - Number(ts) < DNS_CACHE_MS && isPureIP(ip)) {
          if (stats) stats.dnsCached++;
          return ip;
        }
      }
    } catch {
      // 缓存不可用不阻塞解析
    }
  }

  let attempt = 0;
  for (const ep of DOH_ENDPOINTS) {
    const isFallback = attempt > 0;
    attempt++;
    try {
      const url = `${ep.url}?type=A&${ep.param}=${encodeURIComponent(server)}`;
      if (stats) {
        stats.dnsQueried++;
        if (isFallback) stats.dohFallback++;
      }
      const res = await fetchFn(url, {
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/dns-json' },
      });
      if (!res.ok) continue;
      const data = await res.json() as { Status: number; Answer?: { type: number; data: string }[] };
      if (data.Status === 0 && Array.isArray(data.Answer)) {
        for (const ans of data.Answer) {
          // type 1 = A record (IPv4)
          if (ans.type === 1 && isPureIP(ans.data)) {
            if (cache) {
              try {
                await cache.set(cacheKey, `${Date.now()}|${ans.data}`, DNS_CACHE_MS / 1000);
              } catch {
                // 写缓存失败不影响本次解析
              }
            }
            return ans.data;
          }
        }
      }
    } catch {
      // 下一个端点
    }
  }
  return null;
}

interface IpApiBatchResponse {
  status: 'success' | 'fail';
  countryCode?: string;
  message?: string;
  query?: string;
}

export interface IpGeoCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expirationTtlSeconds?: number): Promise<void>;
}

/** 批量 IP 查询（最多 100 个 IP），返回 Map<ip, country>，失败或无 countryCode 则为 null */
export async function batchQuery(
  ips: string[],
  cache: IpGeoCache,
  fetchFn: typeof fetch = fetch,
  stats?: GeoRequestStats
): Promise<Map<string, string | null>> {
  if (!ips.length) return new Map();
  // 1. 检查缓存（仅用于单个 IP）
  // 注意：__NULL__ 不视为有效缓存，始终允许重查（失败不应永久阻塞）
  const uncached: string[] = [];
  const result = new Map<string, string | null>();

  for (const ip of ips) {
    const cacheKey = IP_GEO_KEY_PREFIX + ip;
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const [ts, name] = cached.split('|');
        if (ts && name) {
          if (Date.now() - Number(ts) < IP_GEO_CACHE_MS) {
            // __NULL__ 仍视为未识别（负缓存仅表示「某次查询失败」，不应永久卡死）
            if (name !== '__NULL__') {
              result.set(ip, name);
            } else {
              // __NULL__ 不写 result，但要加入 uncached 以便重新查询
              uncached.push(ip);
            }
            continue;
          }
        } else {
          // 旧格式无时间戳：__NULL__ 视为无效缓存，需重查
          if (cached !== '__NULL__') {
            result.set(ip, cached);
            continue;
          }
        }
      }
    } catch {
      // 缓存不可用不阻塞
    }
    uncached.push(ip);
  }

  if (!uncached.length) return result;

  // 2. 批量查询：按 ≤100 IP/批 循环分包，单次最多 5 批（500 个 IP），不降级单查
  // 滑动窗口速率限制（简单实现，不持久化）
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  const history: number[] = [];
  try {
    const historyRaw = await cache.get('__ip_geo_batch_history');
    if (historyRaw) {
      const entries = JSON.parse(historyRaw) as number[];
      history.push(...entries.filter((ts) => ts > windowStart));
    }
  } catch {}

  const hardCap = MAX_BATCHES * BATCH_LIMIT;
  let offset = 0;
  for (; offset < uncached.length && offset < hardCap; offset += BATCH_LIMIT) {
    // 超限流：停止后续批次（剩余保持未识别，等下次触发重检）
    if (history.length >= RATE_LIMIT_REQUESTS) break;

    const batch = uncached.slice(offset, offset + BATCH_LIMIT);
    const payload = batch.map((ip) => ({ query: ip }));
    const body = JSON.stringify(payload);

    let responses: IpApiBatchResponse[];
    try {
      if (stats) stats.ipApiRequests++;
      const res = await fetchFn(IP_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000), // 10 秒超时
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      responses = (await res.json()) as IpApiBatchResponse[];
      if (!Array.isArray(responses)) throw new Error('Batch response format error');

      // 记录本次批量请求时间戳
      history.push(Date.now());
      try {
        await cache.set('__ip_geo_batch_history', JSON.stringify(history));
      } catch {}
    } catch {
      // 本批请求失败：跳过该批（失败不写缓存，允许后续重试）
      continue;
    }

    // 映射结果（仅成功写入缓存，失败不写）
    for (let i = 0; i < batch.length && i < responses.length; i++) {
      const ip = batch[i];
      const resp = responses[i];
      let country: string | null = null;
      if (resp?.status === 'success' && resp.countryCode) {
        const display = countryDisplayName(resp.countryCode);
        country = display || null;
      }
      result.set(ip, country);
      // 仅成功结果写缓存；null 不写（允许后续重试）
      if (country) {
        try {
          await cache.set(IP_GEO_KEY_PREFIX + ip, `${Date.now()}|${country}`, IP_GEO_CACHE_MS / 1000);
        } catch {}
      }
    }
  }
  // v2.38.6：因限流 / 单次上限而没查到的 IP 必须可观测（不静默丢失）
  if (stats && offset < uncached.length) {
    stats.rateLimited += uncached.length - offset;
  }

  return result;
}

/** 单个 IP 查询（备用） */
export async function singleQuery(
  ip: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await fetchFn(`${IP_API_JSON_URL}${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(5000), // 5 秒超时
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { status: 'success' | 'fail'; countryCode?: string };
    if (data.status !== 'success' || !data.countryCode) return null;
    const display = countryDisplayName(data.countryCode);
    return display || null;
  } catch {
    return null;
  }
}

/** v2.38.6：一次预填充的外部请求计数（用于可观测性与额度评估，全部为真实计数） */
export interface GeoRequestStats {
  /** 命中 DNS 缓存、未发 DoH 的 server 数 */
  dnsCached: number;
  /** 实际发出的 DoH 请求数（Google + Cloudflare 合计） */
  dnsQueried: number;
  /** 其中 Google DoH 失败后回退 Cloudflare 的次数 */
  dohFallback: number;
  /** 实际发出的 ip-api 批量请求数 */
  ipApiRequests: number;
  /** 因 15 次/分钟限流被跳过的待查 IP 数（会留到下次重试） */
  rateLimited: number;
}

export function emptyGeoRequestStats(): GeoRequestStats {
  return { dnsCached: 0, dnsQueried: 0, dohFallback: 0, ipApiRequests: 0, rateLimited: 0 };
}

export interface PrewarmResult {
  /** 本次待检测的 server 数（去重后） */
  total: number;
  /** 命中 IP 缓存的 IP 数 */
  cached: number;
  /** 实际发起归属地查询的 IP 数 */
  queried: number;
  /** 已识别并写回 server 缓存的 server 数 */
  resolved: number;
  /** 查到 IP 但归属地库无明确国家的 server 数 */
  failed: number;
  /**
   * 无法解析出 IP、因而**未进入查询**的 server 数。
   * v2.38.5：此前这类 server 被静默丢弃（既不计 queried 也不计 failed），
   * 导致前端把「没查到」显示成 0；必须显式统计，避免缺失数据伪装成真实的 0。
   */
  unresolved: number;
  /** v2.38.6：外部请求计数明细（Google/Cloudflare DoH、ip-api、缓存命中、限流跳过） */
  requests: GeoRequestStats;
}

/**
 * 主动预填充（Pre-warm）：批量合并查询一批 server 的 IP 归属地并写入 KV 缓存。
 *
 * 作用：把 IP 地理查询与「配置生成」解耦。配置生成时 resolver 直接命中 KV 缓存，
 * 不再触发任何 HTTP；真正的外网查询只在此处发生。
 *
 * 流程：
 *   1. 逐个 server 解析域名 → IP：优先命中 DNS 缓存（6 小时 TTL，v2.38.6），
 *      未命中才发 DoH（Google 优先，失败回退 Cloudflare）；纯 IP 直接短路
 *   2. 按 IP 去重，查 KV 缓存（30 天 TTL），命中且未过期则跳过
 *   3. 未命中项交给 batchQuery 合并成单次批量查询（≤100/IP/次自动分批 + 15 次/分钟限流）
 *   4. 结果同时写回两份缓存：ip_geo:{IP}（batchQuery 内部）和 ip_geo:{server}（统计口径）
 *
 * @returns 统计信息（供日志/返回体展示本次查询情况）
 */
export async function prewarmIpGeo(
  servers: string[],
  cache: IpGeoCache,
  fetchFn: typeof fetch = fetch
): Promise<PrewarmResult> {
  const unique = [...new Set(servers.filter(Boolean))];
  const result: PrewarmResult = {
    total: unique.length,
    cached: 0,
    queried: 0,
    resolved: 0,
    failed: 0,
    unresolved: 0,
    requests: emptyGeoRequestStats(),
  };
  if (unique.length === 0) return result;

  // 0. DNS 解析并记录 server→ip 映射
  const serverToIp = new Map<string, string>();
  for (const server of unique) {
    try {
      const ip = await resolveDomainToIP(server, fetchFn, { cache, stats: result.requests });
      if (ip) serverToIp.set(server, ip);
      // 解析失败：server 无法确定归属，跳过（不调用 batchQuery）
    } catch {
      // 单个解析失败不阻塞
    }
  }
  // 解析不出 IP 的 server 既不会被查询、也不会出现在 resolved/failed 里 —— 单独计数
  result.unresolved = unique.length - serverToIp.size;
  if (serverToIp.size === 0) return result;

  // 1. 查缓存，构建 ip→country 映射（含缓存命中项，确保 server key 兜底回写）
  const ips = [...new Set(serverToIp.values())];
  const ipToCountry = new Map<string, string>();
  const uncached: string[] = [];
  for (const ip of ips) {
    const cacheKey = IP_GEO_KEY_PREFIX + ip;
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const [ts, name] = cached.split('|');
        if (ts && name) {
          if (Date.now() - Number(ts) < IP_GEO_CACHE_MS) {
            // __NULL__ 视为未识别（不写入映射，不 cached++，不 continue → 加入 uncached 重查）
            if (name !== '__NULL__') {
              ipToCountry.set(ip, name);
              result.cached++;
            }
            // __NULL__ 跳过 continue，让它落到 uncached
            if (name !== '__NULL__') continue;
          }
        } else {
          // 旧格式无时间戳：仅非 __NULL__ 视为有效
          if (cached !== '__NULL__') {
            ipToCountry.set(ip, cached);
            result.cached++;
            continue;
          }
        }
      }
    } catch {
      // 缓存不可用不阻塞
    }
    uncached.push(ip);
  }

  // 2. 未命中项批量合并查询（batchQuery 内部写 ip_geo:{IP} 缓存）
  if (uncached.length > 0) {
    result.queried = uncached.length;
    const map = await batchQuery(uncached, cache, fetchFn, result.requests);
    for (const [ip, country] of map) {
      if (country) ipToCountry.set(ip, country);
    }
  }

  // 3. 按 server 回写缓存（与 hasGeoCountry/统计/重检筛选 key 一致）
  //    域名节点才能被统计侧识别为"已识别"；同时保证修复前只写了 IP key 的存量也能补上
  for (const [server, ip] of serverToIp) {
    const country = ipToCountry.get(ip);
    if (country) {
      result.resolved++;
      try {
        await cache.set(IP_GEO_KEY_PREFIX + server, `${Date.now()}|${country}`, IP_GEO_CACHE_MS / 1000);
      } catch {}
    } else {
      result.failed++;
    }
  }
  return result;
}

/**
 * 判断单个 server 是否已有「有效」地理缓存（即能识别国家）。
 *
 * 口径与 createIpGeoResolver 严格一致：查 ip_geo:{server} 缓存，TTL 内且非 __NULL__
 * 才算已识别；无缓存 / 已过期 / __NULL__ / 旧格式 __NULL__ 一律视为未识别。
 * 纯读缓存，不触发任何外网查询（列表页统计与手动重检共用此判定）。
 */
export async function hasGeoCountry(
  server: string,
  cache: IpGeoCache,
): Promise<boolean> {
  if (!server) return false;
  const cacheKey = IP_GEO_KEY_PREFIX + server;
  try {
    const cached = await cache.get(cacheKey);
    if (!cached) return false;
    const [ts, name] = cached.split('|');
    if (ts && name) {
      // 有时间戳
      if (Date.now() - Number(ts) < IP_GEO_CACHE_MS) {
        return name !== '__NULL__';
      }
      return false; // 过期
    }
    // 旧格式无时间戳：非 __NULL__ 视为有效
    return cached !== '__NULL__';
  } catch {
    return false; // 缓存不可用视为未识别
  }
}

/**
 * 从一批 server 中筛出「未识别国家码」的（不触发外网查询）。
 * @returns 去重后、判定为未识别的 server 列表
 * v2.16.0：从逐条串行读 KV 改为分批并发（每批 CONCURRENCY 个 Promise.all），
 *           避免节点数多时串行 KV get 拖慢整个请求（实测 /api/nodes 22.9s → 期望 <1s）。
 */
const GEO_BATCH_CONCURRENCY = 20;

export async function filterUnlocatedServers(
  servers: string[],
  cache: IpGeoCache,
): Promise<string[]> {
  const unique = [...new Set(servers.map(s => (s || '').trim()).filter(Boolean))];
  const unlocated: string[] = [];
  for (let i = 0; i < unique.length; i += GEO_BATCH_CONCURRENCY) {
    const batch = unique.slice(i, i + GEO_BATCH_CONCURRENCY);
    const okFlags = await Promise.all(batch.map(server => hasGeoCountry(server, cache)));
    batch.forEach((server, j) => {
      if (!okFlags[j]) unlocated.push(server);
    });
  }
  return unlocated;
}

/** 统计一批 server 中「未识别国家码」的数量（不触发外网查询） */
export async function countUnlocatedGeo(
  servers: string[],
  cache: IpGeoCache,
): Promise<number> {
  return (await filterUnlocatedServers(servers, cache)).length;
}

/**
 * GeoRetry 门闩状态（active 哨兵，v2.25.0）
 * 结构：{ ts, count, active }
 * - active=true  → cron 每分钟重试
 * - active=false → cron 直接短路（0 KV 写）——正常态，不再每分钟写归零状态
 */
export interface GeoRetryGate {
  ts: number;
  count: number;
  active: boolean;
}

const GEO_DEFAULT: GeoRetryGate = { ts: 0, count: 0, active: false };

/**
 * 读取 GeoRetry 门闩状态。通过 settings 仓储读写（`setting:` 前缀，前端同口径）。
 */
export async function getGeoRetryGate(
  settings: { get(key: string): Promise<string | null> }
): Promise<GeoRetryGate> {
  try {
    const raw = await settings.get(GEO_PENDING_RETRY_KEY);
    if (!raw) return { ...GEO_DEFAULT };
    const p = JSON.parse(raw) as Partial<GeoRetryGate>;
    return {
      ts: typeof p.ts === 'number' ? p.ts : 0,
      count: typeof p.count === 'number' ? p.count : 0,
      active: typeof p.active === 'boolean' ? p.active : false,
    };
  } catch {
    return { ...GEO_DEFAULT };
  }
}

/**
 * 写入 GeoRetry 门闩状态。
 */
export async function setGeoRetryGate(
  settings: { set(key: string, value: string): Promise<void> },
  gate: GeoRetryGate
): Promise<void> {
  await settings.set(GEO_PENDING_RETRY_KEY, JSON.stringify(gate));
}

/**
 * 激活 GeoRetry（发现未识别 IP 时调用）。返回是否真的有未识别 IP 被激活。
 * 供订阅更新 / 手动 geo-redetect / 每日预热等入口把门闩拨到 active，唤醒 cron 重试。
 */
export async function activateGeoRetry(
  unlocatedCount: number,
  settings: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
): Promise<boolean> {
  if (unlocatedCount <= 0) return false;
  await setGeoRetryGate(settings, { ts: Date.now(), count: 0, active: true });
  return true;
}

/**
 * 关闭 GeoRetry（全部识别成功后调用），恢复 0 KV 写睡眠态。
 */
export async function deactivateGeoRetry(
  settings: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
): Promise<void> {
  await setGeoRetryGate(settings, { ts: Date.now(), count: 0, active: false });
}

/** 创建纯 IP 地理定位 resolver */
export function createIpGeoResolver(
  cache: IpGeoCache,
  fetchFn: typeof fetch = fetch
): (server: string) => Promise<string | null> {
  // 用于批量查询的内存缓存，过期清理（LRU 风格，简单实现）
  const batchCache = new Map<string, { country: string | null; ts: number }>();

  return async (server: string): Promise<string | null> => {
    if (!server) return null;
    const cacheKey = IP_GEO_KEY_PREFIX + server;

    // 1. 查本批缓存
    const cached = batchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 5000) { // 5 秒新鲜
      return cached.country;
    }

    // 2. 查持久化缓存
    try {
      const persisted = await cache.get(cacheKey);
      if (persisted) {
        const [ts, name] = persisted.split('|');
        if (ts && name) {
          if (Date.now() - Number(ts) < IP_GEO_CACHE_MS) {
            // __NULL__ 视为未缓存，仍重查
            if (name !== '__NULL__') {
              const country = name;
              batchCache.set(cacheKey, { country, ts: Date.now() });
              return country;
            }
          }
        } else {
          // 旧格式无时间戳：非 __NULL__ 视为有效
          if (persisted !== '__NULL__') {
            const country = persisted;
            batchCache.set(cacheKey, { country, ts: Date.now() });
            return country;
          }
        }
      }
    } catch {
      // 缓存不可用不阻塞
    }

    // 3. 批量查询 IP（每个请求最多 100 个 IP）
    // 注意：这里为了简化，实现为每次查询都发一个批量请求，生产环境可以做请求合并
    const ips = [server];
    const map = await batchQuery(ips, cache, fetchFn);
    const country = map.get(server) || null;
    batchCache.set(cacheKey, { country, ts: Date.now() });

    return country;
  };
}
