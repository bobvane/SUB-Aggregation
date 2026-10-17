/**
 * v2.38.6：/api/output/status 与 /api/output/refresh
 * - 状态数字必须与 getNodes() 同口径（真实进配置的节点数）
 * - 刷新只失效 + 重新生成，不产生任何外部请求
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

const SUB_ID = 'sub-1';
interface TestNode {
  id: string; name: string; protocol: 'vless'; server: string; port: number;
  metadata: { source: string }; version: number;
}
function node(i: number, server: string): TestNode {
  return { id: 'n' + i, name: 'NODE-' + i, protocol: 'vless', server, port: 443 + i, metadata: { source: SUB_ID }, version: 1 };
}
interface StatusData {
  dataVersion: number;
  stale: boolean;
  lastGeneratedAt: number | null;
  snapshot: { version: number; generatedAt: number } | null;
  nodes: { ingested: number; inOutput: number; excluded: { subscriptionDisabled: number; removed: number; disabled: number; dropped: number } };
  formats: { mihomo: { state: string }; others: { mode: string } };
}

describe('output status / refresh API（v2.38.6）', () => {
  let app: ReturnType<typeof createApp>;
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;
  let headers: Record<string, string>;

  async function setup(nodes: ReturnType<typeof node>[]) {
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-pass' }),
    });
    const json = (await res.json()) as { data: { token: string } };
    headers = { Cookie: 'sub_session=' + json.data.token, 'Content-Type': 'application/json' };
    await kv.put('nodes:' + SUB_ID, JSON.stringify(nodes));
    // 预填地理缓存：生成配置时不触发外部请求
    const ts = Date.now();
    for (const n of nodes) await repos.settings.set('ip_geo:' + n.server, `${ts}|日本`);
  }

  async function status(): Promise<StatusData> {
    const res = await app.request('/api/output/status', { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: StatusData }).data;
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  });

  it('首次状态：未生成快照 → stale，并给出真实节点构成', async () => {
    await setup([node(1, 'n1.example.com'), node(2, 'n2.example.com'), node(3, 'n3.example.com'), node(4, 'n4.example.com')]);
    const cfg = createConfigService(repos, kv);
    // 指纹 = server:port:protocol（node(2) 的 port = 443 + 2 = 445）
    await cfg.setDisabledNodes(['n2.example.com:445:vless']);

    const s = await status();
    expect(s.nodes.ingested).toBe(4);
    expect(s.nodes.inOutput).toBe(3);
    expect(s.nodes.excluded.disabled).toBe(1);
    expect(s.stale).toBe(true);
    expect(s.snapshot).toBeNull();
    expect(s.formats.mihomo.state).toBe('not-generated');
    expect(s.formats.others.mode).toBe('live');
  });

  it('生成后状态为最新；新增节点后变回待刷新；刷新后追上', async () => {
    await setup([node(1, 'n1.example.com'), node(2, 'n2.example.com'), node(3, 'n3.example.com')]);
    // 生成一次快照
    const gen = await app.request('/api/output/mihomo', { headers });
    expect(gen.status).toBe(200);
    let s = await status();
    expect(s.stale).toBe(false);
    expect(s.formats.mihomo.state).toBe('generated');
    expect(s.lastGeneratedAt).toBeGreaterThan(0);

    // 直接写入一个新节点（模拟订阅更新已落库但尚未显式失效被绕过）
    await kv.put('nodes:' + SUB_ID, JSON.stringify([
      node(1, 'n1.example.com'), node(2, 'n2.example.com'), node(3, 'n3.example.com'), node(4, 'n4.example.com'),
    ]));
    await repos.settings.set('ip_geo:n4.example.com', `${Date.now()}|日本`);
    const cfg2 = createConfigService(repos, kv);
    await cfg2.resetCache(); // 模拟“数据版本前进”
    s = await status();
    expect(s.stale).toBe(true);
    expect(s.nodes.inOutput).toBe(4);

    const fetchMock = globalThis.fetch as unknown as { mock?: { calls: unknown[] } };
    const before = fetchMock.mock ? fetchMock.mock.calls.length : 0;

    const refresh = await app.request('/api/output/refresh', { method: 'POST', headers });
    expect(refresh.status).toBe(200);
    const rj = ((await refresh.json()) as { data: { generated: boolean; nodes: { inOutput: number }; stale: boolean } }).data;
    expect(rj.generated).toBe(true);
    expect(rj.nodes.inOutput).toBe(4);
    expect(rj.stale).toBe(false);

    const after = fetchMock.mock ? fetchMock.mock.calls.length : 0;
    expect(after).toBe(before); // 刷新不产生任何外部请求

    s = await status();
    expect(s.stale).toBe(false);

    const cfgText = await (await app.request('/api/output/mihomo', { headers })).text();
    expect(cfgText).toContain('n4.example.com');
  });

  it('停用订阅的节点计入 excluded.subscriptionDisabled，不进配置', async () => {
    await setup([node(1, 'n1.example.com')]);
    await repos.subscriptions.create({ name: 'other', url: 'https://x/sub' });
    const subs = await repos.subscriptions.list();
    const other = subs.find((s) => s.name === 'other')!;
    await repos.nodes.setBySubscription(other.id, [node(9, 'n9.example.com') as unknown as import('@/models/node').Node]);
    await repos.subscriptions.update(other.id, { enabled: false });
    await repos.settings.set('ip_geo:n9.example.com', `${Date.now()}|日本`);

    const s = await status();
    expect(s.nodes.ingested).toBe(2);
    expect(s.nodes.inOutput).toBe(1);
    expect(s.nodes.excluded.subscriptionDisabled).toBe(1);
  });
});
