/**
 * 节点测活隔离守卫（v2.44.0）
 *
 * 代理系统只服务于订阅抓取 / GitHub / 地理查询。
 * 节点 TCP/TLS 握手必须保持裸连接，不能引入 http-client 或全局 fetch，
 * 否则「测活也走代理」会让延迟数据与代理状态绑定，失去实际意义。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), 'utf-8');

describe('节点测活不接入 HTTP 代理', () => {
  it('node-probe.service.ts 使用裸 net/tls，不引用 http-client 或 fetch', () => {
    const source = read('src/services/node-probe.service.ts');
    expect(source).toContain("from 'node:net'");
    expect(source).toContain("from 'node:tls'");
    expect(source).not.toContain('http-client');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('http-client 不导出也不实现节点测活能力', () => {
    const source = read('src/engine/http-client.ts');
    // 注意：http-client 里的 "probe" 指「自动模式下的直连可达性探测」
    // （PROXY_PROBE_TIMEOUT_MS，只等 HTTP 握手 + 响应头），与节点测活无关。
    // 这里守的是「不出现裸连接、不导出节点探测函数」这两条实质约束。
    expect(source).not.toMatch(/from 'node:(net|tls)'/);
    expect(source).not.toMatch(/\b(tls|net)\.connect\b/i);
    expect(source).not.toMatch(/export[^\n]*\b(probeNode|probeAllNodes|getNodeHealth|nodeProbe)/);
  });
});
