/**
 * v2.36.8：probe3 —— 3 次探测取中位（丢最高丢最低），多数票判定死活
 */
import { describe, it, expect } from 'vitest';
import { probe3 } from '@/services/node-probe.service';

const ok = (latency: number) => ({ latency, error: null });
const fail = (error: string) => ({ latency: null, error });

describe('probe3 中位数探测', () => {
  it('3 次成功取中间值（丢最高丢最低）', async () => {
    const seq = [500, 150, 900];
    const r = await probe3(() => Promise.resolve(ok(seq.pop()!)));
    expect(r.latency).toBe(500);
  });

  it('VPS 场景：1 次尖峰 1000ms 不污染中位', async () => {
    const seq = [150, 1000, 160];
    const r = await probe3(() => Promise.resolve(ok(seq.pop()!)));
    expect(r.latency).toBe(160);
  });

  it('2 成 1 败 → 取成功两者中较大值（保守），不判死', async () => {
    const seq = [ok(200), fail('TCP 超时'), ok(150)];
    const r = await probe3(() => Promise.resolve(seq.pop()!));
    expect(r.latency).toBe(200);
  });

  it('1 成 2 败 → 判死（多数票）', async () => {
    const seq = [ok(150), fail('TCP 超时'), fail('TCP 超时')];
    const r = await probe3(() => Promise.resolve(seq.pop()!));
    expect(r.latency).toBeNull();
    expect(r.error).toBe('TCP 超时');
  });

  it('3 全败 → 判死', async () => {
    const r = await probe3(() => Promise.resolve(fail('TCP 超时')));
    expect(r.latency).toBeNull();
    expect(r.error).toBe('TCP 超时');
  });
});
