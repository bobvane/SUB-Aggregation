import { describe, it, expect } from 'vitest';
import { createIpGeoResolver, batchQuery, filterUnlocatedServers, countUnlocatedGeo, prewarmIpGeo, hasGeoCountry, IpGeoCache } from '@/services/ip-geo.service';
import { countryDisplayName } from '@/data/country-codes';

/** 内存缓存 adapter + 手动控制 fetch 的测试替身 */
function makeCache(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map<string, number>();
  const cache: IpGeoCache = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v, ttl) => { store.set(k, v); if (ttl !== undefined) ttls.set(k, ttl); },
  };
  const dump = () => Object.fromEntries(store);
  return { cache, dump, store, ttls };
}

function makeFetch(mock: (url: string) => unknown) {
  return (async (url: string, init?: RequestInit) => {
    // batch 请求返回数组，单个请求返回对象
    if (init?.method === 'POST') {
      return {
        ok: true,
        json: async () => Array.isArray(mock(url)) ? mock(url) : [mock(url)],
      };
    }
    return {
      ok: true,
      json: async () => mock(url),
    };
  }) as unknown as typeof fetch;
}

describe('createIpGeoResolver', () => {
  it('returns country display name from ip-api countryCode', async () => {
    const { cache } = makeCache();
    const resolver = createIpGeoResolver(cache, makeFetch(() => ({
      status: 'success', countryCode: 'HK',
    })));
    expect(await resolver('hk.example.com')).toBe(countryDisplayName('HK'));
  });

  it('returns null when ip-api fails', async () => {
    const { cache } = makeCache();
    const resolver = createIpGeoResolver(cache, makeFetch(() => ({
      status: 'fail',
    })));
    expect(await resolver('unknown.example.com')).toBeNull();
  });

  it('returns null when countryCode not in table', async () => {
    const { cache } = makeCache();
    // ZZ 不存在于 COUNTRIES
    const resolver = createIpGeoResolver(cache, makeFetch(() => ({
      status: 'success', countryCode: 'ZZ',
    })));
    expect(await resolver('x.example.com')).toBeNull();
  });

  it('serves from cache and does not call ip-api again', async () => {
    const { cache, dump } = makeCache();
    let calls = 0;
    const fetchMock = makeFetch((_url) => {
      calls++;
      return { status: 'success', countryCode: 'JP' };
    });
    const resolver = createIpGeoResolver(cache, fetchMock);
    const first = await resolver('jp1.example.com');
    expect(first).toBe(countryDisplayName('JP'));
    // 第二次 batchQuery 也会发起（纯 IP 批量不缓存节点级，但会复用 batch 内的缓存）
    const second = await resolver('jp2.example.com');
    expect(second).toBe(countryDisplayName('JP'));
    // batchQuery 应被调用两次（每次都是独立批量请求）
    // 由于 makeFetch 每次都会递增 calls，且两次调用不同 IP
    expect(calls).toBeGreaterThanOrEqual(2);
    // 缓存里应带时间戳
    const stored = dump()['ip_geo:jp1.example.com'] as string;
    expect(stored).toContain('|');
  });

  it('returns null for empty server', async () => {
    const { cache } = makeCache();
    const resolver = createIpGeoResolver(cache, makeFetch(() => ({
      status: 'success', countryCode: 'HK',
    })));
    expect(await resolver('')).toBeNull();
  });

  it('__NULL__ stale cache is re-queried and resolved to country', async () => {
    const { cache, dump } = makeCache({
      'ip_geo:us.example.com': `1|__NULL__`, // 旧格式无时间戳，值为 __NULL__
    });
    let calls = 0;
    const fetchMock = makeFetch((_url) => {
      calls++;
      return { status: 'success', countryCode: 'US' };
    });
    const resolver = createIpGeoResolver(cache, fetchMock);
    // 应重查，不应命中缓存
    const r = await resolver('us.example.com');
    expect(r).toBe(countryDisplayName('US'));
    expect(calls).toBeGreaterThanOrEqual(1);
    // 写入的新缓存不含 __NULL__
    const stored = dump()['ip_geo:us.example.com'] as string;
    expect(stored).toBeDefined();
    expect(stored).toContain('|');
    expect(stored).not.toContain('__NULL__');
  });

  it('batchQuery does not write __NULL__ to cache on failure', async () => {
    const { cache, dump } = makeCache();
    // batch 返回 fail
    const fetchMock = makeFetch((_url) => {
      return [{ status: 'fail', message: 'invalid query', query: 'example.com' }];
    });
    const map = await batchQuery(['example.com'], cache, fetchMock);
    expect(map.get('example.com')).toBeNull();
    // 缓存中不应有 ip_geo:example.com
    expect(dump()['ip_geo:example.com']).toBeUndefined();
  });

  it('batchQuery writes only successful results to cache', async () => {
    const { cache, dump } = makeCache();
    // batch 部分成功：第一个 success，第二个 fail
    const fetchMock = makeFetch((_url) => {
      return [
        { status: 'success', countryCode: 'JP' },
        { status: 'fail', message: 'invalid query', query: 'bad.com' },
      ];
    });
    const map = await batchQuery(['good.com', 'bad.com'], cache, fetchMock);
    expect(map.get('good.com')).toBe(countryDisplayName('JP'));
    expect(map.get('bad.com')).toBeNull();
    // 只有 good.com 写入缓存
    expect(dump()['ip_geo:good.com']).toBeDefined();
    expect(dump()['ip_geo:bad.com']).toBeUndefined();
  });

  it('batchQuery 分包：101 个 IP 发 2 个批量 POST，各批 ≤100', async () => {
    const { cache } = makeCache();
    const ips = Array.from({ length: 101 }, (_, i) => `1.1.${i + 1}.1`);
    const postSizes: number[] = [];
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { query: string }[];
      postSizes.push(payload.length);
      return {
        ok: true,
        json: async () => payload.map(() => ({ status: 'success', countryCode: 'HK' })),
      };
    }) as unknown as typeof fetch;

    const map = await batchQuery(ips, cache, fetchMock);
    expect(postSizes.length).toBe(2);
    expect(postSizes[0]).toBe(100);
    expect(postSizes[1]).toBe(1);
    expect(map.size).toBe(101);
    expect(map.get('1.1.1.1')).toBe(countryDisplayName('HK'));
  });

  it('batchQuery 上限：550 个 IP 只发 5 批（500 个），多余保持未识别', async () => {
    const { cache } = makeCache();
    const ips = Array.from({ length: 550 }, (_, i) => `1.1.${i + 1}.1`);
    let posts = 0;
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      posts++;
      const payload = JSON.parse(String(init?.body)) as { query: string }[];
      return {
        ok: true,
        json: async () => payload.map(() => ({ status: 'success', countryCode: 'JP' })),
      };
    }) as unknown as typeof fetch;

    await batchQuery(ips, cache, fetchMock);
    expect(posts).toBe(5);
  });

  it('batchQuery 限流：本分钟已满 15 次时不再发请求', async () => {
    const { cache } = makeCache({
      '__ip_geo_batch_history': JSON.stringify(Array.from({ length: 15 }, () => Date.now())),
    });
    let posts = 0;
    const fetchMock = (async (_url: string) => {
      posts++;
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;

    await batchQuery(['1.1.1.1'], cache, fetchMock);
    expect(posts).toBe(0);
  });

  it('__NULL__ 带时间戳缓存应触发重新查询（不视为有效命中）', async () => {
    const now = Date.now();
    const { cache, dump, ttls } = makeCache({
      'ip_geo:1.2.3.4': `${now}|__NULL__`, // 30 天内负缓存
      'ip_geo:5.6.7.8': `${now}|__NULL__`,
    });
    let posts = 0;
    const fetchMock = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        const payload = JSON.parse(String(init.body)) as { query: string }[];
        return {
          ok: true,
          json: async () => payload.map(() => ({ status: 'success', countryCode: 'SG' })),
        };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const map = await batchQuery(['1.2.3.4', '5.6.7.8'], cache, fetchMock);
    // 应发起 1 批 POST（2 个 IP 在 ≤100 的范围内）
    expect(posts).toBe(1);
    // 两个 IP 都识别出 SG
    expect(map.get('1.2.3.4')).toBe(countryDisplayName('SG'));
    expect(map.get('5.6.7.8')).toBe(countryDisplayName('SG'));
    // 写入的新缓存不含 __NULL__
    const stored1 = dump()['ip_geo:1.2.3.4'] as string;
    const stored2 = dump()['ip_geo:5.6.7.8'] as string;
    expect(stored1).toBeDefined();
    expect(stored2).toBeDefined();
    expect(stored1).not.toContain('__NULL__');
    expect(stored2).not.toContain('__NULL__');
    expect(ttls.get('ip_geo:1.2.3.4')).toBe(30 * 24 * 60 * 60);
    expect(ttls.get('ip_geo:5.6.7.8')).toBe(30 * 24 * 60 * 60);
  });
});

describe('filterUnlocatedServers / countUnlocatedGeo（未识别统计，纯读缓存不查询）', () => {
  const now = Date.now();

  it('视无缓存 / __NULL__ / 旧格式 __NULL__ / 过期为未识别，去重', async () => {
    const { cache } = makeCache({
      // 新格式带时间戳，未过期：已识别
      'ip_geo:ok.jp': `${now}|JP`,
      // 新格式带时间戳但值 __NULL__：未识别
      'ip_geo:null.jp': `${now}|__NULL__`,
      // 旧格式无时间戳，非 __NULL__：已识别
      'ip_geo:ok.us': `US`,
      // 旧格式无时间戳，值为 __NULL__：未识别
      'ip_geo:null.us': `__NULL__`,
      // 新格式但已过期：未识别
      'ip_geo:stale.hk': `${now - 31 * 24 * 3600 * 1000}|HK`,
      // 无缓存项 b01.jp：未识别（仅靠缓存判定，不触发查询）
      // 重复 server 应去重后只统计一次
    });
    const unlocated = await filterUnlocatedServers(
      ['ok.jp', 'null.jp', 'ok.us', 'null.us', 'stale.hk', 'b01.jp', 'b01.jp'],
      cache,
    );
    expect(unlocated.sort()).toEqual(['b01.jp', 'null.jp', 'null.us', 'stale.hk'].sort());
    expect(await countUnlocatedGeo(['ok.jp', 'null.jp', 'ok.us', 'null.us', 'stale.hk', 'b01.jp'], cache)).toBe(4);
  });

  it('空 server 与空数组合法返回 0', async () => {
    const { cache } = makeCache();
    expect(await countUnlocatedGeo(['', ' ', undefined as unknown as string], cache)).toBe(0);
    expect(await countUnlocatedGeo([], cache)).toBe(0);
  });
});

describe('prewarmIpGeo（域名节点缓存 key 一致性修复）', () => {
  /** mock fetch：POST → ip-api batch；GET → DoH（dns.google 优先） */
  function makePrewarmFetch(domainToIp: Record<string, string>, countryCode: string) {
    return (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { query: string }[];
        return {
          ok: true,
          json: async () => payload.map(() => ({ status: 'success', countryCode })),
        };
      }
      // DoH：dns.google/resolve?type=A&name=xxx
      const name = new URL(url).searchParams.get('name') || '';
      const ip = domainToIp[name];
      if (ip) {
        return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: ip }] }) };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  it('域名 server 解析后同时写入 IP key 与 server key，统计侧可识别', async () => {
    const { cache, dump } = makeCache();
    const fetchMock = makePrewarmFetch({ 'hk.example.com': '1.2.3.4' }, 'HK');
    const res = await prewarmIpGeo(['hk.example.com'], cache, fetchMock);
    // server key 已回写 → hasGeoCountry（统计口径）为 true
    expect(await hasGeoCountry('hk.example.com', cache)).toBe(true);
    expect(dump()['ip_geo:hk.example.com']).toBeDefined();
    // IP key 由 batchQuery 写入
    expect(dump()['ip_geo:1.2.3.4']).toBeDefined();
    // 统计侧不再把域名节点算作未识别
    expect(await countUnlocatedGeo(['hk.example.com'], cache)).toBe(0);
    expect(res.resolved).toBe(1);
  });

  it('纯 IP server 不受影响（server key 即 IP key）', async () => {
    const { cache, dump } = makeCache();
    const fetchMock = makePrewarmFetch({}, 'US');
    const res = await prewarmIpGeo(['8.8.8.8'], cache, fetchMock);
    expect(res.resolved).toBe(1);
    expect(await hasGeoCountry('8.8.8.8', cache)).toBe(true);
    expect(dump()['ip_geo:8.8.8.8']).toBeDefined();
  });

  it('prewarmIpGeo 对 __NULL__ 负缓存的 IP 应触发重新查询并识别', async () => {
    const now = Date.now();
    const { cache, dump } = makeCache({
      // 同时清空限流历史，避免受之前测试干扰
      '__ip_geo_batch_history': '',
      'ip_geo:128.199.82.20': `${now}|__NULL__`,
      'ip_geo:18.141.12.17': `${now}|__NULL__`,
    });
    // 纯 IP 不需要 DoH，mock 只响应 POST
    const fetchMock = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { query: string }[];
        return {
          ok: true,
          json: async () => payload.map(() => ({ status: 'success', countryCode: 'SG' })),
        };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const res = await prewarmIpGeo(['128.199.82.20', '18.141.12.17'], cache, fetchMock);
    // queried 应 > 0（确实发了 ip-api 请求）
    expect(res.queried).toBeGreaterThan(0);
    // resolved 应 = 2（两个都识别）
    expect(res.resolved).toBe(2);
    // 写入的缓存不含 __NULL__
    for (const ip of ['128.199.82.20', '18.141.12.17']) {
      const stored = dump()[`ip_geo:${ip}`] as string;
      expect(stored).toBeDefined();
      expect(stored).not.toContain('__NULL__');
      // 统计侧应能识别
      expect(await hasGeoCountry(ip, cache)).toBe(true);
    }
  });
});
