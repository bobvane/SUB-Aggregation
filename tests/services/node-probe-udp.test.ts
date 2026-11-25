/**
 * v2.50.0：UDP 协议节点（Hysteria2 / TUIC / WireGuard）统一由 mihomo 核心真实测速。
 * 不再有“基础 TCP/TLS 探测不适用”的例外；核心结果正常写健康历史、参与评分与筛选。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, isProbeApplicable, type HealthStorage } from '@/services/node-probe.service';
import { setCoreProbeRunnerForTest } from '@/services/core-probe.service';
import { createNode, nodeFingerprint, type Node } from '@/models/node';

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
    server: '127.0.0.1',
    port: 1,
    tls: protocol === 'hysteria2' || protocol === 'tuic',
    metadata: { source: 'test', originalName: `Node-${protocol}`, tags: [] },
  });

describe('v2.50.0 全协议统一核心测速', () => {
  beforeEach(() => {
    // 假核心：所有节点 alive，延迟 200ms
    setCoreProbeRunnerForTest(async (nodes) => ({
      outcomes: nodes.map((n) => ({
        nodeId: n.id,
        fingerprint: nodeFingerprint(n),
        latency: 200,
        status: 'alive' as const,
        error: null,
        timestamp: Date.now(),
      })),
      coreOk: true,
      error: null,
    }));
  });
  afterEach(() => setCoreProbeRunnerForTest(null));

  it('isProbeApplicable：所有协议都适用核心测速', () => {
    for (const proto of ['hysteria2', 'tuic', 'wireguard', 'vless', 'vmess', 'trojan', 'ss', 'ssr', 'anytls'] as const) {
      expect(isProbeApplicable(proto)).toBe(true);
    }
  });

  it('UDP 节点经核心测速后 alive，并写入健康快照', async () => {
    const storage = memStorage();
    const nodes = [makeNode('hysteria2'), makeNode('tuic'), makeNode('wireguard')];
    const { results } = await probeAllNodes(nodes, storage, 24, { full: true });
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe('alive');
      expect(r.tcpLatency).toBe(200);
      expect(r.tlsLatency).toBeNull();
    }
    expect(storage.keys().filter((k) => k.startsWith('health:latest:')).length).toBe(3);
  });

  it('UDP 节点进入 getNodes，且锁定语义保留', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const nodes = [makeNode('hysteria2'), makeNode('tuic'), makeNode('wireguard')];
    await repos.nodes.setBySubscription('sub1', nodes);

    const { results } = await probeAllNodes(nodes, kv, 24, { full: true });
    for (const r of results) expect(r.status).toBe('alive');

    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).toHaveLength(0);
    const inConfig = await svc.getNodes();
    for (const proto of ['hysteria2', 'tuic', 'wireguard'] as const) {
      expect(inConfig.some((n) => n.protocol === proto)).toBe(true);
    }

    await svc.setLockedNodes([nodeFingerprint(nodes[0])]);
    expect((await svc.getNodes()).some((n) => n.protocol === 'hysteria2')).toBe(true);
  });
});
