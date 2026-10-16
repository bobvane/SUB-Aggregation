/**
 * P0 闭环审计 + P1（阶段 1）：节点可用性闭环
 *
 * 验证「节点健康检测 → dropped → Mihomo 配置生成」完整链路：
 * - A：系统判定不可用（statusMachine=disabled）的节点不得进入最终配置（proxies 与所有 proxy-groups）
 * - B：健康节点必须进入预期配置位置
 * - C：UDP 协议节点：P1 修复② 后不再按协议剔除，非锁定 UDP 节点进入自动配置；锁定语义不变
 * - 配置闭环：任何自动生成的 proxy-group 不得引用被系统判定不可用且无锁定语义的节点
 *
 * 注意：svc.generate('mihomo') 内部经 smartRename 自动重命名节点，
 * 因此最终配置中的 proxy name 不再是原始名（'A'/'B'/'C'），而是
 * 「[旗帜][国家] [协议]-NN」形式。断言用「节点指纹（server:port:protocol）是否出现在配置里」判定。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode, Node, nodeFingerprint } from '@/models/node';
import { createConfigService } from '@/services/config.service';
import { validateMihomo } from '@/generator/mihomo';
import { parseYaml } from '@/generator/yaml-serializer';

const fp = (n: Node) => nodeFingerprint(n);

function healthLatestJson(
  f: string,
  status: string,
  tcp: number | null,
  statusMachine?: 'active' | 'suspect' | 'disabled'
): string {
  return JSON.stringify({
    fingerprint: f,
    status,
    timestamp: Date.now(),
    tcpLatency: tcp,
    tlsLatency: null,
    score: status === 'dead' ? 0 : 50,
    ...(statusMachine ? { statusMachine } : {}),
  });
}

/** 解析生成的 Mihomo YAML，返回配置中出现的全部节点指纹（proxies 的 server:port:protocol）
 *  以及所有 proxy-group 引用的名字集合（用于断言被剔除节点不被引用）。 */
function configFingerprintsAndGroupRefs(yaml: string): { fps: Set<string>; groupRefs: Set<string> } {
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const proxies = (parsed.proxies as Array<Record<string, unknown>>) ?? [];
  const fps = new Set<string>();
  for (const p of proxies) {
    fps.add(`${String(p.server)}:${String(p.port)}:${String(p.type)}`);
  }
  const groups = (parsed['proxy-groups'] as Array<Record<string, unknown>>) ?? [];
  const groupRefs = new Set<string>();
  for (const g of groups) {
    const names = g.proxies as string[] | undefined;
    if (names) for (const n of names) groupRefs.add(n);
  }
  return { fps, groupRefs };
}

async function makeSvcWithNodes() {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  const A = createNode({ name: 'A', server: 'a.example.com', port: 443, protocol: 'vless', uuid: 'ua' });
  const B = createNode({ name: 'B', server: 'b.example.com', port: 443, protocol: 'vless', uuid: 'ub' });
  const C = createNode({ name: 'C', server: 'c.example.com', port: 443, protocol: 'hysteria2', password: 'pc' });
  await repos.nodes.setBySubscription('sub1', [A, B, C]);
  const svc = createConfigService(repos, kv);
  return { kv, repos, svc, A, B, C };
}

describe('P0 闭环：节点 A(disabled) / B(healthy) / C(UDP unknown) 进入 Mihomo 配置', () => {
  it('A：statusMachine=disabled 的节点不进入 proxies，也不被任何 proxy-group 引用', async () => {
    const { kv, svc, A, B } = await makeSvcWithNodes();
    // A 三轮确认失效 → 最新快照 statusMachine=disabled
    await kv.put('health:latest:' + fp(A), healthLatestJson(fp(A), 'dead', null, 'disabled'));
    // B 健康
    await kv.put('health:latest:' + fp(B), healthLatestJson(fp(B), 'alive', 100, 'active'));

    const nodes = await svc.getNodes();
    const names = nodes.map(n => n.name);
    expect(names).not.toContain('A');
    expect(names).toContain('B');

    // 完整生成 Mihomo 配置（走 getNodes → smartRename → generateMihomoConfig 真实链路）
    const yaml = await svc.generate('mihomo');
    expect(validateMihomo(yaml)).toBe(true);
    const { fps, groupRefs } = configFingerprintsAndGroupRefs(yaml);
    // A 的指纹不得出现在最终 proxies
    expect(fps.has(fp(A))).toBe(false);
    // B 的指纹必须出现
    expect(fps.has(fp(B))).toBe(true);
    // 任何自动生成的组都不应引用被剔除节点（精确匹配组名/节点名，非子串）
    expect(groupRefs.has('A')).toBe(false);
  });

  it('B：健康节点进入 proxies（指纹判定）', async () => {
    const { kv, svc, B } = await makeSvcWithNodes();
    await kv.put('health:latest:' + fp(B), healthLatestJson(fp(B), 'alive', 100, 'active'));
    const yaml = await svc.generate('mihomo');
    const { fps } = configFingerprintsAndGroupRefs(yaml);
    expect(fps.has(fp(B))).toBe(true);
  });

  it('C：UDP（hysteria2）节点进入自动配置（P1 修复②：不再按协议剔除，指纹判定）', async () => {
    const { svc, C } = await makeSvcWithNodes();
    const nodes = await svc.getNodes();
    // P1 修复②：UDP 基础探测不适用 ≠ 节点不可用，非锁定 UDP 节点进入自动配置
    expect(nodes.map(n => n.name)).toContain('C');
    // 指纹层面同样必须出现
    const yaml = await svc.generate('mihomo');
    const { fps } = configFingerprintsAndGroupRefs(yaml);
    expect(fps.has(fp(C))).toBe(true);
    // 且通过 mihomo 校验（hysteria2 协议字段映射完整）
    expect(validateMihomo(yaml)).toBe(true);
  });

  it('C + locked：锁定的 UDP 节点强制进配置（锁定语义优先，指纹判定）', async () => {
    const { svc, C } = await makeSvcWithNodes();
    await svc.setLockedNodes([fp(C)]);
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('C'); // 锁定豁免 UDP 过滤
    const yaml = await svc.generate('mihomo');
    const { fps } = configFingerprintsAndGroupRefs(yaml);
    expect(fps.has(fp(C))).toBe(true); // 锁定 UDP 节点进配置
  });

  it('完整闭环：A disabled + C locked + B healthy，最终配置 A 不出现、C 出现（锁定）、B 出现', async () => {
    const { kv, svc, A, B, C } = await makeSvcWithNodes();
    await kv.put('health:latest:' + fp(A), healthLatestJson(fp(A), 'dead', null, 'disabled'));
    await kv.put('health:latest:' + fp(B), healthLatestJson(fp(B), 'alive', 100, 'active'));
    await svc.setLockedNodes([fp(C)]);

    const yaml = await svc.generate('mihomo');
    expect(validateMihomo(yaml)).toBe(true);
    const { fps, groupRefs } = configFingerprintsAndGroupRefs(yaml);
    expect(fps.has(fp(A))).toBe(false); // 被剔除节点不进配置
    expect(fps.has(fp(B))).toBe(true);  // 健康节点进配置
    expect(fps.has(fp(C))).toBe(true);  // 锁定 UDP 节点进配置
    expect(groupRefs.has('A')).toBe(false);
  });
});

describe('P1（阶段 1）：慢节点不再仅因延迟被剔除（延迟 ≠ 失效）', () => {
  it('最新 normal（<=阈值）+ 历史中仅 1 条超阈值 → 保留（行为不变）', async () => {
    const { kv, repos, svc } = await makeSvcWithNodes();
    const S = createNode({ name: 'S', server: 's.example.com', port: 443, protocol: 'vless', uuid: 'us' });
    await repos.nodes.setBySubscription('sub1', [...(await repos.nodes.getAll()), S]);
    const f = fp(S);
    // 默认阈值 2000：latest=500（normal，不超），历史 3 条里 2500/300/2500
    const ts = [Date.now() - 3600_000, Date.now() - 3_600_000, Date.now() - 7_200_000];
    const lat = [2500, 300, 2500];
    for (let i = 0; i < 3; i++) {
      await kv.put('health:hist:' + f + ':' + ts[i], healthLatestJson(f, 'alive', lat[i]));
    }
    await kv.put('health:latest:' + f, healthLatestJson(f, 'alive', 500));
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('S'); // 保留
  });

  it('P1 修复③：最新超阈值 + 历史 2/3 超阈值 → 不再仅因延迟被剔除（保留）', async () => {
    const { kv, repos, svc } = await makeSvcWithNodes();
    const S = createNode({ name: 'S', server: 's.example.com', port: 443, protocol: 'vless', uuid: 'us' });
    await repos.nodes.setBySubscription('sub1', [...(await repos.nodes.getAll()), S]);
    const f = fp(S);
    // 阈值默认 2000：latest=2500（超），历史 3 条 2500/2500/2500（3 条超）
    // P1 修复③ 后：TCP/TLS 握手延迟不再作为剔除依据 → 节点保留
    const ts = [Date.now() - 3600_000, Date.now() - 3_600_000, Date.now() - 7_200_000];
    for (const t of ts) await kv.put('health:hist:' + f + ':' + t, healthLatestJson(f, 'alive', 2500));
    await kv.put('health:latest:' + f, healthLatestJson(f, 'alive', 2500));
    let nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).toContain('S'); // P1 修复③：延迟不再剔除 → 保留

    // 若状态机确认失效（statusMachine=disabled）→ 仍剔除（规则① 不变）
    await kv.put('health:latest:' + f, healthLatestJson(f, 'dead', null, 'disabled'));
    nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).not.toContain('S'); // 状态机确认失效 → 剔除
  });

  it('规则① 独立：statusMachine=disabled 的节点即使 latest 延迟正常（<=阈值）也剔除', async () => {
    const { kv, repos, svc } = await makeSvcWithNodes();
    const D = createNode({ name: 'D', server: 'd.example.com', port: 443, protocol: 'vless', uuid: 'ud' });
    await repos.nodes.setBySubscription('sub1', [...(await repos.nodes.getAll()), D]);
    const f = fp(D);
    // disabled（规则①），latest 延迟 100（不超阈值，规则② 本不触发）
    await kv.put('health:latest:' + f, healthLatestJson(f, 'dead', 100, 'disabled'));
    const nodes = await svc.getNodes();
    expect(nodes.map(n => n.name)).not.toContain('D'); // 规则① 独立剔除
  });
});
