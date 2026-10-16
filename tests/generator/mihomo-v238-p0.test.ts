/**
 * P0 第四阶段：Mihomo 选组优化（v2.38）生成层验证
 *
 * 验证 m00573 第四阶段六项覆盖：
 * ① 顶层「自动选择」直接含预期节点（扁平，非地区组）
 * ② 顶层「自动选择」不含地区组/负载均衡组
 * ③ 地区组仍保留正确 url-test 参数与节点列表
 * ④ 空节点池 / 缺特定地区 / 重复节点 边界
 * ⑤ GLOBAL/业务组/默认出口/面板排序 不因候选调整改变
 * ⑥ HTTPS 测速 URL 与参数
 *
 * 架构依据（src/generator/mihomo.ts）：
 * - 第 4 组「自动选择」proxies = allGeoNodes（扁平节点），非 geoChoices
 * - 业务组（节点选择/国外媒体/Google服务/漏网之鱼/加密货币）仍用 geoChoices（地区组+LB 组）
 * - GLOBAL 全量回填 = 全部组 + DIRECT（zashboard 面板排序依据）
 * - PANEL_ORDER 决定面板展示顺序
 */
import { describe, it, expect } from 'vitest';
import { generateProxyGroups, generateMihomoConfig, validateMihomo } from '@/generator/mihomo';
import { Node } from '@/models/node';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    name: 'JP-01',
    protocol: 'vless',
    server: 'jp.example.com',
    port: 443,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    tls: true,
    metadata: { source: 'test', originalName: 'JP-01', tags: [] },
    version: 1,
    ...overrides,
  } as Node;
}

/** 多地区 resolver：us→美国, jp→日本, hk→香港 */
const multiResolver = async (server: string): Promise<string | null> => {
  if (server.startsWith('us')) return '🇺🇸 美国';
  if (server.startsWith('jp')) return '🇯🇵 日本';
  if (server.startsWith('hk')) return '🇭🇰 香港';
  return null;
};

describe('P0 v2.38 选组优化：顶层自动选择扁平化', () => {
  it('① 顶层「自动选择」proxies = 全部有效节点（扁平），含预期节点名', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'JP-01', server: 'jp1.example.com' }),
        makeNode({ id: 'n3', name: 'HK-01', protocol: 'trojan', server: 'hk1.example.com', password: 'p' }),
      ],
      [], [], multiResolver
    );
    const auto = groups.find(g => g.name === '自动选择');
    const list = auto?.proxies as string[] | undefined;
    expect(list).toContain('US-01');
    expect(list).toContain('JP-01');
    expect(list).toContain('HK-01');
    // 顺序 = geoGroups 顺序（GEO_ORDER: 香港→日本→美国），故 HK-01 < JP-01 < US-01
    expect(list!.indexOf('HK-01')).toBeLessThan(list!.indexOf('JP-01'));
    expect(list!.indexOf('JP-01')).toBeLessThan(list!.indexOf('US-01'));
  });

  it('② 顶层「自动选择」不含地区组/LB 组名', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-02', server: 'us2.example.com' }),
        makeNode({ id: 'n3', name: 'JP-01', server: 'jp1.example.com' }),
      ],
      [], [], multiResolver
    );
    const auto = groups.find(g => g.name === '自动选择');
    const list = auto?.proxies as string[] | undefined;
    expect(list).not.toContain('🇺🇸 美国');
    expect(list).not.toContain('🇺🇸 美国-负载均衡');
    expect(list).not.toContain('🇯🇵 日本');
    // 节点名都在
    expect(list).toContain('US-01');
    expect(list).toContain('US-02');
    expect(list).toContain('JP-01');
  });

  it('③ 地区组保留 url-test 参数（interval/timeout/tolerance/expected-status/max-failed-times）与节点列表', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-02', server: 'us2.example.com' }),
      ],
      [], [], multiResolver
    );
    const us = groups.find(g => g.name === '🇺🇸 美国');
    expect(us?.type).toBe('url-test');
    expect(us?.url).toBe('https://www.gstatic.com/generate_204'); // ⑥ HTTPS
    expect(us?.interval).toBe(300);
    expect(us?.timeout).toBe(5000);
    expect(us?.tolerance).toBe(50);
    expect(us?.['expected-status']).toBe(204);
    expect(us?.['max-failed-times']).toBe(3);
    expect(us?.proxies).toEqual(['US-01', 'US-02']); // 节点列表不变

    // LB 组保留
    const lb = groups.find(g => g.name === '🇺🇸 美国-负载均衡');
    expect(lb?.type).toBe('load-balance');
    expect(lb?.strategy).toBe('consistent-hashing');
    expect(lb?.proxies).toEqual(['US-01', 'US-02']);
  });

  it('④a 空节点池：自动选择 proxies 回落到 DIRECT，validateMihomo 通过', async () => {
    const yaml = await generateMihomoConfig([]);
    expect(validateMihomo(yaml)).toBe(true);
    const groups = await generateProxyGroups([], [], [], multiResolver);
    const auto = groups.find(g => g.name === '自动选择');
    expect(auto?.proxies).toEqual(['DIRECT']);
  });

  it('④b 缺特定地区（无台湾节点）：crypto default-selected 回落「自动选择」，不指向不存在的组', async () => {
    // 只有美国/日本节点，无台湾
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'JP-01', server: 'jp1.example.com' }),
      ],
      [{ id: 'cn', label: '中国直连', tag: 'geosite', target: 'DIRECT', native: true, fixed: true } as never],
      [{ key: 'crypto', name: '加密货币', items: [{ id: 'crypto', label: '加密货币', fixed: true }] }] as never,
      multiResolver
    );
    const crypto = groups.find(g => g.name === '加密货币');
    expect(crypto?.['default-selected']).toBe('自动选择'); // 无台湾组 → 回落到顶层自动选择
    // 候选仍用 geoChoices（地区组+LB），不因 crypto 默认调整而变
    expect(crypto?.proxies).toContain('🇺🇸 美国');
    expect(crypto?.proxies).toContain('🇯🇵 日本');
  });

  it('④b-2 有台湾节点：crypto default-selected = 实际台湾组名', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'TW-01', server: 'tw1.example.com' }),
      ],
      [],
      [{ key: 'crypto', name: '加密货币', items: [{ id: 'crypto', label: '加密货币', fixed: true }] }] as never,
      async (s: string) => (s.startsWith('us') ? '🇺🇸 美国' : s.startsWith('tw') ? '🇹🇼 台湾' : null)
    );
    const crypto = groups.find(g => g.name === '加密货币');
    expect(crypto?.['default-selected']).toBe('🇹🇼 台湾');
  });

  it('④c 重复节点（去重由 generateMihomoConfig 调用 makeUniqueNames）：顶层候选含去重后节点名', async () => {
    // 注：generateProxyGroups 本身不调用 makeUniqueNames；
    // 生产路径是 generateMihomoConfig → makeUniqueNames → generateProxyGroups。
    // 此处直接传两个同名节点，验证顶层候选能容纳重名（去重在 generateMihomoConfig 层完成）。
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-01', server: 'us2.example.com' }), // 同名
      ],
      [], [], multiResolver
    );
    const auto = groups.find(g => g.name === '自动选择');
    const list = auto?.proxies as string[] | undefined;
    expect(list).toHaveLength(2);
    expect(list!.filter(n => n === 'US-01').length).toBe(2); // 两个同名节点都在

    // 经 generateMihomoConfig 路径：makeUniqueNames 给第二个加 -1
    const yaml = await generateMihomoConfig(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-01', server: 'us2.example.com' }),
      ],
      [], [], multiResolver
    );
    expect(yaml).toContain('US-01');
    expect(yaml).toContain('US-01-1');
  });

  it('⑤a GLOBAL 全量回填不变：含全部组 + DIRECT', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'JP-01', server: 'jp1.example.com' }),
      ],
      [], [], multiResolver
    );
    const names = groups.map(g => String(g.name));
    const global = groups.find(g => g.name === 'GLOBAL');
    expect(global?.proxies).toEqual([...names.filter(n => n !== 'GLOBAL'), 'DIRECT']);
  });

  it('⑤b 业务组候选仍用 geoChoices（地区组+LB 组），不因顶层扁平化改变', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-02', server: 'us2.example.com' }),
      ],
      [], [], multiResolver
    );
    for (const name of ['节点选择', '国外媒体', 'Google服务', '漏网之鱼']) {
      const g = groups.find(x => x.name === name);
      const list = g?.proxies as string[] | undefined;
      expect(list, name).toContain('🇺🇸 美国');
      expect(list, name).toContain('🇺🇸 美国-负载均衡');
    }
  });

  it('⑤c 面板顺序不变：自动选择排在广告拦截之前，GLOBAL 压最后', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'JP-01', server: 'jp1.example.com' }),
        makeNode({ id: 'n3', name: 'HK-01', protocol: 'trojan', server: 'hk1.example.com', password: 'p' }),
      ],
      [], [], multiResolver
    );
    const names = groups.map(g => String(g.name));
    const idx = (n: string) => names.indexOf(n);
    expect(idx('自动选择')).toBeLessThan(idx('广告拦截'));
    expect(idx('广告拦截')).toBeLessThan(idx('GLOBAL'));
    expect(idx('GLOBAL')).toBe(names.length - 1);
  });

  it('⑤d 手动切换 default-selected 不变（优先美国组首节点）', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-02', server: 'us2.example.com' }),
        makeNode({ id: 'n3', name: 'JP-01', server: 'jp1.example.com' }),
      ],
      [], [], multiResolver
    );
    const manual = groups.find(g => g.name === '手动切换');
    expect(manual?.['default-selected']).toBe('US-01'); // 美国组首节点
    // 节点顺序按 GEO_ORDER: 香港→日本→美国，故 JP-01 在 US-01 之前
    expect(manual?.proxies).toEqual(['JP-01', 'US-01', 'US-02']);
  });

  it('⑥ 测速 URL 全部改为 https://www.gstatic.com/generate_204（自动选择/地区组/LB 组）', async () => {
    const groups = await generateProxyGroups(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'US-02', server: 'us2.example.com' }),
      ],
      [], [], multiResolver
    );
    const httpsUrl = 'https://www.gstatic.com/generate_204';
    // 顶层自动选择
    const auto = groups.find(g => g.name === '自动选择');
    expect(auto?.url).toBe(httpsUrl);
    // 地区 url-test 组
    const us = groups.find(g => g.name === '🇺🇸 美国');
    expect(us?.url).toBe(httpsUrl);
    // LB 组
    const lb = groups.find(g => g.name === '🇺🇸 美国-负载均衡');
    expect(lb?.url).toBe(httpsUrl);
    // 全部测速组（url-test / load-balance 且带 url 的）都 https
    for (const g of groups) {
      const url = g.url;
      if (typeof url === 'string') {
        expect(url).toBe(httpsUrl);
      }
    }
  });

  it('⑦ 完整 YAML：自动选择扁平化 + validateMihomo 通过', async () => {
    const yaml = await generateMihomoConfig(
      [
        makeNode({ name: 'US-01', server: 'us1.example.com' }),
        makeNode({ id: 'n2', name: 'JP-01', server: 'jp1.example.com' }),
      ],
      [], [], multiResolver
    );
    expect(validateMihomo(yaml)).toBe(true);
    // YAML 中自动选择组候选是节点名而非地区组
    expect(yaml).toContain('US-01');
    // 地区组仍存在（url-test）
    expect(yaml).toContain('🇺🇸 美国');
  });
});
