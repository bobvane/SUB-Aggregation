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
import { getAllNodeHealth, type NodeHealthLatest } from './node-probe.service';

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
  /**
   * 清理「已退出有效节点池」节点的最新健康快照（health:latest:{fp}）。
   *
   * 背景：health:hist 有 30 天 TTL，但 health:latest 从无清理机制。
   * 节点被订阅移除或标记 removed_at 墓碑后，其 latest 快照会永久残留，导致：
   *  ① getDroppedNodes() 返回无对应节点的幽灵指纹；
   *  ② 同一指纹重新加入时，沿用旧 statusMachine/score 直至首轮探测覆盖。
   *
   * 有效节点池口径（**与 getNodes() 的配置输出口径不同，此处按数据生命周期判定**）：
   *  · 用 getAll(true) 取得**含停用订阅**的全部节点 —— 订阅仅是停用而非删除，
   *    其节点数据仍在库中，重启/重新启用后立刻可用，因此**不得**清理其快照；
   *  · 排除 removed_at 墓碑节点 —— 它们已不参与任何配置输出，属可清理对象。
   *
   * 安全机制：
   *  · 节点池读取失败 / 解析异常 → 直接跳过本轮，**不删除任何快照**（宁可不清理，不可误删）；
   *  · 幂等：重复执行结果一致；
   *  · 只删 latest，**不触碰 health:hist**（历史继续遵守既有 30 天 TTL）。
   */
  cleanupOrphanedHealthSnapshots(): Promise<{ scanned: number; removed: number; skipped: boolean }>;
  /** 设置禁用的节点指纹列表 */
  setDisabledNodes(fingerprints: string[]): Promise<void>;
  /** 获取锁定的节点指纹列表（v2.36.9：锁定节点无视测活/延迟/禁用，强制进配置） */
  getLockedNodes(): Promise<string[]>;
  /** 设置锁定的节点指纹列表 */
  setLockedNodes(fingerprints: string[]): Promise<void>;
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
const LOCKED_NODES_KEY = 'locked_nodes';
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

    async getLockedNodes(): Promise<string[]> {
      const raw = await repos.settings.get(LOCKED_NODES_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },

    async setLockedNodes(fingerprints: string[]): Promise<void> {
      const unique = [...new Set(fingerprints)];
      await repos.settings.set(LOCKED_NODES_KEY, JSON.stringify(unique));
      await snapshotCache.invalidateAll();
      await opLog.logManualAction(`锁定 ${unique.length} 个节点（强制进配置）`);
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
      // 过滤：手动禁用 + 熔断抛弃 + removed（v2.36.9：锁定节点全部豁免，强制进配置）
      const disabled = new Set(await this.getDisabledNodes());
      const dropped = new Set(await this.getDroppedNodes());
      const locked = new Set(await this.getLockedNodes());
      return all.filter((n) => {
        const fp = nodeFingerprint(n);
        if (locked.has(fp)) return true;
        if (disabled.has(fp)) return false;
        if (dropped.has(fp)) return false;
        if (n.removed_at) return false;
        // v2.38 P1（阶段 1）：UDP 协议（hysteria2/tuic/wireguard）不再按
        // “探测引擎不适用”从配置剔除。TCP/TLS 探测不适用 ≠ 节点不可用；
        // 节点可用性由协议字段映射、客户端健康检查与用户锁定/禁用语义共同决定。
        return true;
      });
    },

    /**
     * 系统剔除的节点（v2.38 / P1 阶段 1：只保留确认失效的系统剔除）。
     * 规则：
     * 1. statusMachine === 'disabled'（连续失败 ≥3 轮，由 evaluateStateMachine 确认）→ 剔除。
     * 2. 用户主动禁用（getDisabledNodes）与锁定豁免语义不变。
     * 已移除：基于 TCP/TLS 握手延迟阈值的慢节点硬剔除（node_drop_latency_ms 不再影响配置筛选，
     *   握手延迟 ≠ 代理实际转发延迟，不应据此剔除节点）。
     * 单轮 dead → suspect 保留在配置里；恢复 alive → active 自动回归（既有状态机语义不变）。
     */
    async getDroppedNodes(): Promise<string[]> {
      const health = await getAllNodeHealth(kv);
      const dropped: string[] = [];
      for (const h of health) {
        // 确认失效：状态机连续失败 ≥3 轮（statusMachine === 'disabled'）才剔除
        if (h.statusMachine === 'disabled') dropped.push(h.fingerprint);
      }
      return dropped;
    },

    /**
     * 清理已退出有效节点池的 health:latest:{fp} 快照（详见接口注释）。
     *
     * 保守策略：任何异常都视为「无法确认有效节点集合」→ 跳过本轮，不删任何键。
     */
    async cleanupOrphanedHealthSnapshots() {
      // ---- 1. 构造有效节点指纹集合（失败即放弃，不猜） ----
      let validFps: Set<string>;
      try {
        // getAll(true)：含停用订阅。停用 ≠ 删除，节点数据仍在库中，随时可能重新启用，
        // 清理其快照会导致重新启用后丢失历史健康信息 —— 因此必须保留。
        const allNodes = await repos.nodes.getAll(true);
        if (!Array.isArray(allNodes)) return { scanned: 0, removed: 0, skipped: true };
        validFps = new Set<string>();
        for (const n of allNodes) {
          // removed_at 墓碑：数据仍在库但已不参与任何配置输出 → 可清理
          if (n.removed_at) continue;
          validFps.add(nodeFingerprint(n));
        }
      } catch {
        // 节点池不可读：宁可不清理，也不能用不完整集合误删有效快照
        return { scanned: 0, removed: 0, skipped: true };
      }

      // ---- 2. 枚举全部 latest 快照 ----
      let keys: Array<{ key: string }>;
      try {
        keys = await kv.list('health:latest:');
      } catch {
        return { scanned: 0, removed: 0, skipped: true };
      }
      if (!Array.isArray(keys)) return { scanned: 0, removed: 0, skipped: true };

      // ---- 3. 逐个比对并删除孤儿快照（只删 latest，不动 health:hist） ----
      let removed = 0;
      for (const { key } of keys) {
        const fp = key.slice('health:latest:'.length);
        if (!fp) continue;            // 畸形键，保持原样不做判断
        if (validFps.has(fp)) continue; // 有效节点：保留
        try {
          await kv.delete(key);
          removed++;
        } catch {
          // 单个键删除失败不中断整轮，剩余的继续尝试
        }
      }

      return { scanned: keys.length, removed, skipped: false };
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