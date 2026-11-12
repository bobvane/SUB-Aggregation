/**
 * 协议检测器
 * TASK 4.2 - Protocol Detector
 * 08_PARSER_SPEC.md §7
 */

export type DetectedProtocol = 'vmess' | 'vless' | 'trojan' | 'ss' | 'ssr' | 'hysteria2' | 'tuic' | 'wireguard' | 'anytls' | 'unknown';

/**
 * 检测单行节点链接的协议
 */
export function detectProtocol(line: string): DetectedProtocol {
  const trimmed = line.trim();
  if (trimmed.startsWith('vmess://')) return 'vmess';
  if (trimmed.startsWith('vless://')) return 'vless';
  if (trimmed.startsWith('trojan://')) return 'trojan';
  if (trimmed.startsWith('ss://')) return 'ss';
  if (trimmed.startsWith('ssr://')) return 'ssr';
  if (trimmed.startsWith('hysteria2://') || trimmed.startsWith('hy2://')) return 'hysteria2';
  if (trimmed.startsWith('tuic://')) return 'tuic';
  if (trimmed.startsWith('wireguard://') || trimmed.startsWith('wg://')) return 'wireguard';
  if (trimmed.startsWith('anytls://')) return 'anytls';
  return 'unknown';
}

/**
 * 从订阅内容中提取所有节点链接行
 * 过滤空行和注释
 */
export function splitLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}