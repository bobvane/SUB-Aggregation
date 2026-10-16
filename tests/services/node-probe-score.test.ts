/**
 * 阶段 2（评分代次 4）：评分口径与边界严格验证。
 *
 * 核心口径（src/services/node-probe.service.ts calculateScore）：
 * - TLS 适用节点权重 35/30/25/10。
 * - 非 TLS 节点剔除 TLS 维度，其余三维按**生产表达式**归一
 *   （sum = 0.35+0.30+0.10 = 0.7499999999999999，不是字面 0.75），
 *   实际权重 0.46666666666666673 / 0.4 / 0.13333333333333336，权重和恰为 1。
 * - availability 只统计窗口内有效历史，分母 N；N=0 → 0.5。**本轮探测不计入**。
 * - latency：S = 历史 alive 有效延迟 ∪ 本轮 alive 有效延迟；
 *   |S| < 3 → 0.5；否则 max(0, 1 − median(S)/1000)。
 * - stability：同一 S；|S|=0 → 0；1–3 → 0.5；≥4 → 1 − min(CV,1)（样本标准差，分母 n−1）。
 * - TLS：分母 N+1（历史 + 本轮）；缺失 / undefined / null 一律不算成功。
 * - Q1 例外（阶段 2 业务规则）：本轮探测失败且窗口内零 alive 证据 → 直接 0。
 *
 * 与旧公式（引擎 3）的差异：min → median、稳定性由 history.score 均值 → 样本 CV、
 * TLS 分母 N → N+1、全局冷启动 → 按维度默认值、新增 Q1 归零例外。
 */
import { describe, it, expect } from 'vitest';
import { calculateScore, scoreWeights, type ScoreInput } from '@/services/node-probe.service';

/** 固定时间基准：显式注入 now，避免依赖真实当前时间 */
const now = Date.now();
const ts = (offsetMin: number) => now - offsetMin * 60_000;

/** 测试用历史输入：字段可选，缺省由 history() 补齐（显式 NaN 会被原样保留） */
type HistoryInput = {
  status: string;
  timestamp?: number;
  tcpLatency?: number | null;
  tlsLatency?: number | null;
  score?: number;
};

/** 构造窗口内历史（时间戳按行序递减，越靠后越新） */
const history = (rows: HistoryInput[]): ScoreInput['history'] =>
  rows.map((r, i) => ({
    timestamp: r.timestamp ?? ts((i + 1) * 10),
    tcpLatency: r.tcpLatency ?? null,
    tlsLatency: r.tlsLatency ?? null,
    score: r.score ?? 90,
    status: r.status,
  }));

const baseInput = (over: Partial<ScoreInput>): ScoreInput => ({
  tcpLatency: 100,
  tlsLatency: 100,
  tcpOk: true,
  tlsOk: true,
  tlsApplicable: true,
  history: [],
  windowHours: 24,
  now,
  ...over,
});

describe('权重归一化：必须使用生产表达式的实际浮点值', () => {
  it('TLS 适用：0.35 / 0.30 / 0.25 / 0.10', () => {
    const w = scoreWeights(true);
    expect(w.wAvail).toBe(0.35);
    expect(w.wLat).toBe(0.3);
    expect(w.wTls).toBe(0.25);
    expect(w.wStab).toBe(0.1);
  });

  it('非 TLS：剔除 TLS 维度，其余按 sum=0.7499999999999999 归一（不是字面 0.75）', () => {
    const w = scoreWeights(false);
    expect(w.wTls).toBe(0);
    expect(w.wAvail).toBe(0.46666666666666673);
    expect(w.wLat).toBe(0.4);
    expect(w.wStab).toBe(0.13333333333333336);
    // 权重的实际浮点和恰为 1；字面 0.75 归一会得到 0.9999999999999999
    expect(w.wAvail + w.wLat + w.wStab).toBe(1);
    // 与字面量除法的差异（按位不同，防止有人用 0.35/0.75 替代）
    expect(w.wAvail).not.toBe(0.35 / 0.75);
    expect(w.wLat).not.toBe(0.3 / 0.75);
    expect(w.wStab).not.toBe(0.1 / 0.75);
  });
});

describe('冷启动与 Q1 归零例外', () => {
  it('冷启动 + 本轮 TLS 成功：availability/latency/stability 取默认基线，TLS=1/1 → 63', () => {
    // 0.5*0.35 + 0.5*0.30 + 1*0.25 + 0.5*0.10 = 0.625 → 62.5 → 63
    expect(calculateScore(baseInput({ history: [] }))).toBe(63);
  });

  it('冷启动 + 非 TLS 存活：三维各 0.5 → 50', () => {
    expect(
      calculateScore(baseInput({ history: [], tlsApplicable: false, tlsLatency: null }))
    ).toBe(50);
  });

  it('Q1：本轮 TCP 失败 + 无历史 → 0（不再给默认基线）', () => {
    expect(
      calculateScore(
        baseInput({
          history: [],
          tcpLatency: null,
          tlsLatency: null,
          tcpOk: false,
          tlsOk: false,
        })
      )
    ).toBe(0);
  });

  it('Q1：本轮 TCP 成功但 TLS 握手失败 + 无历史 → 0', () => {
    expect(
      calculateScore(
        baseInput({
          history: [],
          tcpLatency: 50,
          tlsLatency: null,
          tcpOk: true,
          tlsOk: false,
        })
      )
    ).toBe(0);
  });

  it('Q1：非 TLS 节点完全失联 + 无历史 → 0', () => {
    expect(
      calculateScore(
        baseInput({
          history: [],
          tcpLatency: null,
          tlsLatency: null,
          tcpOk: false,
          tlsOk: false,
          tlsApplicable: false,
        })
      )
    ).toBe(0);
  });

  it('Q1：窗口内存在 alive 历史 + 本轮失败 → 规则不介入，按公式计算（非 TLS = 69）', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 500 },
      { status: 'alive', tcpLatency: 800 },
      { status: 'alive', tcpLatency: 600 },
    ]);
    // availability=3/3=1；S=[500,600,800]（本轮失败不计入）→ median=600 → 0.4；|S|=3 → 稳定性 0.5
    // 1*0.46666666666666673 + 0.4*0.4 + 0.5*0.13333333333333336 = 0.6933333333333334 → 69
    expect(
      calculateScore(
        baseInput({
          history: hist,
          tcpLatency: null,
          tlsLatency: null,
          tcpOk: false,
          tlsOk: false,
          tlsApplicable: false,
        })
      )
    ).toBe(69);
  });

  it('Q1：窗口内全部为 dead 历史 + 本轮失败 → 0', () => {
    const hist = history([
      { status: 'dead', tcpLatency: null, tlsLatency: null, score: 0 },
      { status: 'dead', tcpLatency: null, tlsLatency: null, score: 0 },
      { status: 'dead', tcpLatency: null, tlsLatency: null, score: 0 },
    ]);
    expect(
      calculateScore(
        baseInput({
          history: hist,
          tcpLatency: null,
          tlsLatency: null,
          tcpOk: false,
          tlsOk: false,
          tlsApplicable: false,
        })
      )
    ).toBe(0);
  });
});

describe('有历史场景：非 TLS 归一化与 TLS 维度区分', () => {
  const nonTlsAllGood = history([
    { status: 'alive', tcpLatency: 100, tlsLatency: null, score: 90 },
    { status: 'alive', tcpLatency: 120, tlsLatency: null, score: 90 },
    { status: 'alive', tcpLatency: 80, tlsLatency: null, score: 90 },
  ]);

  it('非 TLS 全好：S=[100,120,80,100] → median 100 → 0.9；CV=0.16329… → 稳定性 0.83670… → 94', () => {
    const nonTls = calculateScore(
      baseInput({ history: nonTlsAllGood, tlsApplicable: false, tlsLatency: null })
    );
    // 1*0.46666666666666673 + 0.9*0.4 + 0.8367006838144548*0.13333333333333336 = 0.9382267578419274 → 94
    expect(nonTls).toBe(94);
  });

  it('同样历史但标记 TLS 适用且 TLS 全失败：tlsSuccess=0/4 → 77（低于非 TLS）', () => {
    const tlsAllFail = calculateScore(baseInput({ history: nonTlsAllGood }));
    // 1*0.35 + 0.9*0.30 + 0.25*0.25 + 0.8367006838144548*0.10 = 0.7661700683814455 → 77
    expect(tlsAllFail).toBe(77);
    expect(calculateScore(baseInput({ history: nonTlsAllGood, tlsApplicable: false, tlsLatency: null })))
      .toBeGreaterThan(tlsAllFail);
  });

  it('TLS 全好：S 全 100 → CV=0 → 稳定性 1；tlsSuccess=4/4=1 → 97', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 100, tlsLatency: 100, score: 100 },
      { status: 'alive', tcpLatency: 100, tlsLatency: 100, score: 100 },
      { status: 'alive', tcpLatency: 100, tlsLatency: 100, score: 100 },
    ]);
    expect(calculateScore(baseInput({ history: hist }))).toBe(97);
  });

  it('真实 TLS 失败（本轮 TLS 失败）拉低分数，且「不适用」不参与扣分', () => {
    const mixed = history([
      { status: 'alive', tcpLatency: 100, tlsLatency: 100, score: 80 },
      { status: 'alive', tcpLatency: 100, tlsLatency: 100, score: 80 },
      { status: 'alive', tcpLatency: 100, tlsLatency: null, score: 80 },
    ]);
    // 本轮 TCP 成功但 TLS 失败 → 本轮不计入 S，且不计 TLS 成功
    const realFail = calculateScore(
      baseInput({ history: mixed, tcpLatency: 100, tlsLatency: null, tcpOk: true, tlsOk: false })
    );
    // S=[100,100,100] → median 100 → 0.9；|S|=3 → 稳定性 0.5；tlsSuccess=2/4=0.5
    // 1*0.35 + 0.9*0.30 + 0.5*0.25 + 0.5*0.10 = 0.795 → 79.5 → 80
    expect(realFail).toBe(80);

    const fullTls = calculateScore(baseInput({ history: mixed, tlsLatency: 100, tlsOk: true }));
    // 本轮 TLS 成功：histTlsOk=2（第 3 条历史 tlsLatency=null 不算成功）+ 本轮 1 = 3
    // 分母 N+1 = 4 → tlsSuccess = 3/4 = 0.75（不是 4/4，历史里的 TLS 失败仍计入分母）
    // S=[100,100,100,100] → median 100 → 0.9；|S|=4 → CV=0 → 稳定性 1
    // 1*0.35 + 0.9*0.30 + 0.75*0.25 + 1*0.10 = 0.9075 → 90.75 → 91
    expect(fullTls).toBe(91);

    // 同历史按「TLS 不适用」处理：TLS 维度整体剔除并重归一 → 96
    const notApplicable = calculateScore(
      baseInput({ history: mixed, tlsApplicable: false, tlsLatency: null })
    );
    expect(notApplicable).toBe(96);

    expect(realFail).toBeLessThan(fullTls);
    expect(notApplicable).toBeGreaterThan(realFail);
  });
});

describe('边界规则', () => {
  it('极端延迟 ≥1000ms：延迟维度封顶 0；稳定性 CV=0 → 1 → 60', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 5000, tlsLatency: null, score: 100 },
      { status: 'alive', tcpLatency: 5000, tlsLatency: null, score: 100 },
      { status: 'alive', tcpLatency: 5000, tlsLatency: null, score: 100 },
    ]);
    // 1*0.46666666666666673 + 0*0.4 + 1*0.13333333333333336 = 0.6000000000000001 → 60
    expect(
      calculateScore(
        baseInput({ history: hist, tcpLatency: 5000, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(60);
  });

  it('窗口外历史不计入：24h 窗口外的记录全部被过滤 → N=0，本轮存活 → 50', () => {
    const oldRows = [
      { status: 'alive', tcpLatency: 100, tlsLatency: null, score: 100, timestamp: now - 49 * 3_600_000 },
      { status: 'alive', tcpLatency: 100, tlsLatency: null, score: 100, timestamp: now - 48 * 3_600_000 },
      { status: 'alive', tcpLatency: 100, tlsLatency: null, score: 100, timestamp: now - 47 * 3_600_000 },
    ];
    expect(
      calculateScore(
        baseInput({ history: oldRows, tlsApplicable: false, tlsLatency: null })
      )
    ).toBe(50);
  });

  it('结果始终落在 0–100 且为整数', () => {
    const inputs = [
      baseInput({ history: [] }),
      baseInput({ history: [], tlsApplicable: false, tlsLatency: null }),
      baseInput({ tcpLatency: null, tlsLatency: null, tcpOk: false, tlsOk: false }),
      baseInput({ tcpLatency: 99999, tlsLatency: null, tlsApplicable: false }),
    ];
    // 必须对每个输入实际调用 calculateScore()，再对返回值断言
    const scores = inputs.map((i) => calculateScore(i));
    for (const s of scores) {
      expect(Number.isFinite(s)).toBe(true);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});
