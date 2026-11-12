/**
 * 订阅模型 - 表示一个订阅来源
 * 06_DATA_MODEL.md §4
 */

export type SubscriptionStatus = 'active' | 'error' | 'disabled';

export interface Subscription {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastFetchAt?: number;
  nodeCount?: number;
  status: SubscriptionStatus;
  errorMessage?: string;
  /** 连续抓取失败次数；达到自动重试上限后保留计数，等待下一次常规同步或手动操作。 */
  retryCount?: number;
  /** 下次自动重试时间戳（毫秒），undefined 表示当前没有排定的自动重试。 */
  nextRetryAt?: number;
  /** 最近一次失败时间戳（毫秒），用于界面状态说明。 */
  lastErrorAt?: number;
  version: number;
}

/**
 * 创建订阅的工厂函数
 */
export function createSubscription(
  partial: Partial<Subscription> & { name: string; url: string }
): Subscription {
  const now = Date.now();
  return {
    id: partial.id ?? '',
    name: partial.name,
    url: partial.url,
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
    status: partial.status ?? 'active',
    nodeCount: partial.nodeCount,
    lastFetchAt: partial.lastFetchAt,
    retryCount: partial.retryCount,
    nextRetryAt: partial.nextRetryAt,
    lastErrorAt: partial.lastErrorAt,
    errorMessage: partial.errorMessage,
    version: 1,
  };
}
