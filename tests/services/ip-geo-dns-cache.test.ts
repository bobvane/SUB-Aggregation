/**
 * v2.38.6：DNS 解析缓存与外部请求计数。
 * 目标：同一域名在 TTL 内不重复 DoH；Google 失败才回退 Cloudflare；
 * 限流未处理的 IP 必须可观测（不静默丢失）。
 */
import { describe, it, expect } from 'vitest';
import { resolveDomainToIP, prewarmIpGeo, batchQuery, emptyGeoRequestStats } from '@/services/ip-geo.service';

function makeCache(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const ttls = new Map<string, number>();
  return {
    cache: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ttl?: number) => { store.set(k, v); if (ttl !== undefined) ttls.set(k, ttl); },
    },
    dump: () => Object.fromEntries(store),
    ttls,
  };
}

/** DoH 响应 + ip-api 响应分开 mock，并记录调用 */
function makeFetch(opts: { google?: 'ok' | 'fail'; cloudflare?: 'ok' | 'fail'; ip?: string | null } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { query: string }[];
      return { ok: true, json: async () => payload.map(() => ({ status: 'success', countryCode: opts.ip === null ? undefined : 'JP' })) };
    }
    const host = new URL(url).host;
    if (host === 'dns.google') {
      if (opts.google === 'fail') return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] }) };
    }
    if (opts.cloudflare === 'fail') return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '5.6.7.8' }] }) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('resolveDomainToIP：DNS 缓存（v2.38.6）', () => {
  it('缓存有效期内命中缓存，不发起 DoH', async () => {
    const { cache } = makeCache({ 'dns_ip:hk.example.com': `${Date.now()}|9.9.9.9` });
    const { fetchFn, calls } = makeFetch();
    const stats = emptyGeoRequestStats();
    const ip = await resolveDomainToIP('hk.example.com', fetchFn, { cache, stats });
    expect(ip).toBe('9.9.9.9');
    expect(calls).toHaveLength(0);
    expect(stats.dnsCached).toBe(1);
    expect(stats.dnsQueried).toBe(0);
  });

  it('缓存过期后重新解析并写回缓存', async () => {
    const old = Date.now() - 7 * 60 * 60 * 1000; // 7 小时 > 6 小时 TTL
    const { cache, dump, ttls } = makeCache({ 'dns_ip:hk.example.com': `${old}|9.9.9.9` });
    const { fetchFn } = makeFetch({ google: 'ok' });
    const stats = emptyGeoRequestStats();
    const ip = await resolveDomainToIP('hk.example.com', fetchFn, { cache, stats });
    expect(ip).toBe('1.2.3.4');
    expect(stats.dnsQueried).toBe(1);
    expect(dump()['dns_ip:hk.example.com']).toContain('1.2.3.4');
    expect(ttls.get('dns_ip:hk.example.com')).toBe(6 * 60 * 60);
  });

  it('Google 成功时不调用 Cloudflare', async () => {
    const { cache } = makeCache();
    const { fetchFn, calls } = makeFetch({ google: 'ok' });
    const stats = emptyGeoRequestStats();
    const ip = await resolveDomainToIP('a.example.com', fetchFn, { cache, stats });
    expect(ip).toBe('1.2.3.4');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).host).toBe('dns.google');
    expect(stats.dohFallback).toBe(0);
  });

  it('Google 失败时回退 Cloudflare，并计数', async () => {
    const { cache } = makeCache();
    const { fetchFn, calls } = makeFetch({ google: 'fail', cloudflare: 'ok' });
    const stats = emptyGeoRequestStats();
    const ip = await resolveDomainToIP('b.example.com', fetchFn, { cache, stats });
    expect(ip).toBe('5.6.7.8');
    expect(stats.dnsQueried).toBe(2);
    expect(stats.dohFallback).toBe(1);
    expect(calls.map((u) => new URL(u).host)).toContain('cloudflare-dns.com');
  });

  it('纯 IP 不发 DNS 请求', async () => {
    const { cache } = makeCache();
    const { fetchFn, calls } = makeFetch();
    const stats = emptyGeoRequestStats();
    expect(await resolveDomainToIP('8.8.8.8', fetchFn, { cache, stats })).toBe('8.8.8.8');
    expect(calls).toHaveLength(0);
  });
});

describe('prewarmIpGeo：复用 DNS 缓存，避免重复 DoH', () => {
  it('第二次预填充同一批域名不再发 DoH', async () => {
    const { cache } = makeCache();
    const f1 = makeFetch({ google: 'ok' });
    const r1 = await prewarmIpGeo(['a.example.com', 'b.example.com'], cache, f1.fetchFn);
    expect(r1.requests.dnsQueried).toBeGreaterThan(0);
    expect(r1.requests.dnsCached).toBe(0);

    const f2 = makeFetch({ google: 'ok' });
    const r2 = await prewarmIpGeo(['a.example.com', 'b.example.com'], cache, f2.fetchFn);
    expect(f2.calls.map((u) => new URL(u).host).filter((h) => h === 'dns.google')).toHaveLength(0);
    expect(r2.requests.dnsCached).toBe(2);
    expect(r2.requests.dnsQueried).toBe(0);
  });

  it('归属地缓存命中时不再调用 ip-api', async () => {
    const ts = Date.now();
    const { cache } = makeCache({
      'dns_ip:a.example.com': `${ts}|1.2.3.4`,
      'ip_geo:1.2.3.4': `${ts}|日本`,
      'ip_geo:a.example.com': `${ts}|日本`,
    });
    const { fetchFn, calls } = makeFetch();
    const r = await prewarmIpGeo(['a.example.com'], cache, fetchFn);
    expect(calls).toHaveLength(0);
    expect(r.requests.ipApiRequests).toBe(0);
    expect(r.cached).toBeGreaterThan(0);
  });
});

describe('batchQuery：限流未处理必须可观测', () => {
  it('达到 15 次/分钟上限时跳过并记录 rateLimited', async () => {
    const now = Date.now();
    const history = Array.from({ length: 15 }, (_, i) => now - i * 100);
    const { cache } = makeCache({ __ip_geo_batch_history: JSON.stringify(history) });
    const { fetchFn, calls } = makeFetch({});
    const stats = emptyGeoRequestStats();
    const map = await batchQuery(['1.1.1.1', '2.2.2.2'], cache, fetchFn, stats);
    expect(calls).toHaveLength(0);
    expect(map.size).toBe(0);
    expect(stats.rateLimited).toBe(2);
    expect(stats.ipApiRequests).toBe(0);
  });

  it('未限流时按批请求并计数', async () => {
    const { cache } = makeCache();
    const { fetchFn, calls } = makeFetch({});
    const stats = emptyGeoRequestStats();
    const map = await batchQuery(['1.1.1.1', '2.2.2.2'], cache, fetchFn, stats);
    expect(calls).toHaveLength(1);
    expect(stats.ipApiRequests).toBe(1);
    expect(stats.rateLimited).toBe(0);
    expect(map.get('1.1.1.1')).toBeTruthy();
  });
});
