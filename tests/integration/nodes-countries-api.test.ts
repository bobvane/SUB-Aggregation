/**
 * 输出国家组 API 回归（v2.48）：
 * - GET /api/nodes/countries 返回国家清单（含节点数）与已选集合
 * - PUT /api/nodes/countries 保存白名单；非法码 400
 * - GET /api/nodes 返回 countryExcluded；锁定节点豁免
 * - 空数组 = 不过滤
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { countryDisplayName } from '@/data/country-codes';

const HK = 'hk.example.com';
const AR = 'ar.example.com';
const UNKNOWN = 'unknown.example.com';

const mkNode = (server: string): Node =>
  createNode({
    id: server,
    name: server,
    protocol: 'vless',
    server,
    port: 443,
    metadata: { source: 'test', originalName: server, tags: [] },
  } as Partial<Node> & { name: string });

interface NodeRow {
  server: string;
  country: string;
  countryExcluded: boolean;
  locked: boolean;
}

describe('输出国家组 API', () => {
  let app: ReturnType<typeof createApp>;
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass' }),
    });
    const token = ((await login.json()) as { data: { token: string } }).data.token;
    headers = { Cookie: `sub_session=${token}`, 'Content-Type': 'application/json' };

    await repos.nodes.setBySubscription('sub-1', [mkNode(HK), mkNode(AR), mkNode(UNKNOWN)]);
    // 预置 HK/AR 地理缓存；UNKNOWN 不预置 → 走 fetch 桩（返回空 → 未识别）
    await repos.settings.set(`ip_geo:${HK}`, `${Date.now()}|${countryDisplayName('HK')}`);
    await repos.settings.set(`ip_geo:${AR}`, `${Date.now()}|${countryDisplayName('AR')}`);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const listNodes = async (): Promise<{ data: NodeRow[]; outputCountries: string[] }> => {
    const res = await app.request('/api/nodes', { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: NodeRow[]; outputCountries: string[] };
  };

  it('GET 返回国家清单（含节点数）与空选择', async () => {
    const res = await app.request('/api/nodes/countries', { headers });
    expect(res.status).toBe(200);
    const d = ((await res.json()) as {
      data: { available: Array<{ code: string; count: number }>; selected: string[]; enabled: boolean };
    }).data;
    expect(d.selected).toEqual([]);
    expect(d.enabled).toBe(false);
    const byCode = new Map(d.available.map((c) => [c.code, c.count]));
    expect(byCode.get('HK')).toBe(1);
    expect(byCode.get('AR')).toBe(1);
    // 返回全部已知国家（含无节点的），前端默认只展示有节点的
    expect(byCode.get('US')).toBe(0);
  });

  it('PUT 保存白名单后，列表标记 countryExcluded（未识别国家也排除）', async () => {
    const put = await app.request('/api/nodes/countries', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ countries: ['hk'] }),
    });
    expect(put.status).toBe(200);
    const saved = ((await put.json()) as { data: { selected: string[] } }).data;
    expect(saved.selected).toEqual(['HK']);

    const list = await listNodes();
    expect(list.outputCountries).toEqual(['HK']);
    const byServer = new Map(list.data.map((n) => [n.server, n]));
    expect(byServer.get(HK)!.countryExcluded).toBe(false);
    expect(byServer.get(AR)!.countryExcluded).toBe(true);
    expect(byServer.get(UNKNOWN)!.countryExcluded).toBe(true);
  });

  it('锁定节点即使国家未启用也不标记 countryExcluded', async () => {
    await app.request('/api/nodes/countries', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ countries: ['HK'] }),
    });
    const arNode = mkNode(AR);
    await app.request('/api/nodes/locked', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fingerprint: nodeFingerprint(arNode), locked: true }),
    });

    const list = await listNodes();
    const byServer = new Map(list.data.map((n) => [n.server, n]));
    expect(byServer.get(AR)!.locked).toBe(true);
    expect(byServer.get(AR)!.countryExcluded).toBe(false);
  });

  it('PUT 空数组 = 不过滤，全部 countryExcluded=false', async () => {
    await app.request('/api/nodes/countries', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ countries: ['HK'] }),
    });
    const clear = await app.request('/api/nodes/countries', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ countries: [] }),
    });
    expect(clear.status).toBe(200);
    const list = await listNodes();
    expect(list.outputCountries).toEqual([]);
    for (const n of list.data) expect(n.countryExcluded).toBe(false);
  });

  it('PUT 非法国家码返回 400', async () => {
    const res = await app.request('/api/nodes/countries', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ countries: ['ZZ', 'HK'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe('INVALID_PARAMETER');
  });

  it('output/status 的 excluded.country 与国家过滤一致', async () => {
    await app.request('/api/nodes/countries', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ countries: ['HK'] }),
    });
    const res = await app.request('/api/output/status', { headers });
    expect(res.status).toBe(200);
    const d = ((await res.json()) as {
      data: { nodes: { inOutput: number; excluded: { country: number } } };
    }).data;
    expect(d.nodes.inOutput).toBe(1);
    expect(d.nodes.excluded.country).toBe(2);
  });
});
