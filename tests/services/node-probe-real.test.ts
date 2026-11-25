/**
 * v2.50.0：mihomo 核心测速接入健康引擎的闭环测试。
 *
 * 单元测试环境没有真实 mihomo 进程，这里通过 setCoreProbeRunnerForTest 注入假结果，
 * 验证 probeAllNodes → 健康快照 → 评分/状态机 的完整链路。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { probeAllNodes, resetProbeDataIfEngineChanged, type HealthStorage } from '@/services/node-probe.service';
import { setCoreProbeRunnerForTest } from '@/services/core-probe.service';
import { nodeFingerprint, type Node } from '@/models/node';

function memStorage(): HealthStorage {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
  };
}

const makeNode = (id: string, protocol: Node['protocol'] = 'vless'): Node => ({
  id,
  name: id,
  protocol,
  server: '127.0.0.1',
  port: 443,
  version: 0,
  metadata: { source: 'test', originalName: id, tags: [] },
});

describe('核心测速 → 健康引擎闭环', () => {
  beforeEach(() => {
    setCoreProbeRunnerForTest(async (nodes) => ({
      outcomes: nodes.map((n) => ({
        nodeId: n.id,
        fingerprint: nodeFingerprint(n),
        latency: n.id === 'down' ? null : 250,
        status: n.id === 'down' ? ('dead' as const) : ('alive' as const),
        error: n.id === 'down' ? 'all urls failed' : null,
        timestamp: Date.now(),
      })),
      coreOk: true,
      error: null,
    }));
  });
  afterEach(() => setCoreProbeRunnerForTest(null));

  it('alive / dead 结果映射与统计', async () => {
    const { results, stats } = await probeAllNodes(
      [makeNode('up'), makeNode('down')],
      memStorage(),
      24,
      { full: true }
    );
    const up = results.find((r) => r.nodeId === 'up')!;
    const down = results.find((r) => r.nodeId === 'down')!;

    expect(up.status).toBe('alive');
    expect(up.tcpLatency).toBe(250);
    expect(up.tlsLatency).toBeNull();
    expect(up.tlsApplicable).toBe(false);
    expect(up.error).toBeNull();

    expect(down.status).toBe('dead');
    expect(down.tcpLatency).toBeNull();
    expect(down.error).toContain('all urls failed');

    expect(stats.total).toBe(2);
    expect(stats.alive).toBe(1);
    expect(stats.dead).toBe(1);
    expect(stats.avgLatency).toBe(250);
  });

  it('健康记录写盘：latest 快照含 statusMachine / score', async () => {
    const storage = memStorage();
    const { results } = await probeAllNodes([makeNode('up')], storage, 24, { full: true });
    const raw = await storage.get(`health:latest:${results[0].fingerprint}`);
    expect(raw).not.toBeNull();
    const latest = JSON.parse(raw!) as { status: string; statusMachine?: string; score: number; tcpLatency: number };
    expect(latest.status).toBe('alive');
    expect(latest.statusMachine).toBe('active');
    expect(latest.score).toBeGreaterThan(0);
    expect(latest.tcpLatency).toBe(250);
  });

  it('引擎 5 / 评分 5 / 结构 1；升级不删除历史，TTL 仍正常清理', async () => {
    const storage = memStorage();
    const node = makeNode('up');
    const fp = nodeFingerprint(node);

    const now0 = Date.now();
    const DAY = 86_400_000;
    const inTtlButOutOfWindow = [now0 - 3.5 * DAY, now0 - 3 * DAY, now0 - 2.5 * DAY];
    for (const t of inTtlButOutOfWindow) {
      await storage.put(`health:hist:${fp}:${t}`, JSON.stringify({
        fingerprint: fp, status: 'dead', tcpLatency: null, tlsLatency: null, timestamp: t, score: 0,
      }));
    }
    const beyondTtl = [now0 - 40 * DAY, now0 - 41 * DAY];
    for (const t of beyondTtl) {
      await storage.put(`health:hist:${fp}:${t}`, JSON.stringify({
        fingerprint: fp, status: 'dead', tcpLatency: null, tlsLatency: null, timestamp: t, score: 0,
      }));
    }
    await storage.put(`health:latest:${fp}`, JSON.stringify({
      fingerprint: fp, status: 'dead', statusMachine: 'disabled', score: 0,
      tcpLatency: null, tlsLatency: null, timestamp: now0 - DAY,
    }));

    const { results } = await probeAllNodes([node], storage, 24, { full: true });

    expect(results[0].status).toBe('alive');
    // 窗口外记录不参与评分：N=0 → 非 TLS 可用率/延迟/稳定性各 0.5 → 50
    expect(results[0].score).toBe(50);

    for (const t of inTtlButOutOfWindow) {
      expect(await storage.get(`health:hist:${fp}:${t}`)).not.toBeNull();
    }
    for (const t of beyondTtl) {
      expect(await storage.get(`health:hist:${fp}:${t}`)).toBeNull();
    }

    expect(await storage.get('probe:engine_version')).toBe('5');
    expect(await storage.get('probe:score_version')).toBe('5');
    expect(await storage.get('probe:schema_version')).toBe('1');

    const latest = JSON.parse((await storage.get(`health:latest:${fp}`))!) as { status: string; statusMachine: string };
    expect(latest.status).toBe('alive');
    // 状态机读取全部保留历史：本轮 alive，其前一条为 dead → suspect
    expect(latest.statusMachine).toBe('suspect');
  });

  it('版本键同步幂等：首次 true，重复 false', async () => {
    const storage = memStorage();
    expect(await resetProbeDataIfEngineChanged(storage)).toBe(true);
    expect(await resetProbeDataIfEngineChanged(storage)).toBe(false);
  });
});
