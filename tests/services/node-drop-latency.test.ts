/**
 * v2.36.6：慢节点抛弃 —— 测活延迟超过设置阈值（node_drop_latency_ms，100-2000，默认 2000）
 * 的节点进入 getDroppedNodes（即不写入生成的配置），dead 节点不受阈值影响恒抛弃。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { KV_KEYS } from '@/models/config';
import { createConfigService } from '@/services/config.service';

const putHealth = (kv: MemoryKvAdapter, fp: string, status: string, tcpLatency: number | null) =>
  kv.put(KV_KEYS.healthLatest(fp), JSON.stringify({
    fingerprint: fp, status, timestamp: Date.now(),
    tcpLatency, tlsLatency: null, score: 50,
  }));

describe('getDroppedNodes 慢节点抛弃阈值', () => {
  it('默认阈值 2000：延迟 2500 抛弃、1500 保留', async () => {
    const kv = new MemoryKvAdapter();
    await putHealth(kv, 'slow', 'alive', 2500);
    await putHealth(kv, 'ok', 'alive', 1500);
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain('slow');
    expect(dropped).not.toContain('ok');
  });

  it('用户调低阈值（如 500）：延迟 800 也抛弃', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '500');
    await putHealth(kv, 'slow800', 'alive', 800);
    await putHealth(kv, 'ok400', 'alive', 400);
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain('slow800');
    expect(dropped).not.toContain('ok400');
  });

  it('dead 节点无论延迟多低都抛弃；非法阈值回退 2000', async () => {
    const kv = new MemoryKvAdapter();
    await kv.put(KV_KEYS.setting('node_drop_latency_ms'), '99999'); // 越界 → 回退 2000
    await putHealth(kv, 'dead-fast', 'dead', 50);
    await putHealth(kv, 'alive-2100', 'alive', 2100);
    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain('dead-fast');
    expect(dropped).toContain('alive-2100');
  });
});
