/**
 * C2（阶段 C）：节点健康状态语义固化。
 *
 * 目标：把「当前不可用」「历史不稳定」「尚未检测」「证据不足」「已确认失效」
 * 五种状态固化为可执行断言，防止它们被混为一个状态。
 *
 * 状态定义（基于实际实现）：
 *  - 尚未检测     ：无 health:latest 记录（含 UDP 协议，探测不适用）
 *  - 当前不可用   ：healthStatus='dead'（本轮探测失败）
 *  - 历史不稳定   ：statusMachine='suspect'（连续失败 1-2 轮，未确认）
 *  - 证据不足     ：score 低但 statusMachine 仍为 active/suspect（未达剔除阈值）
 *  - 已确认失效   ：statusMachine='disabled'（连续失败 ≥3 轮）
 *
 * 注意：本文件只测「状态判定」，不重复评分公式细节（见 node-probe-score.test.ts）。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { createConfigService } from '@/services/config.service';
import {
  probeAllNodes,
  evaluateStateMachine,
  getNodeHealthLatest,
  isProbeApplicable,
  calculateScore,
} from '@/services/node-probe.service';

const mk = (id: string, name: string, extra: Partial<Node> = {}): Node =>
  createNode({
    id,
    name,
    protocol: 'vless',
    server: `10.5.0.${id.slice(-1)}`,
    port: 443,
    tls: false,
    metadata: { source: 'test', originalName: name, tags: [] },
    ...extra,
  } as Partial<Node> & { name: string });

const DAY = 86_400_000;

/** 写入一条指定状态的历史记录 */
async function putHist(
  kv: MemoryKvAdapter,
  node: Node,
  opts: { status: string; ageMs: number; tcp?: number | null; tls?: number | null; statusMachine?: string }
) {
  const ts = Date.now() - opts.ageMs;
  await kv.put(
    `health:hist:${nodeFingerprint(node)}:${ts}`,
    JSON.stringify({
      nodeId: node.id,
      fingerprint: nodeFingerprint(node),
      timestamp: ts,
      tcpLatency: opts.tcp ?? null,
      tlsLatency: opts.tls ?? null,
      httpLatency: null,
      status: opts.status,
      tlsApplicable: false,
      error: null,
      score: 0,
      ...(opts.statusMachine ? { statusMachine: opts.statusMachine } : {}),
    })
  );
}

describe('C2 状态语义：五种状态可区分', () => {
  it('① 尚未检测：无任何健康记录 → healthStatus 为 null，不被剔除', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-fresh', 'Fresh');
    await repos.nodes.setBySubscription('sub1', [n]);
    const svc = createConfigService(repos, kv);

    expect(await getNodeHealthLatest(nodeFingerprint(n), kv)).toBeNull();
    expect(await svc.getDroppedNodes()).not.toContain(nodeFingerprint(n));
    expect((await svc.getNodes()).map((x) => x.name)).toContain('Fresh');
  });

  it('② 当前不可用但历史有成功：statusMachine=suspect，仍保留在配置', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-flap', 'Flapping');
    await repos.nodes.setBySubscription('sub1', [n]);
    // 1 条 alive（窗口内）+ 本轮 dead → 连续失败 1 次 → suspect
    await putHist(kv, n, { status: 'alive', ageMs: 2 * 3600_000, tcp: 100 });

    const { results } = await probeAllNodes([n], kv, 24);
    expect(results[0].status).toBe('dead');

    const latest = JSON.parse((await kv.get(`health:latest:${nodeFingerprint(n)}`)) ?? '{}');
    expect(latest.statusMachine).toBe('suspect');

    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).not.toContain(nodeFingerprint(n));
    expect((await svc.getNodes()).map((x) => x.name)).toContain('Flapping');
  });

  it('③ 当前不可用且窗口内无成功：连续 3 轮 → disabled → 剔除', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-conf', 'ConfirmedDead');
    await repos.nodes.setBySubscription('sub1', [n]);

    for (let i = 0; i < 3; i++) {
      const { results } = await probeAllNodes([n], kv, 24);
      expect(results[0].status).toBe('dead');
      await new Promise((r) => setTimeout(r, 5)); // 保证 timestamp 唯一
    }

    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).toContain(nodeFingerprint(n));
    expect((await svc.getNodes()).map((x) => x.name)).not.toContain('ConfirmedDead');
  });

  it('④ 证据不足（样本少）：低分但未被剔除 —— 评分与剔除分离', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-low', 'LowScore');
    await repos.nodes.setBySubscription('sub1', [n]);
    // 直接构造「低分 + 未确认失效」的最新快照（不依赖真实网络探测，
    // 以便精确隔离「评分」与「剔除」两个决策，见任务书 §四.4）
    await kv.put(
      `health:latest:${nodeFingerprint(n)}`,
      JSON.stringify({
        nodeId: n.id,
        fingerprint: nodeFingerprint(n),
        timestamp: Date.now(),
        tcpLatency: 900,
        tlsLatency: null,
        httpLatency: null,
        status: 'alive',
        tlsApplicable: false,
        error: null,
        score: 25, // 低分
        statusMachine: 'suspect', // 但未确认失效
      })
    );

    const svc = createConfigService(repos, kv);
    // 关键断言：分数低 ≠ 被剔除。getDroppedNodes 只看 statusMachine。
    expect(await svc.getDroppedNodes()).not.toContain(nodeFingerprint(n));
    expect((await svc.getNodes()).map((x) => x.name)).toContain('LowScore');
  });

  it('⑤ 恢复语义：连续成功可打断失败计数，但历史中的 dead 会令状态停留在 suspect', () => {
    // evaluateStateMachine 的实现（node-probe.service.ts:415）：
    //   按 timestamp 降序后只数「最新一段连续同状态」，遇到异状态即 break，
    //   然后**先**判 consecutiveFail>=1 → suspect，**后**判 consecutiveSuccess>=2 → active。
    // 因此语义是：
    //   全 alive 历史                → active
    //   3 dead + 1 alive             → suspect（失败被打断，但只成功 1 次）
    //   3 dead + 2 alive             → **仍 suspect**（break 时 consecutiveFail=1，
    //                                  在 success>=2 判断之前就返回 suspect）
    // 影响范围：suspect 与 active 都会进入配置（getDroppedNodes 只看 disabled），
    //          故对最终配置无影响，只影响 UI 状态徽标。
    // 【记录现状 · 不修改】修改该判定属业务规则变更，需单独评审。
    const threeDead = [
      { timestamp: 1, status: 'dead' },
      { timestamp: 2, status: 'dead' },
      { timestamp: 3, status: 'dead' },
    ];
    const afterOneAlive = [...threeDead, { timestamp: 4, status: 'alive' }];
    const afterTwoAlive = [...afterOneAlive, { timestamp: 5, status: 'alive' }];

    expect(evaluateStateMachine(threeDead).status).toBe('disabled');
    expect(evaluateStateMachine(afterOneAlive).status).toBe('suspect');
    expect(evaluateStateMachine(afterTwoAlive).status).toBe('suspect'); // ← 记录现状

    // 对照：历史中不存在 dead 记录时，连续成功 2 次 → active
    const allAlive = [1, 2].map((t) => ({ timestamp: t, status: 'alive' }));
    expect(evaluateStateMachine(allAlive).status).toBe('active');

    // 且不论 suspect 还是 active，均不被剔除
    expect(evaluateStateMachine(afterTwoAlive).status).not.toBe('disabled');
  });
});

describe('C2 状态语义：历史时效性', () => {
  it('历史超出评分窗口但仍在 TTL 内：不计入 availability，但不被清理', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-old', 'StaleButValid');
    await repos.nodes.setBySubscription('sub1', [n]);
    // 3 天前：30 天 TTL 内（不被清理）、24h 窗口外（不参与评分）
    await putHist(kv, n, { status: 'dead', ageMs: 3 * DAY, tcp: null });

    const before = (await kv.list(`health:hist:${nodeFingerprint(n)}:`)).length;
    const { results } = await probeAllNodes([n], kv, 24);
    const after = (await kv.list(`health:hist:${nodeFingerprint(n)}:`)).length;

    expect(before).toBe(1);
    expect(after).toBe(2);            // 旧记录保留 + 本轮新增
    expect(results[0].score).toBe(0); // 窗口内无 alive → Q1 归零
  });

  it('历史超过 TTL：被 cleanupOldHistory 正常清理', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-exp', 'Expired');
    await repos.nodes.setBySubscription('sub1', [n]);
    await putHist(kv, n, { status: 'dead', ageMs: 40 * DAY });
    expect((await kv.list(`health:hist:${nodeFingerprint(n)}:`)).length).toBe(1);

    await probeAllNodes([n], kv, 24);
    const keys = await kv.list(`health:hist:${nodeFingerprint(n)}:`);
    expect(keys.length).toBe(1);      // 仅剩本轮新记录
    expect(keys[0].key).toContain(String(Date.now()).slice(0, 8)); // 本轮时间戳
  });
});

describe('C2 状态语义：非法数据不污染判定', () => {
  it('NaN / Infinity / 缺字段延迟不计入样本', async () => {
    const kv = new MemoryKvAdapter();
    const n = mk('n-bad', 'BadSamples');
    await putHist(kv, n, { status: 'alive', ageMs: 3600_000, tcp: NaN });
    await putHist(kv, n, { status: 'alive', ageMs: 2 * 3600_000, tcp: Infinity });
    await kv.put(
      `health:hist:${nodeFingerprint(n)}:${Date.now() - 3 * 3600_000}`,
      JSON.stringify({
        nodeId: n.id, fingerprint: nodeFingerprint(n), timestamp: Date.now() - 3 * 3600_000,
        status: 'alive', tlsApplicable: false, error: null, score: 0,
        // 故意缺 tcpLatency / tlsLatency 字段
      })
    );
    // 3 条 alive 全部无有效延迟 → 样本 S 为空
    const { results } = await probeAllNodes([n], kv, 24);
    // 本轮 TCP 也不通（127.0.0.1:1）→ probeAlive=false，但 aliveCount=3 → Q1 不介入
    // availability=3/3=1；latency/stability 因 |S|=0 → 0.5/0；非 TLS 权重
    expect(Number.isFinite(results[0].score)).toBe(true);
  });

  it('非法时间戳：评分与状态机共用同一有效性规则，不再虚增连续失败次数（R1 修复）', async () => {
    const kv = new MemoryKvAdapter();
    const n = mk('n-badts', 'BadTimestamps');
    // 注意：JSON.stringify 会丢弃 undefined 字段，因此下面用两种形态分别验证：
    //   ① timestamp 字段**缺失**（键被省略）
    //   ② timestamp 为显式异常值 NaN / 0 / -1000
    const rows = [
      { ts: NaN },
      { ts: 0 },
      { ts: -1000 },
      { ts: undefined }, // 键被省略 = 字段缺失
    ];
    for (const { ts } of rows) {
      await kv.put(
        `health:hist:${nodeFingerprint(n)}:${String(ts)}`,
        JSON.stringify({
          nodeId: n.id, fingerprint: nodeFingerprint(n), ...(ts === undefined ? {} : { timestamp: ts }),
          tcpLatency: null, tlsLatency: null, httpLatency: null,
          status: 'dead', tlsApplicable: false, error: null, score: 0,
        })
      );
    }

    const { results } = await probeAllNodes([n], kv, 24);
    const latest = JSON.parse((await kv.get(`health:latest:${nodeFingerprint(n)}`)) ?? '{}');
    expect(results[0].status).toBe('dead');

    // 修复后：4 条非法记录被 isValidHistoryTimestamp 排除，不参与连续计数，
    // 状态机只看到「本轮 1 条 dead」→ consecutiveFail=1 → suspect（不再是 disabled）。
    expect(latest.statusMachine).toBe('suspect');

    // 纯函数侧对照：显式传入同一批非法记录 + 本轮 dead，应与「仅本轮失败」一致
    const fixedNow = 1_700_000_000_000;
    const dirty = [
      { status: 'dead', timestamp: NaN },
      { status: 'dead', timestamp: 0 },
      { status: 'dead', timestamp: -1000 },
      { status: 'dead', timestamp: fixedNow },
    ] as Array<{ status: string; timestamp: number }>;
    expect(evaluateStateMachine(dirty, fixedNow).status).toBe('suspect');
    expect(evaluateStateMachine([{ timestamp: fixedNow, status: 'dead' }], fixedNow).status).toBe('suspect');
  });
});

describe('C2 状态语义：协议特殊性与评分分离', () => {
  it('TLS 失败但历史有成功：不归零，正常计分', async () => {
    const kv = new MemoryKvAdapter();
    const n = mk('n-tls', 'TlsNode', { tls: true, server: '10.5.0.9' });
    // 2 条 TLS 成功历史（窗口内）
    await putHist(kv, n, { status: 'alive', ageMs: 3600_000, tcp: 50, tls: 60 });
    await putHist(kv, n, { status: 'alive', ageMs: 2 * 3600_000, tcp: 50, tls: 60 });
    const { results } = await probeAllNodes([n], kv, 24);
    // 本轮 TCP 不通 → dead；但有 alive 历史 → Q1 不介入 → 正分
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('TLS 不适用（非 TLS 协议）：TLS 维度剔除，不因无法测 TLS 被扣分', () => {
    // 用纯函数直接对比「TLS 不适用」与「TLS 实测失败」两种口径。
    // 不依赖真实网络探测，避免把「节点不可达」误当成「TLS 语义」来断言。
    const FIXED_NOW = 1_700_000_000_000;
    const hist = (tls: number | null) => [
      { timestamp: FIXED_NOW - 3600_000, tcpLatency: 100, tlsLatency: tls, status: 'alive', score: 0 },
      { timestamp: FIXED_NOW - 2 * 3600_000, tcpLatency: 100, tlsLatency: tls, status: 'alive', score: 0 },
      { timestamp: FIXED_NOW - 3 * 3600_000, tcpLatency: 100, tlsLatency: tls, status: 'alive', score: 0 },
    ];
    const base = {
      tcpLatency: 100, tlsLatency: 100, tcpOk: true, tlsOk: true,
      windowHours: 24, now: FIXED_NOW,
    };

    // 非 TLS 协议：TLS 维度整体剔除，其余三维按生产表达式归一
    // S=[100,100,100,100] → median 100 → 0.9；CV=0 → 稳定性 1；availability=1
    // 1*0.46666666666666673 + 0.9*0.4 + 1*0.13333333333333336 = 0.96 → 96
    const nonTls = calculateScore({
      ...base, history: hist(null), tlsLatency: null, tlsApplicable: false,
    });
    expect(nonTls).toBe(96);

    // 对照：同一份历史（alive 记录 tcpLatency=100 / tlsLatency=null）与同一轮探测，
    // 若**错误地**标记为 TLS 适用：
    //   probeAlive = tcpOk && tlsOk = true && false = false（本轮 TLS 失败）
    //   S=[100,100,100]（本轮不计入）→ median 100 → 0.9；|S|=3 → 稳定性 0.5
    //   tlsSuccess = (0 + 0) / 4 = 0
    //   1*0.35 + 0.9*0.30 + 0*0.25 + 0.5*0.10 = 0.67 → 67
    const tlsFail = calculateScore({
      ...base, history: hist(null), tlsLatency: null, tlsApplicable: true,
      tcpOk: true, tlsOk: false,
    });
    expect(tlsFail).toBe(67);

    // 「不适用」必须显著高于「被误判为 TLS 适用」——证明不会因协议特性被固定扣分
    expect(nonTls).toBeGreaterThan(tlsFail);
  });

  it('UDP 未检测：不写健康数据、不剔除、进配置', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const n = mk('n-udp', 'UdpNode', { protocol: 'tuic', server: '10.5.0.7' });
    await repos.nodes.setBySubscription('sub1', [n]);

    const { results } = await probeAllNodes([n], kv, 24);
    expect(results[0].status).toBe('unknown');
    expect((await kv.list(`health:hist:${nodeFingerprint(n)}:`)).length).toBe(0);
    expect(await getNodeHealthLatest(nodeFingerprint(n), kv)).toBeNull();

    const svc = createConfigService(repos, kv);
    expect(await svc.getDroppedNodes()).not.toContain(nodeFingerprint(n));
    expect((await svc.getNodes()).map((x) => x.name)).toContain('UdpNode');
    expect(isProbeApplicable('tuic')).toBe(false);
  });
});
