/**
 * 按目标区分的出网 HTTP 客户端（v2.46.0）
 *
 * 决策顺序（顺序即优先级）：
 *   1. 命中 bypass          → 直连（一票否决，任何策略都改不了）
 *   2. 未配置代理地址        → 直连
 *   3. 目标策略 = off       → 直连
 *   4. 目标策略 = on        → 代理
 *   5. 目标策略 = auto      → 先直连（3 秒探测），失败再走代理
 *
 * 「3 秒探测」只约束「握手 + 收到响应头」：一旦拿到 headers 就清掉计时器，
 * 让响应体按完整业务超时慢慢下载。否则 20MB 的大订阅会被误判成「直连不通」。
 *
 * 节点测活/测速不接入本模块，必须保持裸 TCP/TLS。
 */

import { Agent, ProxyAgent } from 'undici';
import { describeFetchError, isTimeoutError } from './net-errors';
import {
  PROXY_PROBE_TIMEOUT_MS,
  readEffectiveProxyConfig,
  shouldBypass,
  type ProxyTarget,
  type SettingsReader,
} from './proxy-config';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpFetchInit extends RequestInit {
  /** 单次请求超时（毫秒）；不传使用目标的默认值 */
  timeoutMs?: number;
}

export type ProxyTestResult = {
  ok: boolean;
  via: 'proxy' | 'none';
  status?: number;
  ms: number;
  error?: string;
};

export interface HttpClient {
  fetch(target: ProxyTarget, url: string, init?: HttpFetchInit): Promise<Response>;
  asFetch(target: ProxyTarget): FetchFn;
  /** 设置页「测试代理」：固定目标，不允许任意 URL，避免 SSRF；永远走代理 */
  testProxy(): Promise<ProxyTestResult>;
}

export const DEFAULT_TIMEOUT_MS: Record<ProxyTarget, number> = {
  // 订阅源常在境外且内容较大，10s 容易把「慢」误判成「失败」
  subscription: 30_000,
  rules: 15_000,
  version: 15_000,
  dns: 5_000,
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

/** 合并两条通道的错误，让界面能看出「两边都试过了」以及各自原因 */
function combineErrors(direct: unknown, proxy: unknown): Error {
  const first = describeFetchError(direct).message;
  const second = describeFetchError(proxy).message;
  return new Error(`直连失败：${first}；代理也失败：${second}`);
}

export function createHttpClient(
  settings: SettingsReader,
  options: { rawFetch?: typeof fetch; probeTimeoutMs?: number } = {}
): HttpClient {
  const injectedFetch = options.rawFetch;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROXY_PROBE_TIMEOUT_MS;

  function parseHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /**
   * 单次尝试。proxyUrl 为 null 走直连。
   * extraSignal 用于 auto 模式的短探测，与完整超时叠加。
   */
  async function attempt(
    url: string,
    init: HttpFetchInit | undefined,
    target: ProxyTarget,
    proxyUrl: string | null
  ): Promise<Response> {
    const timeout = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS[target];
    const typeSignal = AbortSignal.timeout(timeout);
    const rest: HttpFetchInit = { ...(init ?? {}) };
    delete rest.timeoutMs;
    const signal = rest.signal ? AbortSignal.any([rest.signal, typeSignal]) : typeSignal;
    const doFetch = injectedFetch ?? fetch;
    return doFetch(url, {
      ...rest,
      signal,
      dispatcher: proxyUrl ? getProxyAgent(proxyUrl) : getDirectAgent(),
    } as unknown as RequestInit);
  }

  /**
   * auto 模式的直连探测。
   *
   * 用一个额外的 AbortController 做 3 秒计时，而不是直接把 timeout 设成 3 秒：
   * 一旦 headers 到达就清掉计时器，响应体仍按完整业务超时下载。
   */
  async function attemptDirectWithProbe(
    url: string,
    init: HttpFetchInit | undefined,
    target: ProxyTarget
  ): Promise<Response> {
    const timeout = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS[target];
    const probeMs = Math.min(probeTimeoutMs, timeout);

    const probeController = new AbortController();
    const fullSignal = AbortSignal.timeout(timeout);
    const signals = [fullSignal, probeController.signal];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);

    const rest: HttpFetchInit = { ...(init ?? {}) };
    delete rest.timeoutMs;

    const timer = setTimeout(() => {
      probeController.abort(new Error('直连探测超时'));
    }, probeMs);

    try {
      const doFetch = injectedFetch ?? fetch;
      return await doFetch(url, {
        ...rest,
        signal,
        dispatcher: getDirectAgent(),
      } as unknown as RequestInit);
    } finally {
      // headers 已到达：停掉探测计时器，让 body 继续按完整超时下载
      clearTimeout(timer);
    }
  }

  async function fetchWithPolicy(
    target: ProxyTarget,
    url: string,
    init?: HttpFetchInit
  ): Promise<Response> {
    const config = await readEffectiveProxyConfig(settings);
    const hostname = parseHostname(url);

    // 所有失败都展开 cause 链，避免界面只看到一句 "fetch failed"
    const direct = async () => {
      try {
        return await attempt(url, init, target, null);
      } catch (err) {
        throw describeFetchError(err);
      }
    };
    const viaProxy = async (proxyUrl: string) => {
      try {
        return await attempt(url, init, target, proxyUrl);
      } catch (err) {
        throw describeFetchError(err);
      }
    };

    // 1. bypass 一票否决：内网地址永远直连，内网走代理既慢又多半不通
    if (hostname && shouldBypass(hostname, config.bypass)) {
      return direct();
    }

    const proxyUrl = config.proxyUrl;
    const mode = config.targets[target];

    // 2/3. 没配代理 或 显式要求直连
    if (!proxyUrl || mode === 'off') {
      return direct();
    }

    // 4. 显式要求代理
    if (mode === 'on') {
      return viaProxy(proxyUrl);
    }

    // 5. auto：先直连探测，失败再走代理
    try {
      return await attemptDirectWithProbe(url, init, target);
    } catch (directErr) {
      // 调用方主动取消：不应当成「直连不通」而去试代理
      if (init?.signal?.aborted) throw describeFetchError(directErr);
      console.warn(`[Proxy] 直连失败，改用代理: ${hostname || url}（${describeFetchError(directErr).message}）`);
      try {
        return await viaProxy(proxyUrl);
      } catch (proxyErr) {
        throw combineErrors(directErr, proxyErr);
      }
    }
  }

  return {
    fetch: fetchWithPolicy,

    asFetch(target: ProxyTarget): FetchFn {
      return (url, init) => fetchWithPolicy(target, url, init as HttpFetchInit);
    },

    async testProxy(): Promise<ProxyTestResult> {
      const started = Date.now();
      const config = await readEffectiveProxyConfig(settings);
      if (!config.proxyUrl) {
        return { ok: false, via: 'none', ms: 0, error: '未配置代理地址（留空表示不走代理）' };
      }
      try {
        const res = await attempt(TEST_PROXY_TARGET, { timeoutMs: TEST_PROXY_TIMEOUT_MS }, 'version', config.proxyUrl);
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

export interface ProxyDecision {
  /** 该目标当前策略 */
  mode: 'auto' | 'on' | 'off';
  /** 是否命中 bypass（命中则永远直连） */
  bypassed: boolean;
  /** 是否会先做一次直连探测（仅 auto 且未 bypass 且配了代理） */
  probeDirect: boolean;
  /** 最终会用来发请求的代理地址（null = 直连） */
  proxyUrl: string | null;
}

/** 测试/诊断用：判断某个 URL 在当前设置下会怎么走 */
export async function describeProxyDecision(
  settings: SettingsReader,
  target: ProxyTarget,
  url: string
): Promise<ProxyDecision> {
  const config = await readEffectiveProxyConfig(settings);
  const mode = config.targets[target];
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // ignore
  }
  const bypassed = !!hostname && shouldBypass(hostname, config.bypass);
  const activeProxy = bypassed || !config.proxyUrl || mode === 'off' ? null : config.proxyUrl;
  return {
    mode,
    bypassed,
    probeDirect: !bypassed && !!config.proxyUrl && mode === 'auto',
    proxyUrl: activeProxy,
  };
}

/** 供测试断言：超时错误是否被识别为「直连不通」而非业务失败 */
export { isTimeoutError };
