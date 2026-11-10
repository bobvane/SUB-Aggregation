/**
 * 按用途区分的出网 HTTP 客户端（v2.44.0）
 *
 * 设计要点：
 *   - 每次调用按「设置项 > 环境变量 > 直连」解析代理策略，不污染全局 dispatcher；
 *   - 只有明确允许的用途才走代理（subscription / github / geo）；
 *     订阅抓取默认不代理，v2.44.2 起「未勾选的用途」连失败回退也不会走代理；
 *   - auto 模式下代理失败才回退直连（默认开启，超时不回退），
 *     避免「代理 407 → 所有订阅全灭」再次发生；
 *   - 节点测活/测速不接入本模块，必须保持裸 TCP/TLS。
 */

import { Agent, ProxyAgent } from 'undici';
import { describeFetchError, isTimeoutError } from './net-errors';
import {
  proxyUrlForTarget,
  readEffectiveProxyConfig,
  shouldBypass,
  type EnvLike,
  type ProxyChoice,
  type ProxyPurpose,
  type SettingsReader,
} from './proxy-config';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpFetchInit extends RequestInit {
  /** 单次请求超时（毫秒）；不传使用用途默认值 */
  timeoutMs?: number;
  /** auto（默认）：按用途策略；on：强制代理；off：强制直连 */
  choice?: ProxyChoice;
}

export type ProxyTestResult = {
  ok: boolean;
  via: 'proxy' | 'none';
  status?: number;
  ms: number;
  error?: string;
};

export interface HttpClient {
  fetch(purpose: ProxyPurpose, url: string, init?: HttpFetchInit): Promise<Response>;
  asFetch(purpose: ProxyPurpose): FetchFn;
  /** 设置页「测试代理」：固定目标，不允许任意 URL，避免 SSRF */
  testProxy(): Promise<ProxyTestResult>;
}

export const DEFAULT_TIMEOUT_MS: Record<ProxyPurpose, number> = {
  // v2.44.2：订阅源常在境外且内容较大，10s 容易把「慢」误判成「失败」；
  // 与 fetcher.ts 的 FETCH_TIMEOUT_MS 保持一致。
  subscription: 30_000,
  github: 15_000,
  geo: 10_000,
};

const TEST_PROXY_TARGET = 'https://www.gstatic.com/generate_204';
const TEST_PROXY_TIMEOUT_MS = 8_000;

// ============ Agent 缓存（避免每次请求都新建连接池） ============

let directAgent: Agent | null = null;
const proxyAgents = new Map<string, ProxyAgent>();

function getDirectAgent(): Agent {
  if (!directAgent) directAgent = new Agent();
  return directAgent;
}

function getProxyAgent(url: string): ProxyAgent {
  let agent = proxyAgents.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    proxyAgents.set(url, agent);
  }
  return agent;
}

/** 设置变更后调用：关闭并清空连接池，让新配置立即生效 */
export function resetHttpAgents(): void {
  for (const agent of proxyAgents.values()) {
    void agent.close().catch(() => {});
  }
  proxyAgents.clear();
  if (directAgent) {
    void directAgent.close().catch(() => {});
    directAgent = null;
  }
}

function combineErrors(primary: unknown, fallback: unknown, fallbackLabel: string): Error {
  const first = describeFetchError(primary).message;
  const second = describeFetchError(fallback).message;
  return new Error(`${first}；${fallbackLabel}也失败：${second}`);
}

export function createHttpClient(
  settings: SettingsReader,
  options: { rawFetch?: typeof fetch; env?: EnvLike } = {}
): HttpClient {
  const injectedFetch = options.rawFetch;
  const env = options.env ?? process.env;

  async function request(
    url: string,
    init: HttpFetchInit | undefined,
    purpose: ProxyPurpose,
    proxyUrl: string | null
  ): Promise<Response> {
    const timeout = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS[purpose];
    const typeSignal = AbortSignal.timeout(timeout);
    const rest: HttpFetchInit = { ...(init ?? {}) };
    delete rest.timeoutMs;
    delete rest.choice;
    const signal = rest.signal ? AbortSignal.any([rest.signal, typeSignal]) : typeSignal;
    const dispatchOptions = {
      ...rest,
      signal,
      dispatcher: proxyUrl ? getProxyAgent(proxyUrl) : getDirectAgent(),
    };
    // Node 内置 fetch 的 RequestInit 类型未声明 dispatcher（undici 扩展）
    // 注入函数优先；否则每次调用时解析全局 fetch，便于测试 stubGlobal 生效
    const doFetch = injectedFetch ?? fetch;
    return doFetch(url, dispatchOptions as unknown as RequestInit);
  }

  async function fetchWithPolicy(
    purpose: ProxyPurpose,
    url: string,
    init?: HttpFetchInit
  ): Promise<Response> {
    const config = await readEffectiveProxyConfig(settings, env);
    const choice: ProxyChoice = init?.choice ?? 'auto';
    const targetProxy = proxyUrlForTarget(config, url, env);

    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      // 交给 fetch 抛 URL 解析错误
    }
    const bypassed = hostname ? shouldBypass(hostname, config.bypass) : false;

    let useProxy: boolean;
    if (choice === 'on') {
      if (!targetProxy) {
        throw new Error('当前订阅设置为强制代理，但系统未配置代理地址');
      }
      useProxy = true;
    } else if (choice === 'off') {
      useProxy = false;
    } else {
      useProxy = config.mode !== 'off' && !!targetProxy && config.scope.includes(purpose) && !bypassed;
    }

    try {
      return await request(url, init, purpose, useProxy ? targetProxy : null);
    } catch (err) {
      // 显式 on/off 不回退；超时不回退（否则等待时间翻倍）
      if (choice !== 'auto' || !config.fallback || isTimeoutError(err)) {
        throw describeFetchError(err);
      }

      if (useProxy) {
        try {
          console.warn(`[Proxy] 代理失败，回退直连: ${hostname || url}`);
          return await request(url, init, purpose, null);
        } catch (fallbackErr) {
          throw combineErrors(err, fallbackErr, '直连回退');
        }
      }

      // v2.44.2：移除「直连失败 → 回退代理」。
      // auto 模式首选直连只会因为「用途未勾选 / 命中 bypass / 没有代理地址」而发生，
      // 这三种情况都不允许再走代理；旧实现只看有没有代理地址，导致只勾 github/geo
      // 时订阅直连失败仍被代理接管，使「未勾选的用途始终直连」变成假话。
      // 保留的救援方向是上面的「代理失败 → 回退直连」。
      throw describeFetchError(err);
    }
  }

  return {
    fetch: fetchWithPolicy,

    asFetch(purpose: ProxyPurpose): FetchFn {
      return (url, init) => fetchWithPolicy(purpose, url, init as HttpFetchInit);
    },

    async testProxy(): Promise<ProxyTestResult> {
      const started = Date.now();
      const config = await readEffectiveProxyConfig(settings, env);
      const targetProxy = proxyUrlForTarget(config, TEST_PROXY_TARGET, env);
      if (!targetProxy) {
        return { ok: false, via: 'none', ms: 0, error: '未配置代理地址（当前为直连）' };
      }
      try {
        const res = await request(TEST_PROXY_TARGET, { timeoutMs: TEST_PROXY_TIMEOUT_MS }, 'github', targetProxy);
        return {
          ok: res.ok || res.status === 204,
          via: 'proxy',
          status: res.status,
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          via: 'proxy',
          ms: Date.now() - started,
          error: describeFetchError(err).message,
        };
      }
    },
  };
}

/** 测试/诊断用：判断某个 URL 在当前设置下是否会走代理 */
export async function describeProxyDecision(
  settings: SettingsReader,
  purpose: ProxyPurpose,
  url: string,
  env: EnvLike = process.env
): Promise<{ useProxy: boolean; proxyUrl: string | null }> {
  const config = await readEffectiveProxyConfig(settings, env);
  const proxyUrl = proxyUrlForTarget(config, url, env);
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // ignore
  }
  const useProxy = config.mode !== 'off'
    && !!proxyUrl
    && config.scope.includes(purpose)
    && (!hostname || !shouldBypass(hostname, config.bypass));
  return { useProxy, proxyUrl: useProxy ? proxyUrl : null };
}
