import { describe, it, expect, vi } from 'vitest';
import { SqliteAdapter } from '@/storage/sqlite';
import { createRepositories } from '@/storage/kv';

/**
 * SqliteAdapter —— NAS / Docker 运行时的存储实现
 * 契约与 CF 的 KvAdapter 完全一致，仓储层无感知。
 */
describe('SqliteAdapter', () => {
  const make = () => new SqliteAdapter(':memory:');

  it('put / get 往返，缺失键返回 null', async () => {
    const kv = make();
    await kv.put('admin:hash', '{"hash":"h"}');
    expect(await kv.get('admin:hash')).toBe('{"hash":"h"}');
    expect(await kv.get('nope')).toBeNull();
  });

  it('重复 put 为覆盖写（upsert）', async () => {
    const kv = make();
    await kv.put('k', 'old');
    await kv.put('k', 'new');
    expect(await kv.get('k')).toBe('new');
    expect((await kv.list('k')).length).toBe(1);
  });

  it('delete 后不可见', async () => {
    const kv = make();
    await kv.put('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
    expect(await kv.list('k')).toEqual([]);
  });

  it('list 按前缀精确匹配：下划线是普通字符，不当通配符', async () => {
    const kv = make();
    await kv.put('a_b:1', 'x');
    await kv.put('aXb:1', 'y'); // LIKE 'a_b:%' 会误命中这一条
    expect((await kv.list('a_b:')).map((e) => e.key)).toEqual(['a_b:1']);
    expect((await kv.list('aXb:')).map((e) => e.key)).toEqual(['aXb:1']);
  });

  it('list 以前缀范围精确匹配百分号、Unicode 和空前缀', async () => {
    const kv = make();
    await kv.put('ip%:1', 'a');
    await kv.put('ipX:1', 'b');
    await kv.put('节点:1', 'c');
    await kv.put('节杠:1', 'd');
    expect((await kv.list('ip%:')).map((e) => e.key)).toEqual(['ip%:1']);
    expect((await kv.list('节点:')).map((e) => e.key)).toEqual(['节点:1']);
    expect((await kv.list('')).map((e) => e.key)).toEqual(['ip%:1', 'ipX:1', '节杠:1', '节点:1']);
  });

  it('list 按 key 升序、不含过期键', async () => {
    const kv = make();
    await kv.put('nodes:b', 'b');
    await kv.put('nodes:a', 'a');
    await kv.put('other', 'o');
    expect((await kv.list('nodes:')).map((e) => e.key)).toEqual(['nodes:a', 'nodes:b']);
  });

  it('getMany 超过 100 键自动分批', async () => {
    const kv = make();
    const keys = Array.from({ length: 150 }, (_, i) => `k:${i}`);
    for (const k of keys) await kv.put(k, `v-${k}`);
    const got = await kv.getMany([...keys, 'missing']);
    expect(got.size).toBe(151);
    expect(got.get('k:149')).toBe('v-k:149');
    expect(got.get('missing')).toBeNull();
  });

  it('expirationTtl 到期后 get 与 list 均不可见', async () => {
    vi.useFakeTimers();
    try {
      const kv = make();
      await kv.put('session:1', 'v', { expirationTtl: 60 });
      expect(await kv.get('session:1')).toBe('v');
      vi.setSystemTime(Date.now() + 61_000);
      expect(await kv.get('session:1')).toBeNull();
      expect(await kv.list('session:')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('仓储层可直接复用（KVStorage 契约一致，业务代码零改动）', async () => {
    const kv = make();
    const repos = createRepositories(kv);
    const sub = await repos.subscriptions.create({ name: 'n', url: 'https://example.com/sub' });
    expect((await repos.subscriptions.list()).map((s) => s.id)).toEqual([sub.id]);
    await repos.settings.set('sub_update_interval', '7');
    expect(await repos.settings.get('sub_update_interval')).toBe('7');
  });
});
