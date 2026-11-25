/**
 * 输出国家组（v2.48）回归：
 * - 空选择 = 不过滤，全部保留
 * - 非空选择 = 只保留白名单国家；未识别国家默认排除
 * - 锁定节点强制进配置（豁免国家过滤）
 * - outputStatus 的 excluded.country 与 generate() 同口径
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { createConfigService } from '@/services/config.service';
import { countryDisplayName } from '@/data/country-codes';

const mk = (server: string, port = 443): Node =>
  createNode({
    id: server,
    name: server,
    protocol: 'vless',
    server,
    port,
    metadata: { source: 'test', originalName: server, tags: [] },
  } as Partial<Node> & { name: string });

async function seedGeo(
  repos: ReturnType<typeof createRepositories>,
  map: Record<string, string>
) {
  const ts = Date.now();
  for (const [server, code] of Object.entries(map)) {
    await repos.settings.set('ip_geo:' + server, `${ts}|${countryDisplayName(code)}`);
  }
}

async function setup(nodes: Node[], geo: Record<string, string>) {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  await repos.nodes.setBySubscription('sub-1', nodes);
  await seedGeo(repos, geo);
  const svc = createConfigService(repos, kv);
  return { kv, repos, svc };
}

describe('输出国家组：generate() 过滤', () => {
  beforeEach(() => {
    // 未识别国家的节点会走 batchQuery：桩掉外网，返回空结果
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('空选择 = 不过滤，全部国家进配置', async () => {
    const { svc } = await setup(
      [mk('hk.example.com'), mk('ar.example.com')],
      { 'hk.example.com': 'HK', 'ar.example.com': 'AR' }
    );
    expect(await svc.getOutputCountries()).toEqual([]);
    const yaml = await svc.generate('mihomo');
    expect(yaml).toContain('hk.example.com');
    expect(yaml).toContain('ar.example.com');
  });

  it('非空选择 = 只保留白名单国家', async () => {
    const { svc } = await setup(
      [mk('hk.example.com'), mk('ar.example.com'), mk('jp.example.com')],
      { 'hk.example.com': 'HK', 'ar.example.com': 'AR', 'jp.example.com': 'JP' }
    );
    await svc.setOutputCountries(['HK']);
    const yaml = await svc.generate('mihomo');
    expect(yaml).toContain('hk.example.com');
    expect(yaml).not.toContain('ar.example.com');
    expect(yaml).not.toContain('jp.example.com');
  });

  it('未识别国家的节点默认排除（白名单非空时）', async () => {
    const { svc } = await setup(
      [mk('hk.example.com'), mk('unknown.example.com')],
      { 'hk.example.com': 'HK' }
    );
    await svc.setOutputCountries(['HK']);
    const yaml = await svc.generate('mihomo');
    expect(yaml).toContain('hk.example.com');
    expect(yaml).not.toContain('unknown.example.com');
  });

  it('锁定节点即使国家未启用也强制进配置', async () => {
    const ar = mk('ar.example.com');
    const { svc } = await setup(
      [mk('hk.example.com'), ar],
      { 'hk.example.com': 'HK', 'ar.example.com': 'AR' }
    );
    await svc.setOutputCountries(['HK']);
    await svc.setLockedNodes([nodeFingerprint(ar)]);
    const yaml = await svc.generate('mihomo');
    expect(yaml).toContain('hk.example.com');
    expect(yaml).toContain('ar.example.com');
  });

  it('setOutputCountries 去重、大写并过滤非法码', async () => {
    const { svc } = await setup([mk('hk.example.com')], { 'hk.example.com': 'HK' });
    await svc.setOutputCountries(['hk', 'HK', 'ZZ', 'jp']);
    expect(await svc.getOutputCountries()).toEqual(['HK', 'JP']);
  });
});

describe('输出国家组：outputStatus 统计', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('excluded.country 统计被国家过滤排除的节点', async () => {
    const { svc } = await setup(
      [mk('hk.example.com'), mk('ar.example.com'), mk('unknown.example.com')],
      { 'hk.example.com': 'HK', 'ar.example.com': 'AR' }
    );
    await svc.setOutputCountries(['HK']);
    const s = await svc.outputStatus();
    expect(s.nodes.inOutput).toBe(1);
    expect(s.nodes.excluded.country).toBe(2);
  });

  it('空选择时 excluded.country 为 0', async () => {
    const { svc } = await setup(
      [mk('hk.example.com'), mk('ar.example.com')],
      { 'hk.example.com': 'HK', 'ar.example.com': 'AR' }
    );
    const s = await svc.outputStatus();
    expect(s.nodes.inOutput).toBe(2);
    expect(s.nodes.excluded.country).toBe(0);
  });

  it('锁定节点计入 inOutput，不进入 excluded.country', async () => {
    const ar = mk('ar.example.com');
    const { svc } = await setup(
      [mk('hk.example.com'), ar],
      { 'hk.example.com': 'HK', 'ar.example.com': 'AR' }
    );
    await svc.setOutputCountries(['HK']);
    await svc.setLockedNodes([nodeFingerprint(ar)]);
    const s = await svc.outputStatus();
    expect(s.nodes.inOutput).toBe(2);
    expect(s.nodes.excluded.country).toBe(0);
  });
});
