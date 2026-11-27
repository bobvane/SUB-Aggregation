/**
 * 协议显示名判定（独立链路）
 * 只影响前端展示，不碰 node.protocol 枚举值、去重指纹、订阅存储、生成器输出。
 * VLESS 子类型按官方标准：安全层(none/tls/reality) × 传输层(raw/xhttp/grpc/ws/httpupgrade/mkcp) 的笛卡尔积，
 * 由解析器产出的真实字段(pbk/flow/transport.type)驱动动态拼接。
 *
 * 判定字段来源：
 * - pbk: Reality 公钥（vless.parser.ts / clash.ts 产出）
 * - flow: XTLS 流控（仅 TCP 系有效，官方唯一合法值 xtls-rprx-vision）
 * - transport.type: tcp / xhttp / grpc / ws（解析器只产出这四种，其余归一 tcp）
 *
 * 显示规则（用户拍板）：XTLS Vision 直接表达为 XTLS（XTLS 隐含 TCP，不叠加 TCP 段）。
 */

import { Node } from '@/models/node';

/**
 * 节点 → 协议显示全名（用户要求全名，不要缩写、不要括号）
 */
export function displayProtocol(node: Node): string {
  switch (node.protocol) {
    case 'vmess':
      return 'VMess';
    case 'trojan':
      return 'Trojan';
    case 'ss':
      return 'Shadowsocks';
    case 'ssr':
      return 'ShadowsocksR';
    case 'hysteria2':
      return 'Hysteria2';
    case 'tuic':
      return 'TUIC';
    case 'wireguard':
      return 'WireGuard';
    case 'anytls':
      return 'AnyTLS';
    case 'masque':
      if (node.masqueNetwork === 'h2') return 'MASQUE H2';
      if (node.masqueNetwork === 'h3') return 'MASQUE H3';
      return 'MASQUE';
    case 'vless':
      return displayVlessProtocol(node);
    default:
      // unknown 等未知协议原样显示
      return node.protocol;
  }
}

/**
 * VLESS 子类型：按官方矩阵动态拼接
 * 附加段固定顺序：Reality → XTLS → 传输层
 */
function displayVlessProtocol(node: Node): string {
  const transportType = node.transport?.type ?? 'tcp';
  const segments: string[] = [];

  // Reality（pbk 存在即 Reality，可配 TCP/XHTTP/gRPC）
  if (node.pbk) segments.push('Reality');

  // XTLS 仅 TCP 系有效；官方确认 XHTTP/WS/gRPC 与 Vision 互斥，无效组合忽略 flow
  // 用户拍板：XTLS Vision 直接表达为 XTLS（XTLS 隐含 TCP）
  if (node.flow && transportType === 'tcp') segments.push('XTLS');

  // 传输层（tcp 不单独显示，作为兜底 VLESS TCP）
  if (transportType === 'xhttp') segments.push('XHTTP');
  else if (transportType === 'ws') segments.push('WebSocket');
  else if (transportType === 'grpc') segments.push('gRPC');

  if (segments.length === 0) return 'VLESS TCP';
  return `VLESS + ${segments.join(' + ')}`;
}

/**
 * 协议 → 标签 class（VLESS 全子类型共享 tag-vless 一色，其余协议各一色）
 */
export function protocolTagClass(protocol: string): string {
  const known = ['vless', 'vmess', 'trojan', 'ss', 'ssr', 'hysteria2', 'tuic', 'wireguard', 'anytls', 'masque'];
  return `tag-${known.includes(protocol) ? protocol : 'other'}`;
}
