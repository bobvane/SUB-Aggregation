/**
 * 集成测试 - 首屏 bootstrap（/api/auth/session?page=...）
 *
 * 目标：首次打开页面从 3 次串行往返（session → username → dashboard）降到 1 次。
 * 同时保证「不为没在看的页面白算仪表盘」。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { Node } from '@/models/node';

interface ResData { success: boolean; data?: Record<string, unknown>; }

function makeNode(id: string, name: string, protocol: Node['protocol'], server: string): Node {
  return { id, name, protocol, server, port: 443, metadata: { source: 'test', originalName: name, tags: [] }, version: 1 };
}

describe('首屏 bootstrap - /api/auth/session', () => {
  let app: ReturnType<typeof createApp>;
  let token: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    await repos.subscriptions.create({ name: 'test', url: 'https://example.com/sub' });
    await repos.nodes.setBySubscription('test', [
      makeNode('n1', 'HK-01', 'vmess', '1.2.3.4'),
      makeNode('n2', 'US-01', 'trojan', '5.6.7.8'),
    ]);
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], async () => [], kv),
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
    token = ((await res.json()) as ResData).data!.token as string;
    headers = { Cookie: `sub_session=${token}` };
  });

  it('未登录：只返回 authenticated=false，不带用户名和首屏数据', async () => {
    const res = await app.request('/api/auth/session?page=dashboard');
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    expect(json.data!.authenticated).toBe(false);
    expect(json.data!.username).toBeUndefined();
    expect(json.data!.dashboard).toBeUndefined();
  });

  it('已登录 + page=dashboard：一次返回用户名和仪表盘数据', async () => {
    const res = await app.request('/api/auth/session?page=dashboard', { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.data!.authenticated).toBe(true);
    expect(typeof json.data!.username).toBe('string');
    const d = json.data!.dashboard as Record<string, unknown>;
    expect(d.subscriptions).toBe(1);
    expect(d.nodes).toBe(2);
    expect(d.status).toBe('ok');
  });

  it('bootstrap 返回的 dashboard 与直接请求 /api/dashboard 完全一致', async () => {
    const boot = (await (await app.request('/api/auth/session?page=dashboard', { headers })).json()) as ResData;
    const direct = (await (await app.request('/api/dashboard', { headers })).json()) as ResData;
    expect(boot.data!.dashboard).toEqual(direct.data);
  });

  it('非仪表盘页：返回用户名但不计算仪表盘（不为没看的页面做 KV 读取）', async () => {
    const res = await app.request('/api/auth/session?page=nodes', { headers });
    const json = (await res.json()) as ResData;
    expect(json.data!.authenticated).toBe(true);
    expect(typeof json.data!.username).toBe('string');
    expect(json.data!.dashboard).toBeUndefined();
  });

  it('不带 page 参数：不返回仪表盘数据', async () => {
    const res = await app.request('/api/auth/session', { headers });
    const json = (await res.json()) as ResData;
    expect(json.data!.authenticated).toBe(true);
    expect(json.data!.dashboard).toBeUndefined();
  });
});
