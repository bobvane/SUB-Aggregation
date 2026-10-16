/**
 * 阶段 2（评分代次 4）：新公式专项用例 T13–T21 + 版本键 T23。
 *
 * 覆盖：
 * - Q1 归零例外的六类边界（TCP 失败 / TLS 握手失败 / TCP+TLS 成功 /
 *   有 alive 历史但本轮失败 / 无历史且本轮失败 / 全 dead 历史且本轮失败）。
 * - T13 中位数（奇数 / 偶数样本）。
 * - T14–T16 稳定性 CV（零变异 / 高变异封顶 / 零均值样本 / 样本不足）。
 * - 非有限延迟（NaN / Infinity / 缺失）与 nodeLatencyMs 行为。
 * - TLS 字段缺失 / undefined / null 不得被算作成功。
 * - T17 非法与窗口外 timestamp。
 * - T18/T19 历史排列无关性。
 * - T21 `history.score` 变化不影响新公式结果。
 * - T23 三个版本键的读写与「不清理数据」语义。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter } from '@/storage/kv';
import {
  calculateScore,
  evaluateStateMachine,
  isValidHistoryTimestamp,
  isValidLatency,
  nodeLatencyMs,
  resetProbeDataIfEngineChanged,
  FUTURE_TS_TOLERANCE_MS,
  PROBE_VERSION_KEYS,
  PROBE_VERSION_VALUES,
  type ScoreInput,
} from '@/services/node-probe.service';

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

const history = (rows: HistoryInput[]): ScoreInput['history'] =>
  rows.map((r, i) => ({
    timestamp: r.timestamp ?? ts((i + 1) * 10),
    tcpLatency: r.tcpLatency ?? null,
    tlsLatency: r.tlsLatency ?? null,
    score: r.score ?? 0,
    status: r.status,
  }));

const input = (over: Partial<ScoreInput>): ScoreInput => ({
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

describe('Q1 归零例外：六类边界', () => {
  it('① TCP 连接失败（无历史）→ 0', () => {
    expect(
      calculateScore(
        input({ history: [], tcpLatency: null, tlsLatency: null, tcpOk: false, tlsOk: false })
      )
    ).toBe(0);
  });

  it('② TCP 可达但 TLS 握手失败（无历史）→ 0', () => {
    expect(
      calculateScore(
        input({ history: [], tcpLatency: 50, tlsLatency: null, tcpOk: true, tlsOk: false })
      )
    ).toBe(0);
  });

  it('③ TCP 与 TLS 均成功（无历史）→ 63（不受归零规则影响）', () => {
    expect(
      calculateScore(
        input({ history: [], tcpLatency: 50, tlsLatency: 60, tcpOk: true, tlsOk: true })
      )
    ).toBe(63);
  });

  it('④ 存在历史 alive 证据但本轮失败 → 规则不介入，按公式计算 → 86', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 100, tlsLatency: 100 },
      { status: 'alive', tcpLatency: 100, tlsLatency: 100 },
      { status: 'alive', tcpLatency: 100, tlsLatency: 100 },
    ]);
    // availability=1；S=[100,100,100] → median 100 → 0.9；|S|=3 → 稳定性 0.5；tlsSuccess=3/4=0.75
    // 1*0.35 + 0.9*0.30 + 0.75*0.25 + 0.5*0.10 = 0.8575 → 85.75 → 86
    expect(
      calculateScore(
        input({
          history: hist,
          tcpLatency: null,
          tlsLatency: null,
          tcpOk: false,
          tlsOk: false,
        })
      )
    ).toBe(86);
  });

  it('⑤ 没有历史记录且本轮失败 → 0', () => {
    expect(
      calculateScore(
        input({
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

  it('⑥ 存在历史但全部 dead 且本轮失败 → 0', () => {
    const hist = history([
      { status: 'dead', tcpLatency: null, tlsLatency: null },
      { status: 'dead', tcpLatency: null, tlsLatency: null },
    ]);
    expect(
      calculateScore(
        input({
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

  it('Q1 不覆盖「本轮成功但没有历史」的节点', () => {
    expect(calculateScore(input({ history: [], tcpLatency: 30, tlsLatency: 40 })))
      .toBeGreaterThan(0);
    expect(
      calculateScore(input({ history: [], tcpLatency: 30, tlsLatency: null, tlsApplicable: false }))
    ).toBeGreaterThan(0);
  });
});

describe('T13 中位数：奇数与偶数样本', () => {
  it('奇数样本：S=[100,200,300] → median 200 → 延迟 0.8 → 85', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 100 },
      { status: 'alive', tcpLatency: 300 },
    ]);
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 200, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(85);
  });

  it('偶数样本：S=[100,200,300,400] → median 250 → 延迟 0.75 → 83', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 100 },
      { status: 'alive', tcpLatency: 200 },
      { status: 'alive', tcpLatency: 300 },
    ]);
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 400, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(83);
  });

  it('中位数与「最小值」不同：min 会把分数抬高（旧公式口径）', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 900 },
      { status: 'alive', tcpLatency: 100 },
      { status: 'alive', tcpLatency: 900 },
    ]);
    // S=[100,900,900,900] → median 900 → 延迟 0.1
    const withMedian = calculateScore(
      input({ history: hist, tcpLatency: 900, tlsLatency: null, tlsApplicable: false })
    );
    // 旧公式取 min=100 → 延迟 0.9；两者必须不同，证明已切换为 median
    const minBased = (1 * 0.46666666666666673 + 0.9 * 0.4 + 1 * 0.13333333333333336) * 100;
    expect(withMedian).not.toBe(Math.round(minBased));
  });
});

describe('T14–T16 稳定性 CV', () => {
  it('T14 CV=0（4 个等值样本）→ 稳定性 1 → 92', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 200 },
      { status: 'alive', tcpLatency: 200 },
      { status: 'alive', tcpLatency: 200 },
    ]);
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 200, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(92);
  });

  it('T15 高变异 CV>1 → 稳定性封顶 0 → 66', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 1000 },
      { status: 'alive', tcpLatency: 10 },
      { status: 'alive', tcpLatency: 1000 },
    ]);
    // S=[10,10,1000,1000] → median 505 → 0.495；CV=1.1318… → 1−min(CV,1)=0
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 10, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(66);
  });

  it('T16 零均值样本：mean===0 → CV 按 0 → 稳定性 1；延迟维度 1 → 100', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 0 },
      { status: 'alive', tcpLatency: 0 },
      { status: 'alive', tcpLatency: 0 },
    ]);
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 0, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(100);
  });

  it('样本数 1–3：稳定性取 0.5（不使用 CV）', () => {
    const hist = history([
      { status: 'alive', tcpLatency: 100 },
      { status: 'alive', tcpLatency: 200 },
    ]);
    // S=[100,200,300] → 恰好 3 条
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 300, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(85);
  });

  it('样本数为 0：稳定性 0、延迟 0.5（存在 alive 历史时 Q1 不介入）', () => {
    // 3 条 alive 历史但全部没有有效延迟；本轮失败 —— Q1 不介入（存在 alive 证据）
    const hist = history([
      { status: 'alive', tcpLatency: null, tlsLatency: null },
      { status: 'alive', tcpLatency: null, tlsLatency: null },
      { status: 'alive', tcpLatency: null, tlsLatency: null },
    ]);
    // availability=3/3=1；S=[] → 延迟 0.5、稳定性 0
    // 1*0.46666666666666673 + 0.5*0.4 + 0*0.13333333333333336 = 0.6666666666666667 → 66.666… → 67
    const s = calculateScore(
      input({
        history: hist,
        tcpLatency: null,
        tlsLatency: null,
        tcpOk: false,
        tlsOk: false,
        tlsApplicable: false,
      })
    );
    expect(s).toBe(67);
  });
});

describe('非有限延迟与 nodeLatencyMs', () => {
  it('isValidLatency 排除 null / undefined / NaN / ±Infinity', () => {
    expect(isValidLatency(0)).toBe(true);
    expect(isValidLatency(12.5)).toBe(true);
    expect(isValidLatency(null)).toBe(false);
    expect(isValidLatency(undefined)).toBe(false);
    expect(isValidLatency(NaN)).toBe(false);
    expect(isValidLatency(Infinity)).toBe(false);
    expect(isValidLatency(-Infinity)).toBe(false);
    expect(isValidLatency('100')).toBe(false);
  });

  it('nodeLatencyMs：TLS 优先，非有限值回落到 TCP，两者都无效则 null', () => {
    expect(nodeLatencyMs({})).toBeNull();
    expect(nodeLatencyMs({ tlsLatency: null, tcpLatency: null })).toBeNull();
    expect(nodeLatencyMs({ tlsLatency: undefined, tcpLatency: 200 })).toBe(200);
    expect(nodeLatencyMs({ tlsLatency: NaN, tcpLatency: 200 })).toBe(200);
    expect(nodeLatencyMs({ tlsLatency: Infinity, tcpLatency: 200 })).toBe(200);
    expect(nodeLatencyMs({ tlsLatency: 0, tcpLatency: 200 })).toBe(0);
    expect(nodeLatencyMs({ tlsLatency: 120, tcpLatency: 200 })).toBe(120);
  });

  it('NaN 延迟不得污染 S、median 或稳定性', () => {
    const hist = history([
      { status: 'alive', tcpLatency: NaN },
      { status: 'alive', tcpLatency: 200 },
      { status: 'alive', tcpLatency: 300 },
    ]);
    // NaN 被剔除 → S=[100,200,300] → median 200 → 0.8；|S|=3 → 稳定性 0.5 → 85
    const s = calculateScore(
      input({ history: hist, tcpLatency: 100, tlsLatency: null, tlsApplicable: false })
    );
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBe(85);
  });

  it('Infinity 延迟不得污染 S、median 或稳定性', () => {
    const hist = history([
      { status: 'alive', tcpLatency: Infinity },
      { status: 'alive', tcpLatency: 200 },
      { status: 'alive', tcpLatency: 300 },
    ]);
    expect(
      calculateScore(
        input({ history: hist, tcpLatency: 100, tlsLatency: null, tlsApplicable: false })
      )
    ).toBe(85);
  });
});

describe('TLS 字段缺失 / undefined / null 语义', () => {
  it('缺失 tlsLatency 字段不得被算作 TLS 成功（旧实现 `!== null` 会误算）', () => {
    // 故意构造两条**完全没有 tlsLatency 字段**的记录（运行时 undefined）
    const hist = [
      { status: 'alive', timestamp: ts(10), tcpLatency: 100, score: 50 },
      { status: 'alive', timestamp: ts(20), tcpLatency: 100, score: 50 },
      { status: 'alive', timestamp: ts(30), tcpLatency: 100, tlsLatency: 100, score: 50 },
    ] as unknown as ScoreInput['history'];
    // histTlsOk=1（不是 3）；本轮 TLS 失败 → probeTlsOk=0；分母 N+1=4 → 0.25
    // S=[100,100,100] → median 100 → 0.9；|S|=3 → 稳定性 0.5
    // 1*0.35 + 0.9*0.30 + 0.25*0.25 + 0.5*0.10 = 0.7325 → 73.25 → 73
    const s = calculateScore(
      input({ history: hist, tcpLatency: 100, tlsLatency: null, tcpOk: true, tlsOk: false })
    );
    expect(s).toBe(73);
  });

  it('TLS 分母固定为 N+1（历史 + 本轮）', () => {
    // 空历史 + 本轮 TLS 成功 → 1/1 = 1
    expect(calculateScore(input({ history: [], tcpLatency: 50, tlsLatency: 60 }))).toBe(63);
    // 1 条历史（TLS 成功）+ 本轮 TLS 成功 → 2/2 = 1；但 |S|=2 < 3 → 延迟 0.5 → 80
    const one = history([{ status: 'alive', tcpLatency: 100, tlsLatency: 100 }]);
    expect(
      calculateScore(input({ history: one, tcpLatency: 100, tlsLatency: 100 }))
    ).toBe(80);
  });
});

// 本 describe 仅验证 **calculateScore 评分侧** 的历史过滤；
// 状态机侧的有效性规则由 tests/services/node-health-state-semantics.test.ts 覆盖。
describe('T17 非法与窗口外 timestamp（仅评分侧 calculateScore）', () => {
  it('评分侧：NaN / 缺失 / 0 / 负值 / 窗口外全部被过滤，仅保留 2 条窗口内记录 → 89', () => {
    const mixed: ScoreInput['history'] = [
      { status: 'alive', timestamp: NaN, tcpLatency: 100, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: undefined as unknown as number, tcpLatency: 100, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: 0, tcpLatency: 100, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: -1000, tcpLatency: 100, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: now - 49 * 3_600_000, tcpLatency: 100, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: ts(10), tcpLatency: 100, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: ts(20), tcpLatency: 100, tlsLatency: null, score: 0 },
    ];
    // 有效 N=2 → availability=1；S=[100,100,100]（含本轮）→ median 100 → 0.9；稳定性 0.5
    // 1*0.46666666666666673 + 0.9*0.4 + 0.5*0.13333333333333336 = 0.8933333333333334 → 89
    expect(
      calculateScore(input({ history: mixed, tlsLatency: null, tlsApplicable: false }))
    ).toBe(89);
  });

  it('评分侧：只有非法 timestamp 记录时等同于无历史（本轮失败 → Q1 → 0）', () => {
    const onlyBad: ScoreInput['history'] = [
      { status: 'alive', timestamp: NaN, tcpLatency: 1, tlsLatency: null, score: 0 },
      { status: 'alive', timestamp: 0, tcpLatency: 1, tlsLatency: null, score: 0 },
    ];
    expect(
      calculateScore(
        input({
          history: onlyBad,
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

describe('T18 / T19 历史排列无关性', () => {
  const rows = [
    { status: 'alive', tcpLatency: 100, tlsLatency: null, score: 0 },
    { status: 'dead', tcpLatency: null, tlsLatency: null, score: 0 },
    { status: 'alive', tcpLatency: 250, tlsLatency: null, score: 0 },
    { status: 'alive', tcpLatency: 175, tlsLatency: null, score: 0 },
  ];

  it('同一批记录正序与逆序输入得到完全相同的分数', () => {
    const a = calculateScore(
      input({ history: history(rows), tcpLatency: 150, tlsLatency: null, tlsApplicable: false })
    );
    const b = calculateScore(
      input({
        history: history([...rows].reverse()),
        tcpLatency: 150,
        tlsLatency: null,
        tlsApplicable: false,
      })
    );
    expect(a).toBe(b);
    expect(a).toBe(77);
  });
});

describe('T21 history.score 不影响新公式', () => {
  const rows = [
    { status: 'alive', tcpLatency: 100, tlsLatency: null },
    { status: 'dead', tcpLatency: null, tlsLatency: null },
    { status: 'alive', tcpLatency: 250, tlsLatency: null },
    { status: 'alive', tcpLatency: 175, tlsLatency: null },
  ];

  it('仅改变 history.score（其余字段完全一致）→ 结果不变', () => {
    const withZero = calculateScore(
      input({
        history: history(rows.map((r) => ({ ...r, score: 0 }))),
        tcpLatency: 150,
        tlsLatency: null,
        tlsApplicable: false,
      })
    );
    const withHundred = calculateScore(
      input({
        history: history(rows.map((r) => ({ ...r, score: 100 }))),
        tcpLatency: 150,
        tlsLatency: null,
        tlsApplicable: false,
      })
    );
    const withRandom = calculateScore(
      input({
        history: history(rows.map((r, i) => ({ ...r, score: (i * 37) % 101 }))),
        tcpLatency: 150,
        tlsLatency: null,
        tlsApplicable: false,
      })
    );
    expect(withZero).toBe(withHundred);
    expect(withZero).toBe(withRandom);
    expect(withZero).toBe(77);
  });
});

describe('T23 版本键：三键分离且不清理数据', () => {
  const HIST_KEY = 'health:hist:fp-t23:1000';
  const LATEST_KEY = 'health:latest:fp-t23';

  async function seedStaleData() {
    const kv = new MemoryKvAdapter();
    await kv.put(
      HIST_KEY,
      JSON.stringify({ fingerprint: 'fp-t23', status: 'dead', timestamp: 1000, score: 0 })
    );
    await kv.put(
      LATEST_KEY,
      JSON.stringify({
        fingerprint: 'fp-t23',
        status: 'dead',
        timestamp: 1000,
        score: 0,
        statusMachine: 'disabled',
      })
    );
    return kv;
  }

  it('新装环境（三个键都缺失）：补写版本号，不删除任何数据', async () => {
    const kv = await seedStaleData();
    const changed = await resetProbeDataIfEngineChanged(kv);
    expect(changed).toBe(true);
    expect(await kv.get(HIST_KEY)).not.toBeNull();
    expect(await kv.get(LATEST_KEY)).not.toBeNull();
    expect(await kv.get(PROBE_VERSION_KEYS.engine)).toBe(PROBE_VERSION_VALUES.engine);
    expect(await kv.get(PROBE_VERSION_KEYS.score)).toBe(PROBE_VERSION_VALUES.score);
    expect(await kv.get(PROBE_VERSION_KEYS.schema)).toBe(PROBE_VERSION_VALUES.schema);
  });

  it('旧库升级（engine=3、score 缺失）：不删除数据，仅补写版本号', async () => {
    const kv = await seedStaleData();
    await kv.put(PROBE_VERSION_KEYS.engine, '3');
    const changed = await resetProbeDataIfEngineChanged(kv);
    expect(changed).toBe(true);
    expect(await kv.get(HIST_KEY)).not.toBeNull();
    expect(await kv.get(LATEST_KEY)).not.toBeNull();
    expect(await kv.get(PROBE_VERSION_KEYS.engine)).toBe('4');
  });

  it('statusMachine=disabled 的 latest 必须保留（清空会让失效节点复活进配置）', async () => {
    const kv = await seedStaleData();
    await kv.put(PROBE_VERSION_KEYS.engine, '3');
    await resetProbeDataIfEngineChanged(kv);
    const latest = JSON.parse((await kv.get(LATEST_KEY))!) as { statusMachine: string };
    expect(latest.statusMachine).toBe('disabled');
  });

  it('幂等：连续调用第二次返回 false 且数据不变', async () => {
    const kv = await seedStaleData();
    expect(await resetProbeDataIfEngineChanged(kv)).toBe(true);
    expect(await resetProbeDataIfEngineChanged(kv)).toBe(false);
    expect(await kv.get(HIST_KEY)).not.toBeNull();
    expect(await kv.get(LATEST_KEY)).not.toBeNull();
  });

  it('键被外部清除后仅补写，不影响数据', async () => {
    const kv = await seedStaleData();
    await resetProbeDataIfEngineChanged(kv);
    await kv.delete(PROBE_VERSION_KEYS.score);
    expect(await resetProbeDataIfEngineChanged(kv)).toBe(true);
    expect(await kv.get(HIST_KEY)).not.toBeNull();
    expect(await kv.get(PROBE_VERSION_KEYS.score)).toBe(PROBE_VERSION_VALUES.score);
  });
});

// ══════════════════════════════════════════════════════════════════
// R1：历史时间戳有效性统一规则（评分侧与状态机侧共用）
// ══════════════════════════════════════════════════════════════════

describe('R1 时间戳有效性：统一规则（评分 + 状态机）', () => {
  // 固定时间基准：全部断言不依赖真实运行时刻
  const NOW = 1_700_000_000_000;

  const score = (history: ScoreInput['history'], tcpOk = true, tlsOk = true, tlsApplicable = false) =>
    calculateScore({
      tcpLatency: tcpOk ? 100 : null,
      tlsLatency: tlsApplicable && tlsOk ? 110 : null,
      tcpOk,
      tlsOk,
      tlsApplicable,
      history,
      windowHours: 24,
      now: NOW,
    });

  const sm = (history: Array<{ status: string; timestamp: number }>) =>
    evaluateStateMachine(history, NOW);

  it('基础有效性：缺失 / undefined / null / 非数字 / NaN / ±Infinity / 0 / 负数 一律无效', () => {
    const invalid: unknown[] = [
      undefined,
      null,
      '1700000000000',   // 数字字符串（不做隐式转换）
      'abc',
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      -1_700_000_000_000,
    ];
    for (const v of invalid) {
      // 字段缺失
      expect(isValidHistoryTimestamp({}, NOW)).toBe(false);
      // 显式赋值（含 null / 字符串 / 非有限 / 非正）
      expect(isValidHistoryTimestamp({ timestamp: v as number }, NOW)).toBe(false);
    }
  });

  it('合法的过去时间戳有效（窗口内与状态机均视为有效证据）', () => {
    expect(isValidHistoryTimestamp({ timestamp: NOW - 1000 }, NOW)).toBe(true);
    expect(isValidHistoryTimestamp({ timestamp: NOW - 3600_000 }, NOW)).toBe(true);
    // 过去 60 天（超出评分窗口但仍是有效记录）：评分窗口会剔除，状态机仍读到
    expect(isValidHistoryTimestamp({ timestamp: NOW - 60 * 86400_000 }, NOW)).toBe(true);
  });

  it('未来时间戳容差：容差内有效，超容差无效（固定 now，结果确定）', () => {
    expect(isValidHistoryTimestamp({ timestamp: NOW + FUTURE_TS_TOLERANCE_MS }, NOW)).toBe(true);
    expect(isValidHistoryTimestamp({ timestamp: NOW + FUTURE_TS_TOLERANCE_MS + 1 }, NOW)).toBe(false);
    expect(isValidHistoryTimestamp({ timestamp: NOW + 86_400_000 }, NOW)).toBe(false);
  });

  it('R1-1：非法 dead 历史不再虚增连续失败次数（不会导致误剔除）', () => {
    const dirty = [
      { status: 'dead', timestamp: NaN },
      { status: 'dead', timestamp: 0 },
      { status: 'dead', timestamp: -1000 },
      { status: 'dead', timestamp: NOW },
    ];
    // 过滤后只剩本轮 dead → consecutiveFail=1 → suspect（不是 disabled）
    expect(sm(dirty).status).toBe('suspect');
    expect(sm([{ status: 'dead', timestamp: NOW }]).status).toBe('suspect');
    // 无效 alive 记录不得参与连续计数：
    //   两条无效 alive 被过滤后为空历史 → 走既有关闭语义「无历史数据，默认 active」，
    //   而不是"连续成功 2 次"才 active（后者需要两条真实有效记录）。
    expect(sm([
      { status: 'alive', timestamp: NaN },
      { status: 'alive', timestamp: 0 },
    ]).status).toBe('active'); // = 空历史语义
    // 对照：两条真实有效的 alive 才由连续成功判定为 active
    expect(sm([
      { status: 'alive', timestamp: NOW - 1000 },
      { status: 'alive', timestamp: NOW - 2000 },
    ]).status).toBe('active');
  });

  it('R1-2：全无效历史 + 仅本轮失败 ≡ 无有效历史仅本轮失败', () => {
    const onlyThisRound = sm([{ status: 'dead', timestamp: NOW }]);
    const withInvalid = sm([
      { status: 'dead', timestamp: NaN },
      { status: 'dead', timestamp: 0 },
      { status: 'dead', timestamp: -1 },
      { status: 'dead', timestamp: NOW },
    ]);
    expect(withInvalid.status).toBe(onlyThisRound.status);
    expect(withInvalid.reason).toBe(onlyThisRound.reason);
  });

  it('R1-3：三条有效连续 dead + 一条超容差未来 alive → 未来记录不干扰判定', () => {
    const threeDead = [
      { status: 'dead', timestamp: NOW },
      { status: 'dead', timestamp: NOW - 60_000 },
      { status: 'dead', timestamp: NOW - 120_000 },
    ];
    expect(sm(threeDead).status).toBe('disabled');

    // 超容差未来的 alive 被排除 → 仍按三条有效 dead 判定为 disabled（不被"打断"）
    const withFuture = sm([...threeDead, { status: 'alive', timestamp: NOW + 86_400_000 }]);
    expect(withFuture.status).toBe('disabled');
  });

  it('R1-4：容差内的轻微未来时间戳，评分与状态机都视为有效证据', () => {
    const slightFuture = NOW + 60_000; // 领先 1 分钟，在 5 分钟容差内
    expect(isValidHistoryTimestamp({ timestamp: slightFuture }, NOW)).toBe(true);

    // 状态机：容差内未来 alive 参与连续计数（有效记录）→ 连续成功 2 次 → active
    expect(sm([
      { status: 'alive', timestamp: slightFuture },
      { status: 'alive', timestamp: NOW - 1000 },
    ]).status).toBe('active');

    // 评分侧：本构造为「单条 alive 历史 + 本轮存活」
    //   容差内（有效）：N=1 → availability=1；S=[120(历史), 100(本轮)] → |S|=2 → latency=0.5；
    //                 |S|=2 → stability=0.5；非 TLS 归一权重
    //                 1×0.46666666666666673 + 0.5×0.4 + 0.5×0.13333333333333336 = 0.93333… → 73
    //   超容差（无效，记录被剔除）：N=0 → availability=0.5；S=[100(本轮)] → |S|=1 → latency=0.5；
    //                 |S|=1 → stability=0.5
    //                 0.5×0.46666666666666673 + 0.5×0.4 + 0.5×0.13333333333333336 = 0.5 → 50
    const oneAlive = (ts: number) => [
      { status: 'alive', timestamp: ts, tcpLatency: 120, tlsLatency: null, score: 0 },
    ];
    expect(score(oneAlive(slightFuture))).toBe(73);

    // 对照：同构造但时间戳超出容差 → 记录无效被剔除 → 评分降为 50
    const beyondTolerance = NOW + FUTURE_TS_TOLERANCE_MS + 1;
    expect(isValidHistoryTimestamp({ timestamp: beyondTolerance }, NOW)).toBe(false);
    expect(score(oneAlive(beyondTolerance))).toBe(50);

    // 状态机侧同一对照：超容差记录被排除后只剩 1 条 alive → 连续成功 1 次 → 默认分支 → active
    expect(sm([
      { status: 'alive', timestamp: beyondTolerance },
      { status: 'alive', timestamp: NOW - 1000 },
    ]).status).toBe('active');

    // 两次评分之差即证明「容差内记录确实被计入有效样本」
    expect(score(oneAlive(slightFuture)) - score(oneAlive(beyondTolerance))).toBe(23);
  });

  it('R1-5：评分与状态机在同一 now 下对同一批时间戳给出一致判断', () => {
    const cases: number[] = [NaN, 0, -1, Infinity, -Infinity, NOW - 1000, NOW + FUTURE_TS_TOLERANCE_MS, NOW + FUTURE_TS_TOLERANCE_MS + 1];
    for (const ts of cases) {
      const valid = isValidHistoryTimestamp({ timestamp: ts }, NOW);
      // 构造：一条 status='dead'、timestamp=ts 的历史 + 一条 status='alive'、timestamp=NOW-1 的本轮记录。
      //   · ts 有效 → 该 dead 进入排序（NOW-1 之前），降序后先遇到 dead → consecutiveFail=1 → suspect
      //   · ts 无效 → 该 dead 被 isValidHistoryTimestamp 剔除，仅剩本轮 1 条 alive：
      //             consecutiveSuccess=1（未达 alive>=2 的阈值），循环自然结束且 fail=0，
      //             落到 evaluateStateMachine 的默认分支「latest.status==='alive' → active」→ active
      // 即：无效时间戳的结果由「剩余有效历史 + 本轮结果」决定，此处为空/默认历史语义对应的 active。
      const smStatus = sm([
        { status: 'dead', timestamp: ts },
        { status: 'alive', timestamp: NOW - 1 },
      ]).status;
      // 精确断言：有效 → suspect；无效 → active（不接受联合值）
      if (valid) expect(smStatus).toBe('suspect');
      else expect(smStatus).toBe('active');
    }
  });

  it('R1-6：保留状态机既有阈值与排序方向（不受 R1 影响）', () => {
    // 阈值：dead>=3 → disabled；dead>=1 → suspect；alive>=2 → active
    expect(sm([
      { status: 'dead', timestamp: NOW },
      { status: 'dead', timestamp: NOW - 1 },
      { status: 'dead', timestamp: NOW - 2 },
    ]).status).toBe('disabled');
    expect(sm([
      { status: 'dead', timestamp: NOW },
      { status: 'dead', timestamp: NOW - 1 },
    ]).status).toBe('suspect');
    expect(sm([
      { status: 'alive', timestamp: NOW },
      { status: 'alive', timestamp: NOW - 1 },
    ]).status).toBe('active');

    // 排序方向：降序（最新在前）。最新 dead + 更早 alive → 连续失败 1 → suspect
    expect(sm([
      { status: 'alive', timestamp: NOW - 1000 },
      { status: 'dead', timestamp: NOW },
    ]).status).toBe('suspect');

    // 遇异状态即停止计数：dead,dead,alive → fail=2 后遇 alive break → suspect（不达 3）
    expect(sm([
      { status: 'dead', timestamp: NOW - 3000 },
      { status: 'dead', timestamp: NOW - 2000 },
      { status: 'alive', timestamp: NOW - 1000 },
      { status: 'dead', timestamp: NOW },
    ]).status).toBe('suspect');
  });

  it('R1-7：空历史与全无效历史的行为符合既有关闭语义', () => {
    // 空历史 → 默认 active（既有行为，:451-452）
    expect(sm([]).status).toBe('active');
    // 全无效历史 → 等同空历史
    expect(sm([
      { status: 'dead', timestamp: NaN },
      { status: 'alive', timestamp: 0 },
    ]).status).toBe('active');
    // 评分侧：全无效历史 + 本轮失败 → Q1 → 0
    expect(score([{ status: 'dead', timestamp: NaN, tcpLatency: null, tlsLatency: null, score: 0 }], false, false)).toBe(0);
  });
});
