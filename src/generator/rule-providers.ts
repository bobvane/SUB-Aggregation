/**
 * MetaCubeX 分流规则 → Mihomo rule-providers / rules 生成
 * 关键事实：Web 只写 rule-providers 的 URL，不托管规则文件。
 * 客户端启动时自行从 GitHub 拉取规则集。优先用 jsDelivr CDN（国内友好）。
 *
 * ⚠️ 已验证的 URL 事实（2026-08-15）：
 *   - MetaCubeX/meta-rules-dat 的 `release` 分支根目录只有打包大文件
 *     （geosite.dat / geosite.db 等），**没有** geosite-<分类>.dat 单文件。
 *   - 单个分类规则集在 `meta` 分支 `geo/geosite/<name>.mrs`。
 *   - 该 mrs 可经 raw.githubusercontent / cdn.jsdelivr.net / fastly.jsdelivr.net 访问，已验证 200（2026-08-16）。
 *
 * ⚠️ MRS 格式说明（2026-08-16）：
 *   - MRS 是 Mihomo 原生二进制格式（Clash Meta/OpenClash 也支持），解析更快、内存占用更低。
 *   - 本项目的 Mihomo 输出面向 Mihomo/Clash Meta/OpenClash/Stash，统一用 mrs。
 *   - Sing-box/Surge 等其它客户端输出是独立管线，各自用自己的规则格式，不受这里影响。
 */
import { MetaCubeXRule, RuleGroup } from '@/data/metacubex-rules';

/** 规则文件 CDN 镜像前缀（meta 分支，国内可访问，已验证） */
export const META_DAT_BASE =
  'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/';

/**
 * 生成单独的 rule-provider 定义（一个 geosite 分类 → 一个 http provider）
 * provider 名用 geosite-<小写id>，避免与内置 geosite 规则混淆
 */
export function buildRuleProvider(rule: MetaCubeXRule): {
  name: string;
  url: string;
  path: string;
  interval: number;
  behavior: 'domain';
  format: 'mrs';
  type: 'http';
} {
  return {
    name: providerName(rule.id),
    type: 'http',
    behavior: 'domain',
    format: 'mrs',
    url: providerUrl(rule.id),
    path: `./ruleset/${providerName(rule.id)}.mrs`,
    interval: 86400,
  };
}

/** provider 名：geosite-<小写id> */
export function providerName(id: string): string {
  return `geosite-${id.toLowerCase()}`;
}

/** 规则文件 CDN URL（meta 分支 mrs，已验证存在） */
export function providerUrl(id: string): string {
  return `${META_DAT_BASE}${id.toLowerCase()}.mrs`;
}

/** 计算规则的出口目标（按 V3.1 三层架构路由） */
export function ruleActionTarget(rule: MetaCubeXRule, groups: RuleGroup[] = []): string {
  // 定位所属分组：native 规则用大小写不敏感匹配（原生 id 为小写 geosite 分类名）
  const g = groups.find(gr => gr.items.some(i => i.id.toLowerCase() === rule.id.toLowerCase()));

  // REJECT 统一 → 广告拦截（应用净化已移除，ADS⊂ADS-ALL 93% 重叠）
  if (rule.target === 'REJECT') {
    return '广告拦截';
  }

  // 国内直连规则 → 直接 DIRECT（不建策略组）
  if (g && g.key === 'china-direct') {
    return 'DIRECT';
  }

  // DIRECT 目标：有归属按归属组，无归属直接 DIRECT
  if (rule.target === 'DIRECT') {
    if (!g) return 'DIRECT';
    return g.name;
  }

  // PROXY：找到所属规则大类
  if (!g) return '漏网之鱼'; // 无归属分组，兜底

  // 固化策略组
  if (g.key === 'ads') return '广告拦截';
  if (g.key === 'media') return '国外媒体';

  // 业务条件组 → 使用分组名
  return g.name;
}

/**
 * 单条规则的原生/Provider 输出行：
 *   - native=true → GEOSITE/<GEOIP>,<分类名>,<出口>（原生规则集，客户端内置 geodata 匹配）
 *   - native=false（或无）→ RULE-SET,geosite-<id>,<出口>（HTTP 规则集下载，极少数 .mrs 规则集）
 */
export function ruleSetLine(rule: MetaCubeXRule, groups: RuleGroup[] = []): string {
  // native 规则和 custom（用户添加）规则统一走 GEOSITE/GEOIP 原生输出，不生成 RULE-SET + rule-providers
  if (rule.native || rule.custom) {
    const action = ruleActionTarget(rule, groups);
    // geoip 项内部 id 形如 <name>-geoip（避开与同名 geosite 冲突），输出时剥掉后缀还原为 geoip 分类名
    const normalizedId = rule.tag === 'geoip' ? rule.id.replace(/-geoip$/, '').toLowerCase() : rule.id.toLowerCase();
    if (rule.tag === 'geoip') return `GEOIP,${normalizedId},${action}`;
    return `GEOSITE,${normalizedId},${action}`;
  }
  return `RULE-SET,${providerName(rule.id)},${ruleActionTarget(rule, groups)}`;
}

/**
 * 构建 rule-providers 对象（供 YAML 序列化）
 * 只包含用户勾选的 geosite 规则
 */
export function buildRuleProviders(selected: MetaCubeXRule[] = []): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const rule of selected) {
    // native 规则走原生 GEOSITE/GEOIP 输出，不生成 provider
    if (rule.native) continue;
    // custom（用户添加）规则也走 GEOSITE 原生输出，不生成 provider
    if (rule.custom) continue;
    const p = buildRuleProvider(rule);
    providers[p.name] = {
      type: p.type,
      behavior: p.behavior,
      format: p.format,
      url: p.url,
      path: p.path,
      interval: p.interval,
    };
  }
  return providers;
}

/**
 * 生成完整 rules 数组（有序，v2.11.0 规则排序重构；v2.27.0 页面对齐工程重写）
 * 优先级（自上而下匹配）：
 *   ① 内网防代理 GEOIP,lan,DIRECT,no-resolve（必须最前，防内网误代理）
 *   ①b QUIC 防泄漏：非国内域名 UDP 443 → REJECT（硬编码，吸收专业配置）
 *   ①c TikTok QUIC 例外：TikTok UDP443 先走国外媒体组代理，再执行 ①b 全局拦截
 *        （TikTok 重度依赖 QUIC，被全局拦截吃掉会表现为「连不上」；媒体组关闭时不输出）
 *   ②~⑬ 业务组：严格按 RULE_GROUPS 数组顺序展平输出 = 页面展示顺序 = 输出顺序（单一来源）
 *       内置规则全部 fixed（锁死，只能整组开关）；disabledGroupKeys 整组取消；自定义规则随所属组位置输出
 *   ⑭ GEOIP,CN,DIRECT（承重墙：国内 IP 最终直连）
 *   ⑮ MATCH,漏网之鱼
 *
 * 依据：Mihomo 规则自上而下匹配，先命中的生效。
 *   - 内网防代理必须最前（防 192.168.x.x 误代理），lan 在前 private 在后
 *   - 用户规则紧跟 ①b QUIC 之后（用户显式意图次优先于内网防代理；用户 2026-09-02 拍板）
 *   - 国内直连保持业务组之前：@cn 细分必须排在国际版之前，否则微软/Steam 中国区域名被误判代理
 *   - GEOIP/d 兜底随各自组输出（v2.27.0 起不再统一沉底，用户 2026-09-19 纠正）
 */
export function buildRules(
  selected: MetaCubeXRule[] = [],
  groups: RuleGroup[] = [],
  disabledGroupKeys: Set<string> = new Set()
): string[] {
  const selectedSet = new Set(selected.map(r => r.id));
  const lines: string[] = [];

  // === ① 内网防代理 + ①b QUIC 防泄漏（硬编码，用户不可调）===
  // lan 在前 private 在后；QUIC 非国内域名 UDP443 REJECT（AND 语法见 mihomo 官方文档）
  lines.push('GEOIP,lan,DIRECT,no-resolve');
  lines.push('GEOSITE,private,DIRECT');
  // ①c TikTok QUIC 例外（2026-09-19）：TikTok 重度依赖 QUIC，若被下面的全局 QUIC 拦截吃掉，TCP 回退不畅
  // 时表现为「连不上」。先放行 TikTok 的 UDP443 走国外媒体组代理，再执行全局拦截。
  // 媒体组被整组取消时不输出（否则引用不存在的策略组，客户端会报错）。
  if (!disabledGroupKeys.has('media')) {
    const tiktokUdp: MetaCubeXRule = { id: 'tiktok', label: 'TikTok', tag: 'geosite', target: 'PROXY', native: true, fixed: true };
    lines.push(`AND,((GEOSITE,tiktok),(DST-PORT,443),(NETWORK,UDP)),${ruleActionTarget(tiktokUdp, groups)}`);
  }
  lines.push('AND,((GEOSITE,geolocation-!cn),(DST-PORT,443),(NETWORK,UDP)),REJECT');

  // === ②~⑬ 业务组：严格按 RULE_GROUPS 数组顺序展平（页面次序 = 输出次序 = 匹配优先级）===
  // 锁死模型：内置规则全部 fixed（整组开关 disabledGroupKeys）；自定义规则随所属组位置输出
  for (const g of groups) {
    if (disabledGroupKeys.has(g.key)) continue; // 整组取消
    for (const item of g.items) {
      if (g.key === 'user' && !item.custom) continue; // 用户组只含自定义规则
      if (!item.fixed && !selectedSet.has(item.id)) continue; // 非 fixed（自定义）需选中才输出
      lines.push(ruleSetLine(item, groups));
    }
  }

  // === ⑭ GEOIP,CN,DIRECT（承重墙：国内 IP 最终直连，排业务组之后 MATCH 之前）===
  lines.push('GEOIP,CN,DIRECT');

  // === ⑮ MATCH 收尾 ===
  return [...lines, 'MATCH,漏网之鱼'];
}