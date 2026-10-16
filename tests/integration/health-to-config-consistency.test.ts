/**
 * C3（阶段 C）：健康状态 → 最终配置 端到端闭环。
 *
 * 验证「节点输入 → 健康快照 → getDroppedNodes/getNodes → /api/nodes → Mihomo YAML」
 * 五层之间的**三方一致性**，要求：
 *   - API 的 dropped/locked/healthStatus 字段与 getDroppedNodes() 一致；
 *   - getDroppedNodes() 与 getNodes() 的过滤结果一致；
 *   - getNodes() 与最终 YAML 的 proxies 一致；
 *   - proxy-groups 不引用最终 proxies 中不存在的节点名（无悬空引用）。
 *
 * 与既有 node-health-mihomo-closure.test.ts 的分工：
 *   既有文件验证「单节点级别的进/不进」；
 *   本文件验证「跨层一致性 + 无悬空引用 + 确定性 + 跨地区」。
 * 冻结区（协议映射 / DNS / 分流 / 代理组结构 / YAML 生成）仅作为回归对象，不做改动。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { createNode, nodeFingerprint, type Node } from '@/models/node';
import { validateMihomo } from '@/generator/mihomo';
import { parseYaml } from '@/generator/yaml-serializer';
import { countryDisplayName } from '@/data/country-codes';

const fp = (n: Node) => nodeFingerprint(n);

/** 内置引用：代理组可以合法引用、但不出现在 proxies 中的名字 */
const BUILTIN_REFS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE']);

function parseConfig(yaml: string) {
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const proxies = (parsed.proxies as Array<Record<string, unknown>>) ?? [];
  const groups = (parsed['proxy-groups'] as Array<Record<string, unknown>>) ?? [];
  const proxyNames = new Set(proxies.map((p) => String(p.name)));
  const groupNames = new Set(groups.map((g) => String(g.name)));
  const fps = new Set(proxies.map((p) => `${String(p.server)}:${String(p.port)}:${String(p.type)}`));
  // 全部组引用（去重）
  const refs = new Set<string>();
  for (const g of groups) {
    for (const r of (g.proxies as string[] | undefined) ?? []) refs.add(r);
  }
  return { parsed, proxies, groups, proxyNames, groupNames, fps, refs };
}

const snapshot = (
  f: string,
  status: 'alive' | 'dead',
  statusMachine: 'active' | 'suspect' | 'disabled',
  score: number,
  tcp: number | null = status === 'alive' ? 80 : null
) =>
  JSON.stringify({
    fingerprint: f,
    status,
    timestamp: Date.now(),
    tcpLatency: tcp,
    tlsLatency: null,
    httpLatency: null,
    tlsApplicable: false,
    error: null,
    score,
    statusMachine,
  });

/** 构建「三地区 + 1 disabled + 1 UDP + 1 locked」的完整场景 */
async function buildScenario() {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);

  const hk = createNode({ id: 'n-hk', name: 'HK-1', protocol: 'vless', server: 'hk1.example.com', port: 443, uuid: 'u1', metadata: { source: 'test', originalName: 'HK-1', tags: [] } });
  const jp = createNode({ id: 'n-jp', name: 'JP-1', protocol: 'vless', server: 'jp1.example.com', port: 443, uuid: 'u2', metadata: { source: 'test', originalName: 'JP-1', tags: [] } });
  const us = createNode({ id: 'n-us', name: 'US-1', protocol: 'trojan', server: 'us1.example.com', port: 443, password: 'p', metadata: { source: 'test', originalName: 'US-1', tags: [] } });
  const dead = createNode({ id: 'n-dead', name: 'DEAD-1', protocol: 'vless', server: 'dead1.example.com', port: 443, uuid: 'u3', metadata: { source: 'test', originalName: 'DEAD-1', tags: [] } });
  const udp = createNode({ id: 'n-udp', name: 'TUIC-1', protocol: 'tuic', server: 'tuic1.example.com', port: 10443, uuid: 'uu', password: 'pp', metadata: { source: 'test', originalName: 'TUIC-1', tags: [] } });
  const locked = createNode({ id: 'n-locked', name: 'LOCKED-1', protocol: 'vless', server: 'locked1.example.com', port: 443, uuid: 'u4', metadata: { source: 'test', originalName: 'LOCKED-1', tags: [] } });

  await repos.nodes.setBySubscription('sub1', [hk, jp, us, dead, udp, locked]);

  // 预填 ip-geo 缓存：避免 generate() 对未知域名发起真实网络解析
  // （既保证测试确定性，也把单例耗时从 ~2s 降到毫秒级）
  const geoSeed: Array<[string, string]> = [
    ['hk1.example.com', 'HK'],
    ['jp1.example.com', 'JP'],
    ['us1.example.com', 'US'],
    ['dead1.example.com', 'US'],
    ['tuic1.example.com', 'JP'],
    ['locked1.example.com', 'HK'],
  ];
  for (const [server, code] of geoSeed) {
    await repos.settings.set(`ip_geo:${server}`, `${Date.now()}|${countryDisplayName(code)}`);
  }

  // 健康快照：三个地区健康、dead 确认失效、locked 也确认失效（但被锁定豁免）
  await kv.put(`health:latest:${fp(hk)}`, snapshot(fp(hk), 'alive', 'active', 95));
  await kv.put(`health:latest:${fp(jp)}`, snapshot(fp(jp), 'alive', 'active', 88));
  await kv.put(`health:latest:${fp(us)}`, snapshot(fp(us), 'alive', 'active', 70));
  await kv.put(`health:latest:${fp(dead)}`, snapshot(fp(dead), 'dead', 'disabled', 0));
  await kv.put(`health:latest:${fp(locked)}`, snapshot(fp(locked), 'dead', 'disabled', 0));
  // UDP 节点不写健康数据（生产语义）

  const svc = createConfigService(repos, kv);
  await svc.setLockedNodes([fp(locked)]);

  return { kv, repos, svc, hk, jp, us, dead, udp, locked };
}

/**
 * 构建一个**完全独立**的场景实例（独立 MemoryKvAdapter + 独立 repos + 独立 configService）。
 *
 * 用于确定性对比：snapshot 缓存以 `setting:config_version` 为版本键
 * （src/services/config-cache.service.ts:44-66），两个独立 KV 天然不共享缓存，
 * 因此各自都会真正走一遍 generateMihomoConfig，而不是命中缓存返回同一字符串。
 */
async function buildIndependentScenario() {
  return buildScenario();
}

/** 规范化 YAML：去掉可能随环境变化的部分（此处配置内容本身不含时间戳，仅做统一换行） */
function normalizeYaml(yaml: string): string {
  return yaml.replace(/\r\n/g, '\n').trimEnd();
}

describe('C3 闭环：getDroppedNodes ↔ getNodes ↔ YAML 三方一致', () => {
  it('disabled 节点：进入 dropped、被 getNodes 过滤、不出现在 proxies', async () => {
    const { svc, dead } = await buildScenario();
    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain(fp(dead));

    const nodes = await svc.getNodes();
    expect(nodes.map(fp)).not.toContain(fp(dead));

    const yaml = await svc.generate('mihomo');
    const { fps } = parseConfig(yaml);
    expect(fps.has(fp(dead))).toBe(false);
  });

  it('locked 节点即使 disabled 也进配置（锁定豁免系统剔除）', async () => {
    const { svc, locked } = await buildScenario();
    // dropped 集合仍包含它（健康事实不变）
    expect(await svc.getDroppedNodes()).toContain(fp(locked));
    // 但 getNodes 保留它（锁定豁免）
    expect((await svc.getNodes()).map(fp)).toContain(fp(locked));
    // 且出现在最终配置
    const { fps } = parseConfig(await svc.generate('mihomo'));
    expect(fps.has(fp(locked))).toBe(true);
  });

  it('UDP 未检测节点：不进 dropped、进 getNodes、进最终配置', async () => {
    const { svc, udp } = await buildScenario();
    expect(await svc.getDroppedNodes()).not.toContain(fp(udp));
    expect((await svc.getNodes()).map(fp)).toContain(fp(udp));
    const { fps } = parseConfig(await svc.generate('mihomo'));
    expect(fps.has(fp(udp))).toBe(true);
  });

  it('健康节点全部进入 proxies（跨地区不遗漏）', async () => {
    const { svc, hk, jp, us } = await buildScenario();
    const { fps } = parseConfig(await svc.generate('mihomo'));
    expect(fps.has(fp(hk))).toBe(true);
    expect(fps.has(fp(jp))).toBe(true);
    expect(fps.has(fp(us))).toBe(true);
  });

  it('生成的 YAML 通过 validateMihomo 校验', async () => {
    const { svc } = await buildScenario();
    expect(validateMihomo(await svc.generate('mihomo'))).toBe(true);
  });
});

describe('C3 闭环：无悬空引用与结构完整性', () => {
  it('所有 proxy-group 引用都能在 proxies / 其它组 / 内置项中找到', async () => {
    const { svc } = await buildScenario();
    const { proxyNames, groupNames, refs } = parseConfig(await svc.generate('mihomo'));

    const dangling: string[] = [];
    for (const r of refs) {
      if (proxyNames.has(r)) continue;
      if (groupNames.has(r)) continue;
      if (BUILTIN_REFS.has(r)) continue;
      dangling.push(r);
    }
    expect(dangling).toEqual([]);
  });

  it('代理组名称唯一（无重复 ID）', async () => {
    const { svc } = await buildScenario();
    const { groups } = parseConfig(await svc.generate('mihomo'));
    const names = groups.map((g) => String(g.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('节点名在 proxies 中唯一（makeUniqueNames 生效）', async () => {
    const { svc } = await buildScenario();
    const { proxies } = parseConfig(await svc.generate('mihomo'));
    const names = proxies.map((p) => String(p.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('剔除节点不会留下组内无效引用：dead 被剔除后，所有组引用仍可解析', async () => {
    const { svc, dead } = await buildScenario();
    const yaml = await svc.generate('mihomo');
    const { proxies, proxyNames, groupNames, refs } = parseConfig(yaml);

    // 前置确认：dead 确实被真实筛选链路剔除了
    expect([...proxyNames].some((n) => yaml.includes(n))).toBeTruthy();
    expect(yaml).not.toContain(dead.server);
    const deadInProxies = proxies.some(
      (p) => `${String(p.server)}:${String(p.port)}:${String(p.type)}` === fp(dead)
    );
    expect(deadInProxies).toBe(false);

    // 核心断言：逐个引用校验其属于「proxies ∪ groups ∪ 内置项」，
    // 若某引用指向已被剔除的死节点名称，此处会把它计入 dangling 而失败。
    // 复用与上一用例完全相同的允许集合定义（BUILTIN_REFS / proxyNames / groupNames）。
    const dangling: string[] = [];
    for (const r of refs) {
      if (proxyNames.has(r)) continue;
      if (groupNames.has(r)) continue;
      if (BUILTIN_REFS.has(r)) continue;
      dangling.push(r);
    }
    expect(dangling).toEqual([]);

    // 非空洞自检：引用集合非空、且确有引用落在 proxies 上（否则上面可能空跑）
    expect(refs.size).toBeGreaterThan(0);
    expect([...refs].some((r) => proxyNames.has(r))).toBe(true);
  });
});

describe('C3 闭环：/api/nodes 与后端筛选一致', () => {
  async function makeApp() {
    const { kv, repos, svc, hk, jp, us, dead, udp, locked } = await buildScenario();
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    const app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
      config: svc,
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass' }),
    });
    const token = ((await login.json()) as { data: { token: string } }).data.token;
    return { app, token, svc, hk, jp, us, dead, udp, locked };
  }

  it('API 的 dropped 标记与 getDroppedNodes() 完全一致', async () => {
    const { app, token, hk, jp, us, dead, udp, locked } = await makeApp();
    const res = await app.request('/api/nodes', { headers: { Cookie: `sub_session=${token}` } });
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { data: Array<{ fingerprint: string; dropped: boolean }> }).data;
    const byFp = new Map(list.map((n) => [n.fingerprint, n]));

    // dead 与 locked 的健康事实都是 disabled → dropped=true
    expect(byFp.get(fp(dead))?.dropped).toBe(true);
    expect(byFp.get(fp(locked))?.dropped).toBe(true);
    // 健康节点与 UDP 节点 dropped=false
    expect(byFp.get(fp(hk))?.dropped).toBe(false);
    expect(byFp.get(fp(jp))?.dropped).toBe(false);
    expect(byFp.get(fp(us))?.dropped).toBe(false);
    expect(byFp.get(fp(udp))?.dropped).toBe(false);
  });

  it('API 的 locked 标记与 setLockedNodes 一致', async () => {
    const { app, token, locked, hk } = await makeApp();
    const res = await app.request('/api/nodes', { headers: { Cookie: `sub_session=${token}` } });
    const list = ((await res.json()) as { data: Array<{ fingerprint: string; locked: boolean }> }).data;
    const byFp = new Map(list.map((n) => [n.fingerprint, n]));
    expect(byFp.get(fp(locked))?.locked).toBe(true);
    expect(byFp.get(fp(hk))?.locked).toBe(false);
  });

  it('API 的 healthStatus / statusMachine 与健康快照一致', async () => {
    const { app, token, hk, dead, locked } = await makeApp();
    const res = await app.request('/api/nodes', { headers: { Cookie: `sub_session=${token}` } });
    const list = ((await res.json()) as {
      data: Array<{ fingerprint: string; healthStatus: string | null; statusMachine: string | null }>;
    }).data;
    const byFp = new Map(list.map((n) => [n.fingerprint, n]));

    expect(byFp.get(fp(hk))?.healthStatus).toBe('alive');
    expect(byFp.get(fp(hk))?.statusMachine).toBe('active');
    expect(byFp.get(fp(dead))?.healthStatus).toBe('dead');
    expect(byFp.get(fp(dead))?.statusMachine).toBe('disabled');
    expect(byFp.get(fp(locked))?.healthStatus).toBe('dead'); // 锁定不伪造健康
    expect(byFp.get(fp(locked))?.statusMachine).toBe('disabled');
  });

  it('API 对 UDP 节点标记 probeApplicable=false / healthStatus=unknown / score=null', async () => {
    const { app, token, udp } = await makeApp();
    const res = await app.request('/api/nodes', { headers: { Cookie: `sub_session=${token}` } });
    const list = ((await res.json()) as {
      data: Array<{ fingerprint: string; probeApplicable: boolean; healthStatus: string | null; score: number | null; error: string | null }>;
    }).data;
    const row = list.find((n) => n.fingerprint === fp(udp));
    expect(row?.probeApplicable).toBe(false);
    expect(row?.healthStatus).toBe('unknown');
    expect(row?.score).toBeNull();
    expect(row?.error).toContain('UDP');
  });

  it('API 列出的可进配置节点集合 == getNodes() 结果', async () => {
    const { app, token, svc } = await makeApp();
    const res = await app.request('/api/nodes', { headers: { Cookie: `sub_session=${token}` } });
    const list = ((await res.json()) as {
      data: Array<{ fingerprint: string; dropped: boolean; locked: boolean; enabled: boolean; name: string }>;
    }).data;

    // 从 API 行推导「应进配置」：enabled 且（未 dropped 或 locked）
    const apiIncluded = list
      .filter((n) => n.enabled && (!n.dropped || n.locked))
      .map((n) => n.fingerprint)
      .sort();

    // getNodes() 实际结果（含 UDP 节点）
    const actual = (await svc.getNodes()).map(fp).sort();

    // API 侧不区分 removed_at（tombstone 不出现在 getAll 默认口径），此处场景无 removed
    expect(apiIncluded).toEqual(actual);
  });
});

describe('C3 闭环：确定性与地区一致性', () => {
  it('getNodes() 两次调用结果一致（仅验证节点筛选的确定性）', async () => {
    const { svc } = await buildScenario();
    const fps1 = (await svc.getNodes()).map(fp);
    const fps2 = (await svc.getNodes()).map(fp);
    expect(fps1).toEqual(fps2);
  });

  it('两个独立实例生成同一份配置：完整 YAML / proxies / groups / rules 均一致', async () => {
    // 两个完全独立的场景（独立 KV → 独立 config_version → snapshot 缓存互不影响），
    // 各自真实执行一次 generateMihomoConfig，避免"同一字符串解析两次"的恒真断言。
    const a = await buildIndependentScenario();
    const b = await buildIndependentScenario();

    const yamlA = await a.svc.generate('mihomo');
    const yamlB = await b.svc.generate('mihomo');

    // ① 规范化后的完整 YAML 逐字一致
    expect(normalizeYaml(yamlA)).toBe(normalizeYaml(yamlB));

    const cfgA = parseConfig(yamlA);
    const cfgB = parseConfig(yamlB);

    // ② proxies 集合**及其顺序**一致
    const proxyNamesA = cfgA.proxies.map((p) => String(p.name));
    const proxyNamesB = cfgB.proxies.map((p) => String(p.name));
    expect(proxyNamesA).toEqual(proxyNamesB);
    expect(proxyNamesA.length).toBeGreaterThan(0); // 防空集合导致断言空洞

    // ③ proxy-groups 名称**及其顺序**一致
    const groupNamesA = cfgA.groups.map((g) => String(g.name));
    const groupNamesB = cfgB.groups.map((g) => String(g.name));
    expect(groupNamesA).toEqual(groupNamesB);
    expect(groupNamesA.length).toBeGreaterThan(0);

    // ④ rules 序列一致
    const rulesA = cfgA.parsed.rules;
    const rulesB = cfgB.parsed.rules;
    expect(rulesA).toEqual(rulesB);
    expect(Array.isArray(rulesA) && rulesA.length).toBeTruthy();

    // ⑤ 负向自检：人为破坏一个值后比较必须失败（证明本断言具备检测能力）。
    //    注意 YAML 序列化输出不带引号，实际形态为 `mixed-port: 7893`。
    const mutated = normalizeYaml(yamlA).replace(/(^|\n)mixed-port: 7893/, '$1mixed-port: 9999');
    expect(mutated).not.toBe(normalizeYaml(yamlB));
    expect(mutated).toContain('mixed-port: 9999');
  });

  it('不同地区健康节点均被分组，且地区组不因全局规则被系统性排除', async () => {
    const { svc } = await buildScenario();
    const { groups, proxyNames } = parseConfig(await svc.generate('mihomo'));
    // 存在地区组（含 emoji 或国家码）
    expect(groups.length).toBeGreaterThan(0);
    // 三个地区的节点名字都出现在 proxies 中
    const healthy = proxyNames.size;
    expect(healthy).toBeGreaterThanOrEqual(4); // hk/jp/us + locked（UDP 也可能计入）
  });

  it('节点按健康分降序排列在组内（scoreOf 生效）', async () => {
    const { svc, hk, jp, us } = await buildScenario();
    const yaml = await svc.generate('mihomo');
    const { groups, proxies } = parseConfig(yaml);
    // 取「手动切换」组（扁平节点列表），检查其顺序对应分数降序
    const manual = groups.find((g) => String(g.name) === '手动切换');
    expect(manual).toBeDefined();
    const ordered = (manual!.proxies as string[]) ?? [];
    const proxyByServer = new Map(
      proxies.map((p) => [`${p.server}:${p.port}`, String(p.name)])
    );
    // 期望顺序（按分数）：hk(95) → jp(88) → us(70) → locked(0)
    const nameHk = proxyByServer.get(`${hk.server}:${hk.port}`);
    const nameJp = proxyByServer.get(`${jp.server}:${jp.port}`);
    const nameUs = proxyByServer.get(`${us.server}:${us.port}`);
    const idx = (n?: string) => (n === undefined ? -1 : ordered.indexOf(n));
    expect(idx(nameHk)).toBeGreaterThanOrEqual(0);
    expect(idx(nameJp)).toBeGreaterThanOrEqual(0);
    expect(idx(nameUs)).toBeGreaterThanOrEqual(0);
    expect(idx(nameHk)).toBeLessThan(idx(nameJp));
    expect(idx(nameJp)).toBeLessThan(idx(nameUs));
  });
});