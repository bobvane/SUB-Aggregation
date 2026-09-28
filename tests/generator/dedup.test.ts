import { describe, it, expect } from 'vitest';
import { makeUniqueNames, generateMihomoConfig } from '@/generator/mihomo';
import { generateSingboxConfig } from '@/generator/singbox';
import { generateBase64Config } from '@/generator/base64-generator';
import { nodeToUrl } from '@/generator/node-to-url';
import { Node } from '@/models/node';

function makeNode(name: string): Node {
  return {
    id: 'n1', name, protocol: 'vless', server: 'example.com', port: 443,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    metadata: { source: 'test', originalName: name, tags: [] },
    version: 1,
  } as Node;
}

describe('makeUniqueNames', () => {
  it('should keep unique names unchanged', async () => {
    const nodes = [makeNode('JP'), makeNode('US'), makeNode('HK')];
    const result = makeUniqueNames(nodes);
    expect(result.map(n => n.name)).toEqual(['JP', 'US', 'HK']);
  });

  it('should append suffix to duplicate names', async () => {
    const nodes = [makeNode('US'), makeNode('US'), makeNode('US')];
    const result = makeUniqueNames(nodes);
    expect(result.map(n => n.name)).toEqual(['US', 'US-1', 'US-2']);
  });

  it('should handle mixed duplicates', async () => {
    const nodes = [makeNode('JP'), makeNode('US'), makeNode('US'), makeNode('JP')];
    const result = makeUniqueNames(nodes);
    expect(result.map(n => n.name)).toEqual(['JP', 'US', 'US-1', 'JP-1']);
  });
});

describe('generators with duplicate names', () => {
  it('should not produce duplicate proxy names in mihomo', async () => {
    const yaml = await generateMihomoConfig([makeNode('US'), makeNode('US')]);
    expect(yaml).toContain('US');
    expect(yaml).toContain('US-1');
    // 确保只有 US-1，没有重复
    expect(yaml.match(/^\s+- name: US$/m)).toBeTruthy();
    expect(yaml.match(/^\s+- name: US-1$/m)).toBeTruthy();
  });

  it('should not produce duplicate tags in singbox', async () => {
    const json = generateSingboxConfig([makeNode('US'), makeNode('US')]);
    expect(json).toContain('"US"');
    expect(json).toContain('"US-1"');
  });

  it('should not produce duplicate names in base64 (v2ray/v2rayNG)', async () => {
    const encoded = generateBase64Config([makeNode('US'), makeNode('US')]);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    expect(decoded).toContain('#US');
    expect(decoded).toContain('#US-1');
  });

  it('nodeToUrl keeps originalUrl params but overrides fragment with cleaned name', () => {
    // 原链名字是旧名，node.name 为当前名（v2.35 起由生成时自动命名给出）
    const n = {
      ...makeNode('美国bob'),
      name: '美国bob',
      metadata: { source: 'test', originalName: 'US-bob something', originalUrl: 'vless://uuid@example.com:443?encryption=none#US-bob something', tags: [] },
    } as Node;
    const url = nodeToUrl(n);
    expect(url).toContain('?encryption=none');   // 参数零丢失
    expect(url).toContain('#%E7%BE%8E%E5%9B%BDbob'); // 片段=清洗后名
    expect(url).not.toContain('#US-bob');
  });
});