/**
 * 慢节点抛弃阈值（node_drop_latency_ms）—— v2.38.3 恢复
 *
 * 语义（两条**相互独立**的规则，见 src/services/config.service.ts getDroppedNodes）：
 * - 规则① 健康状态机确认失效：statusMachine === 'disabled'（连续失败 ≥3 轮）→ 抛弃。
 * - 规则② 慢节点阈值：延迟 > node_drop_latency_ms（100–2000，默认 2000）→ 抛弃。
 *
 * 规则② 是**筛选依据，不是健康判定**：不写 health 历史、不改 statusMachine、
 * 不把节点写成 dead；延迟仍用于健康统计与列表排序；UDP（无延迟样本）不被误伤。
 * 边界：latency > threshold 才抛弃，latency === threshold 不抛弃（与列表页红字高亮同口径）。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { KV_KEYS } from '@/models/config';
import { createConfigService, DEFAULT_NODE_DROP_LATENCY_MS } from '@/services/config.service';
import { probeAllNodes } from '@/services/node-probe.service';
import { createNode, nodeFingerprint } from '@/models/node';

const putLatest = (kv: MemoryKvAdapter, fp: string, status: string, tcpLatency: number | null, statusMachine?: string) =>
  kv.put(KV_KEYS.healthLatest(fp), JSON.stringify({
    fingerprint: fp, status, timestamp: Date.now(),
    tcpLatency, tlsLatency: null, score: status === 'dead' ? 0 : 50,
    ...(statusMachine ? { statusMachine } : {}),
  }));

const putHistory = (kv: MemoryKvAdapter, fp: string, ts: number, status: string, tcpLatency: number | null) =>
  kv.put(KV_KEYS.healthHistory(fp, ts), JSON.stringify({
    fingerprint: fp, status, timestamp: ts,
    tcpLatency, tlsLatency: null, score: status === 'dead' ? 0 : 50,
  }));

describe('规则② 慢节点阈值：按用户配置抛弃超阈值节点', () => {
  it('RTT 低于阈值 → 不因慢节点规则被抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'fast', 'alive', 300, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('fast');
  });

  it('RTT 高于默认阈值（2000）→ 归入已抛弃，且健康状态不被改写', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'slow', 'alive', 2500, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain('slow');

    // 健康快照保持原样：status=alive / statusMachine=active，未被"伪造失败"
    const snap = JSON.parse((await kv.get(KV_KEYS.healthLatest('slow'))) ?? '{}') as {
      status: string; statusMachine?: string; tcpLatency: number | null;
    };
    expect(snap.status).toBe('alive');
    expect(snap.statusMachine).toBe('active');
    expect(snap.tcpLatency).toBe(2500);
  });

  it('阈值恰好相等（latency === threshold）→ 不抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'exact', 'alive', 2000, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('exact');
  });

  it('用户调低阈值（500）→ 立即生效：900ms 节点被抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '500');
    await putLatest(kv, 'slow900', 'alive', 900, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain('slow900');
  });

  it('用户调高阈值（2000）→ 1500ms 节点回归配置', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '1000');
    await putLatest(kv, 'slow1500', 'alive', 1500, 'active');
    const repos = createRepositories(kv);
    const before = createConfigService(repos, kv);
    expect(await before.getDroppedNodes()).toContain('slow1500');

    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '2000');
    const after = createConfigService(createRepositories(kv), kv);
    expect(await after.getDroppedNodes()).not.toContain('slow1500');
  });

  it('重启 / 重新加载配置后仍按保存值工作（同一持久化 KV 重建 service）', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '800');
    await putLatest(kv, 'mid', 'alive', 900, 'active');
    const first = createConfigService(createRepositories(kv), kv);
    expect(await first.getDroppedNodes()).toContain('mid');
    const second = createConfigService(createRepositories(kv), kv);
    expect(await second.getDroppedNodes()).toContain('mid');
  });

  it('阈值缺失 → 回退默认 2000（2000 不抛弃 / 2001 抛弃）', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'eq-default', 'alive', DEFAULT_NODE_DROP_LATENCY_MS, 'active');
    await putLatest(kv, 'over-default', 'alive', DEFAULT_NODE_DROP_LATENCY_MS + 1, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).not.toContain('eq-default');
    expect(dropped).toContain('over-default');
  });

  it.each([
    ['非法值（非数字）', 'abc'],
    ['越界偏低（99）', '99'],
    ['越界偏高（2001）', '2001'],
  ])('阈值%s → 回退默认 2000，不静默失效为 0', async (_label, raw) => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), raw);
    await putLatest(kv, 'n300', 'alive', 300, 'active');
    await putLatest(kv, 'n2500', 'alive', 2500, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).not.toContain('n300');
    expect(dropped).toContain('n2500');
  });

  it('阈值下限 100 为合法值：100 不抛弃 / 101 抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '100');
    await putLatest(kv, 'n100', 'alive', 100, 'active');
    await putLatest(kv, 'n101', 'alive', 101, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).not.toContain('n100');
    expect(dropped).toContain('n101');
  });

  it('无延迟样本（null）→ 不被慢节点规则抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'no-latency', 'dead', null, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('no-latency');
  });

  it('TLS 优先于 TCP：tlsLatency 未超阈值时，即便 tcpLatency 超阈值也不抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.healthLatest('tls-wins'), JSON.stringify({
      fingerprint: 'tls-wins', status: 'alive', timestamp: Date.now(),
      tcpLatency: 9000, tlsLatency: 120, score: 50, statusMachine: 'active',
    }));
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('tls-wins');
  });

  it('UDP 节点（unknown 不写健康快照）→ 不被慢节点规则抛弃，仍进 getNodes', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const node = createNode({
      id: 'n-udp', name: 'Udp', protocol: 'tuic', server: '10.1.1.1', port: 443, tls: true,
      metadata: { source: 'test', originalName: 'Udp', tags: [] },
    } as never);
    await repos.nodes.setBySubscription('sub1', [node]);
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '200');
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).not.toContain(nodeFingerprint(node));
    expect((await svc.getNodes()).map((n) => n.name)).toContain('Udp');
  });
});

describe('规则② 与健康状态机相互独立', () => {
  it('慢节点被抛弃但状态机仍是 active（不被写成连续失败）', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'slow-active', 'alive', 2500, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain('slow-active');
    const snap = JSON.parse((await kv.get(KV_KEYS.healthLatest('slow-active'))) ?? '{}') as { statusMachine?: string };
    expect(snap.statusMachine).toBe('active');
  });

  it('规则① 不受阈值影响：latency=null 的 disabled 节点照样被抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'dead-fast', 'dead', null, 'disabled');
    await putLatest(kv, 'fast-alive', 'alive', 50, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain('dead-fast');
    expect(dropped).not.toContain('fast-alive');
  });
});

describe('规则① 健康状态机（原有语义保持不变）', () => {
  it('单轮 dead（statusMachine=suspect）→ 不抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'once-dead', 'dead', null, 'suspect');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('once-dead');
  });

  it('状态机 disabled：连续三轮 dead → 抛弃（经 probeAllNodes 真实链路）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const node = createNode({
      id: 'n-dead3', name: 'Dead3', protocol: 'vless', server: '127.0.0.1', port: 1, tls: false,
      metadata: { source: 'test', originalName: 'Dead3', tags: [] },
    });
    await repos.nodes.setBySubscription('sub1', [node]);
    const f = nodeFingerprint(node);
    for (let i = 0; i < 3; i++) {
      await probeAllNodes([node], kv, 24);
      await new Promise((r) => setTimeout(r, 5));
    }
    const latest = JSON.parse((await kv.get(KV_KEYS.healthLatest(f))) ?? '{}') as { statusMachine?: string };
    expect(latest.statusMachine).toBe('disabled');
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).toContain(f);
  });

  it('无任何健康快照时 getDroppedNodes 返回空（不产生幽灵指纹）', async () => {
    const kv = new MemoryKvAdapter();
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toEqual([]);
  });
});

describe('RTT 统计与排序不受阈值筛选影响', () => {
  it('慢节点仍在健康数据源中（只做筛选，不删数据）', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'slow', 'alive', 2500, 'active');
    await putHistory(kv, 'slow', 1_700_000_000_000, 'alive', 2400);
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain('slow');
    expect(await kv.get(KV_KEYS.healthLatest('slow'))).toBeTruthy();
    expect(await kv.get(KV_KEYS.healthHistory('slow', 1_700_000_000_000))).toBeTruthy();
  });
});

describe('getNodes 过滤链：慢节点被排除，锁定节点豁免', () => {
  const mk = (id: string, name: string, server: string) => createNode({
    id, name, protocol: 'vless' as const, server, port: 443, tls: false,
    metadata: { source: 'test', originalName: name, tags: [] },
  });

  it('慢节点不输出到配置；锁定后强制回归', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const slow = mk('n-1', 'Slow', '10.2.0.1');
    await repos.nodes.setBySubscription('sub1', [slow]);
    const f = nodeFingerprint(slow);
    await putLatest(kv, f, 'alive', 2500, 'active');

    const svc = createConfigService(repos, kv);
    expect((await svc.getNodes()).map((n) => n.name)).not.toContain('Slow');
    expect(await svc.getDroppedNodes()).toContain(f);

    await svc.setLockedNodes([f]);
    expect((await svc.getNodes()).map((n) => n.name)).toContain('Slow');
  });

  it('未超阈值节点正常进配置', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const ok = mk('n-2', 'Ok', '10.2.0.2');
    await repos.nodes.setBySubscription('sub1', [ok]);
    await putLatest(kv, nodeFingerprint(ok), 'alive', 150, 'active');
    const svc = createConfigService(repos, kv);
    expect((await svc.getNodes()).map((n) => n.name)).toContain('Ok');
  });
});
