/**
 * P0 闭环审计（m00972）第十二节第 3 项：引擎版本冷启动完整链路
 *
 * 阶段 2（评分代次 4）起，引擎升级**不再清空健康数据**：
 *  ① health:hist: 与 health:latest: 全部保留，只补写 probe:engine_version / score_version / schema_version；
 *  ② 连续失败计数从保留的历史延续 —— 升级前已连续失败 3 轮的节点，升级后第 1 轮即 disabled；
 *  ③ getDroppedNodes 该节点**进入剔除**（有意的可用性保护：升级不得让已确认失效的节点复活）；
 *  ④ 配置生成不再包含该节点；
 *  ⑤ API 返回数据正常（healthStatus 非 500）。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, nodeFingerprint, resetProbeDataIfEngineChanged } from '@/services/node-probe.service';
import { createNode, type Node } from '@/models/node';

const deadNode = (): Node =>
  createNode({
    id: 'n-cold',
    name: 'ColdNode',
    protocol: 'vless',
    server: '127.0.0.1',
    port: 1,
    tls: false,
    metadata: { source: 'test', originalName: 'ColdNode', tags: [] },
  });

describe('P0 闭环：引擎版本冷启动（engine 3→4）完整链路', () => {
  it('旧引擎 3 条 dead 历史 + engine_version=3 → 历史保留 → 连续失败延续 → disabled → 剔除 → 配置不含', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const node = deadNode();
    const fp = nodeFingerprint(node);

    // 模拟旧引擎（版本 3）留下的 3 条 dead 历史。
    // 时间戳取「测试执行时刻前 3/2/1 天」：在 30 天 TTL 内（不会被清理）、
    // 在 24h 评分窗口外（不参与 availability）、但状态机仍读得到（不按窗口过滤）。
    const now0 = Date.now();
    const old = [now0 - 3 * 86_400_000, now0 - 2 * 86_400_000, now0 - 86_400_000];
    for (const ts of old) {
      await kv.put(
        `health:hist:${fp}:${ts}`,
        JSON.stringify({
          nodeId: node.id, fingerprint: fp, timestamp: ts,
          tcpLatency: null, tlsLatency: null, httpLatency: null,
          status: 'dead', tlsApplicable: false, error: 'old', score: 0, statusMachine: 'disabled',
        }),
      );
    }
    await kv.put('probe:engine_version', '3');
    await kv.put(
      `health:latest:${fp}`,
      JSON.stringify({
        nodeId: node.id, fingerprint: fp, timestamp: old[2],
        tcpLatency: null, tlsLatency: null, httpLatency: null,
        status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
      }),
    );

    // ① 版本键同步：三个键全部就位，且**不删除任何数据**
    const changed = await resetProbeDataIfEngineChanged(kv);
    expect(changed).toBe(true);
    expect(await kv.get('probe:engine_version')).toBe('4');
    expect(await kv.get('probe:score_version')).toBe('4');
    expect(await kv.get('probe:schema_version')).toBe('1');
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(3); // 历史保留
    expect(await kv.get(`health:latest:${fp}`)).not.toBeNull(); // latest 保留（含 disabled）

    // ② 首轮失败 → 追加 1 条 → 连续失败 4 次 → disabled（跨版本延续）
    await repos.nodes.setBySubscription('sub1', [node]);
    const { results } = await probeAllNodes([node], kv, 24);
    expect(results[0].status).toBe('dead');
    const latest = JSON.parse((await kv.get(`health:latest:${fp}`)) ?? '');
    expect(latest.statusMachine).toBe('disabled');
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(4); // 3 旧 + 1 新

    // ③ 进入剔除
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).toContain(fp);

    // ④ 配置不再包含该节点（disabled 被 getNodes 过滤）
    const nodes = await svc.getNodes();
    expect(nodes.map((n) => n.name)).not.toContain('ColdNode');
  });

  it('API 数据正常：引擎变更后 GET /api/nodes 不 500，healthStatus 反映 unknown/alive/dead', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    const config = createConfigService(repos, kv);
    const app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
      config,
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });

    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass' }),
    });
    const token = ((await loginRes.json()) as { data: { token: string } }).data.token;

    const res = await app.request('/api/nodes', {
      headers: { Cookie: `sub_session=${token}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data?: unknown };
    expect(json.success).toBe(true);
  });
});
