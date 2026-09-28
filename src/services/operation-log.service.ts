/**
 * v2.32: 操作日志
 * 
 * 存储：KV（op_log:data:{idx} + op_log:next_idx）
 * 保留：30 天（跟 node_health_history 同步清理）
 * 支持手动清空
 */

import { KVStorage } from '@/storage/kv';
import { KV_KEYS } from '@/models/config';

export interface OperationLogEntry {
  id: number;
  timestamp: number;
  type: 'subscription_update' | 'geoip_update' | 'node_disabled' | 'node_recovered' | 'manual_action' | 'cache_invalidated';
  message: string;
}

const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/**
 * 创建操作日志服务
 */
export function createOperationLog(kv: KVStorage) {
  return {
    /**
     * 写入一条日志
     */
    async log(type: OperationLogEntry['type'], message: string): Promise<void> {
      const idxRaw = await kv.get(KV_KEYS.operationLogIndex);
      const nextIdx = idxRaw ? parseInt(idxRaw, 10) + 1 : 1;
      
      const entry: OperationLogEntry = {
        id: nextIdx,
        timestamp: Date.now(),
        type,
        message,
      };
      
      await kv.put(KV_KEYS.operationLogData(nextIdx), JSON.stringify(entry));
      await kv.put(KV_KEYS.operationLogIndex, String(nextIdx));
      
      // 清理旧日志（顺手清理）
      await this.cleanup();
    },

    /**
     * 获取最近 N 条日志（倒序）
     */
    async getRecent(limit: number = 50): Promise<OperationLogEntry[]> {
      const idxRaw = await kv.get(KV_KEYS.operationLogIndex);
      if (!idxRaw) return [];
      
      const nextIdx = parseInt(idxRaw, 10);
      const entries: OperationLogEntry[] = [];
      
      // 从最新往前读
      for (let i = nextIdx; i >= 1 && entries.length < limit; i--) {
        const raw = await kv.get(KV_KEYS.operationLogData(i));
        if (raw) {
          try {
            entries.push(JSON.parse(raw));
          } catch {}
        }
      }
      
      return entries;
    },

    /**
     * 获取全部日志（用于导出/调试）
     */
    async getAll(): Promise<OperationLogEntry[]> {
      const idxRaw = await kv.get(KV_KEYS.operationLogIndex);
      if (!idxRaw) return [];
      
      const nextIdx = parseInt(idxRaw, 10);
      const entries: OperationLogEntry[] = [];
      
      for (let i = 1; i <= nextIdx; i++) {
        const raw = await kv.get(KV_KEYS.operationLogData(i));
        if (raw) {
          try {
            entries.push(JSON.parse(raw));
          } catch {}
        }
      }
      
      return entries.sort((a, b) => b.timestamp - a.timestamp);
    },

    /**
     * 手动清空所有日志
     */
    async clearAll(): Promise<number> {
      const idxRaw = await kv.get(KV_KEYS.operationLogIndex);
      if (!idxRaw) return 0;
      
      const nextIdx = parseInt(idxRaw, 10);
      let count = 0;
      
      for (let i = 1; i <= nextIdx; i++) {
        await kv.delete(KV_KEYS.operationLogData(i));
        count++;
      }
      
      await kv.put(KV_KEYS.operationLogIndex, '0');
      return count;
    },

    /**
     * 清理 30 天前的日志
     */
    async cleanup(): Promise<number> {
      const idxRaw = await kv.get(KV_KEYS.operationLogIndex);
      if (!idxRaw) return 0;
      
      const nextIdx = parseInt(idxRaw, 10);
      const cutoff = Date.now() - LOG_TTL_MS;
      let deleted = 0;
      
      for (let i = 1; i <= nextIdx; i++) {
        const raw = await kv.get(KV_KEYS.operationLogData(i));
        if (raw) {
          try {
            const entry = JSON.parse(raw) as OperationLogEntry;
            if (entry.timestamp < cutoff) {
              await kv.delete(KV_KEYS.operationLogData(i));
              deleted++;
            }
          } catch {}
        }
      }
      
      return deleted;
    },

    // 便捷方法：记录常见事件
    async logSubscriptionUpdate(name: string, added: number, removed: number, unchanged: number, changed: number) {
      await this.log('subscription_update', `订阅「${name}」更新 +${added} -${removed} 保持${unchanged} 变化${changed}`);
    },

    async logGeoipUpdate(ip: string, country: string) {
      await this.log('geoip_update', `GeoIP 更新 ${ip} → ${country}`);
    },

    async logNodeDisabled(name: string, reason: string) {
      await this.log('node_disabled', `节点 ${name} 自动禁用（${reason}）`);
    },

    async logNodeRecovered(name: string, reason: string) {
      await this.log('node_recovered', `节点 ${name} 已恢复（${reason}）`);
    },

    async logManualAction(action: string) {
      await this.log('manual_action', action);
    },

    async logCacheInvalidated(formats: string[]) {
      await this.log('cache_invalidated', `配置缓存已失效（${formats.join(', ')}）`);
    },
  };
}

// 便捷导出：供 routes 直接调用
export async function getOperationLogs(kv: KVStorage, limit: number = 50): Promise<OperationLogEntry[]> {
  const svc = createOperationLog(kv);
  return svc.getRecent(limit);
}

export async function clearOperationLogs(kv: KVStorage): Promise<number> {
  const svc = createOperationLog(kv);
  return svc.clearAll();
}