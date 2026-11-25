/**
 * v2.50.0：probeAllNodes 并发门闩（同周期不产生重复轮次）。
 * 用假核心 runner 返回 dead；每轮传 { full: true } 以避免增量测速跳过。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, nodeFingerprint } from '@/services/node-probe.service';
import { setCoreProbeRunnerForTest } from '@/services/core-probe.service';
import { createNode, type Node } from '@/models/node';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const deadNode = (): Node =>
  createNode({
    id: 'n-dead',
    name: 'DeadNode',
    protocol: 'vless',
    server: '127.0.0.1',
    port: 1,
    tls: false,
    metadata: { source: 'test', originalName: 'DeadNode', tags: [] },
  });

let clockNow = 0;

beforeEach(() => {
  clockNow = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    const v = clockNow;
    clockNow += 1;
    return v;
  });
  setCoreProbeRunnerForTest(async (nodes) => ({
    outcomes: nodes.map((n) => ({
      nodeId: n.id,
      fingerprint: nodeFingerprint(n),
      latency: null,
      status: 'dead' as const,
      error: 'fake dead',
      timestamp: Date.now(),
    })),
    coreOk: true,
    error: null,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setCoreProbeRunnerForTest(null);
});

const probe = (nodes: Node[], kv: MemoryKvAdapter) =>
  probeAllNodes(nodes, kv, 24, { full: true });

describe('probeAllNodes 并发门闩（同周期不产生重复轮次）', () => {
  it('同一周期并发调用：第二轮在第一轮完成后才启动，历史恰好两轮', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    await probe([node], kv);
    await sleep(5);

    const [r1, r2] = await Promise.all([probe([node], kv), probe([node], kv)]);

    expect(r1.results[0].status).toBe('dead');
    expect(r2.results[0].status).toBe('dead');
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(3);
    expect(r2.results[0].timestamp).toBeGreaterThan(r1.results[0].timestamp);

    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('in-flight 期间第二次调用被排队为下一轮，历史恰好 2 条', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    const p1 = probe([node], kv);
    const p2 = probe([node], kv);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.results[0].timestamp).not.toBe(r2.results[0].timestamp);
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(2);
  });
});
