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
import { CFUsageAccount, getCFAccountsRaw, saveCFAccounts, newId, CF_USAGE_LIMIT } from './cf-usage.service';
import { deduplicateNodes } from '@/parser';
import { createCleanRule, applyCleanRules } from '@/models/clean-rule';
import { createSnapshotCache } from './config-cache.service';
import { createOperationLog } from './operation-log.service';
import { KVStorage } from '@/storage/kv';
import { COUNTRIES, countryFlag, countryDisplayName } from '@/data/country-codes';
import { getAllNodeHealth, NodeHealthLatest } from './node-probe.service';

const CLEAN_RULES_KEY = 'clean_rules';

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
 * 自动命名（v2.34：废弃人工清洗规则，生成时统一重命名所有输出格式）。
 * 格式: [旗帜][国家代码] [协议] [延迟ms]-NN，NN = 批次连续序号（01 起，每个节点都带号，2026-09-28 定稿）。
 * - 旗帜+国家码：来自 ip-geo 缓存（复用地理分组同一数据源）
 * - 延迟：node_health.http_latency（无则回退 tcp_latency，冷启动无数据显示 --）
 */
async function smartRename(
  nodes: Node[],
  ipGeoResolver: (server: string) => Promise<string | null>,
  healthByFp: Map<string, NodeHealthLatest>
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
    const h = healthByFp.get(nodeFingerprint(n));
    const lat = h ? (h.httpLatency ?? h.tcpLatency) : null;
    const proto = PROTOCOL_LABELS[n.protocol] || n.protocol;
    const head = country ? `${flag} ${country} ${proto}` : proto;
    const nn = String(i + 1).padStart(2, '0');
    // 有延迟: 45ms-01；无延迟（冷启动）: --01
    n.name = lat != null ? `${head} ${lat}ms-${nn}` : `${head} --${nn}`;
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
  /** 获取禁用的节点指纹列表 */
  getDisabledNodes(): Promise<string[]>;
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
  // ============ 节点名清洗规则（持久化，订阅更新后自动应用） ============
  getCleanRules(): Promise<import('@/models/clean-rule').CleanRule[]>;
  addCleanRule(rule: { pattern: string; replacement?: string; regex?: boolean }): Promise<import('@/models/clean-rule').CleanRule>;
  deleteCleanRule(id: string): Promise<void>;
  toggleCleanRule(id: string, enabled: boolean): Promise<void>;
  /** 对当前全部节点立即执行清洗规则集（手动触发），返回受影响数量 */
  applyCleanRulesNow(): Promise<number>;
  /** 主动预填充：批量合并查询一批 server 的 IP 归属地并写入缓存（查询与配置生成解耦） */
  prewarmGeo(servers: string[]): Promise<PrewarmResult>;
  /** 返回一批 server 中「未识别国家码」的（纯读缓存，不触发外网查询，口径与 resolver 一致） */
  getUnlocatedServers(servers: string[]): Promise<string[]>;
  /** 统计一批 server 中「未识别国家码」的数量（纯读缓存） */
  countUnlocatedGeo(servers: string[]): Promise<number>;
  // ============ Cloudflare 请求统计账户（v2.18.0，仪表盘显示今日请求数） ============
  getCFUsageAccounts(): Promise<CFUsageAccount[]>;
  /** 新增或更新一个 CF 账户；若传 apiToken 则覆盖，否则保留原值 */
  upsertCFUsageAccount(acc: { id?: string; name: string; accountId: string; apiToken?: string }): Promise<CFUsageAccount>;
  deleteCFUsageAccount(id: string): Promise<void>;
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

    // ============ 节点名清洗规则 ============
    async getCleanRules() {
      const raw = await repos.settings.get(CLEAN_RULES_KEY);
      if (!raw) return [];
      try {
        return JSON.parse(raw) as import('@/models/clean-rule').CleanRule[];
      } catch {
        return [];
      }
    },

    async addCleanRule(rule) {
      const rules = await this.getCleanRules();
      const created = createCleanRule({
        pattern: rule.pattern,
        replacement: rule.replacement ?? '',
        regex: rule.regex ?? false,
      });
      rules.push(created);
      await repos.settings.set(CLEAN_RULES_KEY, JSON.stringify(rules));
      return created;
    },

    async deleteCleanRule(id) {
      const rules = await this.getCleanRules();
      await repos.settings.set(CLEAN_RULES_KEY, JSON.stringify(rules.filter((r) => r.id !== id)));
    },

    async toggleCleanRule(id, enabled) {
      const rules = await this.getCleanRules();
      const target = rules.find((r) => r.id === id);
      if (!target) throw new Error('Clean rule not found');
      target.enabled = enabled;
      await repos.settings.set(CLEAN_RULES_KEY, JSON.stringify(rules));
    },

    async applyCleanRulesNow() {
      const rules = await this.getCleanRules();
      let changed = 0;
      const subs = await repos.subscriptions.list();
      const nodesBySub = await repos.nodes.getBySubscriptions(subs.map((s) => s.id));
      for (const sub of subs) {
        const nodes = nodesBySub.get(sub.id) ?? [];
        let subChanged = false;
        const transformed = nodes.map((n) => {
          // 始终从原始名出发应用全部启用规则（幂等且删除规则后可正确还原）
          const base = n.metadata?.originalName ?? n.name;
          const newName = applyCleanRules(base, rules);
          if (newName !== n.name) {
            changed++;
            subChanged = true;
            return { ...n, name: newName };
          }
          return n;
        });
        if (subChanged) await repos.nodes.setBySubscription(sub.id, transformed);
      }
      return changed;
    },

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

    async getCFUsageAccounts(): Promise<CFUsageAccount[]> {
      return getCFAccountsRaw(repos);
    },

    async getNodes(): Promise<Node[]> {
      // 去重：按 server:port:protocol 三项指纹，合并多订阅重复节点
      // （getAll() 已排除停用订阅的节点 —— 用户 2026-09-24）
      const all = deduplicateNodes(await repos.nodes.getAll());
      // 过滤禁用的节点 + 死节点过滤（status != 'disabled' / removed_at）
      const disabled = new Set(await this.getDisabledNodes());
      return all.filter((n) => {
        if (disabled.has(nodeFingerprint(n))) return false;
        if (n.status === 'disabled') return false;
        if (n.removed_at) return false;
        return true;
      });
    },

    async upsertCFUsageAccount(acc): Promise<CFUsageAccount> {
      const list = await getCFAccountsRaw(repos);
      const existing = acc.id ? list.find((a) => a.id === acc.id) : undefined;
      if (existing) {
        // token 为空 = 保留原值（编辑时不回显、不要求重填）
        existing.name = acc.name;
        existing.accountId = acc.accountId;
        if (acc.apiToken) existing.apiToken = acc.apiToken;
        await saveCFAccounts(repos, list);
        return existing;
      }
      // 新增：限制最多 CF_USAGE_LIMIT 个
      if (list.length >= CF_USAGE_LIMIT) {
        throw new Error(`最多可添加 ${CF_USAGE_LIMIT} 个 Cloudflare 账户`);
      }
      if (!acc.apiToken) throw new Error('新增账户必须填写 API Token');
      const created: CFUsageAccount = {
        id: newId(),
        name: acc.name,
        accountId: acc.accountId,
        apiToken: acc.apiToken,
        enabled: true,
        sort: list.length,
      };
      list.push(created);
      await saveCFAccounts(repos, list);
      return created;
    },

    async deleteCFUsageAccount(id: string): Promise<void> {
      const list = await getCFAccountsRaw(repos);
      await saveCFAccounts(repos, list.filter((a) => a.id !== id));
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
      await smartRename(nodes, ipGeoResolver, healthByFp);

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