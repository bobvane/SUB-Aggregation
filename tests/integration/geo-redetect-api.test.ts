/**
 * v2.38.5 数据契约回归：POST /api/nodes/geo-redetect 必须返回
 * 「服务器级 + IP 级」自洽的统计，且缺失项（无法解析）显式计数。
 *
 * 这里走真实路由 + 真实 prewarmIpGeo，只把外网 fetch 换成可控 mock，
 * 因此覆盖的是真正的数据来源，而不是前端假数据。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

interface GeoData {
  serverTotal: number;
  targets: number;
  total: number;
  cached: number;
  queried: number;
  resolved: number;
  failed: number;
  unresolved: number;
  unlocatedBefore: number;
  unlocatedAfter: number;
  unlocatedServers: string[];
}

/** DoH 只认 domainToIp 表；ip-api batch 一律返回固定国家 */
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

function node(id: string, name: string, server: string) {
  return { id, name, protocol: 'vless', server, port: 443, metadata: {}, version: 1 };
}

describe('geo-redetect API 数据契约', () => {
  let app: ReturnType<typeof createApp>;
  let kv: MemoryKvAdapter;
  let headers: Record<string, string>;

  async function setup(nodes: ReturnType<typeof node>[]) {
    kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => {
      const raw = await kv.get('admin:hash');
      return raw ? (JSON.parse(raw) as { hash: string; salt: string }) : null;
    });
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass' }),
    });
    const json = (await res.json()) as { data: { token: string } };
    headers = { Cookie: 'sub_session=' + json.data.token, 'Content-Type': 'application/json' };
    if (nodes.length) await kv.put('nodes:sub-1', JSON.stringify(nodes));
  }

  async function call(): Promise<GeoData> {
    const res = await app.request('/api/nodes/geo-redetect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope: 'unlocated' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: GeoData };
    expect(json.success).toBe(true);
    return json.data;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('可识别的域名：resolved 与 unlocatedAfter 正确', async () => {
    await setup([node('n1', 'HK-1', 'hk.example.com'), node('n2', 'HK-2', 'hk2.example.com')]);
    vi.stubGlobal('fetch', makeFetch({ 'hk.example.com': '1.2.3.4', 'hk2.example.com': '1.2.3.5' }, 'HK'));
    const d = await call();
    expect(d).toMatchObject({
      serverTotal: 2,
      targets: 2,
      total: 2,
      queried: 2,
      resolved: 2,
      failed: 0,
      unresolved: 0,
      unlocatedBefore: 2,
      unlocatedAfter: 0,
    });
    expect(d.unlocatedServers).toEqual([]);
  });

  it('解析不出 IP 的目标必须计入 unresolved（不再是「全是 0」）', async () => {
    await setup([node('n1', 'BROKEN', 'no-such-host.invalid')]);
    vi.stubGlobal('fetch', makeFetch({}));
    const d = await call();
    expect(d.serverTotal).toBe(1);
    expect(d.targets).toBe(1);
    expect(d.unresolved).toBe(1);
    // 没有发起查询，因此查询类计数保持真实 0，而不是被伪造成「已完成」
    expect(d.queried).toBe(0);
    expect(d.resolved).toBe(0);
    expect(d.failed).toBe(0);
    expect(d.unlocatedBefore).toBe(1);
    expect(d.unlocatedAfter).toBe(1);
    expect(d.unlocatedServers).toEqual(['no-such-host.invalid']);
  });

  it('没有节点时全部为真实的 0', async () => {
    await setup([]);
    vi.stubGlobal('fetch', makeFetch({}));
    const d = await call();
    expect(d).toMatchObject({ serverTotal: 0, targets: 0, total: 0, resolved: 0, failed: 0, unresolved: 0, unlocatedBefore: 0, unlocatedAfter: 0 });
    expect(d.unlocatedServers).toEqual([]);
  });

  it('响应字段集合稳定（前端渲染依赖这些键）', async () => {
    await setup([node('n1', 'HK-1', 'hk.example.com')]);
    vi.stubGlobal('fetch', makeFetch({ 'hk.example.com': '1.2.3.4' }, 'HK'));
    const d = await call();
    expect(Object.keys(d).sort()).toEqual(
      ['cached', 'failed', 'queried', 'requests', 'resolved', 'scope', 'serverTotal', 'targets', 'total', 'unlocatedAfter', 'unlocatedBefore', 'unlocatedServers', 'unresolved'].sort(),
    );
  });

  it('服务器级三类之和 = 待检测总数（口径自洽）', async () => {
    await setup([
      node('n1', 'HK-1', 'hk.example.com'),
      node('n2', 'BROKEN', 'broken.invalid'),
    ]);
    vi.stubGlobal('fetch', makeFetch({ 'hk.example.com': '1.2.3.4' }, 'HK'));
    const d = await call();
    expect(d.resolved + d.failed + d.unresolved).toBe(d.total);
    expect(d.total).toBe(d.targets);
  });
});
