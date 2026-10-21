/**
 * 单元测试 - 订阅自动更新的「间隔小时」判定（v2.31.2）
 * 由「每天固定时刻（北京时间 0-23 点）」改为「每隔 N 小时」：0 = 不更新，1-24 = 间隔小时数。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isSubAutoUpdateDue, runScheduled } from '@/app';
import type { Env } from '@/app';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 26, 10, 0, 0);

describe('isSubAutoUpdateDue', () => {
  it('0 或非法值 = 不更新', () => {
    expect(isSubAutoUpdateDue(0, 0, NOW)).toBe(false);
    expect(isSubAutoUpdateDue(25, 0, NOW)).toBe(false);
    expect(isSubAutoUpdateDue(1.5, 0, NOW)).toBe(false);
    expect(isSubAutoUpdateDue(NaN, 0, NOW)).toBe(false);
  });

  it('从未更新过 → 立刻执行', () => {
    expect(isSubAutoUpdateDue(24, 0, NOW)).toBe(true);
  });

  it('未到间隔不执行，满间隔执行', () => {
    expect(isSubAutoUpdateDue(6, NOW - 5 * H, NOW)).toBe(false);
    expect(isSubAutoUpdateDue(6, NOW - 6 * H, NOW)).toBe(true);
  });

  it('整点 tick 差几十秒也算到点（否则 24 小时间隔会逐日漂移）', () => {
    expect(isSubAutoUpdateDue(24, NOW - 24 * H + 30_000, NOW)).toBe(true);
  });
});

describe('runScheduled - 订阅自动更新', () => {
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;
  const env = {} as Env;

  beforeEach(() => {
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
  });

  it('间隔设为 0 → 不更新，也不写时间戳', async () => {
    await repos.settings.set('sub_update_interval', '0');
    await runScheduled('0 * * * *', NOW, kv, env);
    expect(await repos.settings.get('sub_update_last_at')).toBeNull();
  });

  it('未到间隔 → 不更新', async () => {
    await repos.settings.set('sub_update_interval', '6');
    await repos.settings.set('sub_update_last_at', String(NOW - H));
    await runScheduled('0 * * * *', NOW, kv, env);
    expect(await repos.settings.get('sub_update_last_at')).toBe(String(NOW - H));
  });

  it('到点 → 执行并记录本次时刻', async () => {
    await repos.settings.set('sub_update_interval', '6');
    await repos.settings.set('sub_update_last_at', String(NOW - 7 * H));
    await runScheduled('0 * * * *', NOW, kv, env);
    expect(await repos.settings.get('sub_update_last_at')).toBe(String(NOW));
  });

  it('常规更新失败后，到重试时间只重试失败订阅且不推进常规更新时间', async () => {
    await repos.settings.set('sub_update_interval', '24');
    await repos.settings.set('sub_update_last_at', String(NOW - H));
    const failed = await repos.subscriptions.create({ name: 'failed', url: 'https://example.com/failed' });
    await repos.subscriptions.update(failed.id, {
      status: 'error', errorMessage: 'network down', retryCount: 1,
      nextRetryAt: NOW - 1, lastErrorAt: NOW - H,
    });
    const healthy = await repos.subscriptions.create({ name: 'healthy', url: 'https://example.com/healthy' });
    const called: string[] = [];

    await runScheduled('0 * * * *', NOW, kv, env, async (url) => {
      called.push(url);
      throw new Error('still offline');
    });

    expect(called).toEqual([failed.url]);
    expect((await repos.subscriptions.getById(failed.id))?.retryCount).toBe(2);
    expect((await repos.subscriptions.getById(failed.id))?.nextRetryAt).toBeGreaterThan(NOW);
    expect((await repos.subscriptions.getById(healthy.id))?.status).toBe('active');
    expect(await repos.settings.get('sub_update_last_at')).toBe(String(NOW - H));
  });

  it('超过三次自动重试后暂停，等待常规更新或手动操作', async () => {
    await repos.settings.set('sub_update_interval', '24');
    await repos.settings.set('sub_update_last_at', String(NOW - H));
    const failed = await repos.subscriptions.create({ name: 'failed', url: 'https://example.com/failed' });
    await repos.subscriptions.update(failed.id, { status: 'error', retryCount: 4, nextRetryAt: undefined });
    const fetcher = async () => { throw new Error('must not run'); };

    await runScheduled('0 * * * *', NOW, kv, env, fetcher);

    expect((await repos.subscriptions.getById(failed.id))?.retryCount).toBe(4);
  });
});
