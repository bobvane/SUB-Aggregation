/**
 * 2026-11-10 节点列表「移出配置」按钮的后端回归。
 *
 * 背景：getNodes() 的过滤优先级是 locked > disabled > dropped > removed_at，
 * 锁定节点豁免一切。若「移出配置」只写 disabled 而不解锁，按钮点了节点却仍会强制进配置。
 * 本测试锁死单节点接口行为与「锁定 / 移出配置」互斥语义。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { countryDisplayName } from '@/data/country-codes';

const A = 'a.example.com';
const B = 'b.example.com';

const mkNode = (server: string): Node =>
  createNode({
    id: server,
    name: server,
    protocol: 'vless',
    server,
    port: 443,
    metadata: { source: 'test', originalName: server, tags: [] },
  } as Partial<Node> & { name: string });

const fp = (server: string) => nodeFingerprint(mkNode(server));

interface ApiData {
  success: boolean;
  data?: {
    fingerprint?: string;
    excluded?: boolean;
    locked?: boolean;
    unlocked?: boolean;
    restored?: boolean;
    excludedCount?: number;
    lockedCount?: number;
  };
  error?: { code: string; message: string };
}

describe('POST /api/nodes/excluded（手工移出配置）', () => {
  let app: ReturnType<typeof createApp>;
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;
  let config: ReturnType<typeof createConfigService>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    config = createConfigService(repos, kv);
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => [], kv),
      config,
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

    await repos.nodes.setBySubscription('sub-1', [mkNode(A), mkNode(B)]);
    // 预置 ip-geo 缓存，避免 autoNamed() 在 GET /api/nodes 时发起外部查询
    for (const s of [A, B]) {
      await repos.settings.set(`ip_geo:${s}`, `${Date.now()}|${countryDisplayName('HK')}`);
    }
  });

  const post = (body: unknown) =>
    app.request('/api/nodes/excluded', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

  const postLocked = (fingerprint: string, locked: boolean) =>
    app.request('/api/nodes/locked', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fingerprint, locked }),
    });

  it('移出配置写入 disabled，节点从 getNodes() 消失，GET /api/nodes 回 excluded=true', async () => {
    expect(await config.getNodes()).toHaveLength(2);

    const res = await post({ fingerprint: fp(A), excluded: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as ApiData).toMatchObject({
      success: true,
      data: { fingerprint: fp(A), excluded: true, unlocked: false, excludedCount: 1 },
    });
    expect(await config.getDisabledNodes()).toEqual([fp(A)]);
    expect((await config.getNodes()).map((n) => n.server)).toEqual([B]);

    const list = await app.request('/api/nodes', { headers });
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as {
      data: Array<{ fingerprint: string; excluded: boolean; enabled: boolean; locked: boolean }>;
    }).data;
    expect(rows.find((r) => r.fingerprint === fp(A))).toMatchObject({
      excluded: true,
      enabled: false,
      locked: false,
    });
    expect(rows.find((r) => r.fingerprint === fp(B))!.excluded).toBe(false);
  });

  it('已锁定节点移出配置时自动解锁，否则 locked 会覆盖 disabled', async () => {
    await config.setLockedNodes([fp(A)]);
    expect(await config.getNodes()).toHaveLength(2);

    const res = await post({ fingerprint: fp(A), excluded: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as ApiData).toMatchObject({
      success: true,
      data: { excluded: true, unlocked: true },
    });
    expect(await config.getLockedNodes()).toEqual([]);
    expect((await config.getNodes()).map((n) => n.server)).toEqual([B]);
  });

  it('恢复后节点重新进配置，且不会自动重新锁定', async () => {
    await post({ fingerprint: fp(A), excluded: true });
    const res = await post({ fingerprint: fp(A), excluded: false });
    expect((await res.json()) as ApiData).toMatchObject({
      success: true,
      data: { excluded: false, excludedCount: 0, unlocked: false },
    });
    expect(await config.getDisabledNodes()).toEqual([]);
    expect(await config.getLockedNodes()).toEqual([]);
    expect(await config.getNodes()).toHaveLength(2);
  });

  it('锁定一个已移出配置的节点会恢复它（两个状态互斥）', async () => {
    await post({ fingerprint: fp(A), excluded: true });
    expect(await config.getNodes()).toHaveLength(1);

    const res = await postLocked(fp(A), true);
    expect(res.status).toBe(200);
    expect((await res.json()) as ApiData).toMatchObject({
      success: true,
      data: { locked: true, restored: true },
    });
    expect(await config.getDisabledNodes()).toEqual([]);
    expect(await config.getNodes()).toHaveLength(2);
  });

  it('重复移出配置只保留一条记录（幂等）', async () => {
    await post({ fingerprint: fp(A), excluded: true });
    await post({ fingerprint: fp(A), excluded: true });
    expect(await config.getDisabledNodes()).toEqual([fp(A)]);
  });

  it('单节点接口不会冲掉其他节点的排除状态', async () => {
    await post({ fingerprint: fp(A), excluded: true });
    await post({ fingerprint: fp(B), excluded: true });
    expect((await config.getDisabledNodes()).sort()).toEqual([fp(A), fp(B)].sort());
    await post({ fingerprint: fp(A), excluded: false });
    expect(await config.getDisabledNodes()).toEqual([fp(B)]);
  });

  it('缺少 fingerprint 或 excluded 非布尔时返回 400，且不写入状态', async () => {
    expect((await post({ excluded: true })).status).toBe(400);
    expect((await post({ fingerprint: fp(A), excluded: 'yes' })).status).toBe(400);
    expect(await config.getDisabledNodes()).toEqual([]);
  });
});
