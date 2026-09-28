import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter } from '@/storage/kv';
import { KV_KEYS } from '@/models/config';
import { resolveWindowHours } from '@/services/node-probe.service';

/**
 * v2.35：统计窗口 = 设置页「链接更新时间」sub_update_interval（1-24 小时）。
 * 此前硬编码 24，用户把刷新间隔调成 6 小时，五维评分仍按 24 小时窗口算。
 */
describe('resolveWindowHours (五维评分统计窗口)', () => {
  it('读取设置页 sub_update_interval', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('sub_update_interval'), '6');
    expect(await resolveWindowHours(kv)).toBe(6);
  });

  it('未设置时回退 24', async () => {
    expect(await resolveWindowHours(new MemoryKvAdapter())).toBe(24);
  });

  it('0（不自动更新）与非法值均回退 24', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('sub_update_interval'), '0');
    expect(await resolveWindowHours(kv)).toBe(24);
    await kv.put(KV_KEYS.setting('sub_update_interval'), 'abc');
    expect(await resolveWindowHours(kv)).toBe(24);
    await kv.put(KV_KEYS.setting('sub_update_interval'), '999');
    expect(await resolveWindowHours(kv)).toBe(24);
  });
});
