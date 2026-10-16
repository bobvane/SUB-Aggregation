/**
 * v2.36.9：节点锁定 —— 锁定节点无视测活/延迟/禁用，强制进配置
 * P0-2：系统剔除只认「三轮确认失效」（statusMachine=disabled）；
 *       单轮 dead 是 suspect，不再被抛弃（见 docs/18 审计 §8 P0-2）。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode } from '@/models/node';
import { createConfigService } from '@/services/config.service';

const fp = (n: ReturnType<typeof createNode>) => `${n.server}:${n.port}:${n.protocol}`;

const healthLatest = (f: string, status: string, tcp: number | null, statusMachine?: 'active' | 'suspect' | 'disabled') =>
  JSON.stringify({ fingerprint: f, status, timestamp: Date.now(), tcpLatency: tcp, tlsLatency: null, score: status === 'dead' ? 0 : 50, ...(statusMachine ? { statusMachine } : {}) });

async function makeSvc() {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  const alive = createNode({ name: 'A', server: 'a.com', port: 443, protocol: 'vless' });
  const dead = createNode({ name: 'D', server: 'd.com', port: 443, protocol: 'vless' });
  const slow = createNode({ name: 'S', server: 's.com', port: 443, protocol: 'vless' });
  await repos.nodes.setBySubscription('sub1', [alive, dead, slow]);
  return { kv, repos, svc: createConfigService(repos, kv), alive, dead, slow };
}

describe('节点锁定（强制进配置）', () => {
  it('未锁定：三轮确认失效（statusMachine=disabled）的节点被抛弃，不进 getNodes', async () => {
    const { kv, svc, dead } = await makeSvc();
    // P0-2：单轮 dead 是 suspect（保留），状态机三轮独立失败后才 disabled → 抛弃
    await kv.put('health:latest:' + fp(dead), healthLatest(fp(dead), 'dead', null, 'disabled'));
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).not.toContain('D');
    expect(nodes.map(n => n.name)).toContain('A');
  });

  it('P0-2 复核：未锁定、单轮 dead（suspect）的节点保留在 getNodes', async () => {
    const { kv, svc, dead } = await makeSvc();
    await kv.put('health:latest:' + fp(dead), healthLatest(fp(dead), 'dead', null, 'suspect'));
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('D'); // 尚未确认失效 → 保留
    expect(nodes.map(n => n.name)).toContain('A');
  });

  it('锁定 dead 节点：强制进 getNodes', async () => {
    const { kv, svc, dead } = await makeSvc();
    await kv.put('health:latest:' + fp(dead), healthLatest(fp(dead), 'dead', null, 'disabled'));
    await svc.setLockedNodes([fp(dead)]);
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('D');
  });

  it('锁定 + 禁用同时命中：锁定优先，仍进 getNodes', async () => {
    const { svc, dead } = await makeSvc();
    await svc.setDisabledNodes([fp(dead)]);
    await svc.setLockedNodes([fp(dead)]);
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('D');
  });

  it('锁定 + 移除 tombstone：锁定优先，仍进 getNodes', async () => {
    const { repos, svc, dead } = await makeSvc();
    const tomb = { ...dead, status: 'removed' as const, removed_at: Date.now() };
    await repos.nodes.setBySubscription('sub1', [tomb]);
    await svc.setLockedNodes([fp(dead)]);
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('D');
  });

  it('锁定语义：慢节点（超阈值）默认被抛弃；锁定后仍强制进 getNodes', async () => {
    const { kv, repos, svc, slow } = await makeSvc();
    await repos.settings.set('node_drop_latency_ms', '100');
    // latest 2500 > 阈值 100 → 规则②（慢节点阈值）抛弃；健康状态仍为 alive/active
    const ts = [1_700_000_000_000, 1_700_000_300_000, 1_700_000_600_000];
    for (let i = 0; i < 3; i++) {
      await kv.put('health:hist:' + fp(slow) + ':' + ts[i], healthLatest(fp(slow), 'alive', 2500));
    }
    await kv.put('health:latest:' + fp(slow), healthLatest(fp(slow), 'alive', 2500));
    // 规则②：超阈值 → 未锁定不进配置
    expect((await svc.getNodes()).map(n => n.name)).not.toContain('S');
    expect(await svc.getDroppedNodes()).toContain(fp(slow));
    // 健康状态未被慢节点规则改写
    const snap = JSON.parse((await kv.get('health:latest:' + fp(slow))) ?? '{}') as { status?: string };
    expect(snap.status).toBe('alive');
    // 锁定后：强制进配置（锁定语义不变，v2.36.9 既有）
    await svc.setLockedNodes([fp(slow)]);
    expect((await svc.getNodes()).map(n => n.name)).toContain('S');
  });
});
