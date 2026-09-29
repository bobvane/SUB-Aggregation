/**
 * v2.36.9：节点锁定 —— 锁定节点无视测活/延迟/禁用，强制进配置
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode } from '@/models/node';
import { createConfigService } from '@/services/config.service';

const fp = (n: ReturnType<typeof createNode>) => `${n.server}:${n.port}:${n.protocol}`;

const healthLatest = (f: string, status: string, tcp: number | null) =>
  JSON.stringify({ fingerprint: f, status, timestamp: Date.now(), tcpLatency: tcp, tlsLatency: null, score: status === 'dead' ? 0 : 50 });

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
  it('未锁定：dead 节点被抛弃，不进 getNodes', async () => {
    const { kv, repos, svc, dead } = await makeSvc();
    await kv.put('health:latest:' + fp(dead), healthLatest(fp(dead), 'dead', null));
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).not.toContain('D');
    expect(nodes.map(n => n.name)).toContain('A');
  });

  it('锁定 dead 节点：强制进 getNodes', async () => {
    const { kv, repos, svc, dead } = await makeSvc();
    await kv.put('health:latest:' + fp(dead), healthLatest(fp(dead), 'dead', null));
    await svc.setLockedNodes([fp(dead)]);
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('D');
  });

  it('锁定 + 禁用同时命中：锁定优先，仍进 getNodes', async () => {
    const { repos, svc, dead } = await makeSvc();
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

  it('锁定 + 慢节点超阈值：锁定优先，仍进 getNodes', async () => {
    const { kv, repos, svc, slow } = await makeSvc();
    await repos.settings.set('node_drop_latency_ms', '100');
    // 最近 3 条历史全超阈值 → 触发抛弃
    const ts = [1_700_000_000_000, 1_700_000_300_000, 1_700_000_600_000];
    for (let i = 0; i < 3; i++) {
      await kv.put('health:hist:' + fp(slow) + ':' + ts[i], healthLatest(fp(slow), 'alive', 2500));
    }
    await kv.put('health:latest:' + fp(slow), healthLatest(fp(slow), 'alive', 2500));
    // 先不锁 → 应被抛弃
    expect((await svc.getNodes()).map(n => n.name)).not.toContain('S');
    // 锁 → 强制进配置
    await svc.setLockedNodes([fp(slow)]);
    expect((await svc.getNodes()).map(n => n.name)).toContain('S');
  });
});
