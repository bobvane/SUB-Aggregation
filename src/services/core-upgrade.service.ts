/**
 * mihomo 核心升级服务（v2.50.0）
 *
 * 从 GitHub 官方 Releases 下载最新 linux-amd64 二进制，安装到持久化目录
 * （默认 /data/core/mihomo），供容器重建后继续使用。
 *
 * 流程：停止当前核心 → 下载到临时文件 → gunzip → chmod → `mihomo -v` 验证
 *      → 备份旧文件 → 原子替换 → 失效版本缓存。
 *
 * 说明：不做 SHA256 校验（按用户约定）；保留「临时文件 + 试运行 + 备份回滚」。
 * 下载走项目代理的 github_release 目标（由调用方传入 FetchFn）。
 */

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';import { gunzipSync } from 'node:zlib';
import type { FetchFn } from '@/engine/http-client';
import {
  getCoreVersion,
  invalidateCoreVersionCache,
  resolveCorePath,
  stopActiveCore,
} from './core-probe.service';

const GITHUB_LATEST_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';

export interface CoreReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface CoreLatestRelease {
  version: string;
  assetName: string;
  downloadUrl: string;
}

export interface CoreUpgradeResult {
  from: string | null;
  to: string;
  path: string;
}

/** 核心安装目录（持久化卷） */
export function coreInstallDir(): string {
  return process.env.CORE_INSTALL_DIR ?? '/data/core';
}

function coreInstallPath(): string {
  return join(coreInstallDir(), 'mihomo');
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'SUB-Aggregation',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** 查询 GitHub 最新 mihomo Release，选出 linux-amd64 标准压缩包 */
export async function getLatestCoreRelease(
  fetchFn: FetchFn,
  token?: string
): Promise<CoreLatestRelease> {
  const res = await fetchFn(GITHUB_LATEST_API, { headers: authHeaders(token) });
  if (!res.ok) {
    throw new Error(`查询 GitHub 最新核心失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name?: string;
    assets?: CoreReleaseAsset[];
  };
  const version = String(data.tag_name ?? '').replace(/^v/i, '');
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const asset = assets.find(
    (a) =>
      /^mihomo-linux-amd64-v.*\.gz$/i.test(a.name) &&
      !/compatible/i.test(a.name) &&
      !/go1\d+/i.test(a.name)
  );
  if (!version || !asset) {
    throw new Error('未找到 linux-amd64 的 mihomo 发布包');
  }
  return {
    version,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
  };
}

function verifyBinary(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ['-v'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`核心自检失败：${err.message}`));
        return;
      }
      const out = `${stdout}\n${stderr}`.trim();
      const m = out.match(/v?(\d+\.\d+\.\d+[^\s]*)/i);
      resolve(m ? m[1] : out.split('\n')[0] || 'unknown');
    });
  });
}

/**
 * 升级核心到 GitHub 最新版本。
 * 失败时保留旧版本（临时文件清理），不破坏现有安装。
 */
export async function upgradeCore(
  fetchFn: FetchFn,
  token?: string
): Promise<CoreUpgradeResult> {
  const latest = await getLatestCoreRelease(fetchFn, token);
  const from = await getCoreVersion(true);

  const dir = coreInstallDir();
  mkdirSync(dir, { recursive: true });
  const target = coreInstallPath();
  const tmp = `${target}.tmp`;
  const backup = `${target}.bak`;

  // 停止正在运行的测速核心，避免替换时文件被占用
  stopActiveCore();

  try {
    const res = await fetchFn(latest.downloadUrl, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`下载核心失败：HTTP ${res.status}`);
    }
    const gz = Buffer.from(await res.arrayBuffer());
    let bin: Buffer;
    try {
      bin = gunzipSync(gz);
    } catch {
      throw new Error('核心压缩包解压失败');
    }
    writeFileSync(tmp, bin);
    chmodSync(tmp, 0o755);

    // 自检：能运行 `-v` 才算安装成功
    const installedVersion = await verifyBinary(tmp);

    // 备份旧版本（存在才备份）
    if (existsSync(target)) {
      try {
        rmSync(backup, { force: true });
      } catch {
        // ignore
      }
      renameSync(target, backup);
    }
    renameSync(tmp, target);
    invalidateCoreVersionCache();

    return { from, to: installedVersion || latest.version, path: target };
  } catch (e) {
    // 回滚：若旧版本已被备份而新文件未就位，恢复旧版本
    try {
      if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    } catch {
      // ignore
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

/** 当前核心状态（供设置页显示） */
export async function getCoreStatus(): Promise<{
  version: string | null;
  path: string | null;
  installPath: string;
  installed: boolean;
}> {
  const path = resolveCorePath();
  const version = await getCoreVersion();
  return {
    version,
    path,
    installPath: coreInstallPath(),
    installed: !!path,
  };
}
