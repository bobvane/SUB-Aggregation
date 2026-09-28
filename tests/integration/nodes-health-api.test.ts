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
import { countryDisplayName } from '@/data/country-codes';
import { nodeFingerprint } from '@/models/node';
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
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
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

  it('GET /api/nodes 返回自动命名后的节点名 + 健康字段（v2.36：名字不带延迟）', async () => {
    await repos.nodes.setBySubscription('sub-1', [
      { name: '香港01-中转', protocol: 'vless', server: 'hk1.example.com', port: 443, tls: true } as never,
    ]);
    await repos.settings.set('ip_geo:hk1.example.com', `${Date.now()}|${countryDisplayName('HK')}`);
    await kv.put(
      KV_KEYS.healthLatest(nodeFingerprint({ server: 'hk1.example.com', port: 443, protocol: 'vless' } as never)),
      JSON.stringify(snapshot(nodeFingerprint({ server: 'hk1.example.com', port: 443, protocol: 'vless' } as never), 1700000000000))
    );

    const res = await app.request('/api/nodes', { headers });
    expect(res.status).toBe(200);
    const list = ((await res.json()) as ResData).data as Array<{
      name: string; country: string; latency: number | null; score: number | null;
      healthStatus: string | null; dropped: boolean;
    }>;
    // 旧行为：库里存什么显示什么（'香港01-中转'）；v2.35.1 起与配置输出同款自动命名
    // v2.36：延迟不再写进名字（否则每次生成名字都变，客户端会当新节点）
    expect(list[0].name).toBe('🇭🇰 HK VLESS-01');
    // 列表页排序/状态列需要的数据由接口一次给全
    expect(list[0].country).toBe('HK');
    expect(list[0].latency).toBe(45); // TLS RTT 优先（tcp 30 / http 80 都不该被选中）
    expect(list[0].score).toBe(92);
    expect(list[0].healthStatus).toBe('alive');
    expect(list[0].dropped).toBe(false);
  });

  it('熔断抛弃的节点在列表页可见（dropped=true）且不进入生成的配置', async () => {
    await repos.nodes.setBySubscription('sub-1', [
      { name: 'dead-1', protocol: 'vless', server: 'dead.example.com', port: 443, tls: true } as never,
    ]);
    const fp = nodeFingerprint({ server: 'dead.example.com', port: 443, protocol: 'vless' } as never);
    await kv.put(
      KV_KEYS.healthLatest(fp),
      JSON.stringify({ ...snapshot(fp, 1700000000000), status: 'dead', tcpLatency: null, tlsLatency: null, httpLatency: null, score: 0, statusMachine: 'disabled' })
    );

    const res = await app.request('/api/nodes', { headers });
    const list = ((await res.json()) as ResData).data as Array<{ fingerprint: string; dropped: boolean }>;
    expect(list.find((n) => n.fingerprint === fp)?.dropped).toBe(true);

    // 抛弃 = 不输出到配置：getNodes（生成配置的节点来源）必须过滤掉它
    const config = createConfigService(repos, kv);
    expect((await config.getNodes()).some((n) => nodeFingerprint(n) === fp)).toBe(false);
    expect(await config.getDroppedNodes()).toContain(fp);
  });

  it('v2.36.2：最新一轮 dead 即抛弃（不必等状态机 3 次失败到 disabled）', async () => {
    await repos.nodes.setBySubscription('sub-1', [
      { name: 'dead-2', protocol: 'vless', server: 'dead2.example.com', port: 443, tls: true } as never,
    ]);
    const fp = nodeFingerprint({ server: 'dead2.example.com', port: 443, protocol: 'vless' } as never);
    // 状态机才 active（仅一轮不通），但最新结果为 dead —— 应当立即从配置剔除
    await kv.put(
      KV_KEYS.healthLatest(fp),
      JSON.stringify({ ...snapshot(fp, 1700000000000), status: 'dead', tcpLatency: null, tlsLatency: null, httpLatency: null, score: 0, statusMachine: 'active' })
    );
    const config = createConfigService(repos, kv);
    expect((await config.getNodes()).some((n) => nodeFingerprint(n) === fp)).toBe(false);
    expect(await config.getDroppedNodes()).toContain(fp);
  });

  it('GET /api/nodes/health 未登录返回 401', async () => {
    const res = await app.request('/api/nodes/health');
    expect(res.status).toBe(401);
  });
});
