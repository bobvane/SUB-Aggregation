/**
 * Fetcher 模块 - 订阅内容抓取
 * TASK 3.3 - External Fetch Service
 * 11_SECURITY.md §4-5：SSRF 防护 + Timeout + Size Limit + Redirect 限制
 */

const ALLOWED_PROTOCOLS = ['https:', 'http:'];
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const FETCH_TIMEOUT_MS = 10_000; // 10 秒
const MAX_REDIRECTS = 3;

/**
 * 私有/保留 IP 判断（基于数值 CIDR，覆盖全部保留网段）
 * v2.23.0：替代原字符串前缀匹配，补齐 100.64/10(CGNAT)、192.0.0/24、198.18/15、
 * 组播、TEST-NET、保留区及 IPv6 映射等遗漏网段
 */

/** 将 IPv4 字符串解析为 32 位数值，非法返回 null */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n > 255) return null; // 每段必须 ≤255
    result = (result << 8) | n;
  }
  return result >>> 0;
}

interface Cidr { base: number; mask: number; name: string; }

const BLOCKED_IPV4: Cidr[] = [
  { base: 0x00000000, mask: 8, name: 'this-network' },      // 0.0.0.0/8
  { base: 0x0a000000, mask: 8, name: 'private-10' },        // 10.0.0.0/8
  { base: 0x64400000, mask: 10, name: 'cg-nat' },           // 100.64.0.0/10
  { base: 0x7f000000, mask: 8, name: 'loopback' },          // 127.0.0.0/8
  { base: 0xa9fe0000, mask: 16, name: 'link-local' },       // 169.254.0.0/16
  { base: 0xac100000, mask: 12, name: 'private-172' },      // 172.16.0.0/12
  { base: 0xc0000000, mask: 24, name: 'ietf-pi' },          // 192.0.0.0/24
  { base: 0xc0000200, mask: 24, name: 'test-net-1' },       // 192.0.2.0/24
  { base: 0xc0a80000, mask: 16, name: 'private-192' },      // 192.168.0.0/16
  { base: 0xc6120000, mask: 15, name: 'benchmark' },        // 198.18.0.0/15
  { base: 0xc6336400, mask: 24, name: 'test-net-2' },       // 198.51.100.0/24
  { base: 0xcb007100, mask: 24, name: 'test-net-3' },       // 203.0.113.0/24
  { base: 0xe0000000, mask: 4, name: 'multicast' },         // 224.0.0.0/4
  { base: 0xf0000000, mask: 4, name: 'reserved' },          // 240.0.0.0/4
];

/** 判断一个 IPv4 数值是否落在任一保留网段 */
export function isBlockedIpv4Int(int: number): boolean {
  return BLOCKED_IPV4.some((c) => {
    const maskBits = 32 - c.mask;
    return (int >>> maskBits) === (c.base >>> maskBits);
  });
}

/** IPv6 保留段：采用字符串前缀（IPv6 保留段前缀固定，无需数值计算） */
const BLOCKED_IPV6_PREFIXES: string[] = [
  '::',         // 未指定
  '::1',        // loopback
  'fc00:',      // ULA fc00::/7
  'fd00:',      // ULA fd00::/8
  'fe80:',      // link-local
  'fe9',        // 0xfe8/0xfe9/0xfea/0xfeb (fe80::/10)
  'fea',
  'feb',
  'ff00:',      // multicast ff00::/8
];

/**
 * 判断 IP 是否为禁止访问的地址（SSRF 防护）
 * 支持 IPv4 点分十进制、IPv6（含 ::ffff 映射 IPv4）
 */
export function isBlockedIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    const int = ipv4ToInt(trimmed);
    if (int === null) return true; // 段值非法（如 999.1.1.1）视为不可信阻止
    return isBlockedIpv4Int(int);
  }

  // IPv6 映射地址 ::ffff:<IPv4>（标准的 IPv4-mapped IPv6）
  const v4Mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Mapped) {
    const int = ipv4ToInt(v4Mapped[1]);
    if (int === null) return true;
    return isBlockedIpv4Int(int);
  }

  // IPv6 字面量（去掉方括号）
  if (trimmed.includes(':')) {
    const clean = trimmed.replace(/^\[|\]$/g, '');
    return BLOCKED_IPV6_PREFIXES.some((prefix) => clean.startsWith(prefix));
  }

  return false;
}

/**
 * 从 URL 提取主机名并检查是否合法
 * 只做静态检查（域名→IP 解析后的检查在运行时不可控，尽力而为）
 */
export function validateUrl(url: string): { ok: true; parsed: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, reason: `Protocol ${parsed.protocol} not allowed` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 禁止 localhost / IP 形式
  if (hostname === 'localhost') {
    return { ok: false, reason: 'localhost is not allowed' };
  }

  // 检查是否为 IP 字面量
  const ipv4Match = hostname.match(/^\d{1,3}(\.\d{1,3}){3}$/);
  if (ipv4Match) {
    if (isBlockedIp(hostname)) {
      return { ok: false, reason: 'Private or reserved IP is not allowed' };
    }
  }

  // IPv6 字面量 [::1] 形式
  if (hostname.includes(':')) {
    const cleanIp = hostname.replace(/^\[|\]$/g, '');
    if (isBlockedIp(cleanIp)) {
      return { ok: false, reason: 'Private or reserved IP is not allowed' };
    }
  }

  return { ok: true, parsed };
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(input: string | URL | Request, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 网络错误往往只有笼统的 “fetch failed”，把 Node/undici 的 cause（DNS、连接被拒等）
 * 一并带给管理界面，NAS 用户才能判断是域名解析、出站网络还是远端拦截。
 */
function describeFetchError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (err.name === 'AbortError') return new Error('Fetch timeout');

  const cause = (err as Error & { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof cause === 'string' ? cause : '';
  if (!causeMessage || err.message.includes(causeMessage)) return err;
  return new Error(`${err.message}: ${causeMessage}`);
}

/**
 * 抓取订阅内容
 * 校验：URL 合法 → 超时 → 重定向限制 → 响应大小限制
 */
export async function fetchSubscription(url: string): Promise<string> {
  const validation = validateUrl(url);
  if (!validation.ok) {
    throw new Error(`SSRF check failed: ${validation.reason}`);
  }

  let currentUrl: string = url;

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await fetchWithTimeout(currentUrl, {
        headers: {
          'User-Agent': 'SUB-Aggregation/2.0',
          Accept: 'text/plain,text/html,application/json,*/*',
        },
        redirect: 'manual', // 手动处理重定向以计数
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const location = res.headers.get('location')!;
        currentUrl = new URL(location, currentUrl).toString();
        // 每次重定向都重新校验目标 URL（防 SSRF 绕过）
        const redirectValidation = validateUrl(currentUrl);
        if (!redirectValidation.ok) {
          throw new Error(`Redirect SSRF check failed: ${redirectValidation.reason}`);
        }
        continue;
      }

      if (!res.ok) {
        throw new Error(`Fetch failed with status ${res.status}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        throw new Error('Response too large (content-length)');
      }

      const text = await res.text();
      if (text.length > MAX_RESPONSE_SIZE) {
        throw new Error('Response too large');
      }
      return text;
    }
    throw new Error('Too many redirects');
  } catch (err) {
    throw describeFetchError(err);
  }
}