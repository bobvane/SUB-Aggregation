/**
 * 国家/地区代码表（CF_COUNTRIES）
 *
 * 数据源：Cloudflare 数据中心实际覆盖的国家/地区（135 个）
 *   https://github.com/LufsX/Cloudflare-Data-Center-IATA-Code-list
 *   cloudflare-iata-full.json 的 cca2 字段（ISO 3166-1 alpha-2）
 *
 * 选型理由：CF 在这些国家有真实机房，意味着该国有机房基础，
 *   机场节点出现在这些国家的概率远高于其余 ISO 国家（梵蒂冈等永不会有机场节点）。
 *
 * 用途（共用一个表，避免维护多份）：
 *   1. 节点名识别：节点名里的二字码/中文名 → 地区分组
 *   2. IP 定位兜底：ip-api 返回 cca2 → 中文地区名
 */

export interface CountryInfo {
  /** ISO 3166-1 alpha-2 国家码（ip-api 返回的 countryCode 与此一致） */
  code: string;
  /** 中文名 */
  name: string;
  /** 国旗 emoji */
  emoji: string;
}

/** 美国API外露国家码 → 中文名（CF 数据中心覆盖的 135 国/地区） */
const COUNTRY_NAMES_ZH: Record<string, string> = {
  AE: '阿联酋', AL: '阿尔巴尼亚', AM: '亚美尼亚', AO: '安哥拉', AR: '阿根廷',
  AT: '奥地利', AU: '澳大利亚', AZ: '阿塞拜疆', BB: '巴巴多斯', BD: '孟加拉国',
  BE: '比利时', BF: '布基纳法索', BG: '保加利亚', BH: '巴林', BN: '文莱',
  BO: '玻利维亚', BR: '巴西', BT: '不丹', BW: '博茨瓦纳', BY: '白俄罗斯',
  CA: '加拿大', CD: '刚果金', CH: '瑞士', CI: '科特迪瓦', CL: '智利', CM: '喀麦隆',
  CN: '中国', CO: '哥伦比亚', CR: '哥斯达黎加', CY: '塞浦路斯', CZ: '捷克',
  DE: '德国', DJ: '吉布提', DK: '丹麦', DO: '多米尼加', DZ: '阿尔及利亚',
  EC: '厄瓜多尔', EE: '爱沙尼亚', EG: '埃及', ES: '西班牙', ET: '埃塞俄比亚',
  FI: '芬兰', FJ: '斐济', FR: '法国', GB: '英国', GD: '格林纳达', GE: '格鲁吉亚',
  GH: '加纳', GR: '希腊', GT: '危地马拉', GU: '关岛', GY: '圭亚那', HK: '香港',
  HN: '洪都拉斯', HR: '克罗地亚', HU: '匈牙利', ID: '印尼', IE: '爱尔兰', IL: '以色列',
  IN: '印度', IQ: '伊拉克', IS: '冰岛', IT: '意大利', JM: '牙买加', JO: '约旦',
  JP: '日本', KE: '肯尼亚', KG: '吉尔吉斯斯坦', KH: '柬埔寨', KR: '韩国', KW: '科威特',
  KZ: '哈萨克斯坦', LA: '老挝', LB: '黎巴嫩', LK: '斯里兰卡', LT: '立陶宛', LU: '卢森堡',
  LV: '拉脱维亚', MD: '摩尔多瓦', MG: '马达加斯加', MK: '北马其顿', MN: '蒙古', MO: '澳门',
  MT: '马耳他', MU: '毛里求斯', MV: '马尔代夫', MW: '马拉维', MX: '墨西哥', MY: '马来西亚',
  MZ: '莫桑比克', NA: '纳米比亚', NC: '新喀里多尼亚', NG: '尼日利亚', NL: '荷兰', NO: '挪威',
  NP: '尼泊尔', NZ: '新西兰', OM: '阿曼', PA: '巴拿马', PE: '秘鲁', PF: '法属波利尼西亚',
  PH: '菲律宾', PK: '巴基斯坦', PL: '波兰', PR: '波多黎各', PS: '巴勒斯坦', PT: '葡萄牙',
  PY: '巴拉圭', QA: '卡塔尔', RE: '留尼汪', RO: '罗马尼亚', RS: '塞尔维亚', RU: '俄罗斯',
  RW: '卢旺达', SA: '沙特', SE: '瑞典', SG: '新加坡', SI: '斯洛文尼亚', SK: '斯洛伐克',
  SN: '塞内加尔', SR: '苏里南', TH: '泰国', TN: '突尼斯', TR: '土耳其', TT: '特立尼达',
  TW: '台湾', TZ: '坦桑尼亚', UA: '乌克兰', UG: '乌干达', US: '美国', UZ: '乌兹别克斯坦',
  VN: '越南', ZA: '南非', ZM: '赞比亚', ZW: '津巴布韦',
};

/** ISO 3166-1 alpha-2 → 国旗 emoji */
export function countryFlag(code: string): string {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '';
  return String.fromCodePoint(...[...upper].map(c => 0x1f1e6 + c.charCodeAt(0) - 0x41));
}

/** 国家/地区码 → 信息（含 flag emoji 与中文名） */
export const COUNTRIES: Record<string, CountryInfo> = Object.fromEntries(
  Object.entries(COUNTRY_NAMES_ZH).map(([code, name]) => [
    code,
    { code, name, emoji: countryFlag(code) },
  ])
);

/** 国家/地区码 → "emoji 中文名"（地理分组用的显示名，如 🇭🇰 香港） */
export function countryDisplayName(code: string): string | null {
  const info = COUNTRIES[code];
  if (!info) return null;
  return `${info.emoji} ${info.name}`;
}

/** 地理组默认排序（按主流机场节点常见度） */
export const GEO_ORDER: string[] = [
  '🇭🇰 香港', '🇯🇵 日本', '🇺🇸 美国', '🇸🇬 新加坡', '🇹🇼 台湾', '🇰🇷 韩国',
  '🇬🇧 英国', '🇩🇪 德国', '🇫🇷 法国', '🇨🇦 加拿大', '🇦🇺 澳大利亚', '🇮🇳 印度',
  '🇷🇺 俄罗斯', '🇧🇷 巴西', '🇳🇱 荷兰', '🇸🇪 瑞典', '🇳🇴 挪威', '🇫🇮 芬兰',
  '🇩🇰 丹麦', '🇮🇹 意大利', '🇪🇸 西班牙', '🇨🇭 瑞士', '🇦🇪 阿联酋', '🇹🇷 土耳其',
  '🇹🇭 泰国', '🇻🇳 越南', '🇲🇾 马来西亚', '🇵🇭 菲律宾', '🇮🇩 印尼', '🇳🇿 新西兰',
  '🇲🇴 澳门', '🇨🇳 中国',
];