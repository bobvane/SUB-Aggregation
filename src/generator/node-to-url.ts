/**
 * Node → 标准节点链接序列化
 * 用于 Base64 输出格式（V2RAY/V2RAYNG/NEKORAY/Shadowrocket）
 * 把统一 Node 模型转回 vless:// vmess:// trojan:// ss:// hysteria2:// tuic:// wireguard:// anytls:// 链接
 */

import { Node } from '@/models/node';
import { safeBase64Encode } from './base64';

/**
 * 将 Node 序列化为标准链接
 */
export function nodeToUrl(node: Node): string {
  // 整链保真：保留原链接全部参数/加密；但名字片段用 node.name 覆盖，
  // 使节点名重命名（v2.34 smartRename 生成时统一命名，node.name 为当前名，
  // originalUrl/originalName 保留旧名）同样作用于 base64/v2ray/v2rayNG/nekoray 输出
  if (node.metadata?.originalUrl) {
    return node.name
      ? node.metadata.originalUrl.replace(/#[^#]*$/, `#${encodeURIComponent(node.name)}`)
      : node.metadata.originalUrl;
  }
  switch (node.protocol) {
    case 'vless':
      return nodeToVlessUrl(node);
    case 'vmess':
      return nodeToVmessUrl(node);
    case 'trojan':
      return nodeToTrojanUrl(node);
    case 'ss':
      return nodeToSsUrl(node);
    case 'ssr':
      return nodeToSsrUrl(node);
    case 'hysteria2':
      return nodeToHysteria2Url(node);
    case 'tuic':
      return nodeToTuicUrl(node);
    case 'wireguard':
      return nodeToWireguardUrl(node);
    case 'anytls':
      return nodeToAnytlsUrl(node);
    default:
      return '';
  }
}

/**
 * VLESS → vless://uuid@server:port?params#name
 */
function nodeToVlessUrl(node: Node): string {
  const params = new URLSearchParams();
  params.set('encryption', 'none');
  params.set('security', node.tls ? (node.pbk ? 'reality' : 'tls') : 'none');
  if (node.flow) params.set('flow', node.flow);
  if (node.sni) params.set('sni', node.sni);
  if (node.pbk) params.set('pbk', node.pbk);
  if (node.sid) params.set('sid', node.sid);
  if (node.transport?.type === 'ws') {
    params.set('type', 'ws');
    if (node.transport.path) params.set('path', node.transport.path);
    if (node.transport.host) params.set('host', node.transport.host);
  } else if (node.transport?.type === 'grpc') {
    params.set('type', 'grpc');
    if (node.transport.path) params.set('serviceName', node.transport.path.replace(/^\//, ''));
  } else if (node.transport?.type === 'xhttp') {
    params.set('type', 'xhttp');
    if (node.transport.mode) params.set('mode', node.transport.mode);
    if (node.transport.path) params.set('path', node.transport.path);
    if (node.transport.host) params.set('host', node.transport.host);
  } else {
    params.set('type', 'tcp');
  }

  const query = params.toString();
  const server = formatHost(node.server, node.port);
  const name = encodeURIComponent(node.name);
  return `vless://${node.uuid}@${server}?${query}#${name}`;
}

/**
 * VMess → vmess://base64(JSON)#name
 */
function nodeToVmessUrl(node: Node): string {
  const json = JSON.stringify({
    v: '2',
    ps: node.name,
    add: node.server,
    port: node.port,
    id: node.uuid,
    aid: '0',
    scy: 'auto',
    net: node.transport?.type === 'ws' ? 'ws' : node.transport?.type === 'grpc' ? 'grpc' : 'tcp',
    type: 'none',
    host: node.transport?.host || '',
    path: node.transport?.path || '',
    tls: node.tls ? 'tls' : '',
  });
  const payload = safeBase64Encode(json);
  const name = encodeURIComponent(node.name);
  return `vmess://${payload}#${name}`;
}

/**
 * Trojan → trojan://password@server:port?params#name
 */
function nodeToTrojanUrl(node: Node): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.allowInsecure) params.set('allowInsecure', '1');
  const query = params.toString();
  const server = formatHost(node.server, node.port);
  const name = encodeURIComponent(node.name);
  const qs = query ? '?' + query : '';
  return `trojan://${encodeURIComponent(node.password || '')}@${server}${qs}#${name}`;
}

/**
 * SS → ss://base64(method:password@server:port)#name
 * 或 SIP002: ss://method:password@server:port?plugin=#name
 */
function nodeToSsUrl(node: Node): string {
  const method = node.metadata?.tags?.[0] || 'aes-256-gcm';
  const userinfo = `${method}:${node.password || ''}`;
  const server = formatHost(node.server, node.port);

  let url: string;
  if (node.plugin) {
    // SIP002 格式（支持 plugin）
    url = `ss://${userinfo}@${server}?plugin=${encodeURIComponent(node.plugin)}`;
  } else {
    // 标准 base64 格式
    url = `ss://${safeBase64Encode(userinfo)}@${server}`;
  }
  const name = encodeURIComponent(node.name);
  return `${url}#${name}`;
}

/**
 * Hysteria2 → hysteria2://password@server:port?params#name
 */
function nodeToHysteria2Url(node: Node): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.allowInsecure) params.set('insecure', '1');
  if (node.obfs) {
    params.set('obfs', node.obfs);
    if (node.obfsPassword) params.set('obfs-password', node.obfsPassword);
  }
  if (node.ports) params.set('mport', node.ports);
  if (node.up) params.set('up', node.up);
  if (node.down) params.set('down', node.down);
  if (node.alpn?.length) params.set('alpn', node.alpn.join(','));
  const server = formatHost(node.server, node.port);
  const query = params.toString();
  const name = encodeURIComponent(node.name);
  const qs = query ? '?' + query : '';
  return `hysteria2://${encodeURIComponent(node.password || '')}@${server}${qs}#${name}`;
}

/**
 * TUIC → tuic://uuid:password@server:port?params#name (V5)
 *        tuic://token@server:port?params#name (V4)
 */
function nodeToTuicUrl(node: Node): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.allowInsecure) params.set('allowInsecure', '1');
  if (node.udpRelayMode) params.set('udp-relay-mode', node.udpRelayMode);
  if (node.congestionController) params.set('congestion-controller', node.congestionController);
  if (node.disableSni) params.set('disable-sni', '1');
  if (node.reduceRtt) params.set('reduce-rtt', '1');
  if (node.fastOpen) params.set('fast-open', '1');
  if (node.alpn?.length) params.set('alpn', node.alpn.join(','));
  const server = formatHost(node.server, node.port);
  const query = params.toString();
  const name = encodeURIComponent(node.name);
  const qs = query ? '?' + query : '';
  if (node.token) {
    // V4
    return `tuic://${encodeURIComponent(node.token)}@${server}${qs}#${name}`;
  }
  // V5
  const userInfo = `${node.uuid}:${encodeURIComponent(node.password || '')}`;
  return `tuic://${userInfo}@${server}${qs}#${name}`;
}

/**
 * WireGuard → wireguard://private-key@server:port?params#name
 */
function nodeToWireguardUrl(node: Node): string {
  const params = new URLSearchParams();
  if (node.wgIp) params.set('ip', node.wgIp);
  if (node.wgIpv6) params.set('ipv6', node.wgIpv6);
  if (node.wgPublicKey) params.set('public-key', node.wgPublicKey);
  if (node.wgAllowedIps) params.set('allowed-ips', node.wgAllowedIps);
  if (node.wgPreSharedKey) params.set('pre-shared-key', node.wgPreSharedKey);
  if (node.wgReserved?.length) params.set('reserved', node.wgReserved.join(','));
  if (node.wgMtu) params.set('mtu', String(node.wgMtu));
  const server = formatHost(node.server, node.port);
  const query = params.toString();
  const name = encodeURIComponent(node.name);
  const qs = query ? '?' + query : '';
  return `wireguard://${node.wgPrivateKey}@${server}${qs}#${name}`;
}

/**
 * AnyTLS → anytls://password@server:port?params#name
 */
function nodeToAnytlsUrl(node: Node): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.allowInsecure) params.set('insecure', '1');
  if (node.alpn?.length) params.set('alpn', node.alpn.join(','));
  const server = formatHost(node.server, node.port);
  const query = params.toString();
  const name = encodeURIComponent(node.name);
  const qs = query ? '?' + query : '';
  return `anytls://${encodeURIComponent(node.password || '')}@${server}${qs}#${name}`;
}

/**
 * SSR → ssr://base64(server:port:protocol:method:obfs:base64(password)?obfsparam=...&protoparam=...&remarks=...&group=...)
 * 用于无 originalUrl 时从字段重建（正常情况下走整链保真返回原文）
 */
function nodeToSsrUrl(node: Node): string {
  const method = node.username || node.metadata?.tags?.[0] || 'aes-256-cfb';
  const protocol = node.ssrProtocol || 'origin';
  const obfs = node.obfs || 'plain';
  const pwB64 = urlSafeBase64Encode(node.password || '');
  const core = `${node.server}:${node.port}:${protocol}:${method}:${obfs}:${pwB64}`;

  const params = new URLSearchParams();
  if (node.ssrObfsParam) params.set('obfsparam', urlSafeBase64Encode(node.ssrObfsParam));
  if (node.ssrProtocolParam) params.set('protoparam', urlSafeBase64Encode(node.ssrProtocolParam));
  const name = node.name;
  if (name) params.set('remarks', urlSafeBase64Encode(name));
  if (node.ssrGroup) params.set('group', urlSafeBase64Encode(node.ssrGroup));

  const queryStr = params.toString();
  const body = queryStr ? `${core}?${queryStr}` : core;
  return `ssr://${urlSafeBase64Encode(body)}`;
}

/**
 * 标准 Base64 → URL-safe Base64（SSR 链接体要求，无 +/=）
 */
function urlSafeBase64Encode(input: string): string {
  return safeBase64Encode(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * host:port 格式化（IPv6 加方括号）
 */
function formatHost(server: string, port: number): string {
  if (server.includes(':')) {
    return `[${server}]:${port}`;
  }
  return `${server}:${port}`;
}