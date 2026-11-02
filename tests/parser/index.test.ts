import { describe, it, expect } from 'vitest';
import {
  parseSubscriptionContent,
  deduplicateNodes,
  applyRules,
} from '@/parser/index';
import { decodeSubscriptionContent, safeBase64Decode, looksLikeBase64 } from '@/parser/decoder';
import { detectProtocol } from '@/parser/detector';

describe('Decoder', () => {
  it('should decode standard base64', () => {
    const encoded = btoa('ss://aes-256-gcm:pass@example.com:8388');
    expect(safeBase64Decode(encoded)).toBe('ss://aes-256-gcm:pass@example.com:8388');
  });

  it('should decode url-safe base64', () => {
    // 含 / 的 base64 替换为 _
    const encoded = btoa('vless://abc/def').replace(/\//g, '_').replace(/\+/g, '-');
    const decoded = safeBase64Decode(encoded);
    expect(decoded).toContain('vless://');
  });

  it('should return null for invalid base64', () => {
    expect(safeBase64Decode('!!!invalid!!!')).toBeNull();
  });

  it('should return null for empty input', () => {
    expect(safeBase64Decode('')).toBeNull();
  });

  it('should detect base64-like content', () => {
    expect(looksLikeBase64(btoa('hello world'))).toBe(true);
    expect(looksLikeBase64('not base64 at all ###')).toBe(false);
  });

  it('should decode subscription content when base64', () => {
    const nodeLine = 'ss://aes-256-gcm:pass@example.com:8388';
    const encoded = btoa(nodeLine);
    const decoded = decodeSubscriptionContent(encoded);
    expect(decoded).toContain('ss://');
  });

  it('should keep plain text content unchanged', () => {
    const text = 'ss://aes-256-gcm:pass@example.com:8388\nvless://uuid@host:443';
    expect(decodeSubscriptionContent(text)).toBe(text);
  });
});

describe('Detector', () => {
  it('should detect vmess', () => {
    expect(detectProtocol('vmess://abc')).toBe('vmess');
  });
  it('should detect vless', () => {
    expect(detectProtocol('vless://abc')).toBe('vless');
  });
  it('should detect trojan', () => {
    expect(detectProtocol('trojan://abc')).toBe('trojan');
  });
  it('should detect ss', () => {
    expect(detectProtocol('ss://abc')).toBe('ss');
  });
  it('should detect ssr', () => {
    expect(detectProtocol('ssr://abc')).toBe('ssr');
  });
  it('should return unknown for unsupported', () => {
    expect(detectProtocol('random text')).toBe('unknown');
  });
});

describe('parseSubscriptionContent', () => {
  it('should parse multi-protocol subscription', () => {
    const content = [
      'ss://aes-256-gcm:pass1@jp1.example.com:8388#JP1',
      'vless://550e8400-e29b-41d4-a716-446655440000@us1.example.com:443#US1',
      'trojan://pass2@hk1.example.com:443#HK1',
    ].join('\n');
    const result = parseSubscriptionContent(content, 'test-sub');
    expect(result.total).toBe(3);
    expect(result.success).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.nodes.length).toBe(3);
  });

  it('should set source metadata', () => {
    const result = parseSubscriptionContent('ss://aes-256-gcm:pass@example.com:8388', 'sub-abc');
    expect(result.nodes[0].metadata.source).toBe('sub-abc');
  });

  it('should count parse failures', () => {
    const content = 'ss://aes-256-gcm:pass@example.com:8388\nthis is not a node\nvmess://bad';
    const result = parseSubscriptionContent(content, 'test');
    expect(result.failed).toBe(2);
    expect(result.success).toBe(1);
    expect(result.errors.length).toBe(2);
  });

  it('should handle empty content', () => {
    const result = parseSubscriptionContent('', 'test');
    expect(result.total).toBe(0);
    expect(result.nodes).toEqual([]);
  });

  it('should handle base64 encoded subscription', () => {
    const nodeLine = 'ss://aes-256-gcm:pass@example.com:8388';
    const encoded = btoa(nodeLine);
    const result = parseSubscriptionContent(encoded, 'test');
    expect(result.success).toBe(1);
  });

  it('should skip comment lines', () => {
    const content = '# this is a comment\nss://aes-256-gcm:pass@example.com:8388';
    const result = parseSubscriptionContent(content, 'test');
    expect(result.total).toBe(1);
    expect(result.success).toBe(1);
  });
});

describe('deduplicateNodes', () => {
  it('should deduplicate by server:port:protocol', () => {
    const nodes = [
      { server: 'example.com', port: 443, protocol: 'vless' },
      { server: 'example.com', port: 443, protocol: 'vless' },
      { server: 'example.com', port: 8443, protocol: 'vless' },
      { server: 'example.com', port: 443, protocol: 'trojan' },
    ];
    const result = deduplicateNodes(nodes as never[]);
    expect(result.length).toBe(3);
  });

  it('should keep tcp and xhttp nodes with same server:port:protocol', () => {
    const nodes = [
      { server: 'example.com', port: 443, protocol: 'vless', transport: { type: 'tcp' } },
      { server: 'example.com', port: 443, protocol: 'vless', transport: { type: 'xhttp' } },
    ];
    const result = deduplicateNodes(nodes as never[]);
    expect(result.length).toBe(2);
  });
});

describe('applyRules', () => {
  const nodes = [
    { name: '🇯🇵 日本节点', server: 'jp.example.com', port: 443 },
    { name: '🇺🇸 美国节点', server: 'us.example.com', port: 443 },
    { name: '🇭🇰 香港节点', server: 'hk.example.com', port: 443 },
  ];

  it('should filter by include rule', () => {
    const result = applyRules(nodes as never[], [{ type: 'include', pattern: '日本' }]);
    expect(result.length).toBe(1);
    expect(result[0].name).toContain('日本');
  });

  it('should filter by exclude rule', () => {
    const result = applyRules(nodes as never[], [{ type: 'exclude', pattern: '日本' }]);
    expect(result.length).toBe(2);
  });

  it('should respect disabled rules', () => {
    const result = applyRules(nodes as never[], [
      { type: 'include', pattern: '日本', enabled: false },
    ]);
    expect(result.length).toBe(3);
  });

  it('should match server hostname too', () => {
    const result = applyRules(nodes as never[], [{ type: 'include', pattern: 'us' }]);
    expect(result.length).toBe(1);
    expect(result[0].name).toContain('美国');
  });
});