import { describe, it, expect } from 'vitest';
import { handleHtml } from '@/app';

/**
 * 前端 HTML 响应缓存（ETag / 304）
 * `/` 由 handleHtml 直接应答，不经过应用装配，因此不需要 KV。
 */
describe('前端 HTML 缓存', () => {
  const call = async (headers?: Record<string, string>) => {
    const res = await handleHtml(new Request('https://example.com/', { headers }));
    if (!res) throw new Error('handleHtml 未对 / 返回响应');
    return res;
  };

  it('应返回 200 且带内容哈希 ETag 与 Cache-Control', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    // 16 字节 → 32 位十六进制，带引号
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('If-None-Match 命中时应返回 304 且无响应体', async () => {
    const etag = (await call()).headers.get('ETag');
    expect(etag).not.toBeNull();
    const res = await call({ 'If-None-Match': etag as string });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('ETag')).toBe(etag);
  });

  it('If-None-Match 不匹配时应返回 200 完整 HTML', async () => {
    const res = await call({ 'If-None-Match': '"deadbeefdeadbeefdeadbeefdeadbeef"' });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  it('多次请求的 ETag 应稳定（同一份 HTML 内容）', async () => {
    const a = (await call()).headers.get('ETag');
    const b = (await call()).headers.get('ETag');
    expect(a).toBe(b);
  });

  it('Accept-Encoding: gzip 时应返回 gzip 压缩体，解压后与原文一致', async () => {
    const plain = await call();
    const gz = await call({ 'Accept-Encoding': 'gzip' });
    expect(gz.headers.get('Content-Encoding')).toBe('gzip');
    expect(gz.headers.get('Vary')).toBe('Accept-Encoding');
    // 两种表示用不同 ETag，避免缓存串味
    expect(gz.headers.get('ETag')).toBe(`${(plain.headers.get('ETag') as string).slice(0, -1)}-gzip"`);
    const plainText = await plain.text();
    const gzBytes = await gz.arrayBuffer();
    const raw = await new Response(
      new Blob([gzBytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).text();
    expect(raw).toBe(plainText);
    // 确实变小了：按 **UTF-8 字节** 比较才是正确基准（plainText.length 是 JS 字符数，
    // 中文占 3 字节，用它当分母会随文案增长而失真）。v2.38.6 改为字节比例。
    const plainBytes = new TextEncoder().encode(plainText).byteLength;
    expect(gzBytes.byteLength).toBeLessThan(plainBytes);
    expect(gzBytes.byteLength).toBeLessThan(plainBytes * 0.5);
  });

  it('gzip 客户端带对应 ETag 复访应命中 304', async () => {
    const etag = (await call({ 'Accept-Encoding': 'gzip' })).headers.get('ETag');
    const res = await call({ 'Accept-Encoding': 'gzip', 'If-None-Match': etag as string });
    expect(res.status).toBe(304);
  });
});
