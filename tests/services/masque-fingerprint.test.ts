/**
 * v2.50.5：MASQUE 指纹必须区分传输层（h2/h3）与 SNI，
 * 否则同一 Cloudflare 端点生成的 H2/H3 会在入库去重时互相覆盖。
 */
import { describe, it, expect } from 'vitest';
import { createNode, nodeFingerprint } from '@/models/node';
import { deduplicateNodes } from '@/parser';

const mk = (network: 'h2' | 'h3', sni = 'consumer-masque.cloudflareclient.com') =>
  createNode({
    name: `M-${network}`,
    protocol: 'masque',
    server: '162.159.198.1',
    port: 443,
    masqueNetwork: network,
    sni,
  });

describe('MASQUE 指纹', () => {
  it('同端点 H2 / H3 指纹不同', () => {
    expect(nodeFingerprint(mk('h2'))).not.toBe(nodeFingerprint(mk('h3')));
  });

  it('同传输、不同 SNI 指纹不同', () => {
    expect(nodeFingerprint(mk('h3', 'a.example'))).not.toBe(nodeFingerprint(mk('h3', 'b.example')));
  });

  it('同端点 H2/H3 去重后都保留', () => {
    const out = deduplicateNodes([mk('h2'), mk('h3')]);
    expect(out).toHaveLength(2);
  });

  it('同端点、同传输、同 SNI 去重为 1', () => {
    expect(deduplicateNodes([mk('h3'), mk('h3')])).toHaveLength(1);
  });
});
