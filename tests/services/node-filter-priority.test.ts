/**
 * P2（阶段 C2）：锁定 / 手动禁用 / 自动剔除 / removed_at 的优先级矩阵。
 *
 * 产品语义（多处一致）：
 *  - docs/02_DATA_MODEL.md:37  「setting:locked_nodes：锁定后无视测活/延迟/禁用/移除判定，强制进配置」
 *  - docs/18:78                「锁定节点豁免一切过滤：即使用户禁用、系统剔除（dropped）、
 *                              状态机 disabled、UDP unknown、removed，锁定节点仍强制进入配置」
 *  - config.service.ts getNodes() 过滤链：
 *      locked.has(fp) → true（最高优先级，豁免后续全部）
 *      disabled.has(fp) → false
 *      dropped.has(fp) → false
 *      n.removed_at → false
 *      其余 → true
 *
 * 本测试用完整优先级矩阵固定该语义，并补齐既有测试未覆盖的三种组合：
 *   锁定+手动禁用、锁定+自动剔除、取消锁定后回归自动筛选。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { createConfigService } from '@/services/config.service';
import { isProbeApplicable } from '@/services/node-probe.service';

const mk = (id: string, name: string, extra: Partial<Node> = {}): Node =>
  createNode({
    id,
    name,
    protocol: 'vless',
    server: `10.7.0.${id.slice(-1)}`,
    port: 443,
    metadata: { source: 'test', originalName: name, tags: [] },
    ...extra,
  } as Partial<Node> & { name: string });

/** 写入一条 statusMachine=disabled 的 latest 快照（系统确认失效） */
async function markSystemDropped(kv: MemoryKvAdapter, node: Node) {
  await kv.put(
    `health:latest:${nodeFingerprint(node)}`,
    JSON.stringify({
      nodeId: node.id,
      fingerprint: nodeFingerprint(node),
      timestamp: Date.now(),
      tcpLatency: null,
      tlsLatency: null,
      httpLatency: null,
      status: 'dead',
      tlsApplicable: false,
      error: null,
      score: 0,
      statusMachine: 'disabled',
    })
  );
}

describe('P2 优先级矩阵：getNodes() 完整组合', () => {
  it('普通节点 → 进配置', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const plain = mk('n-plain', 'Plain');
    await repos.nodes.setBySubscription('sub1', [plain]);
    const svc = createConfigService(repos, kv);
    expect((await svc.getNodes()).map((n) => n.name)).toContain('Plain');
  });

  it('手动禁用节点 → 被过滤', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-dis', 'UserDisabled');
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);
    await svc.setDisabledNodes([nodeFingerprint(n)]);
    expect((await svc.getNodes()).map((x) => x.name)).not.toContain('UserDisabled');
  });

  it('自动剔除节点（statusMachine=disabled）→ 被过滤', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-drop', 'SystemDropped');
    await repos.nodes.setBySubscription('sub1', [n]);
    await markSystemDropped(kv, n);
    const svc = createConfigService(repos, kv);
    expect((await svc.getNodes()).map((x) => x.name)).not.toContain('SystemDropped');
  });

  it('removed_at 节点（订阅更新消失的 tombstone）→ 被过滤', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-rem', 'Removed', { status: 'removed', removed_at: Date.now() });
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);
    expect((await svc.getNodes()).map((x) => x.name)).not.toContain('Removed');
  });

  it('人工锁定节点 → 强制进配置', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-lock', 'Locked');
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);
    await svc.setLockedNodes([nodeFingerprint(n)]);
    expect((await svc.getNodes()).map((x) => x.name)).toContain('Locked');
  });

  it('人工锁定 + 手动禁用 → 锁定优先，仍进配置（产品语义：锁定无视禁用）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-ld', 'LockedAndDisabled');
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);
    await svc.setLockedNodes([nodeFingerprint(n)]);
    await svc.setDisabledNodes([nodeFingerprint(n)]);
    const names = (await svc.getNodes()).map((x) => x.name);
    expect(names).toContain('LockedAndDisabled');
  });

  it('人工锁定 + 自动剔除 → 锁定优先，仍进配置（产品语义：锁定豁免系统剔除）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-ldrop', 'LockedAndDropped');
    await repos.nodes.setBySubscription('sub1', [n]);
    await markSystemDropped(kv, n);
    const svc = createConfigService(repos, kv);
    await svc.setLockedNodes([nodeFingerprint(n)]);
    const names = (await svc.getNodes()).map((x) => x.name);
    expect(names).toContain('LockedAndDropped');
  });

  it('人工锁定 + removed_at → 锁定优先，仍进配置', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-lrem', 'LockedAndRemoved', { status: 'removed', removed_at: Date.now() });
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);
    await svc.setLockedNodes([nodeFingerprint(n)]);
    expect((await svc.getNodes()).map((x) => x.name)).toContain('LockedAndRemoved');
  });

  it('取消锁定后 → 恢复正常自动筛选（禁用/剔除重新生效）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-unlock', 'Unlocked');
    await repos.nodes.setBySubscription('sub1', [n]);
    await markSystemDropped(kv, n);
    const svc = createConfigService(repos, kv);

    // 锁定期间：即使系统剔除也保留
    await svc.setLockedNodes([nodeFingerprint(n)]);
    expect((await svc.getNodes()).map((x) => x.name)).toContain('Unlocked');

    // 取消锁定：剔除规则重新生效
    await svc.setLockedNodes([]);
    expect((await svc.getNodes()).map((x) => x.name)).not.toContain('Unlocked');
  });

  it('取消锁定后 → 手动禁用重新生效', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-unlock2', 'Unlocked2');
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);
    await svc.setLockedNodes([nodeFingerprint(n)]);
    await svc.setDisabledNodes([nodeFingerprint(n)]);
    expect((await svc.getNodes()).map((x) => x.name)).toContain('Unlocked2');

    await svc.setLockedNodes([]);
    expect((await svc.getNodes()).map((x) => x.name)).not.toContain('Unlocked2');
  });
});

describe('P2 锁定与健康展示分离', () => {
  it('锁定节点仍如实展示健康状态（不因锁定伪造为健康）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-lockh', 'LockedUnhealthy');
    await repos.nodes.setBySubscription('sub1', [n]);
    await markSystemDropped(kv, n);
    const svc = createConfigService(repos, kv);
    await svc.setLockedNodes([nodeFingerprint(n)]);

    // 锁定 → 进配置
    expect((await svc.getNodes()).map((x) => x.name)).toContain('LockedUnhealthy');
    // 但健康快照仍是 dead + disabled（如实展示，未伪造）
    const { getNodeHealthLatest } = await import('@/services/node-probe.service');
    const h = await getNodeHealthLatest(nodeFingerprint(n), kv);
    expect(h?.status).toBe('dead');
    expect(h?.statusMachine).toBe('disabled');
    expect(h?.score).toBe(0);
  });
});

describe('P2 UDP 节点不被误杀', () => {
  it('hysteria2 / tuic / wireguard 非锁定也进配置（基础探测不适用 ≠ 不可用）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const h2 = mk('n-h2', 'H2', { protocol: 'hysteria2' });
    const tuic = mk('n-tuic', 'Tuic', { protocol: 'tuic' });
    const wg = mk('n-wg', 'Wg', { protocol: 'wireguard' });
    await repos.nodes.setBySubscription('sub1', [h2, tuic, wg]);
    const svc = createConfigService(repos, kv);
    const names = (await svc.getNodes()).map((x) => x.name);
    expect(names).toContain('H2');
    expect(names).toContain('Tuic');
    expect(names).toContain('Wg');
    // 且这些协议确实不适用 TCP/TLS 基础探测（语义前提）
    expect(isProbeApplicable('hysteria2')).toBe(false);
    expect(isProbeApplicable('tuic')).toBe(false);
    expect(isProbeApplicable('wireguard')).toBe(false);
  });

  it('UDP 节点无健康数据时不得被 getDroppedNodes 剔除', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const tuic = mk('n-tuic2', 'TuicNoHealth', { protocol: 'tuic' });
    await repos.nodes.setBySubscription('sub1', [tuic]);
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).not.toContain(nodeFingerprint(tuic));
  });
});
