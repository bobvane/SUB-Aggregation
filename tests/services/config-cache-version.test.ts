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

  it('同版本内数据变更（config_version 自增）依旧失效', async () => {
    const kv = new MemoryKvAdapter();
    const cache = createSnapshotCache(kv, '2.35.0');
    await cache.setCachedConfig('mihomo', 'x', await cache.getVersion());
    expect(await cache.getCachedConfig('mihomo')).not.toBeNull();

    await cache.incrementVersion();
    expect(await cache.getCachedConfig('mihomo')).toBeNull();
  });
});
