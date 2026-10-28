import { describe, it, expect } from 'vitest';
import { parseVless } from '@/parser/vless.parser';
import { parseSubscriptionContent } from '@/parser/index';

// 3X-UI 面板生成的 VLESS+TCP+REALITY 典型格式
const REALITY_NODE = 'vless://550e8400-e29b-41d4-a716-446655440000@192.168.1.1:443?encryption=none&security=reality&type=tcp&headerType=none&flow=xtls-rprx-vision&sni=example.com&fp=chrome&pbk=MyPublicKeyHere&sid=abc123&spx=%2F#My-VLESS-REALITY';

describe('3X-UI VLESS+REALITY nodes', () => {
  it('should parse reality node from 3X-UI', () => {
    const result = parseVless(REALITY_NODE);
    expect(result.success).toBe(true);
    expect(result.node?.protocol).toBe('vless');
    expect(result.node?.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.node?.server).toBe('192.168.1.1');
    expect(result.node?.port).toBe(443);
    expect(result.node?.tls).toBe(true);
    expect(result.node?.flow).toBe('xtls-rprx-vision');
    expect(result.node?.pbk).toBe('MyPublicKeyHere');
    expect(result.node?.sid).toBe('abc123');
    expect(result.node?.sni).toBe('example.com');
    expect(result.node?.name).toBe('My-VLESS-REALITY');
  });

  it('should parse reality node from subscription content', () => {
    const result = parseSubscriptionContent(REALITY_NODE, 'test');
    expect(result.success).toBe(1);
    expect(result.nodes[0].uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.nodes[0].pbk).toBe('MyPublicKeyHere');
  });
});

// Clash YAML 订阅格式
const CLASH_YAML = `proxies:
- name: JP-01
  type: vless
  server: jp.example.com
  port: 443
  uuid: 550e8400-e29b-41d4-a716-446655440000
  tls: true
  flow: xtls-rprx-vision
  udp: true
- name: US-01
  type: vmess
  server: us.example.com
  port: 8443
  uuid: 550e8400-e29b-41d4-a716-446655440001
  tls: true
  network: ws
  ws-opts:
    path: /ws
    headers:
      Host: cdn.example.com
- name: HK-01
  type: trojan
  server: hk.example.com
  port: 443
  password: mypassword
  sni: hk.example.com
- name: SS-01
  type: ss
  server: sg.example.com
  port: 8388
  cipher: aes-256-gcm
  password: sspassword
`;

describe('Clash YAML subscription', () => {
  it('should parse Clash YAML format', () => {
    const result = parseSubscriptionContent(CLASH_YAML, 'clash-sub');
    expect(result.success).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.nodes.length).toBe(4);
  });

  it('should extract vless node from YAML', () => {
    const result = parseSubscriptionContent(CLASH_YAML, 'test');
    const vless = result.nodes.find(n => n.protocol === 'vless');
    expect(vless?.server).toBe('jp.example.com');
    expect(vless?.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(vless?.flow).toBe('xtls-rprx-vision');
  });

  it('should extract vmess node with ws transport from YAML', () => {
    const result = parseSubscriptionContent(CLASH_YAML, 'test');
    const vmess = result.nodes.find(n => n.protocol === 'vmess');
    expect(vmess?.server).toBe('us.example.com');
    expect(vmess?.transport?.type).toBe('ws');
    expect(vmess?.transport?.path).toBe('/ws');
    expect(vmess?.transport?.host).toBe('cdn.example.com');
  });

  it('should extract trojan node from YAML', () => {
    const result = parseSubscriptionContent(CLASH_YAML, 'test');
    const trojan = result.nodes.find(n => n.protocol === 'trojan');
    expect(trojan?.server).toBe('hk.example.com');
    expect(trojan?.password).toBe('mypassword');
  });

  it('should extract ss node from YAML', () => {
    const result = parseSubscriptionContent(CLASH_YAML, 'test');
    const ss = result.nodes.find(n => n.protocol === 'ss');
    expect(ss?.server).toBe('sg.example.com');
    expect(ss?.password).toBe('sspassword');
  });
});

describe('Clash YAML VLESS REALITY 字段保真', () => {
  const REALITY_YAML = `proxies:
- name: REALITY-01
  type: vless
  server: reality.example.com
  port: 443
  uuid: 550e8400-e29b-41d4-a716-446655440000
  tls: true
  flow: xtls-rprx-vision
  servername: target.example.com
  client-fingerprint: chrome
  reality-opts:
    public-key: MyPublicKeyHere
    short-id: abc123
    spx: /spider-path
    support-x25519mlkem768: false
`;

  it('servername 应映射为 node.sni（与 sni 等价）', () => {
    const result = parseSubscriptionContent(REALITY_YAML, 'test');
    expect(result.success).toBe(1);
    expect(result.nodes[0].sni).toBe('target.example.com');
  });

  it('reality-opts 的 spx / support-x25519mlkem768 保留在 metadata.extra', () => {
    const result = parseSubscriptionContent(REALITY_YAML, 'test');
    const extra = result.nodes[0].metadata.extra;
    expect(extra?.spx).toBe('/spider-path');
    expect(extra?.['support-x25519mlkem768']).toBe('false');
  });
});