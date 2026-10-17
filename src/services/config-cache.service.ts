/**
 * v2.32: 配置快照缓存 + ETag
 * 
 * 缓存 key: config:snap:{format}:{version}
 * version 来自 setting:config_version
 * 
 * 失效点（写后即增 version）：
 * - **订阅更新成功落库后**（subscription.service.update）—— v2.38.6 补齐；
 *   此前只有手动动作会失效，导致订阅新增节点后 mihomo 快照长期是旧的
 * - 订阅启用/停用（subscription.service.setEnabled）
 * - 规则选择 / 整组开关 / 自定义规则
 * - 禁用节点 / 锁定节点
 * - 手动「刷新输出配置」（POST /api/output/refresh）
 */

import { KVStorage } from '@/storage/kv';
import { KV_KEYS } from '@/models/config';
import { APP_META } from '@/meta';

export interface SnapshotCache {
  getCachedConfig(format: string): Promise<{ content: string; etag: string; version: number } | null>;
  setCachedConfig(format: string, content: string, version: number): Promise<void>;
  /** 只读查看「当前版本」下是否已有该格式快照，不触发生成 */
  peek(format: string): Promise<{ version: number; generatedAt: number } | null>;
  invalidateAll(): Promise<void>;
  getVersion(): Promise<number>;
  incrementVersion(): Promise<number>;
}

/**
 * 生成内容的 ETag (SHA-256 前 16 字节)
 */
async function generateETag(content: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const bytes = new Uint8Array(buf);
  return `\"${Array.from(bytes.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')}\"`;
}

/**
 * 创建配置快照缓存服务
 *
 * appVersion 参与 key：config_version 只随**数据**变更自增（订阅/规则/分组…），
 * App 升级不会触发 → 旧镜像生成的快照会被新镜像原样吐给用户。
 * 把 App 版本编进 key，升级后自动 miss 并重新生成。
 * （appVersion 可注入仅为可测：见 tests/services/config-cache-version.test.ts）
 */
export function createSnapshotCache(kv: KVStorage, appVersion: string = APP_META.version): SnapshotCache {
  const snapVersion = (version: number) => `${appVersion}:${version}`;
  return {
    async getCachedConfig(format: string) {
      const version = await this.getVersion();
      const key = KV_KEYS.configSnapshot(format, snapVersion(version));
      const raw = await kv.get(key);
      if (!raw) return null;
      
      try {
        const cached = JSON.parse(raw) as { content: string; etag: string; version: number; timestamp: number };
        if (cached.version === version) {
          return { content: cached.content, etag: cached.etag, version: cached.version };
        }
      } catch {}
      return null;
    },

    async setCachedConfig(format: string, content: string, version: number) {
      const etag = await generateETag(content);
      const key = KV_KEYS.configSnapshot(format, snapVersion(version));
      await kv.put(key, JSON.stringify({ content, etag, version, timestamp: Date.now() }));
    },

    async peek(format: string) {
      const version = await this.getVersion();
      const key = KV_KEYS.configSnapshot(format, snapVersion(version));
      const raw = await kv.get(key);
      if (!raw) return null;
      try {
        const cached = JSON.parse(raw) as { version: number; timestamp?: number };
        if (cached.version !== version) return null;
        return { version: cached.version, generatedAt: cached.timestamp ?? 0 };
      } catch {
        return null;
      }
    },

    async invalidateAll() {
      await this.incrementVersion();
    },

    async getVersion(): Promise<number> {
      const raw = await kv.get(KV_KEYS.configVersion);
      if (!raw) return 0;
      const v = parseInt(raw, 10);
      return Number.isInteger(v) ? v : 0;
    },

    async incrementVersion(): Promise<number> {
      const v = await this.getVersion();
      const next = v + 1;
      await kv.put(KV_KEYS.configVersion, String(next));
      return next;
    },
  };
}

/**
 * 中间件：处理 ETag 条件请求
 * 
 * 客户端请求带 If-None-Match → 匹配返回 304
 * 否则返回内容 + ETag
 */
export async function createConfigResponse(
  content: string,
  etag: string,
  request: Request
): Promise<Response> {
  const ifNoneMatch = request.headers.get('If-None-Match');
  
  if (ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        Vary: 'Accept-Encoding',
      },
    });
  }
  
  // 支持 gzip
  const gzip = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
  
  if (gzip) {
    const compressed = await new Response(
      new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    
    return new Response(compressed, {
      headers: {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        Vary: 'Accept-Encoding',
        ETag: etag,
      },
    });
  }
  
  return new Response(content, {
    headers: {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      Vary: 'Accept-Encoding',
      ETag: etag,
    },
  });
}