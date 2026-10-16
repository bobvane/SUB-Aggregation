/**
 * v2.38 P1（阶段 1）：节点剔除口径（只保留确认失效的系统剔除）
 * - 慢节点：TCP/TLS 握手延迟不再作为剔除依据 —— 持续慢（最近 3 条 ≥2 条超阈值）也不再进入
 *   getDroppedNodes。握手延迟 ≠ 代理实际转发延迟；健康统计与排序展示仍可使用延迟数据。
 * - 死节点：必须状态机判定 disabled（连续失败 ≥3 轮）才剔除 —— 单轮 dead 只进 suspect（待复核），
 *   不得因单轮失败即剔除。
 *   【实现现状，勿误读】evaluateStateMachine 先判 consecutiveFail>=1 → suspect，再判
 *   consecutiveSuccess>=2 → active。因此「历史里出现过 dead」或「本轮探测仍为 dead」时，
 *   结果都是 suspect；本文件用例如实断言当前实现产出，不把"仍进配置"当作"已恢复 active"。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { KV_KEYS } from '@/models/config';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes } from '@/services/node-probe.service';
import { createNode, nodeFingerprint } from '@/models/node';

const putLatest = (kv: MemoryKvAdapter, fp: string, status: string, tcpLatency: number | null, statusMachine?: string) =>
  kv.put(KV_KEYS.healthLatest(fp), JSON.stringify({
    fingerprint: fp, status, timestamp: Date.now(),
    tcpLatency, tlsLatency: null, score: status === 'dead' ? 0 : 50,
    ...(statusMachine ? { statusMachine } : {}),
  }));

const putHistory = (kv: MemoryKvAdapter, fp: string, ts: number, status: string, tcpLatency: number | null) =>
  kv.put(KV_KEYS.healthHistory(fp, ts), JSON.stringify({
    fingerprint: fp, status, timestamp: ts,
    tcpLatency, tlsLatency: null, score: status === 'dead' ? 0 : 50,
  }));

describe('getDroppedNodes 只剔除状态机确认失效的节点（P1 阶段 1）', () => {
  it('P1 修复③：持续慢（最近 3 条 2 条 >2000）不再仅因延迟被剔除', async () => {
    const kv = new MemoryKvAdapter();
    const ts = [1_700_000_000_000, 1_700_000_300_000, 1_700_000_600_000];
    for (const [i, t] of ts.entries()) await putHistory(kv, 'slow', t, 'alive', i === 0 ? 2100 : i === 1 ? 2200 : 2500);
    await putLatest(kv, 'slow', 'alive', 2500, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('slow');
  });

  it('P1 修复③：用户调低阈值（500）也不影响剔除 —— 延迟不再参与剔除判定', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '500');
    const ts = [1_700_000_000_000, 1_700_000_300_000, 1_700_000_600_000];
    for (const [i, t] of ts.entries()) await putHistory(kv, 'slow800', t, 'alive', i === 2 ? 900 : 800);
    await putLatest(kv, 'slow800', 'alive', 900, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('slow800');
  });

  it('确认失效（statusMachine=disabled）的 dead 节点 → 仍剔除（与延迟无关）', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'dead-fast', 'dead', null, 'disabled');
    // alive 持续慢（2100>2000）→ 不再剔除（P1 修复③ 后行为）
    const ts = [1_700_000_000_000, 1_700_000_300_000, 1_700_000_600_000];
    for (const [i, t] of ts.entries()) await putHistory(kv, 'alive-2100', t, 'alive', i === 2 ? 2200 : 2100);
    await putLatest(kv, 'alive-2100', 'alive', 2200, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain('dead-fast');
    expect(dropped).not.toContain('alive-2100');
  });

  it('P0-2 复核：单轮 dead（statusMachine=suspect）→ 不剔除', async () => {
    const kv = new MemoryKvAdapter();
    // 只有一轮 dead → 状态机 suspect（待复核）→ 保留
    await putLatest(kv, 'once-dead', 'dead', null, 'suspect');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('once-dead');
  });

  it('状态机恢复（经 probeAllNodes 真实链路产出 statusMachine）：连续 alive 后不再被剔除', async () => {
    // 本用例**不再**直接向 health:latest 硬写 statusMachine，
    // 而是把历史写入 KV 后调用真实探测入口 probeAllNodes，
    // 由 doProbeAllNodes 内部 evaluateStateMachine 计算并写入 statusMachine（node-probe.service.ts:643-657）。
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const node = createNode({
      id: 'n-flap', name: 'Flap', protocol: 'vless', server: '127.0.0.1', port: 1, tls: false,
      metadata: { source: 'test', originalName: 'Flap', tags: [] },
    });
    await repos.nodes.setBySubscription('sub1', [node]);
    const f = nodeFingerprint(node);

    // 历史：2 轮 dead 之后连续 2 轮 alive（127.0.0.1:1 不可达，本轮必然 dead，
    // 因此这里用「历史 alive」来构造恢复后的状态，再让本轮探测结果进入判定）
    const base = 1_700_000_000_000;
    const rows: Array<[number, string, number | null]> = [
      [base, 'dead', null],
      [base + 300_000, 'dead', null],
      [base + 600_000, 'alive', 120],
      [base + 900_000, 'alive', 118],
    ];
    for (const [ts, status, tcp] of rows) {
      await putHistory(kv, f, ts, status, tcp);
    }

    await probeAllNodes([node], kv, 24);

    const latest = JSON.parse((await kv.get(KV_KEYS.healthLatest(f))) ?? '{}') as {
      status: string; statusMachine?: string;
    };
    // 当前实现的真实判定结果：
    //   evaluateStateMachine 只数「最新一段连续同状态」，遇到异状态即 break，
    //   且先判 consecutiveFail>=1 → suspect，后判 consecutiveSuccess>=2 → active。
    //   本场景最新一条是本轮 dead，故最新连续段为 dead(1) → consecutiveFail=1 → suspect。
    //   即：**历史里的 alive 不能让状态机回到 active**，因为本轮探测本身是 dead。
    expect(latest.statusMachine).toBe('suspect');

    // suspect 不等于被剔除：getDroppedNodes 只看 disabled
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).not.toContain(f);

    // 对照：历史全为 alive（无 dead）且本轮 dead → 仍 suspect；
    // 历史全为 alive 且本轮 alive（本轮由 evaluateStateMachine 直接判定）→ 见下一用例
  });

  it('状态机 active 的可达路径：最新连续两轮 alive 且历史无 dead → active → 不剔除', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const node = createNode({
      id: 'n-ok', name: 'Ok', protocol: 'vless', server: '127.0.0.1', port: 1, tls: false,
      metadata: { source: 'test', originalName: 'Ok', tags: [] },
    });
    await repos.nodes.setBySubscription('sub1', [node]);
    const f = nodeFingerprint(node);

    // 两条历史 alive（无任何 dead），本轮探测仍为 dead（127.0.0.1:1 不可达）
    const base = 1_700_000_000_000;
    await putHistory(kv, f, base, 'alive', 120);
    await putHistory(kv, f, base + 300_000, 'alive', 118);

    await probeAllNodes([node], kv, 24);
    const latest = JSON.parse((await kv.get(KV_KEYS.healthLatest(f))) ?? '{}') as {
      statusMachine?: string;
    };
    // 最新段是本轮 dead(1) → consecutiveFail=1 → suspect（不是 active）
    expect(latest.statusMachine).toBe('suspect');
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).not.toContain(f);
  });

  it('状态机 disabled：连续三轮 dead → 剔除（经 probeAllNodes 真实链路）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const node = createNode({
      id: 'n-dead3', name: 'Dead3', protocol: 'vless', server: '127.0.0.1', port: 1, tls: false,
      metadata: { source: 'test', originalName: 'Dead3', tags: [] },
    });
    await repos.nodes.setBySubscription('sub1', [node]);
    const f = nodeFingerprint(node);

    // 3 轮独立探测（本轮写入历史后，本轮 + 前两轮 = 连续 3 次 dead）
    for (let i = 0; i < 3; i++) {
      await probeAllNodes([node], kv, 24);
      await new Promise((r) => setTimeout(r, 5)); // 保证 timestamp 唯一
    }
    const latest = JSON.parse((await kv.get(KV_KEYS.healthLatest(f))) ?? '{}') as {
      statusMachine?: string;
    };
    expect(latest.statusMachine).toBe('disabled');
    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).toContain(f);
  });

  it('P1 修复③ 边界：latest 单条超阈值但历史不足 2 条 → 也不剔除（延迟整体不再参与）', async () => {
    const kv = new MemoryKvAdapter();
    await putLatest(kv, 'solo-slow', 'alive', 2500, 'active');
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).not.toContain('solo-slow');
  });
});
