/**
 * 集成测试 - 未识别国家码自动重试状态 API
 * 验证 /api/nodes/geo-pending 端点（v2.19.1）
 * 前端节点列表页提示「重试10次仍有N个IP未识别国家码，建议检查节点正确性」
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

const TEST_CONTENT = 'ss://aes-256-gcm:pass@jp1.example.com:8388#JP-1';

interface ResData {
  success: boolean;
  data?: { retryCount?: number; lastRetryTs?: number | null; unlocatedServers?: string[]; resultTs?: number | null };
  error?: { code: string; message: string };
}

async function loginToken(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass' }),
  });
  const json = (await res.json()) as ResData;
  return (json.data as unknown as { token: string }).token;
}

describe('Geo Pending API', () => {
  let app: ReturnType<typeof createApp>;
  let baseHeaders: Record<string, string>;
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;

  beforeEach(async () => {
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
      subscriptions: createSubscriptionService(repos, async () => TEST_CONTENT, async () => [], async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => TEST_CONTENT,
      parseContent: async () => [],
    });
    const token = await loginToken(app);
    baseHeaders = { Cookie: `sub_session=${token}` };
  });

  it('GET /api/nodes/geo-pending 未设置时返回空状态（retryCount=0, unlocatedServers=[]）', async () => {
    const res = await app.request('/api/nodes/geo-pending', { headers: baseHeaders });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    expect(json.data!.retryCount).toBe(0);
    expect(json.data!.unlocatedServers).toEqual([]);
  });

  it('GET /api/nodes/geo-pending 返回重试10次的未识别IP列表（前端提示用）', async () => {
    await repos.settings.set('geo_pending_retry', JSON.stringify({ ts: 1700000000000, count: 10 }));
    await repos.settings.set('geo_pending_result', JSON.stringify({ ts: 1700000060000, unlocatedServers: ['1.2.3.4', '5.6.7.8'] }));
    const res = await app.request('/api/nodes/geo-pending', { headers: baseHeaders });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    expect(json.data!.retryCount).toBe(10);
    expect(json.data!.unlocatedServers).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(json.data!.lastRetryTs).toBe(1700000000000);
    expect(json.data!.resultTs).toBe(1700000060000);
  });

  it('GET /api/nodes/geo-pending 重试过程中（retryCount<10）仍有未识别IP（界面不提示）', async () => {
    await repos.settings.set('geo_pending_retry', JSON.stringify({ ts: 1700000000000, count: 3 }));
    await repos.settings.set('geo_pending_result', JSON.stringify({ ts: 1700000060000, unlocatedServers: ['9.9.9.9'] }));
    const res = await app.request('/api/nodes/geo-pending', { headers: baseHeaders });
    const json = (await res.json()) as ResData;
    expect(json.data!.retryCount).toBe(3);
    expect(json.data!.unlocatedServers).toEqual(['9.9.9.9']);
  });

  it('GET /api/nodes/geo-pending 未登录返回 401', async () => {
    const res = await app.request('/api/nodes/geo-pending');
    expect(res.status).toBe(401);
  });

  it('损坏的 KV 数据不报错，降级为空状态', async () => {
    await kv.put('setting:geo_pending_retry', 'not-json{{{');
    await kv.put('setting:geo_pending_result', 'garbage');
    const res = await app.request('/api/nodes/geo-pending', { headers: baseHeaders });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    expect(json.data!.retryCount).toBe(0);
    expect(json.data!.unlocatedServers).toEqual([]);
  });
});