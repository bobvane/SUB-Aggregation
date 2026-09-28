/**
 * 配置模型 / Session 模型 / 系统设置模型
 * 06_DATA_MODEL.md §9-11
 */

export type ConfigFormat = 'mihomo' | 'singbox';

export interface Config {
  id: string;
  format: ConfigFormat;
  name: string;
  subscriptionIds: string[];
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** 签发时对应的密码哈希版本；改密后此值 < 当前版本则会话失效 */
  passwordVersion: number;
}

/**
 * KV 键名常量
 */
export const KV_KEYS = {
  /** 订阅键前缀: subscription:{id} */
  subscription: (id: string) => `subscription:${id}`,
  /** 订阅列表键 */
  subscriptions: 'subscriptions',
  /** 节点缓存键前缀: nodes:{subscriptionId} */
  nodes: (subscriptionId: string) => `nodes:${subscriptionId}`,
  /** 规则键前缀: rule:{id} */
  rule: (id: string) => `rule:${id}`,
  /** 规则列表键 */
  rules: 'rules',
  /** 配置键前缀: config:{id} */
  config: (id: string) => `config:${id}`,
  /** 会话键前缀: session:{id} */
  session: (id: string) => `session:${id}`,
  /** 系统设置键前缀: setting:{key} */
  setting: (key: string) => `setting:${key}`,
  /** 管理员密码哈希 */
  adminPassword: 'admin:hash',
  /** 规则目录快照（动态扫描入库，全量分类） */
  ruleCatalog: 'rule-catalog',
  /** 规则目录已失效黑名单 */
  ruleCatalogRemoved: 'rule-catalog-removed',
  /** 规则目录元信息（版本/时间/状态） */
  ruleCatalogMeta: 'rule-catalog-meta',
  /** v2.32: 节点健康历史（时序，追加写）key: health:hist:{fingerprint}:{timestamp} */
  healthHistory: (fingerprint: string, timestamp: number) => `health:hist:${fingerprint}:${timestamp}`,
  /** v2.32: 节点健康最新快照（覆盖写）key: health:latest:{fingerprint} */
  healthLatest: (fingerprint: string) => `health:latest:${fingerprint}`,
  /** v2.32: 操作日志索引 */
  operationLogIndex: 'op_log:next_idx',
  /** v2.32: 操作日志数据 key: op_log:data:{idx} */
  operationLogData: (idx: number) => `op_log:data:${idx}`,
  /** v2.32: 配置快照缓存 key: config:snap:{format}:{version} */
  configSnapshot: (format: string, version: number) => `config:snap:${format}:${version}`,
  /** v2.32: 配置版本号（每次变更自增，用于缓存失效） */
  configVersion: 'setting:config_version',
} as const;