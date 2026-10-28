import { describe, it, expect, vi } from 'vitest';
import { validateUrl, isBlockedIp, fetchSubscription } from '@/engine/fetcher';

describe('SSRF URL validation', () => {
  it('should accept valid https URL', () => {
    const result = validateUrl('https://example.com/sub');
    expect(result.ok).toBe(true);
  });

  it('should accept valid http URL', () => {
    const result = validateUrl('http://example.com/sub');
    expect(result.ok).toBe(true);
  });

  it('should reject non-http protocols', () => {
    expect(validateUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateUrl('ftp://example.com').ok).toBe(false);
    expect(validateUrl('gopher://example.com').ok).toBe(false);
  });

  it('should reject localhost', () => {
    expect(validateUrl('http://localhost/sub').ok).toBe(false);
    expect(validateUrl('https://localhost:8080/sub').ok).toBe(false);
  });

  it('should reject invalid URL format', () => {
    expect(validateUrl('not-a-url').ok).toBe(false);
    expect(validateUrl('').ok).toBe(false);
  });

  it('should reject loopback IPs', () => {
    expect(validateUrl('http://127.0.0.1/sub').ok).toBe(false);
    expect(validateUrl('http://127.0.0.2:8080/sub').ok).toBe(false);
  });

  it('should reject private IPv4 ranges', () => {
    expect(validateUrl('http://10.0.0.1/sub').ok).toBe(false);
    expect(validateUrl('http://192.168.1.1/sub').ok).toBe(false);
    expect(validateUrl('http://172.16.0.1/sub').ok).toBe(false);
    expect(validateUrl('http://172.31.255.255/sub').ok).toBe(false);
  });

  it('should allow public IPs', () => {
    expect(validateUrl('http://93.184.216.34/sub').ok).toBe(true);
    expect(validateUrl('http://23.149.36.32/sub').ok).toBe(true);
  });

  it('should reject IPv6 local addresses', () => {
    expect(validateUrl('http://[::1]/sub').ok).toBe(false);
    expect(validateUrl('http://[fe80::1]/sub').ok).toBe(false);
  });

  it('should reject link-local addresses', () => {
    expect(validateUrl('http://169.254.169.254/sub').ok).toBe(false);
  });
});

describe('isBlockedIp', () => {
  it('should block loopback', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('::1')).toBe(true);
  });

  it('should block private ranges', () => {
    expect(isBlockedIp('10.1.2.3')).toBe(true);
    expect(isBlockedIp('192.168.0.1')).toBe(true);
    expect(isBlockedIp('172.16.5.5')).toBe(true);
    expect(isBlockedIp('172.32.0.1')).toBe(false); // 172.32 不在私有段
  });

  it('should allow public IPs', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
  });

  // v2.23.0：扩充保留网段 + 非标准 IPv4 + IPv6 映射
  it('should block CGNAT 100.64/10', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true);
    expect(isBlockedIp('100.127.255.255')).toBe(true);
    expect(isBlockedIp('100.128.0.1')).toBe(false); // 超出 /10
  });

  it('should block benchmark 198.18/15 and test-net ranges', () => {
    expect(isBlockedIp('198.18.0.1')).toBe(true);
    expect(isBlockedIp('198.19.255.255')).toBe(true);
    expect(isBlockedIp('198.20.0.1')).toBe(false);
    expect(isBlockedIp('192.0.0.1')).toBe(true);   // IETF PI 192.0.0.0/24
    expect(isBlockedIp('192.0.2.1')).toBe(true);   // TEST-NET-1
    expect(isBlockedIp('198.51.100.1')).toBe(true); // TEST-NET-2
    expect(isBlockedIp('203.0.113.1')).toBe(true);  // TEST-NET-3
  });

  it('should block multicast and reserved ranges', () => {
    expect(isBlockedIp('224.0.0.1')).toBe(true);
    expect(isBlockedIp('239.255.255.255')).toBe(true);
    expect(isBlockedIp('240.0.0.1')).toBe(true);
    expect(isBlockedIp('255.255.255.255')).toBe(true);
  });

  it('should reject invalid IPv4 octet values as blocked', () => {
    expect(isBlockedIp('999.1.1.1')).toBe(true);  // 段值 >255
    expect(isBlockedIp('1.2.3.999')).toBe(true);
  });

  it('should block IPv4-mapped IPv6 (::ffff:) for private IPs', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false); // 公网映射放行
  });
});

describe('fetchSubscription', () => {
  it('should throw on SSRF URL', async () => {
    await expect(fetchSubscription('http://127.0.0.1:3000/sub')).rejects.toThrow(
      'SSRF check failed'
    );
  });

  it('should throw on localhost', async () => {
    await expect(fetchSubscription('http://localhost/sub')).rejects.toThrow('SSRF check failed');
  });

  it('should include the underlying cause when fetch itself fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND sub.example.com') });
    });
    try {
      await expect(fetchSubscription('https://sub.example.com/sub')).rejects.toThrow(
        'fetch failed: getaddrinfo ENOTFOUND sub.example.com'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});