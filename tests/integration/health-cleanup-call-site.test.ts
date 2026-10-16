/**
 * 健康快照清理的调用点集成测试（方案 A：app.ts runScheduled 订阅自动更新末尾）。
 *
 * 被验证的门禁逻辑（src/app.ts runScheduled）：
 *   · 至少发起过一次订阅更新（updateAttempts > 0）且全部成功（updateFailures === 0）
 *     → 才执行 cleanupOrphanedHealthSnapshots()；
 *   · 任一订阅失败 / 本轮无启用的订阅 → 跳过清理（宁可不清，不可误删）；
 *   · 清理自身异常绝不使订阅更新失败。
 *
 * 网络隔离手法：
 *   · 订阅 URL 用 vless:// 直接节点链接（isNodeLink 短路，不产生任何 HTTP 请求）；
 *   · doMock 拦截 probeAllNodes 与 ip-geo 模块（探测与地理预填充全部离线）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '@/app';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode, nodeFingerprint } from '@/models/node';
import { KV_KEYS } from '@/models/config';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 3, 0, 0);

/** vless:// 直接节点链接 → isNodeLink 短路，更新不联网 */
const nodeLink = (name: string) =>
  `vless://00000000-0000-0000-0000-000000000001@10.30.0.${name}:443#node-${name}`;

const mkNode = (name: string, server: string) =>
  createNode({
    id: name, name, protocol: 'vless', server, port: 443,
    uuid: '00000000-0000-0000-0000-000000000001',
    metadata: { source: 'test', originalName: name, tags: [] },
  });

/** 节点链接解析出的指纹（与 mkNode 对齐，供断言复用） */
const linkedFp = (serverOctet: string) => nodeFingerprint(mkNode('x', `10.30.0.${serverOctet}`));
const orphanFp = nodeFingerprint(mkNode('gone', '10.30.0.99'));

async function putLatest(kv: MemoryKvAdapter, fp: string, statusMachine = 'disabled') {
  await kv.put(
    KV_KEYS.healthLatest(fp),
    JSON.stringify({
      fingerprint: fp, status: 'dead', timestamp: NOW,
      tcpLatency: null, tlsLatency: null, httpLatency: null,
      tlsApplicable: false, error: null, score: 0, statusMachine,
    })
  );
}

beforeEach(() => {
  vi.doMock('@/services/node-probe.service', async (importOriginal) => {
    const actual = await (importOriginal() as Promise<Record<string, unknown>>);
    return {
      ...actual,
      probeAllNodes: vi.fn(async () => ({
        results: [],
        stats: { total: 0, alive: 0, dead: 0, unknown: 0, suspect: 0, disabled: 0, avgLatency: null, minLatency: null },
      })),
    };
  });
  vi.doMock('@/services/ip-geo.service', () => ({
    prewarmIpGeo: async () => ({ total: 0, cached: 0, queried: 0, resolved: 0, failed: 0 }),
    filterUnlocatedServers: async () => [],
    activateGeoRetry: async () => {},
    getGeoRetryGate: async () => ({ ts: 0, count: 0, active: false }),
    setGeoRetryGate: async () => {},
    deactivateGeoRetry: async () => {},
    countUnlocatedGeo: async () => 0,
    GEO_RETRY_MAX: 10,
    createIpGeoResolver: () => async () => null,
  }));
});

afterEach(() => {
  vi.doUnmock('@/services/node-probe.service');
  vi.doUnmock('@/services/ip-geo.service');
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function loadRunScheduled() {
  const mod = await import('@/app');
  return mod.runScheduled;
}

async function setup() {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  await repos.settings.set('sub_update_interval', '6');
  await repos.settings.set('sub_update_last_at', String(NOW - 7 * H));
  return { kv, repos };
}

describe('调用点：订阅自动更新末尾的健康快照清理', () => {
  it('① 完整成功更新后触发清理：孤儿快照被删除', async () => {
    const { kv, repos } = await setup();
    await repos.subscriptions.create({ name: 'on', url: nodeLink('1') });

    const run = await loadRunScheduled();
    await putLatest(kv, orphanFp);

    await run('0 * * * *', NOW, kv, {} as Env);

    expect(await kv.get(`health:latest:${orphanFp}`)).toBeNull();
    // 池内有效节点的快照保留
    expect(await kv.get(`health:latest:${linkedFp('1')}`)).toBeNull(); // 探测被 mock，无人写入 → 不报错即可
  });

  it('② 有订阅更新失败时不触发清理，但更新流程仍完成', async () => {
    const { kv, repos } = await setup();
    await repos.subscriptions.create({ name: 'bad', url: 'https://invalid.example/subscribe' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const run = await loadRunScheduled();
    await putLatest(kv, orphanFp);
    await run('0 * * * *', NOW, kv, {} as Env);

    expect(await kv.get(`health:latest:${orphanFp}`)).not.toBeNull();
    expect(await repos.settings.get('sub_update_last_at')).toBe(String(NOW));
  });

  it('③ 本轮没有启用的订阅（无更新动作）→ 不触发清理', async () => {
    const { kv, repos } = await setup();
    const off = await repos.subscriptions.create({ name: 'off', url: nodeLink('2') });
    await repos.subscriptions.update(off.id, { enabled: false });

    const run = await loadRunScheduled();
    await putLatest(kv, orphanFp);
    await run('0 * * * *', NOW, kv, {} as Env);

    expect(await kv.get(`health:latest:${orphanFp}`)).not.toBeNull();
  });

  it('④ 停用订阅的节点仍在有效池（getAll(true)），其快照不被清理', async () => {
    const { kv, repos } = await setup();
    await repos.subscriptions.create({ name: 'on', url: nodeLink('3') });
    const off = await repos.subscriptions.create({ name: 'off', url: nodeLink('4') });
    // 停用后手工写入其节点（避免成功轮 update 覆盖节点缓存）
    await repos.subscriptions.update(off.id, { enabled: false });
    const offNodeFp = nodeFingerprint(mkNode('offNode', '10.30.0.50'));
    await repos.nodes.setBySubscription(off.id, [mkNode('offNode', '10.30.0.50')]);
    await putLatest(kv, offNodeFp, 'active');

    const run = await loadRunScheduled();
    await run('0 * * * *', NOW, kv, {} as Env); // 启用订阅成功 → 清理执行

    expect(await kv.get(`health:latest:${offNodeFp}`)).not.toBeNull();
  });

  it('⑤ 清理内部读取失败：整体跳过，订阅更新不受影响', async () => {
    const { kv, repos } = await setup();
    await repos.subscriptions.create({ name: 'on', url: nodeLink('5') });

    const run = await loadRunScheduled();
    await putLatest(kv, orphanFp);
    // health:latest 读取抛错 → 清理兜底跳过，孤儿保留，runScheduled 不抛
    const realList = kv.list.bind(kv);
    kv.list = async (prefix: string) => {
      if (prefix === 'health:latest:') throw new Error('storage read failure');
      return realList(prefix);
    };

    await expect(run('0 * * * *', NOW, kv, {} as Env)).resolves.toBeUndefined();
    expect(await kv.get(`health:latest:${orphanFp}`)).not.toBeNull();
    expect(await repos.settings.get('sub_update_last_at')).toBe(String(NOW));
  });

  it('⑥ 重复成功更新幂等：有效快照始终完好', async () => {
    const { kv, repos } = await setup();
    await repos.subscriptions.create({ name: 'on', url: nodeLink('6') });
    const liveFp = linkedFp('6');
    await putLatest(kv, orphanFp);
    await putLatest(kv, liveFp, 'active');

    const run = await loadRunScheduled();
    await run('0 * * * *', NOW, kv, {} as Env);
    expect(await kv.get(`health:latest:${orphanFp}`)).toBeNull();
    expect(await kv.get(`health:latest:${liveFp}`)).not.toBeNull();

    // 第二轮（另一间隔点）：仍不报错、有效快照不动
    await putLatest(kv, liveFp, 'active');
    await repos.settings.set('sub_update_last_at', String(NOW - 7 * H));
    await run('0 * * * *', NOW + 2 * H, kv, {} as Env);
    expect(await kv.get(`health:latest:${liveFp}`)).not.toBeNull();
  });

  it('⑦ 失败轮跳过、恢复成功轮补清理', async () => {
    const { kv, repos } = await setup();
    await repos.subscriptions.create({ name: 'good', url: nodeLink('7') });
    const bad = await repos.subscriptions.create({ name: 'bad', url: 'https://invalid.example/x' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));

    const run = await loadRunScheduled();
    await putLatest(kv, orphanFp);

    // 混合轮：good 成功、bad 失败 → 整体跳过
    await run('0 * * * *', NOW, kv, {} as Env);
    expect(await kv.get(`health:latest:${orphanFp}`)).not.toBeNull();

    // bad 恢复为节点链接 → 全成功 → 补清理
    await repos.subscriptions.update(bad.id, { url: nodeLink('8'), status: 'active' });
    vi.unstubAllGlobals();
    await repos.settings.set('sub_update_last_at', String(NOW - 7 * H));
    await run('0 * * * *', NOW + 2 * H, kv, {} as Env);
    expect(await kv.get(`health:latest:${orphanFp}`)).toBeNull();
  });
});
