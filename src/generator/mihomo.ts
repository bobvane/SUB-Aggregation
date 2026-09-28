/**
 * Mihomo 配置生成器
 * TASK 5.1 - Mihomo Generator
 * 09_CONFIG_GENERATOR_SPEC.md §7：输出 YAML，兼容 Mihomo/Clash Meta/OpenClash
 */

import { Node } from '@/models/node';
import { generateYaml, parseYaml } from './yaml-serializer';
import { MetaCubeXRule, RuleGroup } from '@/data/metacubex-rules';
import { buildRuleProviders, buildRules } from './rule-providers';
import {
  COUNTRIES,
  GEO_ORDER,
  countryDisplayName,
} from '@/data/country-codes';

/** 判断是否为 IPv4 地址 */
function isIPAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * 节点名去重：同名节点追加数字后缀
 */
export function makeUniqueNames(nodes: Node[]): Node[] {
  const seen = new Map<string, number>();
  return nodes.map((n) => {
    const count = seen.get(n.name) ?? 0;
    seen.set(n.name, count + 1);
    if (count === 0) return n;
    return { ...n, name: `${n.name}-${count}` };
  });
}

/**
 * 将 Node 转换为 Mihomo proxy 配置对象
 */
export function nodeToMihomoProxy(node: Node): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: node.name,
    type: node.protocol,
    server: node.server,
    port: node.port,
  };

  switch (node.protocol) {
    case 'vmess':
      base.uuid = node.uuid;
      base.alterId = 0;
      if (node.tls) base.tls = true;
      if (node.transport?.type === 'ws') {
        base.network = 'ws';
        base['ws-opts'] = {
          path: node.transport.path,
          headers: node.transport.host ? { Host: node.transport.host } : undefined,
        };
      }
      if (node.transport?.type === 'grpc') {
        base.network = 'grpc';
        base['grpc-opts'] = {
          grpcServiceName: node.transport.path?.replace(/^\/+/, '') || '',
        };
      }
      break;

    case 'vless':
      base.uuid = node.uuid;
      base.udp = true;
      base.encryption = 'none';
      if (node.tls) base.tls = true;
      if (node.flow) base.flow = node.flow;
      // SNI 优先用显式 sni 参数；若缺省但开启了 TLS 且是 ws 传输（Host 头一般是真实 SNI 域名），
      // 用 transport.host 兜底——否则 TLS 握手会用 server 的 IP 当 SNI，Cloudflare/CDN 会拒握。
      if (node.sni) base.servername = node.sni;
      else if (node.tls && node.transport?.type === 'ws' && node.transport.host) base.servername = node.transport.host;
      // ALPN:链接带 alpn 参数时原样输出(XHTTP 缺省默认 [h2] 已随 XHTTP 支持移除,2026-08-30)
      if (node.alpn?.length) base.alpn = node.alpn;
      if (node.allowInsecure) base['skip-cert-verify'] = true;
      if (node.transport?.type === 'ws') {
        base.network = 'ws';
        base['ws-opts'] = {
          path: node.transport.path,
          headers: node.transport.host ? { Host: node.transport.host } : undefined,
        };
      }
      if (node.transport?.type === 'grpc') {
        base.network = 'grpc';
        base['grpc-opts'] = {
          grpcServiceName: node.transport.path?.replace(/^\/+/, '') || '',
        };
      }
      // XHTTP 传输已降级为普通 VLESS(用户 2026-08-30 决定暂停 XHTTP 支持):不输出 network/xhttp-opts
      // Reality:字段名用连字符 reality-opts,加 client-fingerprint 做 TLS 指纹伪装
      if (node.pbk) {
        const realityOpts: Record<string, string> = {
          'public-key': node.pbk,
          'short-id': node.sid ?? '',
        };
        // spx 是 Reality 的扩展协议参数
        if (node.metadata?.extra?.spx) {
          realityOpts.spx = node.metadata.extra.spx;
        }
        base['reality-opts'] = realityOpts;
        base['client-fingerprint'] = node.metadata?.fingerprint ?? 'chrome';
      }

      // 非 Reality 的 TLS VLESS:client-fingerprint 默认 chrome(订阅原文带 fp 时覆盖)
      if (!node.pbk && node.tls) {
        base['client-fingerprint'] = node.metadata?.fingerprint ?? 'chrome';
      }

      // ECH(加密 Client Hello)已随 XHTTP 支持暂停移除(2026-08-30 用户决定)

      // XHTTP 额外字段(x-padding-* 等)已随 XHTTP 支持暂停移除(2026-08-30 用户决定)
      break;

    case 'trojan':
      base.password = node.password;
      // trojan 协议强制 TLS，Mihomo trojan 类型没有 tls 字段，不需显式设置
      if (node.sni) base.sni = node.sni;
      else if (node.tls && node.transport?.type === 'ws' && node.transport.host) base.sni = node.transport.host;
      // 仅当 server 是 IP 时跳过证书校验（IP 直连 CF 证书必然不匹配）
      // 域名节点保持严格校验，先做最小化 A/B 测试（不动 TLS 握手行为）
      if (node.allowInsecure || isIPAddress(node.server)) base['skip-cert-verify'] = true;
      if (node.transport?.type === 'ws') {
        base.network = 'ws';
        base['ws-opts'] = {
          path: node.transport.path,
          headers: node.transport.host ? { Host: node.transport.host } : undefined,
        };
      }
      break;

    case 'ss':
      base.cipher = node.metadata.tags[0] ?? node.username ?? 'aes-256-gcm';
      base.password = node.password;
      if (node.plugin) {
        // plugin=xxx 格式: v2ray-plugin;tls;host=xxx
        const pluginParts = node.plugin.split(';');
        base.plugin = pluginParts[0];
        const opts: Record<string, string> = {};
        for (const part of pluginParts.slice(1)) {
          if (part.includes('=')) {
            const [k, v] = part.split('=');
            opts[k] = v;
          } else {
            opts.mode = part;
          }
        }
        if (Object.keys(opts).length > 0) base['plugin-opts'] = opts;
      }
      break;

    case 'ssr':
      base.cipher = node.username ?? node.metadata.tags[0] ?? 'aes-256-cfb';
      base.password = node.password;
      if (node.ssrProtocol) base.protocol = node.ssrProtocol;
      if (node.ssrProtocolParam) base['protocol-param'] = node.ssrProtocolParam;
      if (node.obfs) base.obfs = node.obfs;
      if (node.ssrObfsParam) base['obfs-param'] = node.ssrObfsParam;
      if (node.ssrGroup) base.group = node.ssrGroup;
      break;

    case 'hysteria2':
      base.password = node.password;
      base.tls = true;
      if (node.sni) base.sni = node.sni;
      if (node.allowInsecure) base['skip-cert-verify'] = true;
      if (node.ports) base.ports = node.ports;
      if (node.up) base.up = node.up;
      if (node.down) base.down = node.down;
      if (node.obfs) {
        base.obfs = node.obfs;
        if (node.obfsPassword) base['obfs-password'] = node.obfsPassword;
      }
      if (node.alpn) base.alpn = node.alpn;
      if (node.fingerprint) base.fingerprint = node.fingerprint;
      break;

    case 'tuic':
      if (node.token) {
        // TUIC V4
        base.token = node.token;
      } else {
        // TUIC V5
        base.uuid = node.uuid;
        base.password = node.password;
      }
      base.tls = true;
      if (node.sni) base.sni = node.sni;
      if (node.allowInsecure) base['skip-cert-verify'] = true;
      if (node.udpRelayMode) base['udp-relay-mode'] = node.udpRelayMode;
      if (node.congestionController) base['congestion-controller'] = node.congestionController;
      if (node.disableSni) base['disable-sni'] = node.disableSni;
      if (node.reduceRtt) base['reduce-rtt'] = node.reduceRtt;
      if (node.fastOpen) base['fast-open'] = node.fastOpen;
      if (node.alpn) base.alpn = node.alpn;
      break;

    case 'wireguard':
      base['private-key'] = node.wgPrivateKey ?? '';
      base.udp = true;
      if (node.wgIp) base.ip = node.wgIp;
      if (node.wgIpv6) base.ipv6 = node.wgIpv6;
      if (node.wgPublicKey) base['public-key'] = node.wgPublicKey;
      if (node.wgAllowedIps) base['allowed-ips'] = [node.wgAllowedIps];
      if (node.wgPreSharedKey) base['pre-shared-key'] = node.wgPreSharedKey;
      if (node.wgReserved) base.reserved = node.wgReserved;
      if (node.wgMtu) base.mtu = node.wgMtu;
      break;

    case 'anytls':
      base.password = node.password;
      base.tls = true;
      if (node.sni) base.sni = node.sni;
      if (node.allowInsecure) base['skip-cert-verify'] = true;
      if (node.alpn) base.alpn = node.alpn;
      if (node.fingerprint) base.fingerprint = node.fingerprint;
      if (node.idleSessionCheckInterval !== undefined) base['idle-session-check-interval'] = node.idleSessionCheckInterval;
      if (node.idleSessionTimeout !== undefined) base['idle-session-timeout'] = node.idleSessionTimeout;
      if (node.minIdleSession !== undefined) base['min-idle-session'] = node.minIdleSession;
      if (node.clientMetadata) base['client-metadata'] = node.clientMetadata;
      break;
  }

  return base;
}

/**
 * 地区代码 → "emoji 中文名"映射（地理分组显示名）
 * 基于 CF 数据中心覆盖的 135 国/地区（country-codes.ts），补充 UK 别名。
 */
export const GEO_NAMES: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const code of Object.keys(COUNTRIES)) {
    const display = countryDisplayName(code);
    if (display) m[code] = display;
  }
  m['UK'] = m['GB']!; // 英国别名
  return m;
})();

// 地理分组显示名 → 国家码（反向映射，供图标查找）
const GEO_CODE_BY_NAME: Record<string, string> = {};
for (const [code, display] of Object.entries(GEO_NAMES)) {
  GEO_CODE_BY_NAME[display] = code;
}

// 地理组图标：国家码 → Qure IconSet 国旗（缺失/无法识别的回落 Area.png）
// 2026-09-24 吸收 Perfect-Rules：每个策略组配图标（纯视觉，不涉及分流逻辑）
const GEO_ICON_BASE = 'https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/';
const GEO_ICON_FALLBACK = GEO_ICON_BASE + 'Area.png';
const GEO_ICON_CODES = new Set([
  'AR', 'AU', 'BR', 'CA', 'CN', 'DE', 'EG', 'EU', 'FI', 'FR',
  'HK', 'IN', 'JP', 'KR', 'LA', 'MO', 'MY', 'PH', 'RU', 'SG',
  'TH', 'TR', 'TW', 'UA', 'UK', 'US',
]);

/**
 * 按地区对节点分组（纯 IP 定位）
 * @param nodes 节点完整对象
 * @param ipGeoResolver IP 地理定位函数（返回 emoji 中文名或 null）
 */
async function groupNodesByGeo(
  nodes: Node[],
  ipGeoResolver?: (server: string) => Promise<string | null>
): Promise<{ name: string; nodes: string[] }[]> {
  // 直接使用纯 IP 定位进行地理分组，不进行任何名称关键词匹配
  const groups = new Map<string, string[]>();
  const ungrouped: string[] = [];

  for (const node of nodes) {
    // 直接使用外部 resolver 查询单个 IP
    const geoName = ipGeoResolver ? await ipGeoResolver(node.server) : null;
    if (geoName) {
      // geoName 已经是 emoji 中文名
      const list = groups.get(geoName) || [];
      list.push(node.name);
      groups.set(geoName, list);
    } else {
      ungrouped.push(node.name);
    }
  }

  const result: { name: string; nodes: string[] }[] = [];
  // 使用预定义的地理组顺序
  for (const key of GEO_ORDER) {
    if (groups.has(key)) {
      result.push({ name: key, nodes: groups.get(key)! });
      groups.delete(key);
    }
  }

  // 剩余的按字母序
  for (const [name, nodes] of [...groups.entries()].sort()) {
    result.push({ name, nodes });
  }

  // 无法归类的放到"其他"组
  if (ungrouped.length > 0) {
    result.push({ name: '其他', nodes: ungrouped });
  }

  return result;
}

export interface GeoResolver {
  (server: string): Promise<string | null>;
}

/**
 * 生成代理组配置（参考 ACL4SSR/参考配置 sub.bobvane.top 排序与结构）
 *
 * 分组排序（v2.27.2 起）：整组顺位按分流页面（RULE_GROUPS）顺序排列，
 *   由函数末尾 PANEL_ORDER 排序实现。结构为：
 *   顶层切换组（节点选择/手动切换/自动选择）
 *   → 业务分类组（用户规则/广告拦截/AI 平台/YouTube/GitHub/Google服务/微软服务/苹果服务/社交/国外媒体/加密货币/游戏平台）
 *   → 漏网之鱼（MATCH 兜底）→ GLOBAL（显式定义）→ 地理组（🇭🇰 香港 / 🇯🇵 日本 / ...，除指定 7 地区外全部 select；
 *     香港/美国/马来西亚/日本/新加坡/台湾/韩国 7 组 url-test 自动测速，且各自另配一组 load-balance 负载均衡组）
 *
 * 不生成「全球直连」「国内媒体」策略组：国内直连规则在 rule-providers 中直接写 RULE-SET,xxx,DIRECT。
 * 应用净化已移除（CATEGORY-ADS⊂CATEGORY-ADS-ALL，93% 重叠，并入广告拦截）。
 *
 * 关键：GLOBAL 组必须显式、完整地按期望顺序引用所有策略组，
 *       因 zashboard/metacubexd 面板的节点组排序 = GLOBAL 组 proxies 引用顺序。
 */
export async function generateProxyGroups(
  nodes: Node[],
  selectedRules: MetaCubeXRule[] = [],
  ruleGroups: RuleGroup[] = [],
  ipGeoResolver?: GeoResolver,
  disabledGroupKeys: Set<string> = new Set(),
  scoreOf?: (name: string) => number | undefined
): Promise<Record<string, unknown>[]> {
  // 判断某规则大类是否有规则被勾选（v2.27.0：含 fixed 项即视为选中——内置规则全部锁死）
  const hasSelected = (key: string): boolean =>
    ruleGroups.find(g => g.key === key)?.items.some(i => i.fixed) ||
    selectedRules.some(r => ruleGroups.find(g => g.key === key)?.items.some(i => i.id === r.id));

  // 1. 地理分组（emoji/名字优先 + 三字码补充 + IP 兜底）
  const geoGroups = await groupNodesByGeo(nodes, ipGeoResolver);
  // 组内节点按 node_health.score 降序（v2.34）：得分高的在前，未知分靠后（稳定排序保持其余顺序）
  if (scoreOf) {
    for (const g of geoGroups) {
      g.nodes.sort((a, b) => (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1));
    }
  }
  const geoGroupNames = geoGroups.map(g => g.name);
  const allGeoNodes = geoGroups.flatMap(g => g.nodes);

  // 测速地区：指定地区自动测速(url-test)，其余 select。美国/马来西亚/日本/新加坡/台湾/韩国（用户 2026-08-30 指定）
  // + 香港（用户 2026-09-24：原手工选定改为自动测速组）。
  // 单节点自动降级为 select（用户 2026-08-30 拍板：url-test 组仅 1 个节点时测速无意义），此时也不产出负载均衡组。
  const URL_TEST_REGIONS = ['香港', '美国', '马来西亚', '日本', '新加坡', '台湾', '韩国'];
  const testRegionNames = new Set(
    geoGroups.filter(g => URL_TEST_REGIONS.some(r => g.name.includes(r)) && g.nodes.length > 1).map(g => g.name)
  );
  // 排序（用户 2026-09-24 指令，硬编码）：自动测速地区在前（其负载均衡组紧跟），其他 select 地区在后。
  // 稳定排序 → 测试组内部、普通组内部各自保持原相对顺序；仅整体把测试组提到最前。
  geoGroups.sort((a, b) => Number(testRegionNames.has(b.name)) - Number(testRegionNames.has(a.name)));

  // 候选列表用（用户 2026-09-24）：凡引用地理组的组，同时给出该地区的负载均衡组，紧跟地区组之后。
  // 注意 geoGroupNames 保持「纯地区组」——下面的下标查找依赖它与 geoGroups 一一对应。
  const geoChoices = geoGroups.flatMap(g =>
    testRegionNames.has(g.name) ? [g.name, `${g.name}-负载均衡`] : [g.name]
  );
  const groups: Record<string, unknown>[] = [];

  // 2. 节点选择（手动选地区/节点方案，默认自动选择）
  groups.push({
    name: '节点选择',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Static.png',
    'default-selected': '自动选择',
    proxies: ['自动选择', ...geoChoices, '手动切换', 'DIRECT'],
  });

  // 3. 手动切换（select：具体节点扁平列表，逐节点选）
  // default-selected：优先取「美国」组的第一个节点（用户 2026-09-02 指定 美国bob-bob@gmail.com），否则取第一个地理节点，再兜底 DIRECT
  const usGeo = geoGroupNames.findIndex(n => n.includes('美国'));
  groups.push({
    name: '手动切换',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Final.png',
    'default-selected': (usGeo >= 0 && geoGroups[usGeo].nodes[0]) || allGeoNodes[0] || 'DIRECT',
    proxies: allGeoNodes.length > 0 ? allGeoNodes : ['DIRECT'],
  });

  // 4. 自动选择（url-test：按地理组测速，挑最优地区）——v2.19.4 改：proxies 从扁平节点名改为地理组名
  groups.push({
    name: '自动选择',
    type: 'url-test',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Auto.png',
    url: 'http://www.gstatic.com/generate_204',
    interval: 300,
    timeout: 5000,
    tolerance: 50,
    // 2026-09-24（吸收 Perfect-Rules）：只认 generate_204 的 204 为存活；连续 3 次失败触发强制复检
    'expected-status': 204,
    'max-failed-times': 3,
    // 测速对象从「具体节点」改为「地理组」——geoChoices = 各国地理组（测速地区附带其负载均衡组）
    proxies: geoChoices.length > 0 ? geoChoices : ['DIRECT'],
  });

  // 5. 国外媒体（流媒体 PROXY，默认自动选择）——固化策略组
  groups.push({
    name: '国外媒体',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Streaming.png',
    'default-selected': '自动选择',
    proxies: ['自动选择', '节点选择', ...geoChoices, '手动切换', 'DIRECT'],
  });

  // 5b. Google服务（v2.15.0 建组，v2.31.3 用户拍板：default-selected 改手动切换，跟 AI 平台一致）——固化策略组
  groups.push({
    name: 'Google服务',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Google.png',
    'default-selected': '手动切换',
    proxies: ['自动选择', '节点选择', ...geoChoices, '手动切换', 'DIRECT'],
  });

  // 6. 广告拦截（默认 REJECT）——固化策略组，只保留 REJECT 和 DIRECT（用户 2026-08-30 拍板）
  groups.push({
    name: '广告拦截',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Adblock.png',
    'default-selected': 'REJECT',
    proxies: ['REJECT', 'DIRECT'],
  });

  // 8. 业务分类策略组（仅当勾选该大类规则时才生成，条件组）
  //    ads(广告拦截) / media(国外媒体) 已由上方固化策略组承接；
  // Orz-3/mini Color 图标映射：仓库实际文件名（英文），无对应图标时用 Global.png 兜底
  const groupIconMap: Record<string, string> = {
    'microsoft': 'Microsoft.png',
    'apple': 'Apple.png',
    'game': 'GAME.png',
    'ai': 'OpenAI.png',
    'youtube': 'YouTube.png',
    'github': 'https://raw.githubusercontent.com/Koolson/Qure/refs/heads/master/IconSet/Color/GitHub.png',
    'social': 'Telegram.png',
    'crypto': 'Global.png',
    'user': 'Manual.png',
  };
  // AI 平台默认「美国地理组」：取美国组的实际名字（AI 组排除港澳台，美国本身在组内，是合法默认成员）
  const US_GEO_NAME = geoGroupNames.find(n => n.includes('美国')) || '手动切换';
  const groupDefaults: Record<string, { name: string; default: string }> = {
    'microsoft': { name: '微软服务', default: 'DIRECT' },
    'apple': { name: '苹果服务', default: 'DIRECT' },
    'game': { name: '游戏平台', default: 'DIRECT' },
    'ai': { name: 'AI 平台', default: US_GEO_NAME },
    'youtube': { name: 'YouTube', default: '自动选择' },
    'github': { name: 'GitHub', default: '自动选择' },
    'social': { name: '社交', default: '自动选择' },
    'crypto': { name: '加密货币', default: '🇹🇼 台湾' },
    'user': { name: '用户规则', default: '手动切换' },
  };
  const independentGroupKeys = Object.keys(groupDefaults);
  const ruleClassGroupNames: string[] = [];
  
  for (const key of independentGroupKeys) {
    const g = ruleGroups.find(gr => gr.key === key);
    if (!g || !hasSelected(key) || disabledGroupKeys.has(key)) continue;
    ruleClassGroupNames.push(g.name);

    let proxies: string[] = ['节点选择', '手动切换', '自动选择', ...geoChoices, 'DIRECT'];

    if (key === 'ai') {
      const banned = ['香港', '澳门', '台湾'];
      const allowed = geoChoices.filter(n => !banned.some(b => n.includes(b)));
      proxies = ['节点选择', '手动切换', ...allowed, 'DIRECT'];
    }

    if (key === 'crypto') {
      proxies = ['节点选择', '手动切换', ...geoChoices, 'DIRECT'];
    }

    groups.push({ 
      name: g.name, 
      type: 'select', 
      'default-selected': groupDefaults[key].default,
      icon: groupIconMap[key]?.startsWith('http')
        ? groupIconMap[key]
        : `https://raw.githubusercontent.com/Orz-3/mini/master/Color/${groupIconMap[key] || 'Global.png'}`,
      proxies 
    });
  }

  // 9. 漏网之鱼（MATCH 兜底，默认手动切换）——用户 2026-09-03 修改：从自动选择改为手动切换
  groups.push({
    name: '漏网之鱼',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Global.png',
    'default-selected': '自动选择',
    proxies: ['节点选择', '手动切换', '自动选择', ...geoChoices, 'DIRECT'],
  });

  // 10. GLOBAL（默认自动选择；无 url，不需要测速 —— 用户 2026-09-02 拍板）
  // proxies 不在此处写死：zashboard/metacubexd 的组顺序 = GLOBAL.all 下标，
  // 故必须在全部组生成、排序完成后，按面板顺序全量回填（见函数末尾）。
  groups.push({
    name: 'GLOBAL',
    type: 'select',
    icon: 'https://raw.githubusercontent.com/Orz-3/mini/master/Color/Final.png',
    'default-selected': '自动选择',
  });

  // 11. 地理组：testRegionNames 内的走 url-test 自动测速（并另配负载均衡组），其余 select
  // 地理组图标：国家码 → Qure IconSet 国旗（缺失/无法识别的回落 Area.png）
  const geoIcon = (name: string): string => {
    const code = GEO_CODE_BY_NAME[name];
    return code && GEO_ICON_CODES.has(code) ? GEO_ICON_BASE + code + '.png' : GEO_ICON_FALLBACK;
  };
  for (const geo of geoGroups) {
    // 与候选列表（geoChoices）同源，避免两处判断跑偏
    const useUrlTest = testRegionNames.has(geo.name);
    // 键顺序：name → type →（url/interval/timeout/tolerance）→ proxies，让测速参数紧跟 type 下方，排版更清晰（用户 2026-09-02 拍板）
    const group: Record<string, unknown> = {
      name: geo.name,
      type: useUrlTest ? 'url-test' : 'select',
    };
    group.icon = geoIcon(geo.name);
    if (useUrlTest) {
      group.url = 'http://www.gstatic.com/generate_204';
      group.interval = 300;
      group.timeout = 5000;
      group.tolerance = 50;
      // 2026-09-24（吸收 Perfect-Rules）：只认 generate_204 的 204 为存活；连续 3 次失败触发强制复检
      group['expected-status'] = 204;
      group['max-failed-times'] = 3;
    }
    group.proxies = geo.nodes;
    groups.push(group);

    // 地理负载均衡组（用户 2026-09-24 拍板：保留原 url-test 组，同地区另加一组 load-balance，紧随其地区组之后）。
    // strategy 硬编码 consistent-hashing（与内核默认一致，但显式输出，用户 2026-09-24）；
    // tolerance 是 url-test 专有参数，load-balance 不认，故此处不输出。
    if (useUrlTest) {
      groups.push({
        name: `${geo.name}-负载均衡`,
        type: 'load-balance',
        strategy: 'consistent-hashing',
        icon: geoIcon(geo.name),
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        timeout: 5000,
        'expected-status': 204,
        'max-failed-times': 3,
        proxies: geo.nodes,
      });
    }
  }

  // 面板顺序 = PANEL_ORDER 排位。用户 2026-09-24 重排：
  // 顶层切换组最前 → 用户规则(仅勾选时出现) → 业务组(AI/GitHub/Google/YouTube/加密货币/国外媒体/社交)
  // → 漏网之鱼 → 微软/苹果/游戏 → 广告拦截 → 国家地理组 → GLOBAL 压最后。
  // 地理组无对应分流分组，走 ??100；故 GLOBAL 取 101 才能落到地理组之后。
  const PANEL_ORDER: Record<string, number> = {
    '节点选择': 1, '手动切换': 2, '自动选择': 3, '用户规则': 4,
    'AI 平台': 5, 'GitHub': 6, 'Google服务': 7, 'YouTube': 8,
    '加密货币': 9, '国外媒体': 10, '社交': 11, '漏网之鱼': 12,
    '微软服务': 13, '苹果服务': 14, '游戏平台': 15, '广告拦截': 16,
    'GLOBAL': 101,
  };
  groups.sort((a, b) => {
    const ra = PANEL_ORDER[String(a.name)] ?? 100;
    const rb = PANEL_ORDER[String(b.name)] ?? 100;
    return ra - rb;
  });

  // GLOBAL 全量回填（用户 2026-09-24 拍板，推翻 08-30「只留四组」）：
  // zashboard/metacubexd 用 GLOBAL.all 的下标给组排序，不在该数组里的组会掉进字母序，
  // 面板顺序就失控。故按面板顺序把全部组写进 GLOBAL.proxies，DIRECT 收尾。
  const globalGroup = groups.find(g => g.name === 'GLOBAL');
  if (globalGroup) {
    globalGroup.proxies = [
      ...groups.filter(g => g.name !== 'GLOBAL').map(g => String(g.name)),
      'DIRECT',
    ];
  }

  return groups;
}

/**
 * 专业配置基础层（2026-09-19 吸收，全输出）：
 * geox-url / ntp / tun / sniffer / dns 五大块，忠实还原专业配置的可运行架构。
 * 唯一适配：dns 段原引用 qichiyuhub 第三方 rule-set（fakeipfilter_cn/!cn），
 * 按设计改为本项目 MetaCubeX 原生 geosite 快捷式（cn / private / microsoft@cn / apple@cn / steam@cn / geolocation-!cn）。
 * TUN route-exclude-address-set 原引用 cn_ip rule-provider，项目用原生 GEOIP,CN 快捷式替代。
 * 另吸收 unified-delay / tcp-concurrent / profile(store-selected+store-fake-ip)（用户 2026-09-19 拍板，推翻 v2.12.2 删除指令）。
 * 不吸收：external-controller/secret/external-ui(zashboard)（裸开控制 API 有安全风险）、authentication(明文口令随 URL 分发)、bind-address(默认即 *)。
 */
const BASE_LAYER: Record<string, unknown> = {
  'unified-delay': true,
  'tcp-concurrent': true,
  // DNS 防泄露：顶层 ipv6:false（对齐 Perfect-Rules）—— 内核不使用 IPv6：不做 AAAA 解析、
  // 不建 IPv6 出站，避免 IPv6 侧绕过 TUN 直连导致 DNS/IP 双泄漏。
  ipv6: false,
  'geox-url': {
    // 四项同源 CDN（jsdelivr testingcf）。geox-url 只是 URL 对照表，不会主动下载，
    // 仅当内核工作目录缺失对应文件时才按此表获取；内核默认源全是 github.com，国内常超时。
    geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
    // mmdb 用内核自身的默认文件 geoip.metadb（含国家+ASN，比 GeoLite2-Country 数据更全），
    // 只换下载域名 → 内容与内核默认完全一致，兼容性最保险。
    mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb',
    asn: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb',
  },
  ntp: {
    enable: true,
    'write-to-system': true,
  },
  tun: {
    enable: true,
    stack: 'mixed', // 内核 >v1.19.31 可改 mips 自研协议栈，性能更佳
    'dns-hijack': ['any:53', 'tcp://any:53'],
    'auto-route': true,
    'auto-redirect': true,
    'auto-detect-interface': true,
    'route-exclude-address-set': ['GEOIP,CN'],
    'strict-route': true, // DNS 防泄露：严格路由，堵住系统/网卡侧路由绕过
    mtu: 1280,
  },
  sniffer: {
    enable: true,
    'override-destination': true,
    'force-dns-mapping': true,
    'parse-pure-ip': true,
    sniff: {
      HTTP: { ports: [80, '8080-8880'] },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] },
    },
    'skip-domain': ['Mijia Cloud', '+.push.apple.com'],
  },
  dns: {
    enable: true,
    'cache-algorithm': 'arc',
    listen: '0.0.0.0:53', // DNS 防泄露：显式监听，配合 dns-hijack 接管系统 DNS
    ipv6: false,
    'enhanced-mode': 'fake-ip',
    'fake-ip-ttl': 1,
    'fake-ip-range': '198.18.0.0/16',
    'fake-ip-filter-mode': 'blacklist',
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    'proxy-server-nameserver': ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
    'direct-nameserver': ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
    'nameserver-policy': {
      'geosite:cn,private,microsoft@cn,apple@cn,steam@cn': [
        'https://dns.alidns.com/dns-query#disable-qtype-65=true',
        'https://doh.pub/dns-query#disable-qtype-65=true',
      ],
      'geosite:geolocation-!cn': ['https://8.8.8.8/dns-query#漏网之鱼&disable-qtype-65=true'],
    },
    nameserver: ['https://8.8.8.8/dns-query#漏网之鱼&ecs=223.5.5.0/24'],
    fallback: [
      // DNS 防泄露：境外双备（走项目兜底组「漏网之鱼」代理），避免 8.8.8.8 单点
      'https://cloudflare-dns.com/dns-query#漏网之鱼',
      'https://dns.google/dns-query#漏网之鱼',
    ],
    'fallback-filter': {
      geoip: true,
      'geoip-code': 'CN',
      // 国外常用站强制只走 fallback（境外解析），防境外域名被国内解析污染/泄露
      domain: [
        '+.google.com',
        '+.googleapis.com',
        '+.googlevideo.com',
        '+.youtube.com',
        '+.github.com',
        '+.openai.com',
        '+.chatgpt.com',
        '+.anthropic.com',
        '+.claude.ai',
      ],
    },
    'fake-ip-filter': [
      // DNS 防泄露：仅排除必须拿真实 IP 的最小集（局域网/本地、NTP、Apple 推送与激活检测、
      // 系统连通性探测），其余全部走 fake-ip → TUN 全接管。不再排除 geosite:cn /
      // geolocation-!cn —— 那会把假 IP 防泄露主闸关掉，漏测站（境外域名）走真实 IP 直连即泄露。
      '+.lan',
      '+.local',
      '+.localhost',
      '+.home.arpa',
      'time.*.com',
      'time.*.gov',
      'pool.ntp.org',
      '+.push.apple.com',
      'mesu.apple.com',
      'swscan.apple.com',
      'captive.apple.com',
      'connectivitycheck.gstatic.com',
      'connectivitycheck.android.com',
      'www.msftconnecttest.com',
      'www.msftncsi.com',
    ],
  },
  profile: {
    'store-selected': true,
    'store-fake-ip': true,
  },
};

/**
 * 生成 Mihomo YAML 配置
 * @param selectedRules 用户勾选的 MetaCubeX 分流规则（用于生成 rule-providers + rules）
 * @param ruleGroups 预定义规则大类（用于生成按规则分类的 proxy-groups）
 * @param ipGeoResolver 可选 IP 定位回调，用于名字无法识别的节点兜底
 */
export async function generateMihomoConfig(
  nodes: Node[],
  selectedRules: MetaCubeXRule[] = [],
  ruleGroups: RuleGroup[] = [],
  ipGeoResolver?: GeoResolver,
  disabledGroupKeys: Set<string> = new Set(),
  scoreOf?: (name: string) => number | undefined
): Promise<string> {
  // 注：v2.12.2 按用户指令去除全部硬编码头字段（mixed-port/allow-lan/mode/log-level/ipv6/
  // external-controller/secret）及 profile/dns/sniffer 段，配置仅输出 proxies/proxy-groups/rules。
  // v2.13.0：按用户指令恢复必要头部（port/socks-port/allow-lan/mode/log-level），与硬编码规则集一起
  // 构成 Mihomo 完整可运行配置；自动选择 + url-test 地理组的测速参数同步调整（砍掉 lazy，
  // url/interval/tolerance 移到 type 正下方便于阅读，测速地址统一用 google generate_204）。
  const uniqueNodes = makeUniqueNames(nodes);
  const proxies = uniqueNodes.map(nodeToMihomoProxy);
  const groups = await generateProxyGroups(uniqueNodes, selectedRules, ruleGroups, ipGeoResolver, disabledGroupKeys, scoreOf);

  const config: Record<string, unknown> = {
    'mixed-port': 7893,
    port: 7890,
    'socks-port': 7891,
    'allow-lan': true,
    mode: 'Rule',
    'log-level': 'info',
    ...BASE_LAYER,
    proxies,
    'proxy-groups': groups,
    rules: ['MATCH,漏网之鱼'],
  };

  // 分流规则：用户勾选了规则才生成 rule-providers + 有序 rules
  // custom（用户添加）规则和 native 规则一样走 GEOSITE 原生输出，不生成 rule-providers
  const nonNativeRules = selectedRules.filter(r => !r.native && !r.custom);
  if (selectedRules.length > 0) {
    // 只有非 native 规则才生成 rule-providers（原生规则走 GEOSITE 直出）
    if (nonNativeRules.length > 0) {
      config['rule-providers'] = buildRuleProviders(nonNativeRules);
    }
    config.rules = buildRules(selectedRules, ruleGroups, disabledGroupKeys);
  }

  return generateYaml(config);
}

/**
 * 验证生成的 YAML 能否被解析
 */
export function validateMihomo(yaml: string): boolean {
  try {
    const parsed = parseYaml(yaml);
    return !!parsed && Array.isArray((parsed as Record<string, unknown>).proxies);
  } catch {
    return false;
  }
}