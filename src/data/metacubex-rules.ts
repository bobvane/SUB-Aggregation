/**
 * MetaCubeX 分流规则大类定义（预定义分组 + 默认规则）
 * 数据源：MetaCubeX/meta-rules-dat geosite.dat（src/data/metacubex-catalog.json 为 1546 全量清单）
 *
 * 结构：13 个常规大类，每个大类预置常用规则（默认勾选）
 * 用户可在设置页自定义：添加/删除分类、新建大类、改名
 *
 * 分组顺序 = 策略组生成顺序 = 输出 rules 顺序 = 页面展示顺序（单一来源，v2.27.0 页面对齐工程）
 * 锁死模型（2026-09-19 用户拍板）：内置规则全部 fixed（组内锁死、只能整组取消 disabledGroups），
 * 自定义规则（custom）唯一可自由增删/勾选，且随所属组的配置位置输出。
 */
import catalogRaw from './metacubex-catalog.json';

export interface MetaCubeXRule {
  /** 规则 id（geosite category 名。原生规则为小写分类名，可含 @cn/!cn 属性；provider 规则为大写 catalog id） */
  id: string;
  /** 显示名 */
  label: string;
  /** 规则的 tag 类型：geosite / geoip / ruleset */
  tag: 'geosite' | 'geoip' | 'ruleset';
  /** 目标策略：PROXY / DIRECT / REJECT */
  target: 'PROXY' | 'DIRECT' | 'REJECT';
  /** 用户自定义规则（在输出配置中享有最高优先级，紧随 PRIVATE 之后第一个命中） */
  custom?: boolean;
  /** 原生 GEOSITE/GEOIP 输出（不走 rule-provider）；缺省=false → 走 RULE-SET provider */
  native?: boolean;
  /** 灰色固定（承重墙）：UI 展示但不可取消，输出端始终输出 */
  fixed?: boolean;
}

export interface RuleGroup {
  /** 分组 key */
  key: string;
  /** 分组名 */
  name: string;
  /** 图标 */
  icon: string;
  /** 组内规则 */
  items: MetaCubeXRule[];
}

/** 全量分类目录（供扫描/搜索使用，不参与默认勾选） */
export interface CatalogEntry {
  id: string;
  label: string;
  type: 'aggregate' | 'site' | 'tld';
}

/** 用户自定义加入的规则（存 KV，合并进 RULE_GROUPS 展示与生成） */
export interface CustomRule {
  /** geosite 分类 id（大写） */
  id: string;
  /** 显示名（用户可改） */
  label: string;
  /** 归入的大分组 key（必须是 RULE_GROUPS 中的 key） */
  groupKey: string;
  /** 分流目标 */
  target: 'PROXY' | 'DIRECT' | 'REJECT';
  /** 添加时间戳 */
  createdAt?: number;
}

export const METACUBEX_CATALOG: { meta: Record<string, string | number>; catalog: CatalogEntry[] } = catalogRaw as unknown as {
  meta: Record<string, string | number>;
  catalog: CatalogEntry[];
};

/**
 * 预定义规则分组
 * 分组顺序 = 输出顺序 = 页面展示顺序（v2.27.0 页面对齐工程）：按专业配置 mihomo.yaml 的命中次序排布。
 *   对齐依据（专业配置规则表，2026-09-19 用户共同确认）：
 *     private → AI → YouTube → GitHub → Google → Microsoft(含微软中国→直连) → Apple → Telegram → TikTok/NETFLIX
 *     → Wallet → Steam → 直连兜底 → IP 段兜底 → MATCH
 *   - 项目为聚合规则集（category-* 一锅端），落到"目标策略组流向"对齐，聚合组在对应位置。
 *   - 国内直连保持业务组之前（承重墙）：microsoft@cn / steam@cn 必须排在国际版之前，否则微软/Steam 中国区域名被误判代理。
 *   - googlefcm（Google FCM 推送，mtalk*.google.com）国内可直连，并入国内直连组（用户 2026-09-19 拍板）。
 *   - YouTube 单独成组、位于 Google 之前（避免 YouTube 域名先被 Google 或漏网之鱼截走）。
 *   - IP 段兜底随各自组输出（google-geoip/telegram-geoip/netflix-geoip），不再统一沉底（用户 2026-09-19 纠正）。
 *
 * 硬层（不在此数组，buildRules 硬编码）：GEOIP,lan,DIRECT,no-resolve + GEOSITE,private,DIRECT + QUIC 防泄漏
 *                                        + GEOIP,CN,DIRECT + MATCH,漏网之鱼。
 */
export const RULE_GROUPS: RuleGroup[] = [
  // 用户规则组 — 首位，优先级最高
  {
    key: 'user', name: '用户规则', icon: '👑',
    items: [
      // 用户规则组初始为空，规则由用户从右侧规则库自行添加
    ],
  },
  {
    key: 'ads', name: '广告拦截', icon: '🔥',
    items: [
      // 广告拦截 — 原生 GEOSITE 输出，不走 rule-provider
      { id: 'category-ads-all', label: '广告拦截通用合集', tag: 'geosite', target: 'REJECT', native: true, fixed: true },
    ],
  },
  {
    key: 'china-direct', name: '国内直连', icon: '🇨🇳',
    items: [
      // 承重墙 — 固定灰色，不可取消；末尾去重，只留 MATCH
      { id: 'cn', label: '中国直连域名', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      // @cn 属性细分（2026-09-19 吸收专业配置）：中国区域名直连，必须排在同名国际版规则之前
      { id: 'microsoft@cn', label: '微软服务(中国区)', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      { id: 'steam@cn', label: 'Steam 中国区', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      // Google FCM 推送（mtalk*.google.com）国内可直连打通，并入国内直连组（用户 2026-09-19 拍板；谷歌FCM 独立组撤除）
      { id: 'googlefcm', label: '谷歌推送(Google FCM)', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
    ],
  },
  {
    key: 'ai', name: 'AI 平台', icon: '🤖',
    items: [
      // 2026-09-19 用户实测：点名规则比聚合分类命中更稳，四家补入并锁死（组内 fixed，只能整组取消）。
      // 排在聚合分类之前 —— 同组同出口，顺序不影响路由，但点名规则独立命中、不受聚合分类后续变更影响。
      // 小写 id = 原生 geosite 分类名（MetaCubeX meta 分支同名 .mrs 已验证 200；大写形式 404）。
      { id: 'google-gemini', label: 'Google Gemini', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'perplexity', label: 'Perplexity', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'openai', label: 'OpenAI (ChatGPT)', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'anthropic', label: 'Anthropic (Claude)', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // 原生 GEOSITE 输出，聚合分类灰色固定；点名的 8 条已移除
      { id: 'category-ai-!cn', label: 'AI 平台(非中国)', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'category-ai-chat-!cn', label: 'AI 对话(非中国)', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'youtube', name: 'YouTube', icon: '▶️',
    items: [
      // 单独成组，位于 Google 之前（用户 2026-09-19）：YouTube 域名先命中本组，不再漏给 Google / 漏网之鱼。
      // geosite:youtube 已覆盖 googlevideo.com 等视频域名；MetaCubeX 无 geoip:youtube（与专业配置一致，无 IP 兜底）。
      { id: 'youtube', label: 'YouTube', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'github', name: 'GitHub', icon: '🐙',
    items: [
      // 2026-09-19 吸收专业配置 github_domain → GitHub 组（MetaCubeX 有 geosite:github）
      // GitHub 位于 Google 之前（用户 2026-09-19）：GitHub 域名先命中本组，不落 Google/漏网之鱼。
      { id: 'github', label: 'GitHub', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'google', name: 'Google服务', icon: '🔍',
    items: [
      // 原生 GEOSITE + GEOIP 输出（v2.15.0）
      { id: 'google', label: 'Google', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'google-gemini', label: 'Google Gemini', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'google-deepmind', label: 'Google DeepMind', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'google-play', label: 'Google Play', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'google-scholar', label: 'Google 学术', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'google-trust-services', label: 'Google Trust 服务', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // geoip:google 随本组输出（v2.27.0 起不再统一沉底），内部 id 用 google-geoip 避开与 geosite:google 同名冲突
      { id: 'google-geoip', label: 'Google IP段', tag: 'geoip', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'microsoft', name: '微软服务', icon: '🪟',
    items: [
      // 原生 GEOSITE 输出；skype 被 microsoft 聚合兜底；onedrive 已在国内直连走 DIRECT，不在本组重复；azure/bing/msn 已移除
      { id: 'microsoft', label: '微软服务', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'microsoft-dev', label: '微软开发者', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'microsoft-pki', label: '微软 PKI', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'apple', name: '苹果服务', icon: '🍎',
    items: [
      // 原生 GEOSITE 输出；appstore 被 apple/itunes 聚合兜底，不在本组重复；podcasts/tvplus/intelligence/icloud/itunes 已移除
      { id: 'apple', label: '苹果服务', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      { id: 'apple-music', label: 'Apple Music', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      { id: 'apple-dev', label: 'Apple 开发者', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      { id: 'apple-update', label: 'Apple 系统更新', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
      { id: 'apple-pki', label: 'Apple PKI', tag: 'geosite', target: 'DIRECT', native: true, fixed: true },
    ],
  },
  {
    key: 'social', name: '社交', icon: '📱',
    items: [
      // 2026-11-10 用户要求：geosite:TWITTER / geosite:META 点名固定规则，排在聚合分类之前
      { id: 'twitter', label: 'Twitter / X', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'meta', label: 'Meta', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // 原生 GEOSITE 输出，聚合分类灰色固定
      { id: 'category-communication', label: '社交通讯聚合', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'category-social-media-!cn', label: '海外社交(非中国)', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // IP 段兜底（2026-09-19 吸收专业配置）：纯 IP 访问（无域名）时兜底走代理
      { id: 'telegram-geoip', label: 'Telegram IP段', tag: 'geoip', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'media', name: '国外媒体', icon: '🌍',
    items: [
      // 原生 GEOSITE 输出；category-media 灰色固定
      // 注：category-media 实为「新闻媒体站」聚合（BBC/CNN/NYT/NHK/RTHK 等 178 条），并不含流媒体
      { id: 'category-media', label: '媒体聚合', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // 点名单应用域名（2026-09-19 补）：TikTok/Netflix 原先不在本组，域名流量一路漏到 MATCH 兜底
      { id: 'netflix', label: 'Netflix', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'tiktok', label: 'TikTok', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // IP 段兜底（2026-09-19 吸收专业配置）：纯 IP 访问（无域名）时兜底走代理
      // 注：MetaCubeX 无 geoip:tiktok（404），TikTok 只有域名规则，无 IP 兜底
      { id: 'netflix-geoip', label: 'Netflix IP段', tag: 'geoip', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'crypto', name: '加密货币', icon: '💰',
    items: [
      // 2026-11-10 用户要求：geosite:BINANCE / geosite:OKX 点名固定规则，排在聚合分类之前
      { id: 'binance', label: 'Binance', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      { id: 'okx', label: 'OKX', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
      // 原生 GEOSITE 输出；category-cryptocurrency 灰色固定；其余点名规则已移除
      { id: 'category-cryptocurrency', label: '加密货币通用合集', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
    ],
  },
  {
    key: 'game', name: '游戏平台', icon: '🎮',
    items: [
      // 原生 GEOSITE 输出；category-games-!cn 灰色固定；点名的 11 条已移除
      { id: 'category-games-!cn', label: '游戏聚合(非中国)', tag: 'geosite', target: 'PROXY', native: true, fixed: true },
    ],
  },
];

/** 将 RULE_GROUPS 转为前端所需的小写风格（保持 geosite id 大写） */
export function getRuleIdSet(): Set<string> {
  return new Set(RULE_GROUPS.flatMap(g => g.items.map(i => i.id)));
}

/** 从 catalog 查找分类 */
export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return METACUBEX_CATALOG.catalog.find(e => e.id === id || e.id === id.toUpperCase());
}

/** 检查分类是否存在于真实 geosite 数据 */
export function isValidCategory(id: string): boolean {
  return METACUBEX_CATALOG.catalog.some(e => e.id === id.toUpperCase());
}

/**
 * 将自定义规则合并进 RULE_GROUPS（按 groupKey 插入对应分组）
 * 返回新的分组数组（不修改原常量）
 */
export function mergeCustomRules(custom: CustomRule[]): RuleGroup[] {
  if (custom.length === 0) return RULE_GROUPS;
  const groups = RULE_GROUPS.map(g => ({ key: g.key, name: g.name, icon: g.icon, items: [...g.items] }));
  for (const c of custom) {
    const group = groups.find(g => g.key === c.groupKey);
    const item: MetaCubeXRule = { id: c.id, label: c.label, tag: 'geosite', target: c.target, custom: true };
    if (group) {
      // 去重：同一分组内已存在同 id 则替换
      const idx = group.items.findIndex(i => i.id === c.id);
      if (idx >= 0) group.items[idx] = item;
      else group.items.push(item);
    } else {
      // 分组不存在则放到"用户规则"，不存在就建一个
      const other = groups.find(g => g.key === 'user');
      if (other && !other.items.some(i => i.id === c.id)) other.items.push(item);
    }
  }
  return groups;
}

/**
 * 在合并了自定义规则的分组中查找规则（含自定义）
 */
export function findRuleInGroups(groups: RuleGroup[], id: string): MetaCubeXRule | undefined {
  for (const g of groups) {
    const f = g.items.find(i => i.id === id);
    if (f) return f;
  }
  return undefined;
}