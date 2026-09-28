/**
 * 订阅服务 - Subscription Service
 * TASK 3.x：订阅的创建、删除、更新、查询
 * 更新流程：Fetch → Decode → Parse → Normalize → Store（EPIC 3/4 接入）
 * 支持：订阅 URL 和直接节点链接（vless:// 等）
 * v2.32: 增加 Subscription Diff + 节点探测触发
 */

import { Subscription } from '@/models/subscription';
import { Node } from '@/models/node';
import { Repositories } from '@/storage/kv';
import { KVStorage } from '@/storage/kv';
import {
  parseSubscriptionContent,
  applyRules,
} from '@/parser';
import { nodeFingerprint } from '@/services/node-probe.service';
import { createOperationLog } from '@/services/operation-log.service';

const NODE_LINK_PREFIXES = ['vmess://', 'vless://', 'trojan://', 'ss://', 'ssr://', 'hysteria2://', 'tuic://'];

/**
 * 判断是否为直接节点链接（非 HTTP 订阅 URL）
 */
export function isNodeLink(url: string): boolean {
  return NODE_LINK_PREFIXES.some(prefix => url.trim().toLowerCase().startsWith(prefix));
}

export interface DiffResult {
  added: number;
  removed: number;
  unchanged: number;
  changed: number;
  addedNodes: Node[];
  removedNodes: Node[];
  changedNodes: Node[];
}

export interface SubscriptionService {
  list(): Promise<Subscription[]>;
  getById(id: string): Promise<Subscription | null>;
  create(name: string, url: string): Promise<Subscription>;
  delete(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<Subscription | null>;
  update(id: string, fetcher: (url: string) => Promise<string>): Promise<{
    subscription: Subscription;
    nodes: Node[];
    nodeCount: number;
    diff: DiffResult;
  }>;
  /** v2.32: 触发全量节点探测（异步，不阻塞） */
  triggerProbe(): Promise<void>;
}

function diffNodes(oldNodes: Node[], newNodes: Node[]): DiffResult {
  const oldMap = new Map(oldNodes.map(n => [nodeFingerprint(n), n]));
  const newMap = new Map(newNodes.map(n => [nodeFingerprint(n), n]));
  
  const addedNodes: Node[] = [];
  const removedNodes: Node[] = [];
  const changedNodes: Node[] = [];
  let unchanged = 0;
  
  // 新增 + 变化
  for (const [fp, newNode] of newMap) {
    const oldNode = oldMap.get(fp);
    if (!oldNode) {
      // 新增节点
      addedNodes.push({ ...newNode, original_address: newNode.server, first_seen_at: Date.now() });
    } else {
      // 对比字段是否变化（排除 dynamic 字段）
      const fields = ['name', 'server', 'port', 'protocol', 'password', 'uuid', 'tls', 'transport', 'flow', 'pbk', 'sid', 'sni', 'allowInsecure'];
      const isChanged = fields.some(f => oldNode[f as keyof Node] !== newNode[f as keyof Node]);
      
      if (isChanged) {
        // 变化节点：保留 original_address、first_seen_at
        changedNodes.push({
          ...newNode,
          original_address: oldNode.original_address ?? oldNode.server,
          first_seen_at: oldNode.first_seen_at ?? Date.now(),
        });
      } else {
        unchanged++;
      }
    }
  }
  
  // 删除（tombstone：标记 removed_at，不物理删除）
  for (const [fp, oldNode] of oldMap) {
    if (!newMap.has(fp)) {
      removedNodes.push({ ...oldNode, removed_at: Date.now(), status: 'removed' as const });
    }
  }
  
  return {
    added: addedNodes.length,
    removed: removedNodes.length,
    unchanged,
    changed: changedNodes.length,
    addedNodes,
    removedNodes,
    changedNodes,
  };
}

function mergeNodes(oldNodes: Node[], diff: DiffResult): Node[] {
  const result: Node[] = [];
  const removedFps = new Set(diff.removedNodes.map(nodeFingerprint));
  
  // 保留未删除的旧节点（保留 original_address/first_seen_at/status）
  for (const oldNode of oldNodes) {
    if (!removedFps.has(nodeFingerprint(oldNode))) {
      result.push(oldNode);
    }
  }
  
  // 添加新增节点
  result.push(...diff.addedNodes);
  
  // 更新变化节点
  for (const changed of diff.changedNodes) {
    const idx = result.findIndex(n => nodeFingerprint(n) === nodeFingerprint(changed));
    if (idx >= 0) result[idx] = changed;
    else result.push(changed);
  }
  
  return result;
}

export function createSubscriptionService(
  repos: Repositories,
  fetchRawContent: (url: string) => Promise<string>,
  getRules: () => Promise<{ type: 'include' | 'exclude' | 'replace'; pattern: string; enabled?: boolean }[]>,
  kv: KVStorage
): SubscriptionService {
  const opLog = createOperationLog(kv);
  
  return {
    async list() {
      return repos.subscriptions.list();
    },

    async getById(id: string) {
      return repos.subscriptions.getById(id);
    },

    async create(name: string, url: string) {
      return repos.subscriptions.create({ name, url });
    },

    async delete(id: string) {
      return repos.subscriptions.delete(id);
    },

    async setEnabled(id: string, enabled: boolean) {
      const existing = await repos.subscriptions.getById(id);
      if (!existing) return null;
      return repos.subscriptions.update(id, { enabled });
    },

    async update(id: string, fetcher: (url: string) => Promise<string>) {
      const existing = await repos.subscriptions.getById(id);
      if (!existing) {
        throw new Error('Subscription not found');
      }

      try {
        // 1. 获取内容：如果是节点链接（vless:// 等），直接当作内容解析
        //    否则通过 HTTP 抓取订阅
        const raw = isNodeLink(existing.url)
          ? existing.url  // 直接节点链接，本身即内容
          : await fetcher(existing.url);

        // 2. 解析 + 标准化
        const parsed = parseSubscriptionContent(raw, id);
        // 3. 不去重：记录原始节点（去重在节点列表页面统一做）
        let newNodes = parsed.nodes;
        // 4. 应用规则（关键字过滤）
        const rules = await getRules();
        newNodes = applyRules(newNodes, rules);

        // 5. 获取旧节点用于 Diff
        const oldNodes = await repos.nodes.getBySubscription(id);

        // 6. 计算 Diff
        const diff = diffNodes(oldNodes, newNodes);

        // 7. 合并节点（保留 tombstone、original_address、first_seen_at）
        // v2.35：原「清洗规则」段已废弃，节点名改为生成时自动命名（smartRename）
        const mergedNodes = mergeNodes(oldNodes, diff);

        // 9. 写入节点缓存
        await repos.nodes.setBySubscription(id, mergedNodes);

        const updated = await repos.subscriptions.update(id, {
          status: 'active',
          lastFetchAt: Date.now(),
          nodeCount: mergedNodes.filter(n => !n.removed_at).length,
          errorMessage: undefined,
        });

        // 10. 记录操作日志
        await opLog.logSubscriptionUpdate(existing.name, diff.added, diff.removed, diff.unchanged, diff.changed);

        return {
          subscription: updated!,
          nodes: mergedNodes,
          nodeCount: mergedNodes.filter(n => !n.removed_at).length,
          diff,
        };
      } catch (err) {
        await repos.subscriptions.update(id, {
          status: 'error',
          errorMessage: (err as Error).message,
        });
        throw err;
      }
    },

    async triggerProbe() {
      // 异步触发，不阻塞响应
      // 实际探测逻辑在 app.ts scheduled handler 里调用
    },
  };
}