/**
 * 测试 - CF 请求统计（v2.18.0）
 * 覆盖：fetchCfUsage 的 GraphQL 请求/解析/错误分支 + config.service 的账户 CRUD/上限
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { fetchCfUsage, CF_USAGE_LIMIT } from '@/services/cf-usage.service';

function makeFetch(mock: () => unknown) {
  return (async (_url: string) => {
    return { ok: true, json: async () => mock() };
  }) as unknown as typeof fetch;
}

function makeErrorFetch() {
  return (async () => {
    return { ok: false, status: 403, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe('fetchCfUsage', () => {
  it('解析 pages + workers 请求数合计', async () => {
    const fetcher = makeFetch(() => ({
      data: {
        viewer: {
          accounts: [{
            pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 120 } }],
            workersInvocationsAdaptive: [{ sum: { requests: 80 } }],
          }],
        },
      },
    }));
    const r = await fetchCfUsage('acct1', 'token-x', fetcher);
    expect(r.success).toBe(true);
    expect(r.pages).toBe(120);
    expect(r.workers).toBe(80);
    expect(r.total).toBe(200);
    expect(r.max).toBe(100000);
  });

  it('无数据返回 0，不崩', async () => {
    const fetcher = makeFetch(() => ({ data: { viewer: { accounts: [{}] } } }));
    const r = await fetchCfUsage('acct1', 'token-x', fetcher);
    expect(r.total).toBe(0);
  });

  it('HTTP 非 ok 抛错', async () => {
    await expect(fetchCfUsage('acct1', 't', makeErrorFetch())).rejects.toThrow();
  });

  it('GraphQL errors 抛首条 message', async () => {
    const fetcher = makeFetch(() => ({ errors: [{ message: 'Invalid token' }] }));
    await expect(fetchCfUsage('a', 'bad', fetcher)).rejects.toThrow('Invalid token');
  });
});

describe('CFUsageAccount CRUD（config.service）', () => {
  it('新增/读取，token 与 accountId 正确持久化', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);

    const created = await svc.upsertCFUsageAccount({ name: '主站', accountId: 'abc123', apiToken: 'secret-token' });
    expect(created.id).toBeTruthy();
    expect(created.apiToken).toBe('secret-token');
    expect(created.name).toBe('主站');

    const list = await svc.getCFUsageAccounts();
    expect(list.length).toBe(1);
    expect(list[0].apiToken).toBe('secret-token');
    expect(list[0].accountId).toBe('abc123');
  });

  it('达到上限 3 后新增抛错', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);
    for (let i = 1; i <= CF_USAGE_LIMIT; i++) {
      await svc.upsertCFUsageAccount({ name: `账户${i}`, accountId: `a${i}`, apiToken: `t${i}` });
    }
    await expect(
      svc.upsertCFUsageAccount({ name: '第4个', accountId: 'a4', apiToken: 't4' })
    ).rejects.toThrow(/最多可添加 3 个/);
  });

  it('编辑时 apiToken 留空保留原值', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);
    const created = await svc.upsertCFUsageAccount({ name: 'A', accountId: 'acc', apiToken: 'tok-1' });
    await svc.upsertCFUsageAccount({ id: created.id, name: 'A2', accountId: created.accountId });
    const list = await svc.getCFUsageAccounts();
    expect(list[0].name).toBe('A2');
    expect(list[0].apiToken).toBe('tok-1');
  });

  it('删除账户后列表为空', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);
    const created = await svc.upsertCFUsageAccount({ name: 'X', accountId: 'x1', apiToken: 'tk' });
    await svc.deleteCFUsageAccount(created.id);
    expect(await svc.getCFUsageAccounts()).toEqual([]);
  });
});