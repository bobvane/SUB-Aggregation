import { describe, it, expect } from 'vitest';
import { parseVless } from '@/parser/vless.parser';
import { nodeToUrl } from '@/generator/node-to-url';
import { nodeToMihomoProxy } from '@/generator/mihomo';
import { Node } from '@/models/node';

/**
 * 整链保真:订阅 → 节点 → 复制/输出,任何参数都不丢(用户 2026-08-28 需求)
 * 样本为真实 v2rayN XHTTP 节点链接
 */
const REAL_XHTTP_LINK =
  'vless://bc1f510f-8ac5-4071-88e5-b3db7c0a5ecd@172.237.7.122:443?' +
  'encryption=none&security=tls&sni=bot.wenbo.de5.net&fp=chrome&insecure=0&allowInsecure=0' +
  '&ech=cloudflare-ech.com%2Bhttps%3A%2F%2Fdns.alidns.com%2Fdns-query&type=xhttp' +
  '&host=bot.wenbo.de5.net&path=%2F&mode=stream-one' +
  '&extra=%7B%22xPaddingObfsMode%22%3Atrue%2C%22xPaddingMethod%22%3A%22tokenish%22%2C%22xPaddingPlacement%22%3A%22queryInHeader%22%2C%22xPaddingHeader%22%3A%22c1f510%22%2C%22xPaddingKey%22%3A%22_3db7c0%22%7D' +
  '#%E5%9C%B0%E5%8C%BA%E9%9A%8F%E6%9C%BA%20%7C%20%E6%97%A5%E6%9C%AC%20JP%20%7C%20NRT%20%7C%20172.237.7.122%3A443';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    name: 'Test',
    protocol: 'vless',
    server: 'example.com',
    port: 443,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    tls: true,
    metadata: { source: 'test', originalName: 'Test', tags: [] },
    version: 1,
    ...overrides,
  } as Node;
}

describe('整链保真', () => {
  it('解析真实 XHTTP 链接时保留全部参数', () => {
    const result = parseVless(REAL_XHTTP_LINK);
    expect(result.success).toBe(true);
    const node = result.node!;

    // 结构化字段
    expect(node.uuid).toBe('bc1f510f-8ac5-4071-88e5-b3db7c0a5ecd');
    expect(node.server).toBe('172.237.7.122');
    expect(node.port).toBe(443);
    expect(node.sni).toBe('bot.wenbo.de5.net');
    expect(node.tls).toBe(true);
    expect(node.transport?.type).toBe('xhttp');
    expect(node.transport?.mode).toBe('stream-one');
    expect(node.transport?.path).toBe('/');
    expect(node.transport?.host).toBe('bot.wenbo.de5.net');

    // 指纹
    expect(node.metadata?.fingerprint).toBe('chrome');

    // 保真参数全部进 extra,一个都不能丢
    expect(node.metadata?.extra?.['ech']).toBe('cloudflare-ech.com+https://dns.alidns.com/dns-query');
    expect(node.metadata?.extra?.['insecure']).toBe('0');
    expect(node.metadata?.extra?.['allowInsecure']).toBe('0');
    expect(node.metadata?.extra?.['encryption']).toBe('none');
    expect(node.metadata?.extra?.['extra']).toContain('xPaddingObfsMode');

    // originalUrl 原样保留
    expect(node.metadata?.originalUrl).toBe(REAL_XHTTP_LINK);
  });

  it('nodeToUrl 优先返回 originalUrl(复制/输出零丢失)', () => {
    const result = parseVless(REAL_XHTTP_LINK);
    const url = nodeToUrl(result.node!);
    expect(url).toBe(REAL_XHTTP_LINK);
  });

  it('无 originalUrl 时走正常序列化', () => {
    const node = makeNode({});
    expect(nodeToUrl(node)).toContain('vless://');
  });

  it('Mihomo 生成器: XHTTP 输出 network/xhttp/xhttp-opts/ECH/x-padding', () => {
    const result = parseVless(REAL_XHTTP_LINK);
    const proxy = nodeToMihomoProxy(result.node!);

    // Mihomo/Clash Meta/OpenClash XHTTP 标准字段
    expect(proxy.network).toBe('xhttp');
    expect(proxy.alpn).toEqual(['h2']);
    expect(proxy['xhttp-opts']).toMatchObject({
      path: '/',
      host: 'bot.wenbo.de5.net',
      mode: 'stream-one',
      'x-padding-obfs-mode': true,
      'x-padding-method': 'tokenish',
      'x-padding-placement': 'queryInHeader',
      'x-padding-header': 'c1f510',
      'x-padding-key': '_3db7c0',
    });
    // ECH：query-server-name 取 ech 参数 '+' 前的域名
    expect(proxy['ech-opts']).toEqual({
      enable: true,
      'query-server-name': 'cloudflare-ech.com',
    });

    // 普通 VLESS 字段仍然保留
    expect(proxy.type).toBe('vless');
    expect(proxy.uuid).toBe('bc1f510f-8ac5-4071-88e5-b3db7c0a5ecd');
    expect(proxy.server).toBe('172.237.7.122');
    expect(proxy.port).toBe(443);
    expect(proxy.udp).toBe(true);
    expect(proxy.encryption).toBe('none');
    expect(proxy.tls).toBe(true);
    expect(proxy.servername).toBe('bot.wenbo.de5.net');
    expect(proxy['client-fingerprint']).toBe('chrome');
  });

  it('XHTTP + VLESS Encryption + flow（3X-UI 克隆入站）必须原样透传', () => {
    const enc = 'mlkem768x25519plus.native.0rtt.TESTKEY';
    const link =
      'vless://550e8400-e29b-41d4-a716-446655440000@198.51.100.10:8443?' +
      `encryption=${enc}&flow=xtls-rprx-vision&fp=chrome&host=&mode=auto&path=%2F` +
      '&pbk=TEST_PUBLIC_KEY&security=reality&sid=abcd1234&sni=www.apple.com' +
      '&type=xhttp&x_padding_bytes=100-1000#XHTTP-MLKEM';

    const result = parseVless(link);
    expect(result.success).toBe(true);
    const node = result.node!;
    expect(node.flow).toBe('xtls-rprx-vision');
    expect(node.metadata?.extra?.['encryption']).toBe(enc);

    const proxy = nodeToMihomoProxy(node);
    expect(proxy.network).toBe('xhttp');
    expect(proxy.encryption).toBe(enc);
    expect(proxy.flow).toBe('xtls-rprx-vision');
  });

  it('从结构化模型回写链接时保留 VLESS Encryption（无 originalUrl 场景）', () => {
    const enc = 'mlkem768x25519plus.native.0rtt.TESTKEY';
    const link =
      'vless://550e8400-e29b-41d4-a716-446655440000@198.51.100.10:8443?' +
      `encryption=${enc}&fp=chrome&host=&mode=auto&path=%2F` +
      '&pbk=TEST_PUBLIC_KEY&security=reality&sid=abcd1234&sni=www.apple.com&type=xhttp#XHTTP-MLKEM';

    const node = parseVless(link).node!;
    // 模拟 YAML 源：没有 originalUrl，只能靠结构化字段重建
    const rebuilt = nodeToUrl({ ...node, metadata: { ...node.metadata!, originalUrl: undefined } });
    expect(new URL(rebuilt).searchParams.get('encryption')).toBe(enc);
  });
});