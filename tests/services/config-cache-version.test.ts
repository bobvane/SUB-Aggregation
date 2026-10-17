import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter } from '@/storage/kv';
import { createSnapshotCache } from '@/services/config-cache.service';

/**
 * v2.35.1 回归：App 升级必须让配置快照失效。
 *
 * 线上故障：config_version 只随数据变更自增，升级镜像后旧快照的 version 仍匹配，
 * 于是新代码被跳过、用户拿到的还是旧代码生成的配置（节点名没自动命名）。
 */
describe('配置快照缓存 × App 版本', () => {
  it('升级 App 版本后旧快照不再命中（同一 config_version 也算 miss）', async () => {
    const kv = new MemoryKvAdapter();

    const old = createSnapshotCache(kv, '2.32.0');
    await old.setCachedConfig('mihomo', 'proxies: []  # 旧镜像产物', await old.getVersion());
    expect((await old.getCachedConfig('mihomo'))?.content).toContain('旧镜像产物');

    const fresh = createSnapshotCache(kv, '2.35.0');
    expect(await fresh.getCachedConfig('mihomo')).toBeNull();
  });

  it('v2.38.6：用旧版本写回不会污染新版本（避免旧内容盖上新版本）', async () => {
    const kv = new MemoryKvAdapter();
    const cache = createSnapshotCache(kv, '2.38.6');

    const captured = await cache.getVersion(); // 生成开始时的版本
    await cache.incrementVersion();            // 生成期间有更新推进了版本

    await cache.setCachedConfig('mihomo', 'proxies: []  # 基于旧数据生成', captured);
    // 当前版本键仍是空的 → 下一次请求必须重新生成
    expect(await cache.getCachedConfig('mihomo')).toBeNull();
    expect(await cache.peek('mihomo')).toBeNull();
  });

  it('peek 只读当前版本快照，不生成、不改变版本', async () => {
    const kv = new MemoryKvAdapter();
    const cache = createSnapshotCache(kv, '2.38.6');
    expect(await cache.peek('mihomo')).toBeNull();
    const v = await cache.getVersion();
    await cache.setCachedConfig('mihomo', 'x', v);
    const snap = await cache.peek('mihomo');
    expect(snap?.version).toBe(v);
    expect(snap?.generatedAt).toBeGreaterThan(0);
    expect(await cache.getVersion()).toBe(v);
  });

  it('同版本内数据变更（config_version 自增）依旧失效', async () => {
    const kv = new MemoryKvAdapter();
    const cache = createSnapshotCache(kv, '2.35.0');
    await cache.setCachedConfig('mihomo', 'x', await cache.getVersion());
    expect(await cache.getCachedConfig('mihomo')).not.toBeNull();

    await cache.incrementVersion();
    expect(await cache.getCachedConfig('mihomo')).toBeNull();
  });
});
