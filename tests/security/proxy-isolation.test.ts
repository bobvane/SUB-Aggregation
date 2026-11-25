/**
 * 节点测速隔离守卫（v2.50.0）
 *
 * 代理系统只服务于订阅抓取 / GitHub / 地理查询。
 * 节点测速改为 mihomo 核心：核心只监听 127.0.0.1，测速请求走本地 controller，
 * 不能引入项目 http-client（否则测速会被项目代理状态污染）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), 'utf-8');

describe('节点测速隔离守卫', () => {
  it('node-probe.service.ts 不再做裸 TCP/TLS 握手，改为委托核心探测', () => {
    const source = read('src/services/node-probe.service.ts');
    expect(source).not.toContain("from 'node:net'");
    expect(source).not.toContain("from 'node:tls'");
    expect(source).toContain("from '@/services/core-probe.service'");
  });

  it('core-probe.service.ts 的 fetch 只用于本地 controller，不引入项目 HTTP 代理', () => {
    const source = read('src/services/core-probe.service.ts');
    expect(source).not.toContain('http-client');
    const fetchTargets = [...source.matchAll(/fetch\(`([^`]*)`/g)].map((m) => m[1]);
    expect(fetchTargets.length).toBeGreaterThan(0);
    for (const t of fetchTargets) expect(t).toContain('127.0.0.1');
  });

  it('http-client 不导出也不实现节点测活能力', () => {
    const source = read('src/engine/http-client.ts');
    expect(source).not.toMatch(/from 'node:(net|tls)'/);
    expect(source).not.toMatch(/\b(tls|net)\.connect\b/i);
    expect(source).not.toMatch(/export[^\n]*\b(probeNode|probeAllNodes|getNodeHealth|nodeProbe)/);
  });
});
