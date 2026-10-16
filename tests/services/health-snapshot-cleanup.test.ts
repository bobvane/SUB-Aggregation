/**
 * health:latest 孤儿快照清理。
 *
 * 背景：health:hist 有 30 天 TTL，但 health:latest:{fp} 从无清理机制。
 * 节点退出有效节点池后其 latest 快照永久残留，导致：
 *   ① getDroppedNodes() 返回无对应节点的幽灵指纹；
 *   ② 同一指纹重新加入时沿用旧 statusMachine/score。
 *
 * 有效节点池口径（与 getNodes() 的**配置输出口径不同**）：
 *   · getAll(true) 含停用订阅 —— 停用 ≠ 删除，数据仍在库、可重新启用，故**不清理**；
 *   · 排除 removed_at 墓碑 —— 已不参与任何配置输出，故**清理**。
 *
 * 覆盖 9 个场景：移除/有效保留/停用订阅/墓碑/不动历史/重加不继承/
 * 节点池读取失败/幂等/dropped 判定不变。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories, type KVStorage } from '@/storage/kv';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { createConfigService } from '@/services/config.service';

const mkNode = (id: string, name: string, extra: Partial<Node> = {}): Node =>
  createNode({
    id,
    name,
    protocol: 'vless',
    server: `10.20.0.${id.slice(-1)}`,
    port: 443,
    uuid: `uuid-${id}`,
    metadata: { source: 'test', originalName: name, tags: [] },
    ...extra,
  } as Partial<Node> & { name: string });

const putLatest = (kv: MemoryKvAdapter, fp: string, over: Record<string, unknown> = {}) =>
  kv.put(`health:latest:${fp}`, JSON.stringify({
    fingerprint: fp, status: 'dead', timestamp: Date.now(),
    tcpLatency: null, tlsLatency: null, httpLatency: null,
    tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
    ...over,
  }));

const putHist = (kv: MemoryKvAdapter, fp: string, ts: number) =>
  kv.put(`health:hist:${fp}:${ts}`, JSON.stringify({
    fingerprint: fp, timestamp: ts, status: 'dead',
    tcpLatency: null, tlsLatency: null, httpLatency: null,
    tlsApplicable: false, error: null, score: 0,
  }));

async function setup(nodes: Node[]) {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  await repos.nodes.setBySubscription('sub1', nodes);
  const svc = createConfigService(repos, kv);
  return { kv, repos, svc };
}

describe('孤儿健康快照清理：已移除节点', () => {
  it('① 已退出有效节点池的 latest 快照被清理', async () => {
    const { kv, svc } = await setup([mkNode('n1', 'A')]);
    const gone = nodeFingerprint(mkNode('n9', 'Gone'));
    await putLatest(kv, gone);

    const r = await svc.cleanupOrphanedHealthSnapshots();

    expect(r.skipped).toBe(false);
    expect(r.removed).toBe(1);
    expect(await kv.get(`health:latest:${gone}`)).toBeNull();
  });

  it('② 有效节点的 latest 快照不被误删', async () => {
    const keep = mkNode('n1', 'A');
    const { kv, svc } = await setup([keep]);
    const fp = nodeFingerprint(keep);
    await putLatest(kv, fp, { status: 'alive', statusMachine: 'active', score: 88 });

    const r = await svc.cleanupOrphanedHealthSnapshots();

    expect(r.removed).toBe(0);
    expect(await kv.get(`health:latest:${fp}`)).not.toBeNull();
  });

  it('③ 停用订阅中的节点快照不被清理（停用 ≠ 删除）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    // 必须用 create() 真实创建订阅：它的 id 是随机生成的，
    // 节点要存到该 id 之下，否则 getAll() 的停用过滤匹配不到。
    const sub = await repos.subscriptions.create({ name: 'sub1', url: 'https://example.com/s' });
    const subNode = mkNode('n1', 'A');
    await repos.nodes.setBySubscription(sub.id, [subNode]);
    // 停用该订阅
    await repos.subscriptions.update(sub.id, { enabled: false });

    const svc = createConfigService(repos, kv);
    const fp = nodeFingerprint(subNode);
    await putLatest(kv, fp, { status: 'alive', statusMachine: 'active', score: 91 });

    // 前置确认：getNodes() 确实排除了停用订阅（否则本用例无意义）
    expect((await svc.getNodes()).map(nodeFingerprint)).not.toContain(fp);
    // 但快照必须保留
    const r = await svc.cleanupOrphanedHealthSnapshots();
    expect(r.removed).toBe(0);
    expect(await kv.get(`health:latest:${fp}`)).not.toBeNull();
  });

  it('④ removed_at 墓碑节点的 latest 快照被清理', async () => {
    const aliveNode = mkNode('n1', 'A');
    const tomb = mkNode('n2', 'B', { removed_at: Date.now(), status: 'removed' });
    const { kv, svc } = await setup([aliveNode, tomb]);
    const tombFp = nodeFingerprint(tomb);
    const aliveFp = nodeFingerprint(aliveNode);
    await putLatest(kv, tombFp);
    await putLatest(kv, aliveFp, { status: 'alive', statusMachine: 'active' });

    const r = await svc.cleanupOrphanedHealthSnapshots();

    expect(r.removed).toBe(1);
    expect(await kv.get(`health:latest:${tombFp}`)).toBeNull();
    expect(await kv.get(`health:latest:${aliveFp}`)).not.toBeNull();
  });

  it('⑤ 清理不提前删除历史记录（health:hist 仍遵守 30 天 TTL）', async () => {
    const { kv, svc } = await setup([mkNode('n1', 'A')]);
    const gone = nodeFingerprint(mkNode('n9', 'Gone'));
    const old = Date.now() - 1000;
    await putLatest(kv, gone);
    await putHist(kv, gone, old);

    await svc.cleanupOrphanedHealthSnapshots();

    // latest 被清理
    expect(await kv.get(`health:latest:${gone}`)).toBeNull();
    // history 保留（清理由既有 cleanupOldHistory 按 TTL 处理，与本方法无关）
    expect(await kv.get(`health:hist:${gone}:${old}`)).not.toBeNull();
  });

  it('⑥ 同指纹重新加入时不继承已清理的旧快照', async () => {
    const gone = mkNode('n9', 'Gone');
    const goneFp = nodeFingerprint(gone);
    const { kv, svc } = await setup([mkNode('n1', 'A')]);
    await putLatest(kv, goneFp); // 旧快照 statusMachine=disabled

    // 清理前：幽灵指纹会进入 dropped
    expect(await svc.getDroppedNodes()).toContain(goneFp);
    await svc.cleanupOrphanedHealthSnapshots();

    // 清理后：不再是幽灵
    expect(await svc.getDroppedNodes()).not.toContain(goneFp);

    // 同指纹重新加入 → 无历史快照可继承，首轮探测从零开始
    const kv2 = new MemoryKvAdapter();
    const repos2 = createRepositories(kv2);
    await repos2.nodes.setBySubscription('sub1', [gone]);
    const svc2 = createConfigService(repos2, kv2);
    expect(await svc2.getDroppedNodes()).toEqual([]);
  });

  it('⑦ 节点池读取失败时不误删任何快照', async () => {
    const { kv, svc } = await setup([mkNode('n1', 'A')]);
    const fp = nodeFingerprint(mkNode('n1', 'A'));
    await putLatest(kv, fp, { status: 'alive', statusMachine: 'active' });
    await putLatest(kv, nodeFingerprint(mkNode('n9', 'Gone')));

    // 注入一个读取必然抛错的 repos.nodes.getAll
    const brokenKv = kv as unknown as KVStorage;
    const brokenRepos = {
      ...createRepositories(kv),
      nodes: {
        ...createRepositories(kv).nodes,
        getAll: async () => { throw new Error('storage unavailable'); },
      },
    };
    const brokenSvc = createConfigService(brokenRepos as never, brokenKv);

    const r = await brokenSvc.cleanupOrphanedHealthSnapshots();

    // 跳过本轮，任何快照都未被删除
    expect(r.skipped).toBe(true);
    expect(r.removed).toBe(0);
    expect(await kv.get(`health:latest:${fp}`)).not.toBeNull();
    expect(await kv.get(`health:latest:${nodeFingerprint(mkNode('n9', 'Gone'))}`)).not.toBeNull();
    void svc;
  });

  it('⑧ 重复执行清理幂等（第二次无新增删除）', async () => {
    const { kv, svc } = await setup([mkNode('n1', 'A')]);
    const gone = nodeFingerprint(mkNode('n9', 'Gone'));
    await putLatest(kv, gone);
    const keep = nodeFingerprint(mkNode('n1', 'A'));
    await putLatest(kv, keep, { status: 'alive', statusMachine: 'active' });

    const first = await svc.cleanupOrphanedHealthSnapshots();
    const second = await svc.cleanupOrphanedHealthSnapshots();
    const third = await svc.cleanupOrphanedHealthSnapshots();

    expect(first.removed).toBe(1);
    expect(second.removed).toBe(0);
    expect(third.removed).toBe(0);
    expect(await kv.get(`health:latest:${keep}`)).not.toBeNull();
  });

  it('⑨ 清理不改变有效节点的 dropped 判定', async () => {
    const good = mkNode('n1', 'A');
    const bad = mkNode('n2', 'B');
    const gone = mkNode('n9', 'Gone');
    const { kv, svc } = await setup([good, bad]);

    const badFp = nodeFingerprint(bad);
    const goodFp = nodeFingerprint(good);
    await putLatest(kv, badFp, { status: 'dead', statusMachine: 'disabled', score: 0 });
    await putLatest(kv, goodFp, { status: 'alive', statusMachine: 'active', score: 95 });
    await putLatest(kv, nodeFingerprint(gone), { status: 'dead', statusMachine: 'disabled' });

    const droppedBefore = (await svc.getDroppedNodes()).sort();
    const nodesBefore = (await svc.getNodes()).map(nodeFingerprint).sort();

    await svc.cleanupOrphanedHealthSnapshots();

    const droppedAfter = (await svc.getDroppedNodes()).sort();
    const nodesAfter = (await svc.getNodes()).map(nodeFingerprint).sort();

    // 有效节点的 dropped 与配置输出完全不变
    expect(droppedBefore.filter((f) => f === badFp || f === goodFp))
      .toEqual(droppedAfter.filter((f) => f === badFp || f === goodFp));
    expect(nodesBefore).toEqual(nodesAfter);
    // 唯一变化：幽灵指纹消失
    expect(droppedBefore).toContain(nodeFingerprint(gone));
    expect(droppedAfter).not.toContain(nodeFingerprint(gone));
  });
});

describe('孤儿健康快照清理：UDP / 状态机语义不变', () => {
  it('UDP 节点无健康数据 → 清理不影响其保留在配置中', async () => {
    const udp = mkNode('n1', 'Tuic', { protocol: 'tuic', uuid: 'u', password: 'p' } as Partial<Node>);
    const { svc } = await setup([udp]);
    // UDP 走 unknown 分支，不写 health:latest —— 无快照可清理，也不得影响保留
    const r = await svc.cleanupOrphanedHealthSnapshots();
    expect(r.removed).toBe(0);
    expect((await svc.getNodes()).map(nodeFingerprint)).toContain(nodeFingerprint(udp));
  });
});
