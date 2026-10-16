/**
 * P0 闭环审计（m00972）第十二节第 2 项：probeAllNodes 并发门闩
 *
 * 架构依据（src/services/node-probe.service.ts）：
 * - probeAllNodes(:435)：probeAllNodesInflight 单飞门闩。
 *   第一次调用启动 doProbeAllNodes；同一周期内的第二次调用等当前轮完成后
 *   再作为「独立新一轮」执行（.then(() => doProbeAllNodes(...))）。
 * - 断言目标：
 *   ① 同周期并发调用 → 历史只产生「两轮」（第一轮跑完后第二轮才启动），
 *      而不是「同一轮被重复写两次」（防重复计数）；
 *   ② 第一轮完成后，下一次真正调用产生第二轮（.then 链路）；
 *   ③ 两个并调在结果里都拿到数据（第二个拿到的是「第二轮」结果，非第一轮）。
 *
 * 使用不可达节点（127.0.0.1:1）做真实探测，保证每轮确实产生新历史条目。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, nodeFingerprint } from '@/services/node-probe.service';
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

describe('probeAllNodes 并发门闩（同周期不产生重复轮次）', () => {
  it('同一周期并发调用：第二轮在第一轮完成后才启动，历史恰好两轮（第二轮各 1 条）', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    // 第一轮已跑完一次（1 条历史）
    await probeAllNodes([node], kv, 24);
    await sleep(5);

    // 并发两个调用：此刻 inflight 为空，第一个启动新一轮；
    // 第二个等第一个完成后作为独立第三轮执行。
    const [r1, r2] = await Promise.all([
      probeAllNodes([node], kv, 24),
      probeAllNodes([node], kv, 24),
    ]);

    // 两个都拿到 dead 结果（各自的轮次）
    expect(r1.results[0].status).toBe('dead');
    expect(r2.results[0].status).toBe('dead');

    // 历史共 3 条（初始 1 + 并发 2 轮），每轮各 1 条 —— 没有同轮重复写
    const hist = await kv.list(`health:hist:${fp}:`);
    expect(hist.length).toBe(3);

    // 第二轮（r2）的 timestamp 严格晚于第一轮（r1）
    expect(r2.results[0].timestamp).toBeGreaterThan(r1.results[0].timestamp);

    // 状态机：3 轮 dead → disabled
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('第一轮完成前并发调用不会把同一轮写两次：in-flight 期间第二次调用被排队为下一轮', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    // 直接验证单飞语义：连续快速发起两次（第二次在第一轮完成前发起）
    const p1 = probeAllNodes([node], kv, 24);
    const p2 = probeAllNodes([node], kv, 24); // 第一轮 in-flight 时发起 → 排队
    const [r1, r2] = await Promise.all([p1, p2]);

    // 两轮 timestamp 不同（独立轮次，非同轮重复）
    expect(r1.results[0].timestamp).not.toBe(r2.results[0].timestamp);
    // 历史恰好 2 条（两轮各 1 条）
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(2);
  });
});
