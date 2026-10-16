/**
 * 阶段 2：TUIC 独立节点配置生成闭环。
 *
 * 现有 tests/parser/tuic.test.ts 只覆盖 URI 解析，**不等于配置闭环**。
 * 本测试使用独立 TUIC 节点（不依赖其他协议间接覆盖），验证完整链路：
 *
 *   TUIC 节点输入 → getNodes() → generate('mihomo') → validateMihomo() → 配置指纹 + 协议字段
 *
 * 注意：`validateMihomo`（src/generator/mihomo.ts:769）只校验 YAML 可解析且
 * `proxies` 是数组，**不校验任何协议字段**，因此 TUIC 关键字段必须单独断言。
 *
 * 边界：不修改冻结的协议映射（src/generator/mihomo.ts case 'tuic'）、
 * 不改 DNS 防泄漏规则、不改代理组结构。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { createConfigService } from '@/services/config.service';
import { isProbeApplicable } from '@/services/node-probe.service';
import { validateMihomo } from '@/generator/mihomo';
import { parseYaml } from '@/generator/yaml-serializer';

const TUIC_V5: Node = createNode({
  id: 'n-tuic-v5',
  name: 'TUIC-V5',
  protocol: 'tuic',
  server: 'tuic5.example.com',
  port: 10443,
  uuid: '00000000-0000-0000-0000-000000000001',
  password: 'pass-v5',
  sni: 'tuic5.example.com',
  udpRelayMode: 'native',
  congestionController: 'bbr',
  metadata: { source: 'test', originalName: 'TUIC-V5', tags: [] },
});

const TUIC_V4: Node = createNode({
  id: 'n-tuic-v4',
  name: 'TUIC-V4',
  protocol: 'tuic',
  server: 'tuic4.example.com',
  port: 10444,
  token: 'token-v4',
  sni: 'tuic4.example.com',
  disableSni: true,
  reduceRtt: true,
  metadata: { source: 'test', originalName: 'TUIC-V4', tags: [] },
});

async function setup(nodes: Node[]) {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  await repos.nodes.setBySubscription('sub-tuic', nodes);
  const svc = createConfigService(repos, kv);
  return { kv, repos, svc };
}

/** 解析生成的 Mihomo YAML，取出全部 proxies 与指定 server:port 的代理项 */
function parseProxies(yaml: string): Array<Record<string, unknown>> {
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  return (parsed.proxies as Array<Record<string, unknown>>) ?? [];
}

const findProxy = (yaml: string, server: string, port: number) =>
  parseProxies(yaml).find((p) => p.server === server && p.port === port);

describe('TUIC 独立节点闭环：getNodes → generate(mihomo) → validateMihomo', () => {
  it('TUIC 属于 UDP 基础探测不适用协议（不因此被剔除配置）', () => {
    expect(isProbeApplicable('tuic')).toBe(false);
  });

  it('TUIC V5（uuid + password）：进入 getNodes 与最终配置，关键字段完整', async () => {
    const { svc } = await setup([TUIC_V5]);

    // ① getNodes() 保留 TUIC 节点（UDP 不适用 ≠ 不可用）
    const nodes = await svc.getNodes();
    expect(nodes.map((n) => nodeFingerprint(n))).toContain(nodeFingerprint(TUIC_V5));

    // ② 生成 Mihomo 配置并通过校验
    const yaml = await svc.generate('mihomo');
    expect(validateMihomo(yaml)).toBe(true);

    // ③ 配置指纹：必须能按 server:port:type 定位到该节点
    const proxy = findProxy(yaml, TUIC_V5.server, TUIC_V5.port);
    expect(proxy).toBeDefined();

    // ④ 协议字段断言（依据 src/generator/mihomo.ts case 'tuic'）
    expect(proxy!.type).toBe('tuic');
    expect(proxy!.uuid).toBe(TUIC_V5.uuid);
    expect(proxy!.password).toBe('pass-v5');
    expect(proxy!.tls).toBe(true); // case 'tuic' 恒置 tls=true
    expect(proxy!.sni).toBe('tuic5.example.com');
    expect(proxy!['udp-relay-mode']).toBe('native');
    expect(proxy!['congestion-controller']).toBe('bbr');
    // V5 分支不得混入 V4 的 token
    expect(proxy!.token).toBeUndefined();
  });

  it('TUIC V4（token）：进入最终配置，token 分支不写入 uuid/password', async () => {
    const { svc } = await setup([TUIC_V4]);

    const nodes = await svc.getNodes();
    expect(nodes.map((n) => nodeFingerprint(n))).toContain(nodeFingerprint(TUIC_V4));

    const yaml = await svc.generate('mihomo');
    expect(validateMihomo(yaml)).toBe(true);

    const proxy = findProxy(yaml, TUIC_V4.server, TUIC_V4.port);
    expect(proxy).toBeDefined();
    expect(proxy!.type).toBe('tuic');
    expect(proxy!.token).toBe('token-v4');
    expect(proxy!.tls).toBe(true);
    expect(proxy!.sni).toBe('tuic4.example.com');
    expect(proxy!['disable-sni']).toBe(true);
    expect(proxy!['reduce-rtt']).toBe(true);
    // V4 分支不得写入 uuid/password
    expect(proxy!.uuid).toBeUndefined();
    expect(proxy!.password).toBeUndefined();
  });

  it('V4 与 V5 同时存在：两条指纹各自独立出现、互不覆盖', async () => {
    const { svc } = await setup([TUIC_V5, TUIC_V4]);

    const yaml = await svc.generate('mihomo');
    expect(validateMihomo(yaml)).toBe(true);

    const proxies = parseProxies(yaml);
    const fps = new Set(proxies.map((p) => `${String(p.server)}:${String(p.port)}:${String(p.type)}`));
    expect(fps.has(nodeFingerprint(TUIC_V5))).toBe(true);
    expect(fps.has(nodeFingerprint(TUIC_V4))).toBe(true);

    // 两条 TUIC 项，且分别走各自分支
    const tuicProxies = proxies.filter((p) => p.type === 'tuic');
    expect(tuicProxies).toHaveLength(2);
    const v5 = tuicProxies.find((p) => p.server === TUIC_V5.server)!;
    const v4 = tuicProxies.find((p) => p.server === TUIC_V4.server)!;
    expect(v5.uuid).toBe(TUIC_V5.uuid);
    expect(v5.token).toBeUndefined();
    expect(v4.token).toBe('token-v4');
    expect(v4.uuid).toBeUndefined();
  });

  it('生成结果可被再次解析，且 DNS 防泄漏与代理组结构未被触碰', async () => {
    const { svc } = await setup([TUIC_V5]);
    const yaml = await svc.generate('mihomo');
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(Array.isArray(parsed.proxies)).toBe(true);
    expect(Array.isArray(parsed['proxy-groups'])).toBe(true);
    expect(Array.isArray(parsed.rules)).toBe(true);

    // DNS 防泄漏（BASE_LAYER）结构不变：fake-ip + 显式监听 + 严格路由
    const dns = parsed.dns as Record<string, unknown> | undefined;
    expect(dns).toBeDefined();
    expect(dns!.enable).toBe(true);
    expect(dns!['enhanced-mode']).toBe('fake-ip');
    expect(parsed.ipv6).toBe(false);
    const tun = parsed.tun as Record<string, unknown> | undefined;
    expect(tun!['strict-route']).toBe(true);
    expect(tun!['dns-hijack']).toEqual(['any:53', 'tcp://any:53']);
  });
});
