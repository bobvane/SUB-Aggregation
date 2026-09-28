/**
 * 集成测试 - 节点健康 API（v2.32）
 *
 * 回归背景：路由曾把 `repos.settings`（KvSettingsRepository，只有 get/set）
 * 强转成 KVStorage 传给探测引擎 → list/put 不存在 →
 *   ① GET /api/nodes/health 抛 500
 *   ② 订阅更新后的全量测活静默失败（异常被 waitUntil 吞掉），健康数据一条都写不进去
 * 修复：用裸 kv（repos.kv / deps.storage）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { KV_KEYS } from '@/models/config';

interface ResData {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

async function loginToken(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass' }),
  });
  return ((await res.json()) as { data: { token: string } }).data.token;
}

const snapshot = (fingerprint: string, timestamp: number) => ({
  nodeId: `n-${fingerprint}`,
  fingerprint,
  timestamp,
  tcpLatency: 30,
  tlsLatency: 45,
  httpLatency: 80,
  status: 'alive' as const,
  error: null,
  score: 92,
});

describe('Nodes Health API', () => {
  let app: ReturnType<typeof createApp>;
  let kv: MemoryKvAdapter;
  let headers: Record<string, string>;

  beforeEach(async () => {
    kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    headers = { Cookie: `sub_session=${await loginToken(app)}` };
  });

  it('GET /api/nodes/health 返回全部健康快照（修复前此请求 500）', async () => {
    await kv.put(KV_KEYS.healthLatest('fp-hk-01'), JSON.stringify(snapshot('fp-hk-01', 1700000000000)));
    await kv.put(KV_KEYS.healthLatest('fp-us-01'), JSON.stringify(snapshot('fp-us-01', 1700000001000)));

    const res = await app.request('/api/nodes/health', { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    const list = json.data as Array<{ fingerprint: string; score: number }>;
    expect(list.map((h) => h.fingerprint).sort()).toEqual(['fp-hk-01', 'fp-us-01']);
    expect(list[0].score).toBe(92);
  });

  it('GET /api/nodes/health?fingerprint= 返回该节点历史', async () => {
    await kv.put(KV_KEYS.healthHistory('fp-hk-01', 1700000000000), JSON.stringify(snapshot('fp-hk-01', 1700000000000)));
    await kv.put(KV_KEYS.healthHistory('fp-hk-01', 1700000001000), JSON.stringify(snapshot('fp-hk-01', 1700000001000)));
    await kv.put(KV_KEYS.healthHistory('fp-us-01', 1700000002000), JSON.stringify(snapshot('fp-us-01', 1700000002000)));

    const res = await app.request('/api/nodes/health?fingerprint=fp-hk-01', { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    const history = json.data as Array<{ fingerprint: string; timestamp: number }>;
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.fingerprint === 'fp-hk-01')).toBe(true);
  });

  it('GET /api/nodes/health 未登录返回 401', async () => {
    const res = await app.request('/api/nodes/health');
    expect(res.status).toBe(401);
  });
});
