/**
 * P0-1 + P1（阶段 1）：UDP 协议节点的探测与筛选语义
 * - Hysteria2 / TUIC / WireGuard 基于 UDP（QUIC/UDP），对 UDP-only 端口做 TCP connect 必然失败，
 *   不能据此判 dead；probeNode 早退 status='unknown'、不写健康历史/最新值。
 * - P1 修复②：UDP 协议不再从 getNodes 剔除 —— 基础探测不适用 ≠ 节点不可用；
 *   节点可用性由协议字段映射、客户端健康检查与用户锁定/禁用语义共同决定。
 *   锁定语义（v2.36.9 既有）保持不变。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, isProbeApplicable, type HealthStorage } from '@/services/node-probe.service';
import { createNode, type Node } from '@/models/node';

/** 内存 HealthStorage 适配器，并暴露 keys() 供断言 */
const memStorage = () => {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async (prefix: string) => [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
    keys: () => [...m.keys()],
  } as HealthStorage & { keys: () => string[] };
};

const makeNode = (protocol: Node['protocol']): Node =>
  createNode({
    id: `n-${protocol}`,
    name: `Node-${protocol}`,
    protocol,
    server: '127.0.0.1', // 本地 1 端口不可达，模拟 TCP 失败
    port: 1,
    tls: protocol === 'hysteria2' || protocol === 'tuic',
    metadata: { source: 'test', originalName: `Node-${protocol}`, tags: [] },
  });

describe('P0-1 UDP 协议基础探测策略', () => {
  it('isProbeApplicable：UDP 协议不适用基础探测', () => {
    expect(isProbeApplicable('hysteria2')).toBe(false);
    expect(isProbeApplicable('tuic')).toBe(false);
    expect(isProbeApplicable('wireguard')).toBe(false);
    // TCP 承载协议仍适用
    expect(isProbeApplicable('vless')).toBe(true);
    expect(isProbeApplicable('vmess')).toBe(true);
    expect(isProbeApplicable('trojan')).toBe(true);
    expect(isProbeApplicable('ss')).toBe(true);
    expect(isProbeApplicable('ssr')).toBe(true);
    expect(isProbeApplicable('anytls')).toBe(true);
  });

  it('probeAllNodes：UDP 节点状态为 unknown（不适用）、不做 TCP/TLS 探测、不写健康历史', async () => {
    const storage = memStorage();
    const { results } = await probeAllNodes(
      [makeNode('hysteria2'), makeNode('tuic'), makeNode('wireguard')],
      storage,
    );
    for (const r of results) {
      expect(r.status).toBe('unknown');      // 不是 dead / timeout / error
      expect(r.tcpLatency).toBeNull();       // 未做 TCP 探测
      expect(r.tlsLatency).toBeNull();       // 未做 TLS 探测
    }
    // 不写 health:hist / health:latest（unknown 不得污染状态机与剔除判定）
    expect(storage.keys().filter((k) => k.startsWith('health:')).length).toBe(0);
  });

  it('P1 修复②：UDP 节点经 probeAllNodes（TCP 不可达）后：unknown 不累计、不进 getDroppedNodes；' +
     '非锁定 UDP 节点仍进入 getNodes（不再按协议剔除），锁定后强制进', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const nodes = [makeNode('hysteria2'), makeNode('tuic'), makeNode('wireguard')];
    await repos.nodes.setBySubscription('sub1', nodes);

    // 模拟探测轮次：UDP 节点基础探测不适用（unknown），不写健康历史
    const storage = memStorage();
    const { results } = await probeAllNodes(nodes, storage);
    for (const r of results) expect(r.status).toBe('unknown');

    // unknown 不累计失败、不产生健康数据 → getDroppedNodes 无 UDP 指纹
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).toHaveLength(0);

    // P1 修复②（m02100 授权）：UDP 协议不再从配置剔除；基础探测不适用不代表节点不可用，
    // 非锁定 UDP 节点仍进入自动配置（可用性由协议字段映射与客户端健康检查共同决定）。
    const inConfig = await svc.getNodes();
    for (const proto of ['hysteria2', 'tuic', 'wireguard'] as const) {
      expect(inConfig.some((n) => n.protocol === proto)).toBe(true);
    }

    // 锁定后：UDP 节点强制进配置（锁定语义优先，v2.36.9 既有语义保留）
    await svc.setLockedNodes([`${nodes[0].server}:${nodes[0].port}:${nodes[0].protocol}`]);
    const inConfigLocked = await svc.getNodes();
    expect(inConfigLocked.some((n) => n.protocol === 'hysteria2')).toBe(true);
  });
});
