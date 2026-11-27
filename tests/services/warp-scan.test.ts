/**
 * WARP 端点发现 + 存活验证（v2.50.4）回归：
 * - 候选生成：自检固定 8 组、H3 固定 4 个、H2 采样、端口矩阵、组合上限
 * - 任务生命周期：成功 / 失败 / 取消 / 并发守卫
 * - 结果分类：alive / failed / unknown 由 runner 提供，服务只做计数
 *
 * 不启动真实 mihomo：通过 setWarpScanRunnerForTest 注入假 runner。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WARP_SCAN_MAX_COMBOS,
  WARP_SCAN_PORTS,
  buildWarpScanCandidates,
  cancelWarpScanJob,
  getWarpScanJob,
  resetWarpScanStateForTest,
  setWarpScanRunnerForTest,
  startWarpScan,
  waitForWarpScanJob,
  type WarpScanRunner,
} from '@/services/warp-scan.service';
import type { WarpLabAccount } from '@/services/warp-lab.service';

const account: WarpLabAccount = {
  id: 'dev-12345678',
  token: 'token-abc',
  privateKey: 'cHJpdmF0ZQ==',
  peerPublicKey: 'cGVlcg==',
  ipv4: '172.16.0.2',
  ipv6: 'fd01::2',
  registeredAt: 1_700_000_000_000,
};

function makeCyclingRand(): (n: number) => number {
  let cursor = 0;
  // 确定性地覆盖 0..n-1，避免 while 循环取到重复值卡死
  return (n: number): number => {
    const cur = cursor % Math.max(1, n);
    cursor++;
    return cur;
  };
}

let cyclingRand: (n: number) => number;

beforeEach(() => {
  cyclingRand = makeCyclingRand();
  resetWarpScanStateForTest();
});

afterEach(() => {
  resetWarpScanStateForTest();
});

describe('候选生成', () => {
  it('自检固定 4 个 IP × {h2,h3} × 443 = 8 组', () => {
    const list = buildWarpScanCandidates({ selfcheck: true });
    expect(list).toHaveLength(8);
    expect(list.every((c) => c.port === 443)).toBe(true);
    expect(list.filter((c) => c.transport === 'h2')).toHaveLength(4);
    expect(list.filter((c) => c.transport === 'h3')).toHaveLength(4);
  });

  it('只选 H3 时是固定 4 个地址', () => {
    const list = buildWarpScanCandidates({ protocols: ['h3'], ports: [443] });
    expect(list.map((c) => `${c.server}:${c.port}:${c.transport}`)).toEqual([
      '162.159.198.1:443:h3',
      '162.159.198.2:443:h3',
      '162.159.199.1:443:h3',
      '162.159.199.2:443:h3',
    ]);
  });

  it('H2 每个 /24 采样 N 个，两个网段共 2N', () => {
    const list = buildWarpScanCandidates(
      { protocols: ['h2'], ports: [443], samplePerSubnet: 8 },
      cyclingRand
    );
    expect(list).toHaveLength(16);
    expect(new Set(list.map((c) => c.server)).size).toBe(16);
    expect(list.every((c) => c.transport === 'h2' && c.port === 443)).toBe(true);
    expect(list.some((c) => c.server.startsWith('162.159.198.'))).toBe(true);
    expect(list.some((c) => c.server.startsWith('162.159.199.'))).toBe(true);
  });

  it('端口矩阵按勾选展开', () => {
    const list = buildWarpScanCandidates({ protocols: ['h3'], ports: [443, 500] });
    expect(list).toHaveLength(8);
    expect(list.filter((c) => c.port === 500)).toHaveLength(4);
  });

  it('组合数超过上限时抛可读错误', () => {
    expect(() =>
      buildWarpScanCandidates({
        protocols: ['h2', 'h3'],
        ports: WARP_SCAN_PORTS,
        samplePerSubnet: 32,
      })
    ).toThrow(new RegExp(String(WARP_SCAN_MAX_COMBOS)));
  });
});

describe('任务生命周期', () => {
  it('runner 全部存活 → success，计数正确', async () => {
    const runner: WarpScanRunner = async (_a, candidates, ctx) => {
      for (const c of candidates) {
        ctx.onResult({ ...c, status: 'alive', latency: 20, error: null, attempts: 1 });
      }
      return { coreOk: true, error: null };
    };
    setWarpScanRunnerForTest(runner);
    const job = startWarpScan(account, { selfcheck: true });
    expect(job.total).toBe(8);
    const done = await waitForWarpScanJob(job.id);
    expect(done?.state).toBe('success');
    expect(done?.alive).toBe(8);
    expect(done?.processed).toBe(8);
    expect(done?.results).toHaveLength(8);
  });

  it('runner 返回 coreOk=false → failed，并保留 unknown 结果', async () => {
    const runner: WarpScanRunner = async (_a, candidates, ctx) => {
      for (const c of candidates) {
        ctx.onResult({ ...c, status: 'unknown', latency: null, error: '核心未安装', attempts: 0 });
      }
      return { coreOk: false, error: '核心未安装' };
    };
    setWarpScanRunnerForTest(runner);
    const job = startWarpScan(account, { selfcheck: true });
    const done = await waitForWarpScanJob(job.id);
    expect(done?.state).toBe('failed');
    expect(done?.unknown).toBe(8);
    expect(done?.error).toBe('核心未安装');
  });

  it('取消后状态为 cancelled，且不再继续产出结果', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: WarpScanRunner = async (_a, candidates, ctx) => {
      await gate;
      for (const c of candidates) {
        if (ctx.shouldStop()) break;
        ctx.onResult({ ...c, status: 'alive', latency: 20, error: null, attempts: 1 });
      }
      return { coreOk: true, error: null };
    };
    setWarpScanRunnerForTest(runner);
    const job = startWarpScan(account, { selfcheck: true });
    expect(cancelWarpScanJob(job.id)).toBe(true);
    release();
    const done = await waitForWarpScanJob(job.id);
    expect(done?.state).toBe('cancelled');
    expect(done?.alive).toBe(0);
    expect(done?.processed).toBe(0);
  });

  it('已有任务运行时拒绝启动第二个', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: WarpScanRunner = async () => {
      await gate;
      return { coreOk: true, error: null };
    };
    setWarpScanRunnerForTest(runner);
    const first = startWarpScan(account, { selfcheck: true });
    expect(() => startWarpScan(account, { selfcheck: true })).toThrow(/已有/);
    cancelWarpScanJob(first.id);
    release();
    await waitForWarpScanJob(first.id);
  });

  it('未知任务返回 null', () => {
    expect(getWarpScanJob('missing')).toBeNull();
  });
});
