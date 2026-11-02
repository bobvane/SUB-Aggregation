/**
 * VMess 解析器
 * TASK 4.3 - VMess Parser
 * 08_PARSER_SPEC.md §9
 * 输入: vmess://base64(JSON)
 */

import { Node, createNode } from '@/models/node';
import { ParserResult, makeError } from './types';

/**
 * 解析 vmess://base64 链接
 */
export function parseVmess(input: string): ParserResult {
  try {
    const payload = input.replace(/^vmess:\/\//i, '');
    if (!payload) {
      return makeError('EMPTY_PAYLOAD', 'VMess payload is empty');
    }

    // 尝试 Base64 解码
    const decoded = tryDecode(payload);
    if (!decoded) {
      return makeError('INVALID_BASE64', 'VMess payload is not valid Base64');
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(decoded);
    } catch {
      return makeError('INVALID_JSON', 'VMess payload is not valid JSON');
    }

    const server = asString(data.add);
    const port = asNumber(data.port);
    const uuid = asString(data.id);

    if (!server) return makeError('MISSING_SERVER', 'VMess missing server (add)');
    if (!port) return makeError('MISSING_PORT', 'VMess missing port');
    if (!uuid) return makeError('MISSING_UUID', 'VMess missing uuid (id)');

    const net = asString(data.net) || 'tcp';
    const tls = asString(data.tls).toLowerCase() === 'tls';
    const alpnRaw = asString(data.alpn);

    const node: Node = createNode({
      name: asString(data.ps) || `${server}:${port}`,
      protocol: 'vmess',
      server,
      port,
      uuid,
      tls,
      sni: asString(data.sni) || undefined,
      allowInsecure: isTruthy(data.allowInsecure),
      alpn: alpnRaw ? alpnRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      transport: {
        type: net === 'ws' ? 'ws' : net === 'grpc' ? 'grpc' : net === 'h2' ? 'h2' : 'tcp',
        path: asString(data.path) || undefined,
        host: asString(data.host) || undefined,
      },
      metadata: {
        source: 'unknown',
        originalName: asString(data.ps) || `${server}:${port}`,
        tags: asString(data.scy) ? [asString(data.scy)] : [],
        fingerprint: asString(data.fp) || undefined,
        extra: vmessExtra(data),
      },
    });

    return { success: true, node };
  } catch {
    return makeError('PARSE_FAILED', 'VMess parse failed');
  }
}

function isTruthy(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? '').toLowerCase();
  return s === '1' || s === 'true';
}

/** 保留 VMess JSON 中非结构化字段(保真用) */
const KNOWN_VMESS_KEYS = new Set(['v','ps','add','port','id','aid','scy','net','type','host','path','tls','alpn','sni','fp','cid','spx']);

function vmessExtra(data: Record<string, unknown>): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_VMESS_KEYS.has(k) && v !== undefined && v !== null) extra[k] = String(v);
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function tryDecode(input: string): string | null {
  try {
    let normalized = input.trim();
    // 可能带后缀参数
    normalized = normalized.split('#')[0];
    // URL-safe base64 兼容
    normalized = normalized.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4 !== 0) normalized += '=';

    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}