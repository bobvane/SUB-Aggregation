import { describe, it, expect } from 'vitest';
import { generateBase64Config, validateBase64 } from '@/generator/base64-generator';
import { nodeToUrl } from '@/generator/node-to-url';
import { Node } from '@/models/node';
import { safeBase64Decode } from '@/generator/base64';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    name: 'JP-01',
    protocol: 'vless',
    server: 'jp.example.com',
    port: 443,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    tls: true,
    flow: 'xtls-rprx-vision',
    pbk: 'pubkey123',
    sid: 'abc',
    sni: 'real.example.com',
    metadata: { source: 'test', originalName: 'JP-01', tags: [] },
    version: 1,
    ...overrides,
  } as Node;
}

describe('nodeToUrl', () => {
  it('should serialize vless reality node back to link', () => {
    const url = nodeToUrl(makeNode());
    expect(url.startsWith('vless://')).toBe(true);
    expect(url).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(url).toContain('jp.example.com:443');
    expect(url).toContain('security=reality');
    expect(url).toContain('flow=xtls-rprx-vision');
    expect(url).toContain('pbk=pubkey123');
    expect(url).toContain('sid=abc');
    expect(url).toContain('sni=real.example.com');
    expect(url.endsWith('#JP-01')).toBe(true);
  });

  it('should serialize vless ws node', () => {
    const node = makeNode({
      transport: { type: 'ws', path: '/ws', host: 'cdn.example.com' },
      pbk: undefined,
      sid: undefined,
      flow: undefined,
    });
    const url = nodeToUrl(node);
    expect(url).toContain('type=ws');
    expect(url).toContain('path=%2Fws');
    expect(url).toContain('host=cdn.example.com');
    expect(url).toContain('security=tls');
  });

  it('should serialize vmess node', () => {
    const node = makeNode({
      protocol: 'vmess',
      transport: { type: 'ws', path: '/ws', host: 'cdn.example.com' },
    });
    const url = nodeToUrl(node);
    expect(url.startsWith('vmess://')).toBe(true);
    // 解码 JSON 部分验证字段
    const payload = url.slice('vmess://'.length).split('#')[0];
    const decoded = safeBase64Decode(payload)!;
    const json = JSON.parse(decoded);
    expect(json.add).toBe('jp.example.com');
    expect(json.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should serialize trojan node', () => {
    const node = makeNode({ protocol: 'trojan', password: 'secret' });
    const url = nodeToUrl(node);
    expect(url.startsWith('trojan://')).toBe(true);
    expect(url).toContain('secret@jp.example.com:443');
  });

  it('should serialize ss node', () => {
    const node = makeNode({
      protocol: 'ss',
      password: 'pw',
      metadata: { source: 'test', originalName: 'SS-1', tags: ['aes-256-gcm'] },
    });
    const url = nodeToUrl(node);
    expect(url.startsWith('ss://')).toBe(true);
  });
});

describe('generateBase64Config', () => {
  it('should encode node list to base64 subscription', () => {
    const content = generateBase64Config([makeNode()]);
    expect(validateBase64(content)).toBe(true);
    const decoded = safeBase64Decode(content);
    expect(decoded).toContain('vless://');
    expect(decoded).toContain('JP-01');
  });

  it('rebuilds fingerprint / alpn / spx / allowInsecure when originalUrl is absent', () => {
    const node = makeNode({
      allowInsecure: true,
      alpn: ['h2', 'http/1.1'],
      metadata: {
        source: 'clash',
        originalName: 'YAML',
        tags: [],
        fingerprint: 'chrome',
        extra: { spx: '/spider' },
      },
    });
    const url = nodeToUrl(node);
    expect(url).toContain('fp=chrome');
    expect(url).toContain('alpn=h2%2Chttp%2F1.1');
    expect(url).toContain('spx=%2Fspider');
    expect(url).toContain('allowInsecure=1');
  });
});