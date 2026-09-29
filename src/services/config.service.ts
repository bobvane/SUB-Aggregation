/**
 * 配置输出服务
 * TASK 5.3 - Subscription Endpoint
 * 支持：节点启用状态过滤（disabled_nodes 存储于 KV Settings）
 * v2.32: 配置快照缓存 + 智能重命名 + 死节点过滤
 */

import { Node, nodeFingerprint } from '@/models/node';
import { Repositories } from '@/storage/kv';
import { generateMihomoConfig } from '@/generator/mihomo';
import { generateSingboxConfig } from '@/generator/singbox';
import { generateBase64Config } from '@/generator/base64-generator';
import { nodeToUrl } from '@/generator/node-to-url';
import { MetaCubeXRule, RULE_GROUPS, CustomRule, mergeCustomRules, findRuleInGroups } from '@/data/metacubex-rules';
import { createIpGeoResolver, prewarmIpGeo, PrewarmResult, filterUnlocatedServers, countUnlocatedGeo } from './ip-geo.service';
import { deduplicateNodes } from '@/parser';
import { createSnapshotCache } from './config-cache.service';
import { createOperationLog } from './operation-log.service';
import { KVStorage } from '@/storage/kv';
import { COUNTRIES, countryFlag, countryDisplayName } from '@/data/country-codes';
import { getAllNodeHealth, nodeLatencyMs, getNodeHealthHistory, NodeHealthLatest } from './node-probe.service';

/** 协议 → 配置显示名（与前端 displayProtocol 一致） */
const PROTOCOL_LABELS: Record<Node['protocol'], string> = {
  vless: 'VLESS', vmess: 'VMESS', trojan: 'Trojan', ss: 'Shadowsocks', ssr: 'ShadowsocksR',
  hysteria2: 'Hysteria2', tuic: 'TUIC', wireguard: 'WireGuard', anytls: 'AnyTLS',
};

/** 地理显示名（"🇭🇰 香港"，即 ip-geo 缓存存的值）→ ISO 码（逆向查表） */
const DISPLAY_TO_CODE: Record<string, string> = {};
for (const code of Object.keys(COUNTRIES)) {
  const d = countryDisplayName(code);
  if (d) DISPLAY_TO_CODE[d] = code;
}

/**
 * 自动命名（v2.36 起不含延迟：延迟每次都变，写进名字会让客户端把节点当新节点）
 * - 格式：🇭🇰 HK VLESS-01（无国家信息时降级为 VLESS-01）
 * - 旗帜+国家码：来自 ip-geo 缓存（复用地理分组同一数据源）
 * - 同时把国家码写回 metadata.country，供列表页按国家分组排序
 */
async function smartRename(
  nodes: Node[],
  ipGeoResolver: (server: string) => Promise<string | null>
): Promise<void> {
  const geoCache = new Map<string, string | null>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    let country = '';
    if (!geoCache.has(n.server)) {
      geoCache.set(n.server, ipGeoResolver ? await ipGeoResolver(n.server) : null);
    }
    const geoName = geoCache.get(n.server);
    if (geoName) country = DISPLAY_TO_CODE[geoName] || '';
    const flag = country ? countryFlag(country) : '';
    const proto = PROTOCOL_LABELS[n.protocol] || n.protocol;
    const head = country ? `${flag} ${country} ${proto}` : proto;
    const nn = String(i + 1).padStart(2, '0');
    n.name = `${head}-${nn}`;
    if (country) n.metadata = { ...n.metadata, country };
  }
}

/** node 名 → 健康得分（地理组内排序用，未知分返回 undefined 靠后） */
function buildScoreOf(
  nodes: Node[],
  healthByFp: Map<string, NodeHealthLatest>
): (name: string) => number | undefined {
  return (name: string) => {
    const n = nodes.find((x) => x.name === name);
    const h = n ? healthByFp.get(nodeFingerprint(n)) : undefined;
    return h ? h.score : undefined;
  };
}

export type OutputFormat =
  | 'mihomo'
  | 'singbox'
  | 'v2ray'
  | 'v2rayn'
  | 'nekoray'
  | 'shadowrocket';

export interface OutputResult {
  content: string;
  contentType: string;
  filename: string;
}

export interface ConfigService {
  generate(format: OutputFormat): Promise<string>;
  generateOutput(format: OutputFormat): Promise<OutputResult>;
  getNodes(): Promise<Node[]>;
  /** 自动命名后的节点（展示用：与配置输出同一套命名，不改动库中原始名） */
  autoNamed(nodes: Node[]): Promise<Node[]>;
  /** 获取禁用的节点指纹列表 */
  getDisabledNodes(): Promise<string[]>;
  /** 熔断抛弃的节点指纹（连续失败 3 次），不输出到配置但保留记录继续测活 */
  getDroppedNodes(): Promise<string[]>;
  /** 设置禁用的节点指纹列表 */
  setDisabledNodes(fingerprints: string[]): Promise<void>;
  /** 获取用户勾选的规则 id 列表 */
  getSelectedRuleIds(): Promise<string[]>;
  /** 设置用户勾选的规则 id 列表 */
  setSelectedRuleIds(ids: string[]): Promise<void>;
  /** 获取整组取消的规则大类 key 列表（v2.27.0 锁死模型：内置规则只能整组开关） */
  getDisabledGroupKeys(): Promise<string[]>;
  /** 设置整组取消的规则大类 key 列表 */
  setDisabledGroupKeys(keys: string[]): Promise<void>;
  /** 获取用户勾选的完整规则对象列表（由 id 解析自 RULE_GROUPS） */
  getSelectedRules(): Promise<MetaCubeXRule[]>;
  /** 获取自定义规则列表 */
  getCustomRules(): Promise<CustomRule[]>;
  /** 添加/更新一条自定义规则 */
  upsertCustomRule(rule: CustomRule): Promise<void>;
  /** 删除一条自定义规则（按 id） */
  deleteCustomRule(id: string): Promise<void>;
  /** 获取合并自定义规则后的完整分组（供 /api/rules/groups 返回） */
  getMergedGroups(): Promise<(typeof RULE_GROUPS)[number][]>;
  // ============ 节点名清洗规则（v2.35 已废弃，改为生成时自动命名） ============

  /** 主动预填充：批量合并查询一批 server 的 IP 归属地并写入缓存（查询与配置生成解耦） */
  prewarmGeo(servers: string[]): Promise<PrewarmResult>;
  /** 返回一批 server 中「未识别国家码」的（纯读缓存，不触发外网查询，口径与 resolver 一致） */
  getUnlocatedServers(servers: string[]): Promise<string[]>;
  /** 统计一批 server 中「未识别国家码」的数量（纯读缓存） */
  countUnlocatedGeo(servers: string[]): Promise<number>;
  /** v2.32: 主动清除配置快照缓存(测试/订阅状态变更时调用) */
  resetCache(): Promise<void>;
}

const FORMAT_META: Record<OutputFormat, { contentType: string; filename: string }> = {
  mihomo: { contentType: 'text/yaml; charset=utf-8', filename: 'mihomo.yaml' },
  singbox: { contentType: 'application/json; charset=utf-8', filename: 'sing-box.json' },
  v2ray: { contentType: 'text/plain; charset=utf-8', filename: 'v2ray.txt' },
  v2rayn: { contentType: 'text/plain; charset=utf-8', filename: 'v2rayn.txt' },
  nekoray: { contentType: 'text/plain; charset=utf-8', filename: 'nekoray.txt' },
  shadowrocket: { contentType: 'text/plain; charset=utf-8', filename: 'shadowrocket.txt' },
};

const DISABLED_NODES_KEY = 'disabled_nodes';
const SELECTED_RULES_KEY = 'selected_rules';
const CUSTOM_RULES_KEY = 'custom_rules';
const DISABLED_GROUPS_KEY = 'disabled_groups';

export function createConfigService(repos: Repositories, kv: KVStorage): ConfigService {
  const snapshotCache = createSnapshotCache(kv);
  const opLog = createOperationLog(kv);

  return {

    async getDisabledNodes(): Promise<string[]> {
      const raw = await repos.settings.get(DISABLED_NODES_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },

    async setDisabledNodes(fingerprints: string[]): Promise<void> {
      const unique = [...new Set(fingerprints)];
      await repos.settings.set(DISABLED_NODES_KEY, JSON.stringify(unique));
      await snapshotCache.invalidateAll();
      await opLog.logManualAction(`手动禁用 ${unique.length} 个节点`);
    },

    async getSelectedRuleIds(): Promise<string[]> {
      const raw = await repos.settings.get(SELECTED_RULES_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },

    async setSelectedRuleIds(ids: string[]): Promise<void> {
      const unique = [...new Set(ids)];
      await repos.settings.set(SELECTED_RULES_KEY, JSON.stringify(unique));
      await snapshotCache.invalidateAll();
      await opLog.logManualAction(`更新规则选择，共 ${unique.length} 个规则`);
    },

    async getDisabledGroupKeys(): Promise<string[]> {
      const raw = await repos.settings.get(DISABLED_GROUPS_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },

    async setDisabledGroupKeys(keys: string[]): Promise<void> {
      const unique = [...new Set(keys)];
      await repos.settings.set(DISABLED_GROUPS_KEY, JSON.stringify(unique));
      await snapshotCache.invalidateAll();
      await opLog.logManualAction(`更新禁用分组，共 ${unique.length} 个分组`);
    },

    async getSelectedRules(): Promise<MetaCubeXRule[]> {
      const ids = await this.getSelectedRuleIds();
      const groups = await this.getMergedGroups();
      // 自动注入 native 固定规则：即使未勾选也要输出（承重墙）
      const fixedNativeIds = new Set(
        groups.flatMap(g => g.items.filter(it => it.fixed && it.native).map(it => it.id))
      );
      const mergedIds = [...new Set([...ids, ...fixedNativeIds])];
      return mergedIds
        .map((id) => findRuleInGroups(groups, id))
        .filter((r): r is MetaCubeXRule => r !== undefined);
    },

    async getCustomRules(): Promise<CustomRule[]> {
      const raw = await repos.settings.get(CUSTOM_RULES_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as CustomRule[] : [];
      } catch {
        return [];
      }
    },

    async upsertCustomRule(rule: CustomRule): Promise<void> {
      const rules = await this.getCustomRules();
      const idx = rules.findIndex((r) => r.id === rule.id);
      const item: CustomRule = { ...rule, createdAt: rule.createdAt ?? Date.now() };
      if (idx >= 0) rules[idx] = item;
      else rules.push(item);
      await repos.settings.set(CUSTOM_RULES_KEY, JSON.stringify(rules));
      await snapshotCache.invalidateAll();
      await opLog.logManualAction(`添加/更新自定义规则 ${rule.id}`);
    },

    async deleteCustomRule(id: string): Promise<void> {
      const rules = await this.getCustomRules();
      const filtered = rules.filter((r) => r.id !== id);
      await repos.settings.set(CUSTOM_RULES_KEY, JSON.stringify(filtered));
      // 同时从勾选集合中移除
      const selected = await this.getSelectedRuleIds();
      if (selected.includes(id)) {
        await this.setSelectedRuleIds(selected.filter((s) => s !== id));
      }
      await snapshotCache.invalidateAll();
      await opLog.logManualAction(`删除自定义规则 ${id}`);
    },

    async getMergedGroups() {
      const custom = await this.getCustomRules();
      return mergeCustomRules(custom);
    },

    // ============ 节点名清洗规则（v2.35 已废弃：改为生成时自动命名 smartRename） ============

    async prewarmGeo(servers: string[]): Promise<PrewarmResult> {
      return prewarmIpGeo(
        servers,
        { get: (k) => repos.settings.get(k), set: (k, v) => repos.settings.set(k, v) },
      );
    },

    async getUnlocatedServers(servers: string[]): Promise<string[]> {
      return filterUnlocatedServers(
        servers,
        { get: (k) => repos.settings.get(k), set: (k, v) => repos.settings.set(k, v) },
      );
    },

    async countUnlocatedGeo(servers: string[]): Promise<number> {
      return countUnlocatedGeo(
        servers,
        { get: (k) => repos.settings.get(k), set: (k, v) => repos.settings.set(k, v) },
      );
    },

    async getNodes(): Promise<Node[]> {
      // 去重：按 server:port:protocol 三项指纹，合并多订阅重复节点
      // （getAll() 已排除停用订阅的节点 —— 用户 2026-09-24）
      const all = deduplicateNodes(await repos.nodes.getAll());
      // 过滤：手动禁用 + 熔断抛弃 + removed
      const disabled = new Set(await this.getDisabledNodes());
      const dropped = new Set(await this.getDroppedNodes());
      return all.filter((n) => {
        if (disabled.has(nodeFingerprint(n))) return false;
        if (dropped.has(nodeFingerprint(n))) return false;
        if (n.status === 'disabled') return false;
        if (n.removed_at) return false;
        return true;
      });
    },

    /**
     * 熔断抛弃的节点。
     * v2.36.2：最新一轮探测 dead 即从配置剔除（立即生效、可自愈）。
     * v2.36.6：延迟超过用户设定阈值（设置页 node_drop_latency_ms，100-2000ms，默认 2000）
     * 的节点同样抛弃——通着但太慢，进配置无意义。
     */
    async getDroppedNodes(): Promise<string[]> {
      let threshold = 2000;
      try {
        const raw = Number((await repos.settings.get('node_drop_latency_ms')) ?? '');
        if (Number.isFinite(raw) && raw >= 100 && raw <= 2000) threshold = raw;
      } catch { /* 读设置失败用默认值 */ }
      const health = await getAllNodeHealth(kv);
      const dropped: string[] = [];
      for (const h of health) {
        if (h.status === 'dead') { dropped.push(h.fingerprint); continue; }
        const latency = nodeLatencyMs(h);
        if (latency == null || latency <= threshold) continue;
        // 超阈值：单次尖峰不算数（实测 VPS 单轮 1000ms、平时 150ms，单轮即抛会误杀）
        // 最近 3 条记录里 ≥2 条超阈值才抛弃；历史不足 3 条时维持原行为（最新 1 次即抛）
        const history = await getNodeHealthHistory(h.fingerprint, kv, 3);
        const overCount = history.filter(x => (nodeLatencyMs(x) ?? 0) > threshold).length;
        if (history.length < 3 || overCount >= 2) dropped.push(h.fingerprint);
      }
      return dropped;
    },

    /**
     * 自动命名后的节点（展示用）。
     * v2.35 起清洗不再写库，节点名只在输出时生成 → 列表页必须走这里，
     * 否则用户看到的是订阅原始名，与生成的配置不一致。
     * 返回重命名后的新数组，不改动入参/库中数据。
     */
    async autoNamed(nodes: Node[]): Promise<Node[]> {
      const copy = nodes.map((n) => ({ ...n }));
      const ipGeoResolver = createIpGeoResolver({
        get: (k) => repos.settings.get(k),
        set: (k, v) => repos.settings.set(k, v),
      });
      await smartRename(copy, ipGeoResolver);
      return copy;
    },

    async generate(format: OutputFormat): Promise<string> {
      // 只缓存 mihomo（90% 拉取量），singbox/v2ray 直接生成
      if (format === 'mihomo') {
        const version = await snapshotCache.getVersion();
        const cached = await snapshotCache.getCachedConfig(format);
        if (cached && cached.version === version) {
          return cached.content;
        }
      }

      // 获取已过滤的节点（去重 + 禁用/死节点过滤）
      const nodes = await this.getNodes();

      // 自动命名（v2.34 废弃人工清洗）：[旗帜][国家代码] [协议] [延迟ms]-NN
      const ipGeoResolver = createIpGeoResolver({
        get: (k) => repos.settings.get(k),
        set: (k, v) => repos.settings.set(k, v),
      });
      const healthList = await getAllNodeHealth(kv);
      const healthByFp = new Map<string, NodeHealthLatest>(healthList.map(h => [h.fingerprint, h]));
      await smartRename(nodes, ipGeoResolver);

      let content = '';
      switch (format) {
        case 'mihomo':
          content = await generateMihomoConfig(
            nodes,
            await this.getSelectedRules(),
            await this.getMergedGroups(),
            ipGeoResolver,
            new Set(await this.getDisabledGroupKeys()),
            buildScoreOf(nodes, healthByFp)
          );
          // 写缓存
          const newVersion = await snapshotCache.getVersion();
          await snapshotCache.setCachedConfig(format, content, newVersion);
          break;
        case 'singbox':
          content = generateSingboxConfig(nodes);
          break;
        case 'v2ray':
        case 'v2rayn':
        case 'nekoray':
        case 'shadowrocket':
          content = generateBase64Config(nodes);
          break;
        default:
          content = '';
      }
      return content;
    },

    async generateOutput(format: OutputFormat): Promise<OutputResult> {
      const content = await this.generate(format);
      return {
        content,
        contentType: FORMAT_META[format].contentType,
        filename: FORMAT_META[format].filename,
      };
    },

    async resetCache(): Promise<void> {
      await snapshotCache.invalidateAll();
    },
  };
}

/**
 * 生成单节点链接（无 Base64 编码，调试用）
 */
export function nodeToLink(node: Node): string {
  return nodeToUrl(node);
}