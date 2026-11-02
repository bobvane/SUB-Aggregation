/**
 * Trojan 解析器
 * TASK 4.5 - Trojan Parser
 * 08_PARSER_SPEC.md §11
 * 输入: trojan://password@server:port?params#name
 */

import { Node, createNode } from '@/models/node';
import { ParserResult, makeError } from './types';

export function parseTrojan(input: string): ParserResult {
  try {
    const payload = input.replace(/^trojan:\/\//i, '');

    // 分离 name
    const hashIndex = payload.indexOf('#');
    const name = hashIndex >= 0 ? decodeURIComponent(payload.slice(hashIndex + 1).trim()) : '';

    const authPart = hashIndex >= 0 ? payload.slice(0, hashIndex) : payload;
    const queryIndex = authPart.indexOf('?');
    const authority = queryIndex >= 0 ? authPart.slice(0, queryIndex) : authPart;
    const queryStr = queryIndex >= 0 ? authPart.slice(queryIndex + 1) : '';

    const params = new URLSearchParams(queryStr);

    // password@server:port
    const atIndex = authority.lastIndexOf('@');
    if (atIndex < 0) return makeError('INVALID_FORMAT', 'Trojan missing @ separator');
    const password = authority.slice(0, atIndex);
    const hostPort = authority.slice(atIndex + 1);

    if (!password) return makeError('MISSING_PASSWORD', 'Trojan missing password');

    // server:port
    const lastColon = hostPort.lastIndexOf(':');
    if (lastColon <= 0) return makeError('MISSING_SERVER', 'Trojan missing server');
    const server = hostPort.slice(0, lastColon);
    const port = parseInt(hostPort.slice(lastColon + 1), 10);
    if (!server) return makeError('MISSING_SERVER', 'Trojan missing server');
    if (!Number.isFinite(port) || port <= 0) return makeError('MISSING_PORT', 'Trojan missing port');

    const sni = params.get('sni') ?? undefined;
    const allowInsecure = params.get('allowInsecure') === '1' || params.get('allowInsecure') === 'true';
    const tls = params.get('security') !== 'none';
    const net = params.get('type') ?? 'tcp';
    const host = params.get('host') ?? undefined;
    const path = params.get('path') ?? params.get('serviceName') ?? undefined;
    const alpn = params.get('alpn')?.split(',').filter(Boolean) ?? undefined;
    const fp = params.get('fp') ?? undefined;

    const node: Node = createNode({
      name: name || `${server}:${port}`,
      protocol: 'trojan',
      server,
      port,
      password,
      tls,
      sni,
      allowInsecure,
      transport: {
        type: net === 'ws' ? 'ws' : net === 'grpc' ? 'grpc' : net === 'h2' ? 'h2' : 'tcp',
        path,
        host,
      },
      alpn,
      metadata: {
        source: 'unknown',
        originalName: name || `${server}:${port}`,
        tags: [],
        fingerprint: fp,
        originalUrl: input.trim(),
      },
    });

    return { success: true, node };
  } catch {
    return makeError('PARSE_FAILED', 'Trojan parse failed');
  }
}