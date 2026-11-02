/**
 * Parser 引擎编排
 * TASK 4.7 - Normalizer 管线
 * 08_PARSER_SPEC.md §3-5：Content Decoder → Protocol Detector → Parser → Normalized Node
 */

import { Node, nodeFingerprint } from '@/models/node';
import { detectProtocol, splitLines } from './detector';
import { decodeSubscriptionContent } from './decoder';
import { parseVmess } from './vmess.parser';
import { parseVless } from './vless.parser';
import { parseTrojan } from './trojan.parser';
import { parseShadowsocks } from './shadowsocks.parser';
import { parseShadowsocksR } from './shadowsocksr.parser';
import { parseHysteria2 } from './hysteria2.parser';
import { parseTuic } from './tuic.parser';
import { parseWireguard } from './wireguard.parser';
import { parseAnytls } from './anytls.parser';
import { isClashYaml, parseClashYaml } from './clash';
import { ParserResult } from './types';

export interface ParseSummary {
  total: number;
  success: number;
  failed: number;
  nodes: Node[];
  errors: { line: number; code: string; message: string }[];
}

/**
 * 解析订阅内容的完整管线
 * 输入：原始订阅内容 + 来源标识
 * 输出：统一 Node[] + 统计
 */
export function parseSubscriptionContent(content: string, source: string): ParseSummary {
  // 1. 解码（Base64 自动识别）
  const decoded = decodeSubscriptionContent(content);

  // 2. 检测是否为 Clash YAML 格式
  if (isClashYaml(decoded)) {
    const clashResult = parseClashYaml(decoded);
    // 标记来源
    for (const node of clashResult.nodes) {
      node.metadata.source = source;
    }
    return {
      total: clashResult.nodes.length + clashResult.errors.length,
      success: clashResult.nodes.length,
      failed: clashResult.errors.length,
      nodes: clashResult.nodes,
      errors: clashResult.errors,
    };
  }

  // 3. 分行（标准链接格式）
  const lines = splitLines(decoded);

  const nodes: Node[] = [];
  const errors: { line: number; code: string; message: string }[] = [];
  let success = 0;

  lines.forEach((line, idx) => {
    const protocol = detectProtocol(line);
    let result: ParserResult;

    switch (protocol) {
      case 'vmess':
        result = parseVmess(line);
        break;
      case 'vless':
        result = parseVless(line);
        break;
      case 'trojan':
        result = parseTrojan(line);
        break;
      case 'ss':
        result = parseShadowsocks(line);
        break;
      case 'ssr':
        result = parseShadowsocksR(line);
        break;
      case 'hysteria2':
        result = parseHysteria2(line);
        break;
      case 'tuic':
        result = parseTuic(line);
        break;
      case 'wireguard':
        result = parseWireguard(line);
        break;
      case 'anytls':
        result = parseAnytls(line);
        break;
      default:
        result = { success: false, error: { code: 'UNKNOWN_PROTOCOL', message: 'Unsupported protocol' } };
    }

    if (result.success && result.node) {
      // 标记来源
      result.node.metadata.source = source;
      nodes.push(result.node);
      success++;
    } else {
      errors.push({
        line: idx + 1,
        code: result.error?.code ?? 'UNKNOWN',
        message: result.error?.message ?? 'Parse error',
      });
    }
  });

  return {
    total: lines.length,
    success,
    failed: lines.length - success,
    nodes,
    errors,
  };
}

/**
 * 节点去重：统一使用 nodeFingerprint()。
 * 不能在这里另写一份 server:port:protocol 逻辑，否则 XHTTP 后缀等
 * 指纹语义变更会与锁定/禁用/健康数据脱节。
 */
export function deduplicateNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const result: Node[] = [];
  for (const node of nodes) {
    const key = nodeFingerprint(node);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(node);
    }
  }
  return result;
}

/**
 * 应用过滤规则（Rule Engine）
 * 08_PARSER_SPEC.md §12 / 06_DATA_MODEL.md §8
 * include → 只保留匹配；exclude → 移除匹配
 */
export function applyRules(
  nodes: Node[],
  rules: { type: 'include' | 'exclude' | 'replace'; pattern: string; enabled?: boolean }[]
): Node[] {
  let result = [...nodes];
  const includes = rules.filter((r) => r.type === 'include' && r.enabled !== false);
  const excludes = rules.filter((r) => r.type === 'exclude' && r.enabled !== false);

  if (includes.length > 0) {
    result = result.filter((n) =>
      includes.some((r) => nodeMatches(n, r.pattern))
    );
  }

  if (excludes.length > 0) {
    result = result.filter((n) => !excludes.some((r) => nodeMatches(n, r.pattern)));
  }

  return result;
}

function nodeMatches(node: Node, pattern: string): boolean {
  const originalName = node.metadata?.originalName ?? '';
  const haystack = `${node.name} ${node.server} ${originalName}`.toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}