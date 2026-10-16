/**
 * 测试 - 项目元信息与升级检测 API
 */
import { describe, it, expect } from 'vitest';
import { APP_META, isNewerVersion } from '@/meta';
import pkg from '../../package.json';

describe('APP_META.version 单一来源（v2.38.3 修复）', () => {
  it('运行版本号 == package.json 的 version（不再硬编码漂移）', () => {
    expect(APP_META.version).toBe(pkg.version);
  });

  it('版本号为 x.y.z 形式，且能被升级检测函数消费', () => {
    expect(APP_META.version).toMatch(/^\d+\.\d+\.\d+$/);
    // 「运行版本」是本地版本，「最新版本」来自 GitHub —— 二者语义必须可区分
    expect(isNewerVersion('99.0.0', APP_META.version)).toBe(true);
    expect(isNewerVersion(APP_META.version, APP_META.version)).toBe(false);
  });
});

describe('isNewerVersion（语义化版本比较）', () => {
  it('检测出新版本', () => {
    expect(isNewerVersion('1.1.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
  });

  it('检测出不是新版本（相等或更旧）', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(false);
  });

  it('容忍数字前缀 v', () => {
    // 注意：调用方负责去掉 v 前缀；此函数只比较纯数字段
    expect(isNewerVersion('1.0.1', '1.0')).toBe(true);
    expect(isNewerVersion('1.0', '1.0.1')).toBe(false);
  });

  it('非数字段降级为 0', () => {
    expect(isNewerVersion('abc', '0.1.0')).toBe(false);
  });
});