/**
 * 集成测试 - 仪表盘 API
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { Node } from '@/models/node';

interface ResData { success: boolean; data?: Record<string, unknown>; }

async function loginToken(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass' }),
  });
  return ((await res.json()) as ResData).data!.token as string;
}

function makeNode(id: string, name: string, protocol: Node['protocol'], server: string): Node {
  return { id, name, protocol, server, port: 443, metadata: { source: 'test', originalName: name, tags: [] }, version: 1 };
}

describe('Dashboard API', () => {
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;
  let repos: ReturnType<typeof createRepositories>;

  beforeEach(async () => {
    const kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    // 注入 1 个订阅 + 2 个节点（vmess + trojan）
    await repos.subscriptions.create({ name: 'test', url: 'https://example.com/sub' });
    await repos.nodes.setBySubscription('test', [
      makeNode('n1', 'HK-01', 'vmess', '1.2.3.4'),
      makeNode('n2', 'US-01', 'trojan', '5.6.7.8'),
    ]);
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    const token = await loginToken(app);
    headers = { Cookie: `sub_session=${token}` };
  });

  it('GET /api/dashboard 返回完整统计字段', async () => {
    const res = await app.request('/api/dashboard', { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: {
      subscriptions: number; enabledSubscriptions: number; disabledSubscriptions: number;
      nodes: number; uniqueNodes: number; duplicates: number; enabledNodes: number; disabledNodes: number;
      alive: number; dead: number; droppedNodes: number; lastProbe: number | null;
      protoCount: Record<string, number>; lastUpdate: number | null; status: string;
    } };
    expect(json.success).toBe(true);
    expect(json.data.subscriptions).toBe(1);
    expect(json.data.enabledSubscriptions).toBe(1);
    expect(json.data.disabledSubscriptions).toBe(0);
    expect(json.data.nodes).toBe(2);
    // v2.36.3：与节点列表页同口径的去重 + 测活健康字段
    expect(json.data.uniqueNodes).toBe(2);
    expect(json.data.alive).toBe(0); // 未测活时存活/不通/已抛弃均为 0
    expect(json.data.dead).toBe(0);
    expect(json.data.droppedNodes).toBe(0);
    expect(json.data.lastProbe).toBe(null);
    expect(json.data.enabledNodes).toBe(2);
    expect(json.data.disabledNodes).toBe(0);
    expect(json.data.protoCount.vmess).toBe(1);
    expect(json.data.protoCount.trojan).toBe(1);
    expect(json.data.status).toBe('ok');
  });

  it('节点总数含停用订阅的节点，已禁用订阅单独计数（2026-09-24 用户指令）', async () => {
    // 再建一个订阅并停用它：其节点应计入「节点总数」，不计入「已启用节点」
    const off = await repos.subscriptions.create({ name: 'off', url: 'https://example.com/off' });
    await repos.nodes.setBySubscription(off.id, [
      makeNode('n3', 'JP-01', 'ss', '9.9.9.9'),
    ]);
    await repos.subscriptions.update(off.id, { enabled: false });

    const res = await app.request('/api/dashboard', { headers });
    const json = (await res.json()) as { data: {
      subscriptions: number; enabledSubscriptions: number; disabledSubscriptions: number; nodes: number;
      enabledNodes: number; protoCount: Record<string, number>;
    } };
    expect(json.data.subscriptions).toBe(2);
    expect(json.data.enabledSubscriptions).toBe(1);
    expect(json.data.disabledSubscriptions).toBe(1);
    expect(json.data.nodes).toBe(3); // 启用订阅 2 + 停用订阅 1
    expect(json.data.enabledNodes).toBe(2); // 只算启用订阅
    expect(json.data.protoCount.ss).toBe(1); // 协议分布与节点总数同口径
  });
});