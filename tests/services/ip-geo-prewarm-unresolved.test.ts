/**
 * v2.38.5 回归：prewarmIpGeo 必须显式统计「解析不出 IP、未进入查询」的服务器数。
 *
 * 背景：此前这类 server 被静默丢弃 —— total 计入、queried/resolved/failed 都不计，
 * 前端结果窗口因此把「根本没查」显示成 0，属于把缺失数据伪装成真实 0。
 */
import { describe, it, expect } from 'vitest';
import { prewarmIpGeo } from '@/services/ip-geo.service';

function makeCache() {
  const store = new Map<string, string>();
  return {
    cache: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    },
    dump: () => Object.fromEntries(store),
  };
}

/** DoH 只认 domainToIp 表里的域名；ip-api POST 一律返回 countryCode */
function makeFetch(domainToIp: Record<string, string>, countryCode = 'HK') {
  return (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { query: string }[];
      return { ok: true, json: async () => payload.map(() => ({ status: 'success', countryCode })) };
    }
    const name = new URL(url).searchParams.get('name') || '';
    const ip = domainToIp[name];
    if (ip) return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: ip }] }) };
    return { ok: false, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe('prewarmIpGeo：无法解析的服务器必须计入 unresolved（不伪装成 0）', () => {
  it('域名解析失败 → unresolved=1，且不虚增 queried/resolved/failed', async () => {
    const { cache } = makeCache();
    const res = await prewarmIpGeo(['no-such-host.invalid'], cache, makeFetch({}));
    expect(res.total).toBe(1);
    expect(res.unresolved).toBe(1);
    expect(res.queried).toBe(0);
    expect(res.resolved).toBe(0);
    expect(res.failed).toBe(0);
    // 不变量：服务器级三类之和 = 待检测总数
    expect(res.resolved + res.failed + res.unresolved).toBe(res.total);
  });

  it('可解析域名 → unresolved=0，正常识别', async () => {
    const { cache } = makeCache();
    const res = await prewarmIpGeo(['hk.example.com'], cache, makeFetch({ 'hk.example.com': '1.2.3.4' }));
    expect(res.total).toBe(1);
    expect(res.unresolved).toBe(0);
    expect(res.resolved).toBe(1);
    expect(res.resolved + res.failed + res.unresolved).toBe(res.total);
  });

  it('混合场景：1 个可解析 + 1 个不可解析 → 两类分别计数', async () => {
    const { cache } = makeCache();
    const res = await prewarmIpGeo(
      ['hk.example.com', 'broken.invalid'],
      cache,
      makeFetch({ 'hk.example.com': '1.2.3.4' }),
    );
    expect(res.total).toBe(2);
    expect(res.resolved).toBe(1);
    expect(res.unresolved).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.resolved + res.failed + res.unresolved).toBe(res.total);
  });

  it('IP 级与服务器级口径不同：两个 server 指向同一 IP 时 queried=1、total=2', async () => {
    const { cache } = makeCache();
    const res = await prewarmIpGeo(
      ['a.example.com', 'b.example.com'],
      cache,
      makeFetch({ 'a.example.com': '5.6.7.8', 'b.example.com': '5.6.7.8' }),
    );
    expect(res.total).toBe(2); // 服务器级
    expect(res.queried).toBe(1); // IP 级（去重后）
    expect(res.resolved).toBe(2); // 两个 server 都写回了国家
    expect(res.unresolved).toBe(0);
  });

  it('空输入不产生任何伪统计', async () => {
    const { cache } = makeCache();
    const res = await prewarmIpGeo([], cache, makeFetch({}));
    expect(res).toEqual({
      total: 0, cached: 0, queried: 0, resolved: 0, failed: 0, unresolved: 0,
      requests: { dnsCached: 0, dnsQueried: 0, dohFallback: 0, ipApiRequests: 0, rateLimited: 0 },
    });
  });
});
