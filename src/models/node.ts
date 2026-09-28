/**
 * 节点模型 - 系统内部统一节点对象
 * 06_DATA_MODEL.md §5
 */

export type NodeProtocol =
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'ss'
  | 'ssr'
  | 'hysteria2'
  | 'tuic'
  | 'wireguard'
  | 'anytls';

export type TransportType = 'tcp' | 'ws' | 'grpc' | 'h2' | 'xhttp';

export interface Transport {
  type: TransportType;
  path?: string;
  host?: string;
  mode?: string;
}

export interface NodeMetadata {
  country?: string;
  region?: string;
  source: string;
  originalName: string;
  tags: string[];
  /** TLS 客户端指纹（client-fingerprint / fp，如 chrome/firefox/safari） */
  fingerprint?: string;
  /**
   * 订阅原始链接中未被结构化字段吸收的全部 query 参数（保真用）。
   * 生成器按协议按需读取；序列化回分享链接时优先用 originalUrl，否则合并回写。
   */
  extra?: Record<string, string>;
  /**
   * 订阅原文中的完整节点链接（URI 方案）。有值时复制/Base64 输出优先原样返回，保证零丢失。
   * Clash YAML 来源无 URI 时为空。
   */
  originalUrl?: string;
}

export interface Node {
  id: string;
  name: string;
  protocol: NodeProtocol;
  server: string;
  port: number;
  username?: string;
  password?: string;
  uuid?: string;
  tls?: boolean;
  transport?: Transport;
  /** Reality 参数（VLESS） */
  flow?: string;
  pbk?: string;
  sid?: string;
  sni?: string;
  /** Shadowsocks 插件 */
  plugin?: string;
  /** 是否允许不安全证书 */
  allowInsecure?: boolean;
  /** Hysteria2 专用字段 */
  /** 端口跳跃范围 (e.g. "443-8443") */
  ports?: string;
  /** 限速上传 (e.g. "30 Mbps") */
  up?: string;
  /** 限速下载 (e.g. "200 Mbps") */
  down?: string;
  /** Hysteria2 混淆类型 (salamander/gecko) */
  obfs?: string;
  /** Hysteria2 混淆密码 */
  obfsPassword?: string;
  /** TUIC 专用字段 */
  /** TUIC V4 token */
  token?: string;
  /** TUIC UDP relay 模式 (native/quic) */
  udpRelayMode?: string;
  /** TUIC 拥塞控制算法 (cubic/new_reno/bbr) */
  congestionController?: string;
  /** TUIC disable-sni */
  disableSni?: boolean;
  /** TUIC reduce-rtt */
  reduceRtt?: boolean;
  /** TUIC fast-open */
  fastOpen?: boolean;
  /** WireGuard 专用字段 */
  /** WireGuard 本地 IPv4 */
  wgIp?: string;
  /** WireGuard 本地 IPv6 */
  wgIpv6?: string;
  /** WireGuard 客户端私钥 */
  wgPrivateKey?: string;
  /** WireGuard 服务端公钥 */
  wgPublicKey?: string;
  /** WireGuard allowed-ips */
  wgAllowedIps?: string;
  /** WireGuard pre-shared-key */
  wgPreSharedKey?: string;
  /** WireGuard reserved 字段 */
  wgReserved?: number[];
  /** WireGuard MTU */
  wgMtu?: number;
  /** AnyTLS 专用字段 */
  /** AnyTLS idle-session-check-interval */
  idleSessionCheckInterval?: number;
  /** AnyTLS idle-session-timeout */
  idleSessionTimeout?: number;
  /** AnyTLS min-idle-session */
  minIdleSession?: number;
  /** AnyTLS client-metadata */
  clientMetadata?: string;
  /** ShadowsocksR 专用字段 */
  /** SSR 协议方式 (origin / auth_aes128_md5 等) */
  ssrProtocol?: string;
  /** SSR 协议参数 */
  ssrProtocolParam?: string;
  /** SSR 混淆参数 */
  ssrObfsParam?: string;
  /** SSR 组名 */
  ssrGroup?: string;
  /** TLS alpn */
  alpn?: string[];
  /** TLS fingerprint (client-fingerprint) */
  fingerprint?: string;
  metadata: NodeMetadata;
  version: number;
  /** v2.32: 首次入库原始订阅地址（永久保留，用于 Diff 追溯） */
  original_address?: string;
  /** v2.32: 首次入库时间戳 */
  first_seen_at?: number;
  /** v2.32: 节点状态机（active | suspect | disabled | removed） */
  status?: 'active' | 'suspect' | 'disabled' | 'removed';
  /** v2.32: 被标记为 removed 的时间戳（订阅更新时节点消失，tombstone 机制） */
  removed_at?: number | null;
}

/**
 * 创建节点的工厂函数
 */
export function createNode(partial: Partial<Node> & { name: string }): Node {
  return {
    id: partial.id ?? '',
    name: partial.name,
    protocol: partial.protocol ?? 'vmess',
    server: partial.server ?? '',
    port: partial.port ?? 443,
    username: partial.username,
    password: partial.password,
    uuid: partial.uuid,
    tls: partial.tls,
    transport: partial.transport,
    flow: partial.flow,
    pbk: partial.pbk,
    sid: partial.sid,
    sni: partial.sni,
    plugin: partial.plugin,
    allowInsecure: partial.allowInsecure,
    ports: partial.ports,
    up: partial.up,
    down: partial.down,
    obfs: partial.obfs,
    obfsPassword: partial.obfsPassword,
    token: partial.token,
    udpRelayMode: partial.udpRelayMode,
    congestionController: partial.congestionController,
    disableSni: partial.disableSni,
    reduceRtt: partial.reduceRtt,
    fastOpen: partial.fastOpen,
    wgIp: partial.wgIp,
    wgIpv6: partial.wgIpv6,
    wgPrivateKey: partial.wgPrivateKey,
    wgPublicKey: partial.wgPublicKey,
    wgAllowedIps: partial.wgAllowedIps,
    wgPreSharedKey: partial.wgPreSharedKey,
    wgReserved: partial.wgReserved,
    wgMtu: partial.wgMtu,
    idleSessionCheckInterval: partial.idleSessionCheckInterval,
    idleSessionTimeout: partial.idleSessionTimeout,
    minIdleSession: partial.minIdleSession,
    clientMetadata: partial.clientMetadata,
    ssrProtocol: partial.ssrProtocol,
    ssrProtocolParam: partial.ssrProtocolParam,
    ssrObfsParam: partial.ssrObfsParam,
    ssrGroup: partial.ssrGroup,
    alpn: partial.alpn,
    fingerprint: partial.fingerprint,
    metadata: {
      source: partial.metadata?.source ?? 'unknown',
      originalName: partial.metadata?.originalName ?? partial.name,
      tags: partial.metadata?.tags ?? [],
      country: partial.metadata?.country,
      region: partial.metadata?.region,
      fingerprint: partial.metadata?.fingerprint ?? partial.fingerprint,
      extra: partial.metadata?.extra,
      originalUrl: partial.metadata?.originalUrl,
    },
    version: 1,
    original_address: partial.original_address,
    first_seen_at: partial.first_seen_at,
    status: partial.status ?? 'active',
    removed_at: partial.removed_at ?? null,
  };
}

/**
 * 节点指纹：server:port:protocol
 * 用于节点禁用状态持久化（重抓订阅后状态不丢失）
 */
export function nodeFingerprint(node: Pick<Node, 'server' | 'port' | 'protocol'>): string {
  return `${node.server}:${node.port}:${node.protocol}`.toLowerCase();
}