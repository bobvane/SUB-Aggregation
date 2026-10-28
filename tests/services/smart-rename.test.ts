/**
 * 自动命名稳定性回归。
 *
 * 旧实现按过滤后的全局数组下标编号：新增/移除任意国家的节点都会让所有名字重排，
 * OpenClash 会把同一节点当成新节点（之前的选择与测速记录失效）。
 * 新行为：每个国家独立编号，组内按 server:port:protocol 排序。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { Node } from '@/models/node';
import { countryDisplayName } from '@/data/country-codes';

function makeNode(name: string, server: string, protocol: Node['protocol'] = 'vless'): Node {
  return {
    id: server,
    name,
    protocol,
    server,
    port: 443,
    metadata: { source: 'test', originalName: name, tags: [] },
    version: 1,
  } as Node;
}

describe('smartRename 每个国家独立编号', () => {
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;

  beforeEach(() => {
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
  });

  async function seedGeo(servers: string[], code: string) {
    for (const server of servers) {
      await repos.settings.set(`ip_geo:${server}`, `${Date.now()}|${countryDisplayName(code)}`);
    }
  }

  it('美国节点编号不受其他国家节点数量影响', async () => {
    const caServers = Array.from({ length: 12 }, (_, i) => `ca-${String(i).padStart(2, '0')}.example.com`);
    await seedGeo(caServers, 'CA');
    await seedGeo(['hk-1.example.com', 'hk-2.example.com'], 'HK');
    await seedGeo(['us-1.example.com'], 'US');

    const base = [
      ...caServers.map((s) => makeNode(s, s)),
      makeNode('hk-1', 'hk-1.example.com'),
      makeNode('hk-2', 'hk-2.example.com'),
      makeNode('us-1', 'us-1.example.com'),
    ];

    const service = createConfigService(repos, kv);
    const first = await service.autoNamed(base.map((n) => ({ ...n })));
    const usFirst = first.find((n) => n.server === 'us-1.example.com')!;
    expect(usFirst.name).toBe('🇺🇸 US VLESS-01');
    expect(first.find((n) => n.server === 'hk-1.example.com')!.name).toBe('🇭🇰 HK VLESS-01');

    // 再增加更多 CA/HK 节点（不含新的美国节点）→ 美国仍为 01
    const moreCa = Array.from({ length: 20 }, (_, i) => `new-ca-${i}.example.com`);
    await seedGeo(moreCa, 'CA');
    await seedGeo(['hk-3.example.com'], 'HK');
    const expanded = [
      ...moreCa.map((s) => makeNode(s, s)),
      ...base,
      makeNode('hk-3', 'hk-3.example.com'),
    ];
    const second = await service.autoNamed(expanded.map((n) => ({ ...n })));
    expect(second.find((n) => n.server === 'us-1.example.com')!.name).toBe('🇺🇸 US VLESS-01');
  });

  it('同一国家内按 server:port:protocol 排序编号，与数组顺序无关', async () => {
    await seedGeo(['hk-z.example.com', 'hk-a.example.com'], 'HK');
    const service = createConfigService(repos, kv);

    const nodes = [
      makeNode('z', 'hk-z.example.com'),
      makeNode('a', 'hk-a.example.com'),
    ];
    const named = await service.autoNamed(nodes);
    expect(named[0].name).toBe('🇭🇰 HK VLESS-02'); // z 排序在后，但输出顺序不变
    expect(named[1].name).toBe('🇭🇰 HK VLESS-01'); // a 排序在前
  });

  it('锁定节点在本国组内优先拿小号', async () => {
    await seedGeo(['hk-a.example.com', 'hk-z.example.com'], 'HK');
    await repos.settings.set(
      'locked_nodes',
      JSON.stringify(['hk-z.example.com:443:vless'])
    );
    const service = createConfigService(repos, kv);

    const nodes = [
      makeNode('a', 'hk-a.example.com'),
      makeNode('z', 'hk-z.example.com'),
    ];
    const named = await service.autoNamed(nodes);
    // z 锁定 → 01；未锁定的 a 顺延为 02（输出顺序仍保持入参数组顺序）
    expect(named[0].name).toBe('🇭🇰 HK VLESS-02');
    expect(named[1].name).toBe('🇭🇰 HK VLESS-01');
  });
});
