/**
 * 守护测试：Docker 构建上下文必须包含 .github/scripts（v2.38.9）
 *
 * 背景：镜像构建阶段会执行 `npm run build:html && npm test`，而
 * tests/tools/release-audit.test.ts 需要导入 .github/scripts/release-audit.mjs。
 * v2.38.8 的 tag 发布因 .dockerignore 排除了整个 .github 而在镜像内报
 * "Cannot find module '../../.github/scripts/release-audit.mjs'"，导致发布失败。
 * 该测试防止同类改动再次悄悄破坏镜像构建。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = process.cwd();

function ignorePatterns(): string[] {
  return readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** 简化版 .dockerignore 匹配：目录前缀 / 完全相等 / 后缀通配 / 取反 */
function isIgnored(path: string): boolean {
  let ignored = false;
  for (const raw of ignorePatterns()) {
    const negate = raw.startsWith('!');
    const pat = (negate ? raw.slice(1) : raw).replace(/\/$/, '');
    let hit = path === pat || path.startsWith(pat + '/');
    if (!hit && pat.startsWith('*.')) hit = path.endsWith(pat.slice(1));
    if (!hit && pat.endsWith('/*')) hit = path.startsWith(pat.slice(0, -1));
    if (hit) ignored = !negate;
  }
  return ignored;
}

describe('Docker 构建上下文（.dockerignore）', () => {
  it('不排除 .github/scripts/release-audit.mjs（镜像内 npm test 依赖它）', () => {
    expect(isIgnored('.github/scripts/release-audit.mjs')).toBe(false);
    expect(isIgnored('.github/scripts/release-audit.d.mts')).toBe(false);
  });

  it('仍排除体积大或敏感的目录', () => {
    expect(isIgnored('node_modules/vitest/package.json')).toBe(true);
    expect(isIgnored('.git/config')).toBe(true);
    expect(isIgnored('dist/server.mjs')).toBe(true);
    expect(isIgnored('coverage/index.html')).toBe(true);
    expect(isIgnored('.env')).toBe(true);
    expect(isIgnored('app.log')).toBe(true);
  });

  it('.github/workflows 仍可排除（镜像内不需要）', () => {
    expect(isIgnored('.github/workflows/ci-cd.yml')).toBe(true);
  });
});
