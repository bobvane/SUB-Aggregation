/**
 * v2.50.0：核心测速状态机闭环（三轮独立失败 / 成功重置 / 持久化 / 引擎升级保留历史）。
 *
 * 用假核心 runner 注入 alive/dead，验证：
 * - 连续非 alive ≥3 → disabled；≥1 → suspect；连续 alive ≥2 → active。
 * - unknown（核心不可用）不写历史、不累计失败。
 * - 状态从 KV 历史重算，重启不重复计数。
 * - 引擎升级只同步版本号，不删除历史。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, nodeFingerprint } from '@/services/node-probe.service';
import { setCoreProbeRunnerForTest } from '@/services/core-probe.service';
import { createNode, type Node } from '@/models/node';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const makeNode = (id: string, protocol: Node['protocol'] = 'vless'): Node =>
  createNode({
    id,
    name: id,
    protocol,
    server: '127.0.0.1',
    port: 443,
    metadata: { source: 'test', originalName: id, tags: [] },
  });

let aliveIds = new Set<string>();
let unknownIds = new Set<string>();

beforeEach(() => {
  aliveIds = new Set();
  unknownIds = new Set();
  setCoreProbeRunnerForTest(async (nodes) => ({
    outcomes: nodes.map((n) => {
      if (unknownIds.has(n.id)) {
        return { nodeId: n.id, fingerprint: nodeFingerprint(n), latency: null, status: 'unknown' as const, error: 'core unavailable', timestamp: Date.now() };
      }
      const alive = aliveIds.has(n.id);
      return {
        nodeId: n.id,
        fingerprint: nodeFingerprint(n),
        latency: alive ? 200 : null,
        status: alive ? ('alive' as const) : ('dead' as const),
        error: alive ? null : 'fake dead',
        timestamp: Date.now(),
      };
    }),
    coreOk: true,
    error: null,
  }));
});
afterEach(() => setCoreProbeRunnerForTest(null));

const probe = (nodes: Node[], kv: MemoryKvAdapter) =>
  probeAllNodes(nodes, kv, 24, { full: true });

describe('核心测速状态机确认', () => {
  it('连续三轮 dead → disabled → 进入 getDroppedNodes；历史恰好 3 条', async () => {
    const kv = new MemoryKvAdapter();
    const node = makeNode('dead');
    const fp = nodeFingerprint(node);

    for (let i = 0; i < 3; i++) {
      const { results } = await probe([node], kv);
      expect(results[0].status).toBe('dead');
      await sleep(3);
    }

    const latest = JSON.parse((await kv.get(`health:latest:${fp}`))!);
    expect(latest.statusMachine).toBe('disabled');
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(3);

    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('dead, dead, alive, dead, dead → 连续失败被 alive 打断，仍 suspect，不剔除', async () => {
    const kv = new MemoryKvAdapter();
    const node = makeNode('n1');
    const fp = nodeFingerprint(node);

    await probe([node], kv); await sleep(3);
    await probe([node], kv); await sleep(3);
    aliveIds.add('n1');
    await probe([node], kv); await sleep(3);
    aliveIds.delete('n1');
    await probe([node], kv); await sleep(3);
    await probe([node], kv);

    const latest = JSON.parse((await kv.get(`health:latest:${fp}`))!);
    expect(latest.statusMachine).toBe('suspect');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain(fp);
  });

  it('dead, dead, alive, dead, dead, dead → 重新累计到 3 轮 → disabled', async () => {
    const kv = new MemoryKvAdapter();
    const node = makeNode('n2');
    const fp = nodeFingerprint(node);

    await probe([node], kv); await sleep(3);
    await probe([node], kv); await sleep(3);
    aliveIds.add('n2');
    await probe([node], kv); await sleep(3);
    aliveIds.delete('n2');
    for (let i = 0; i < 3; i++) {
      await probe([node], kv);
      await sleep(3);
    }

    const latest = JSON.parse((await kv.get(`health:latest:${fp}`))!);
    expect(latest.statusMachine).toBe('disabled');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('引擎 3→5 保留历史：连续失败计数跨版本延续 → disabled', async () => {
    const kv = new MemoryKvAdapter();
    const node = makeNode('n3');
    const fp = nodeFingerprint(node);
    const now0 = Date.now();
    const old = [now0 - 3 * 86_400_000, now0 - 2 * 86_400_000, now0 - 86_400_000];
    for (const ts of old) {
      await kv.put(`health:hist:${fp}:${ts}`, JSON.stringify({
        nodeId: node.id, fingerprint: fp, timestamp: ts,
        tcpLatency: null, tlsLatency: null, httpLatency: null,
        status: 'dead', tlsApplicable: false, error: 'old', score: 0,
      }));
    }
    await kv.put('probe:engine_version', '3');
    await kv.put(`health:latest:${fp}`, JSON.stringify({
      nodeId: node.id, fingerprint: fp, timestamp: old[2],
      tcpLatency: null, tlsLatency: null, httpLatency: null,
      status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
    }));

    const { results } = await probe([node], kv);
    expect(results[0].status).toBe('dead');
    expect(await kv.get('probe:engine_version')).toBe('5');
    expect(await kv.get('probe:score_version')).toBe('5');
    expect(await kv.get('probe:schema_version')).toBe('1');
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(4);

    const latest = JSON.parse((await kv.get(`health:latest:${fp}`))!);
    expect(latest.statusMachine).toBe('disabled');
  });

  it('核心不可用（unknown）不累计失败、不写历史、不进入 dropped', async () => {
    const kv = new MemoryKvAdapter();
    const udp = makeNode('h2', 'hysteria2');
    const fp = nodeFingerprint(udp);
    unknownIds.add('h2');

    for (let i = 0; i < 3; i++) {
      const { results } = await probe([udp], kv);
      expect(results[0].status).toBe('unknown');
      await sleep(3);
    }
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(0);
    expect(await kv.get(`health:latest:${fp}`)).toBeNull();

    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain(fp);
  });

  it('持久化：重启后从 KV 历史重算，不重复计数、不漏计', async () => {
    const kv = new MemoryKvAdapter();
    const node = makeNode('n4');
    const fp = nodeFingerprint(node);

    await probe([node], kv); await sleep(3);
    await probe([node], kv);
    const m1 = JSON.parse((await kv.get(`health:latest:${fp}`))!);
    expect(m1.statusMachine).toBe('suspect');

    const dump = new MemoryKvAdapter();
    for (const { key } of await kv.list('')) {
      const v = await kv.get(key);
      if (v !== null) await dump.put(key, v);
    }

    await probe([node], dump);
    const m2 = JSON.parse((await dump.get(`health:latest:${fp}`))!);
    expect(m2.statusMachine).toBe('disabled');
    expect((await dump.list(`health:hist:${fp}:`)).length).toBe(3);
  });

  it('系统剔除只认状态机 disabled；慢节点按核心阈值剔除；suspect 死节点保留', async () => {
    const kv = new MemoryKvAdapter();
    const svc = createConfigService(createRepositories(kv), kv);

    const deadDisabled = '10.0.0.1:443:vless';
    await kv.put(`health:latest:${deadDisabled}`, JSON.stringify({
      nodeId: 'x1', fingerprint: deadDisabled, timestamp: 2_000_000_000_000,
      tcpLatency: null, tlsLatency: null, httpLatency: null,
      status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
    }));

    const slowFp = '10.0.0.2:443:vmess';
    await kv.put(`health:latest:${slowFp}`, JSON.stringify({
      nodeId: 'x2', fingerprint: slowFp, timestamp: 2_000_000_000_000,
      tcpLatency: 3500, tlsLatency: null, httpLatency: null,
      status: 'alive', tlsApplicable: false, error: null, score: 50, statusMachine: 'active',
    }));

    const suspectFp = '10.0.0.3:443:vmess';
    await kv.put(`health:latest:${suspectFp}`, JSON.stringify({
      nodeId: 'x3', fingerprint: suspectFp, timestamp: 2_000_000_000_000,
      tcpLatency: null, tlsLatency: null, httpLatency: null,
      status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'suspect',
    }));

    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain(deadDisabled);
    expect(dropped).toContain(slowFp);
    expect(dropped).not.toContain(suspectFp);
  });

  it('同一毫秒内两轮探测仍写两条独立历史', async () => {
    const kv = new MemoryKvAdapter();
    const node = makeNode('n5');
    const fp = nodeFingerprint(node);
    const fixed = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixed);

    await probe([node], kv);
    await probe([node], kv);
    spy.mockRestore();

    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(2);
  });
});
