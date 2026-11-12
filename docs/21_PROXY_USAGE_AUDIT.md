# 21 · 项目代理使用调研（Proxy Usage Audit）

> 调研基线：v2.43.1（commit `ad988ac`）
> 性质：调研文档。文中 P0–P3 建议已于 **v2.44.0** 全部实现；下文「当前实现」保留基线描述，用于对照改造前后的差异。
> 触发背景：2026-11-09 NAS 订阅全部拉取失败，根因是全局出网代理返回 `407 Proxy Authentication Required`，而项目没有任何按用途区分代理的能力（详见 §5 复盘）。
> v2.44.3 补充：已移除「跟随环境变量」模式，代理地址只来自设置页；本文中提及 `env` 模式的段落仅作历史记录。
> **v2.46.0 提示：代理模型已重写为「5 个目标 × 3 态」（订阅拉取 / 规则目录同步 / 版本检查 / 域名解析 / IP 归属，各自可设自动 / 代理 / 直连），`proxy_scope` 与单条订阅 `useProxy` 均已移除。本文正文（§0–§5）是 v2.43.1 基线的调研记录，仅作历史对照，当前语义以 `docs/ARCHITECTURE.md` 与 `src/engine/proxy-config.ts` 为准。**

## 交付状态（v2.44.0）

| 建议 | 落地位置 |
|---|---|
| 删除硬编码 `192.168.2.5:7890`，代理默认留空 | `docker-compose.yml`、`.env.example`、`README.md`、`docs/DEPLOYMENT.md` |
| 升级检测 / 目录同步超时 | `src/api/routes.ts`（5s）、`src/app.ts`（15s） |
| `describeFetchError` 展开完整 cause 链 | `src/engine/net-errors.ts` |
| 按用途区分的代理模式与设置 UI | `src/engine/proxy-config.ts`、`src/engine/http-client.ts`、`public/index.html` |
| 单条订阅 `useProxy` 覆盖 | `src/models/subscription.ts`、`src/services/subscription.service.ts`、`src/api/routes.ts` |
| 自动回退（超时不回退） | `src/engine/http-client.ts` |
| 节点测活保持直连并加隔离守卫 | `src/services/node-probe.service.ts`、`tests/security/proxy-isolation.test.ts` |

## 交付状态（v2.44.2 修正）

| 问题 | 修正 |
|---|---|
| `proxy_scope` 未保存、env 模式默认把订阅抓取也纳入代理 | 默认用途改为 `github + geo`；env 模式同样按用途收窄，订阅 URL 默认直连 |
| 直连失败回退代理时未检查用途与 bypass | 移除「直连 → 代理」回退，只保留「代理失败 → 回退直连」；未勾选的用途始终直连 |
| 订阅抓取 10s 超时偏短，慢源被误判成 `Fetch timeout` | 放宽到 30s（`fetcher.ts` 与 `http-client.ts` 同步） |
| `GET /api/settings` 返回生效值，被设置页全量原样回存 | 新增 `proxy_raw` / `proxy_effective`；表单只回显原始存储值，只提交改动过的字段 |
| 「测试代理」不反映用途配置、`proxy_env_detected` 未使用 | UI 明示按钮只验证代理地址可达性，并显示环境变量代理提示 |

> 下文 §2 表格里的「10s」等数字是 v2.43.1 基线描述，保留用于对照，不代表当前值。

---

## 0. 先澄清：项目里有三种完全不同的「代理」

很多误解来自把这三件事混为一谈。本文只讨论第 1 种。

| # | 名称 | 是什么 | 谁在使用 | 本文是否讨论 |
|---|------|--------|----------|:---:|
| 1 | **服务端出网代理** | `HTTP_PROXY` / `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` | SUB-Aggregation 容器自己（Node `fetch`） | ✅ **本文主题** |
| 2 | **订阅里的代理节点** | VMess / VLESS / Hysteria2 等节点 | 下游客户端（mihomo、sing-box、手机 App） | ❌ 项目自身从不使用 |
| 3 | **客户端代理组 / url-test** | 生成配置里的 `proxy-groups`、`url-test` | 下游客户端 | ❌ 项目自身从不使用 |

**关键结论：SUB-Aggregation 从来不「通过代理节点上网」。** 它把节点收集起来、生成配置交给客户端；它自己出网只访问几类固定的元数据源（订阅 URL、GitHub、DoH、ip-api）。所谓「项目用了代理」，准确说法是：

> 容器的 `fetch` 请求被进程级环境变量统一接管，走了局域网里的一个 HTTP 代理（OpenClash / mihomo 的 7890 端口）。

所以用户问题里的两个推测需要纠正：

- 「节点筛选地理组要用代理组」→ **不对**。地理分组是服务端向 `ip-api.com` 查 IP 归属、向 DoH 查域名 IP，与代理组无关。
- 「分流规则要用代理组」→ **不对**。分流规则只是生成 YAML 文本，规则的匹配与生效全部发生在下游客户端，项目自己不需要「走代理」。
- 真正需要出网代理的只有：**订阅抓取** 和 **GitHub 元数据**（视网络环境而定）。

---

## 1. 代理当前是怎么生效的

### 1.1 机制

- Node 24 的内置 `fetch`（undici）**默认不读取** `HTTP_PROXY` / `HTTPS_PROXY`。
- 只有设置 `NODE_USE_ENV_PROXY=1` 后，`fetch` 才会读取环境变量并使用代理。
- 这是一个 **进程级、全局生效** 的开关：
  - 对代码里所有 `fetch(...)` 一视同仁；
  - 没有任何「这个请求不走代理」的调用级开关；
  - 唯一的例外手段是 `NO_PROXY`（按目标主机名/IP 排除）。
- `net.connect` / `tls.connect` / `dns.lookup` **不受影响**，永远直连。

### 1.2 现有配置位置

| 文件 | 内容 | 备注 |
|------|------|------|
| `docker-compose.yml:35-38` | `NODE_USE_ENV_PROXY: "1"`，`HTTP_PROXY` / `HTTPS_PROXY` 默认 `http://192.168.2.5:7890` | ⚠️ 个人内网地址被写成了**仓库默认值** |
| `.env.example:16-22` | 注释形式给出同样配置，默认值写 `192.168.2.5:7890` | 与 compose 默认值重复 |
| `README.md:56-62` | compose 片段，代理默认值为空 `${HTTP_PROXY:-}` | 与 compose 实际默认值**不一致** |
| `README.md:160-161` | 「节点掉进其他组 → 配代理、不要删 `NODE_USE_ENV_PROXY=1`」 | 把代理描述成运行前提 |
| `docs/DEPLOYMENT.md:7,14-16` | 部署环境需要代理时配置 | 未说明哪些请求会走代理 |
| `docs/ARCHITECTURE.md:43` | 说明 `NODE_USE_ENV_PROXY=1` | 同上 |
| `src/api/routes.ts:921-960` | `/api/settings` 仅支持 `app_name`、`sub_update_interval`、`node_drop_latency_ms` | **没有任何代理设置项** |

### 1.3 代理设置的实际语义

当前配置等价于：

```text
所有 fetch（订阅、GitHub、DoH、ip-api、未来任何新增请求）
        │
        └── 全部走 http://192.168.2.5:7890
                （除非命中 NO_PROXY）
```

这就导致：代理一坏（401/407/超时/端口变更/设备重刷），**所有**出网功能同时坏；而唯一不受影响的恰好是用户最关心的「测活测速」，于是表现为「测速正常、订阅拉不动」的强迷惑现象。

---

## 2. 项目内全部外部网络调用清单

扫描方式：`rg "fetch\(|fetchFn|net\.connect|tls\.connect|https?\.request" src`，并逐个人工确认。以下为**完整清单**。

| # | 用途 | 代码位置 | 外部目标 | 触发时机 | 超时 / 限制 | 现状走代理？ | 结论 |
|---|------|----------|----------|----------|-------------|:---:|------|
| 1 | **订阅抓取** | `src/engine/fetcher.ts:149-157`（`fetchWithTimeout`）、`:178`（`fetchSubscription`）；调用方 `src/services/subscription.service.ts:222-226` | 用户填写的订阅 URL（http/https） | 手动更新、自动更新（默认 24h）、失败重试 | 10s；5 MB；最多 3 次重定向；手动跟随并逐跳 SSRF 复检 | ✅ 是 | **可配，默认直连** |
| 2 | **升级检测** | `src/api/routes.ts:113-177` | `https://github.com/bobvane/SUB-Aggregation/releases.atom` | 打开/刷新页面 | ❌ **无超时** | ✅ 是 | **可配，默认直连；必须补超时** |
| 3 | **规则目录同步** | `src/app.ts:36-50`（`createCatalogFetcher`）、`src/services/catalog-sync.service.ts:28,68-91` | `https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/...` × 3 次 | 每月 1 日 03:00 UTC、手动刷新 | ❌ **无超时**；可带 `GITHUB_TOKEN` | ✅ 是 | **可配，低优先级** |
| 4 | 目录同步的默认回退 fetcher | `src/api/routes.ts:81` | 同上 | 仅当调用方未注入 `catalogSync`（测试/旧路径） | 无 | ✅ 是 | 代码清理，非独立功能 |
| 5 | **DoH 域名解析** | `src/services/ip-geo.service.ts:34-36,84-101` | `https://dns.google/resolve`、`https://cloudflare-dns.com/dns-query` | 节点 `server` 是域名且无地理缓存时 | 5s；两个端点依次回退；结果缓存 6h | ✅ 是 | **可配，默认直连** |
| 6 | **ip-api 批量查归属** | `src/services/ip-geo.service.ts:204` | `http://ip-api.com/batch`（**仅 HTTP**） | 订阅更新后预填充、手动重检、GeoRetry | 10s；100 IP/批；单次最多 5 批；项目内 15 次/分钟 | ✅ 是 | **建议直连优先** |
| 7 | **ip-api 单个查询** | `src/services/ip-geo.service.ts:256` | `http://ip-api.com/json/{ip}` | 备用路径 | 5s | ✅ 是 | 同上 |
| 8 | **节点 TCP 测活** | `src/services/node-probe.service.ts:119` | 各节点 `server:port` | 订阅更新后、手动测活、定时任务 | 3s；并发 50 | ❌ **否** | **禁止代理（现状正确）** |
| 9 | **节点 TLS 握手** | `src/services/node-probe.service.ts:149` | 各节点 `server:port`（SNI） | 同上 | 3s | ❌ **否** | **禁止代理（现状正确）** |
| 10 | 前端页面 | `public/index.html`、`public/api.js` | 同源 `/api/*`；GitHub 仅为 `<a>` 外链 | 用户操作 | — | 不适用（浏览器侧） | 不适用 |
| 11 | 生成配置里的 URL | `src/generator/mihomo.ts:356,483-776`、`src/generator/singbox.ts:383`、`src/generator/rule-providers.ts:21-25` | 图标、`rule-providers`、GeoIP、DNS、`url-test` 探测 URL | **由下游客户端拉取** | — | 不适用 | 不适用（客户端职责） |

> 补充：第 1 项中，如果订阅地址本身是节点链接（`vless://`、`hysteria2://` 等），`subscription.service.ts:222-226` 会直接当作内容解析，**根本不会发起任何网络请求**。这类「订阅」不受代理影响。

### 2.1 代理影响面的直观对比

```text
走代理（受 NODE_USE_ENV_PROXY 影响）
├── 订阅抓取        → 失败 = 用户直接可见的「拉取失败」
├── GitHub 升级检测 → 失败 = 静默「检查更新失败」
├── GitHub 目录同步 → 失败 = 静默 stale，回退内置目录
├── DoH 解析        → 失败 = 域名节点查不到 IP
└── ip-api 查询     → 失败 = 节点掉进「其他」分组

不走代理（裸 TCP/TLS）
└── 节点测活/测速   → 失败 = 真实反映 NAS→节点路径
```

这条分界线正是本次事故「测速正常但订阅失败」的原因。

---

## 3. 逐项判断

### 3.1 订阅抓取 —— **可配，默认直连**

- **为什么曾经要代理**：订阅域名（机场、自建 CF Worker、GitHub Raw 托管）在国内网络经常被阻断；NAS 直连会超时。
- **为什么不能强制代理**：订阅源千差万别。用户可能把订阅放在内网、Tailscale、或本身就能直连的域名上；强制走代理等于把一个可选依赖变成单点故障（本次事故）。
- **建议**：
  - 默认 **直连**；
  - 全局可开启代理；更进一步支持「直连失败后自动用代理重试一次」（可配置）；
  - 允许**按订阅覆盖**（单条订阅 `use_proxy: on/off/auto`），因为真实场景常是「A 机场要代理、B 自建直连更快」；
  - 代理失败必须给出可诊断的错误（见 §6.6）。
- **注意**：走代理时，目标域名由**代理侧解析**，现有 SSRF 静态校验只检查字面量 IP/主机名（`fetcher.ts:96-132` 已注释说明），无法阻止「域名解析到内网再由代理访问」的情况。代理本身是可信基础设施时可接受，但要在文档里写明。

### 3.2 GitHub 升级检测 —— **可配，默认直连，必须补超时**

- 当前实现是裸 `fetch`，**没有 `AbortSignal`**（`routes.ts:117-122`）。代理挂起时会拖住请求，直到 undici 默认超时（可能数十秒），而前端页面正在等它。
- 失败已经会静默降级为 `checked:false, checkError:network`，行为正确，无需改。
- 建议：归入「GitHub / 国外元数据」这一类开关；默认直连；超时 5s。

### 3.3 规则目录同步 —— **可配，默认直连，低优先级**

- 每月一次、3 次 API 调用、有 `GITHUB_TOKEN`、失败回退内置 `metacubex-catalog.json`，属于「坏了也不影响主流程」的功能。
- 同样**没有超时**，建议一并补上。
- 不建议为它单独做界面开关；跟随「GitHub 类」开关即可。

### 3.4 DoH（dns.google / cloudflare-dns.com）—— **可配，默认直连**

- 用途是解析**节点域名**，结果与请求者位置无关；走不走代理不影响解析结果（DoH 内容是加密的，代理只看到 `dns.google:443`）。
- 但国内直连 `dns.google` 经常不可用；`cloudflare-dns.com` 也可能被干扰。因此**需要可配**。
- 失败影响是「节点国家识别不出来 → 掉进其他组」，属于可降级功能，不应阻塞。
- 建议归入「地理查询」类开关；默认直连，直连失败可回退代理。

### 3.5 ip-api —— **建议直连优先**

- `ip-api.com` 免费接口**只支持 HTTP**，且官方限额 45 次/分钟（按**来源 IP** 计）。项目内部另有 15 次/分钟的滑动窗口（`RATE_LIMIT_REQUESTS=15`）。
- 查询结果描述的是**节点 IP 的归属**，不是请求者的归属，所以走代理不会「查错国家」。
- 但走代理会让所有用户的查询共用代理出口的额度，更容易撞限流；直连能让额度按 NAS 出口独立计算。
- 请求内容是公开 IP 列表，无凭据；HTTP 明文可接受。
- 建议：直连优先，失败可回退代理；归入「地理查询」类。

### 3.6 节点测活 / 测速 —— **禁止代理（现状正确，不要改）**

- `net.connect` / `tls.connect` 测的是 **NAS → 节点服务器** 这条真实路径。
- 一旦改成走代理，测到的就是 **NAS → 代理 → 节点**，延迟、丢包、可用性全部失真，健康评分和自动淘汰逻辑会集体失效。
- 代理可用性属于**客户端**职责：mihomo 的 `url-test` 会做真实代理请求（见 `docs/19_PROXY_AVAILABILITY_DESIGN.md`）。项目不应、也无法替代它。
- **建议加一道防回归约束**：在测试中断言 `node-probe.service.ts` 不引用全局 `fetch`/dispatcher，防止未来「统一出网层」重构时误伤。

### 3.7 前端 —— **不适用**

- `public/index.html` 与 `public/api.js` 只请求同源 `/api/*`；`qrcode.min.js` 是本地文件。
- 页面上的 GitHub 链接只是 `<a target="_blank">`，由用户浏览器打开，和容器代理无关。

### 3.8 生成配置里的 URL —— **不适用（客户端职责）**

包括：

- `rule-providers`（`cdn.jsdelivr.net` / `raw.githubusercontent.com`）
- 节点/分组图标
- `geodata-mode` 的 `geoip.dat` / `geosite.dat` / `mmdb`
- DNS 的 DoH 服务器（`dns.alidns.com`、`doh.pub`、`8.8.8.8` 等）
- `url-test` 的探测 URL（`gstatic.com/generate_204`、`cp.cloudflare.com/generate_204`）

这些都由**下游 mihomo / sing-box 客户端**拉取，走的是客户端自己的代理/直连策略。项目的服务端代理设置**不应该**、也不会影响它们。

---

## 4. 判断矩阵（改造依据）

| 用途 | 是否应该走代理 | 默认值 | 可配置粒度 | 失败后的行为 |
|------|:---:|:---:|------|------|
| 订阅抓取 | **视网络而定** | 直连 | 全局 + 单订阅 | 报错并落库，保留旧节点，进入重试 |
| GitHub 升级检测 | 视网络而定 | 直连 | 跟随「国外元数据」开关 | 静默降级 |
| GitHub 规则目录 | 视网络而定 | 直连 | 跟随「国外元数据」开关 | 静默 stale，回退内置目录 |
| DoH 解析 | 视网络而定 | 直连 | 跟随「地理查询」开关 | 跳过，节点标记未识别 |
| ip-api 查询 | **倾向直连** | 直连 | 跟随「地理查询」开关 | 跳过，进入 GeoRetry |
| 节点 TCP 测活 | **绝对不应该** | 直连 | 不可配置 | 真实反映节点状态 |
| 节点 TLS 握手 | **绝对不应该** | 直连 | 不可配置 | 真实反映节点状态 |
| 前端 / 生成配置 | 不适用 | — | — | — |

一句话结论：

> **项目不应该「默认全量代理」，而应该「默认直连 + 按用途可选代理」。代理是可选出网通道，不是运行前提。**

---

## 5. 事故复盘：为什么「全局代理」这个设计一定会再坏一次

2026-11-09 的故障链：

```text
软路由被重刷（ImmortalWrt-Bob 24.10.1 → ImmortalWrt 25.12.2）
  → 新 OpenClash 的 7890/7893 默认开启 Basic 认证
  → 容器仍带 NODE_USE_ENV_PROXY=1 + HTTP_PROXY=http://192.168.2.5:7890
  → 所有 fetch 在 CONNECT 阶段收到 407
  → undici 包装成 TypeError: fetch failed → Error: Request was cancelled.
  → describeFetchError 只解一层 cause，界面只显示 "Request was cancelled."
  → 47–62ms 内失败，看起来不像超时，极难定位
```

同时：

- 节点测活走裸 TCP，47ms 后依然成功 → 「网络是通的」假象；
- 升级检测、地理查询、目录同步也一起静默失效，但没人注意到。

这暴露了三个设计问题：

1. **耦合**：一个与「拉订阅」无关的基础设施（旁路由）变化，能让核心功能全灭。
2. **不可观测**：错误信息丢失了真正的 407；代理状态没有任何健康检查或提示。
3. **默认值污染**：仓库把 `192.168.2.5:7890` 写成 compose 默认值，等于把个人拓扑强加给所有部署者。

---

## 6. 改造建议（供后续实施）

### 6.1 设置模型

在现有 `/api/settings`（`src/api/routes.ts:921-960`）基础上新增：

| 键 | 类型 | 默认 | 说明 |
|----|------|------|------|
| `proxy_mode` | `off` \| `manual` \| `env` | `env`（兼容现状） | `off`=全部直连；`manual`=用 `proxy_url`；`env`=沿用环境变量 |
| `proxy_url` | string | 空 | 如 `http://192.168.2.5:7890`；支持 `http://user:pass@host:port` |
| `proxy_bypass` | string | `localhost,127.0.0.1,::1` + 内网段 | 逗号分隔；**不要**默认写入个人网段 |
| `proxy_scope` | 多选 | 无（全部直连） | 取值：`subscription`、`github`、`geo` |

> 如果不想一次做太细，最小可用版本只需 `proxy_mode` + `proxy_url` + `proxy_scope` 三项；`bypass` 先固定即可。

### 6.2 代码结构：分用途的 fetch 工厂

新增 `src/engine/http-client.ts`（示意）：

```ts
type Purpose = 'subscription' | 'github' | 'geo';

createFetcher(purpose): typeof fetch
  // 1. 读 settings：proxy_mode / proxy_url / proxy_scope
  // 2. proxy_mode=off        → 直连
  // 3. proxy_mode=env        → 维持当前全局行为（过渡期）
  // 4. proxy_mode=manual     → purpose ∈ scope ? ProxyAgent : 直连
  // 5. 统一注入超时与 describeFetchError（完整 cause 链）
```

要点：

- **必须按调用注入 dispatcher**，不要用 `setGlobalDispatcher`（否则又回到全局污染）。
- Node 24 内置 `fetch` 不导出 `ProxyAgent`，需要引入 `undici` 依赖，或使用 Node 暴露的 `EnvHttpProxyAgent`。实现前先做一次 10 行 spike 验证打包（esbuild）与运行都正常。
- 建议同时把 `fetcher.ts`、`ip-geo.service.ts`、`routes.ts`（升级检测）、`app.ts`（目录同步）全部改为接收注入的 fetcher，便于测试。
- `node-probe.service.ts` **不接入**这个工厂。

### 6.3 与现有环境变量的兼容 / 迁移

1. 升级后若 `proxy_mode` 未设置：
   - 检测到 `NODE_USE_ENV_PROXY=1` 且存在 `HTTPS_PROXY`/`HTTP_PROXY` → 视为 `proxy_mode=env`，行为不变，日志打印一次「已沿用环境变量代理，建议迁移到设置页」。
   - 否则视为 `off`。
2. 设置页保存 `manual` 后，以设置项为准，环境变量不再生效（但仍保留 `NO_PROXY` 语义）。
3. 提供「从环境变量导入」按钮，避免用户重新手抄代理地址。
4. 文档同步更新：`README.md`、`.env.example`、`docs/DEPLOYMENT.md`、`docker-compose.yml`——**删除 `192.168.2.5:7890` 这个仓库默认值**，改为空值。

### 6.4 设置页 UI

设置 → 「网络代理」：

- 代理模式：关闭 / 手动 / 跟随环境变量
- 代理地址（密码用 `type=password`，支持显示/隐藏）
- 用途勾选：`订阅抓取`、`GitHub（更新检测 / 规则目录）`、`地理查询（DoH / ip-api）`
- 「测试代理」按钮：服务端发起一次 `https://www.gstatic.com/generate_204` 或 `https://api.github.com/` 请求，显示状态码与耗时
- 明确提示：**节点测活/测速始终直连，不受此设置影响**

### 6.5 安全注意事项

- `GET /api/settings` 返回代理地址时**必须脱敏**密码（`http://user:***@host:port`）。
- 代理 URL 只能用 `http` / `https`（如果上游是 SOCKS5，建议在代理侧开 HTTP 入口，避免引入 SOCKS 依赖）。
- 代理密码会落到 SQLite（`settings` 表）。这是本地自托管应用的合理取舍，但要在 UI 与文档中告知；备份文件即包含该密码。
- 若允许「测试任意 URL」会引入 SSRF，测试接口应固定目标或只允许探测已保存的代理地址。
- 走代理时 SSRF 防护只能覆盖字面量私网地址，需在文档中注明（代理侧解析域名）。

### 6.6 可观测性（强烈建议一起做）

- `describeFetchError` 改为**递归展开 cause 链**（上次事故中 `Proxy response (407)` 被埋在第 3 层）。这会直接避免下一次同类问题。
- 代理测试/抓取失败时，错误信息中包含 `host:port`（不含凭据）与阶段（DNS / CONNECT / TLS / HTTP）。
- 设置页显示「上次代理测试结果 + 时间」，而不是等用户发现订阅坏了才知道。
- 启动时若 `proxy_mode=env`，打印一行有效代理目标（脱敏），便于排障。

### 6.7 建议实施顺序

| 优先级 | 内容 | 理由 |
|:---:|---|---|
| **P0** | 删除 compose 中 `192.168.2.5:7890` 默认值；给升级检测、目录同步补 5s 超时；`describeFetchError` 展开完整 cause | 低成本、直接防止同类事故再次不可诊断 |
| **P1** | `proxy_mode` / `proxy_url` / `proxy_scope` 设置项 + `http-client` 工厂 + 四处 fetch 改造 | 核心目标 |
| **P2** | 设置页 UI + 测试按钮 + 环境变量导入 + 文档更新 | 可用性 |
| **P3** | 单订阅 `use_proxy` 覆盖 / 直连失败自动回退代理 | 进阶体验，按需 |

---

## 7. 明确不建议做的事

1. **不要把节点测活/测速改成走代理**，也不要为了「统一出网」把它们接进 `http-client`。
2. **不要用「项目内代理节点」给自己出网**（例如让项目通过订阅里的节点去抓订阅）——会形成循环依赖、放大故障域，也超出项目职责。
3. **不要保留「代理即前提」的文档表述**。代理是可选通道；不配代理也必须能跑（直连可用时）。
4. **不要只把代理设置做成环境变量别名**。环境变量的问题是「全局、无用途区分」，仅换个 UI 存放位置不解决根本问题。

---

## 附录 A：本次调研的验证证据

| 验证 | 结果 |
|------|------|
| 本机直连订阅 URL | `HTTP 200`，1.12 MB 正常内容 |
| 本机 `NODE_USE_ENV_PROXY=1` + 指向 `192.168.2.5:7890` | `TypeError: fetch failed` → `Request was cancelled.` → `Proxy response (407) !== 200 when HTTP Tunneling`，27–49ms |
| NAS 上 `POST /api/subscriptions/:id/update` | 47–62ms 返回 `fetch failed: Request was cancelled.` |
| NAS 上用 `http://1.1.1.1/`、`http://www.baidu.com/` 测试 | 同样 47–62ms 失败（排除 DNS / TLS / 目标站点因素） |
| NAS 上 `POST /api/nodes/probe` | 6 节点 4 存活，平均 307ms（裸 TCP 正常） |
| 代理端口探测 | `7890` / `7893` → 407；`7891`（SOCKS5）拒绝用户 |
| `curl -x http://192.168.2.5:7890 http://example.com/` | `407 Proxy Authentication Required` |

结论：订阅、DNS、目标站点、NAS 出网均正常，唯一变量是「全局代理要求认证」。

## 附录 B：代码索引

| 主题 | 位置 |
|------|------|
| 订阅抓取入口 | `src/engine/fetcher.ts:149-157`、`:178-226` |
| 订阅更新（节点链接短路） | `src/services/subscription.service.ts:216-240` |
| 自动更新调度 | `src/app.ts:180-280` |
| 升级检测 | `src/api/routes.ts:109-177` |
| 设置 API | `src/api/routes.ts:921-960` |
| GitHub 目录同步 | `src/app.ts:36-50`、`src/services/catalog-sync.service.ts:28,68-100` |
| DoH / ip-api | `src/services/ip-geo.service.ts:15-36,84-101,190-270` |
| 节点测活 | `src/services/node-probe.service.ts:31-32,119,149` |
| 生成配置（客户端 URL） | `src/generator/mihomo.ts:356,483-776`、`src/generator/singbox.ts:383`、`src/generator/rule-providers.ts:21-25` |
| 既有代理可用性设计 | `docs/19_PROXY_AVAILABILITY_DESIGN.md` |
| 代理相关部署说明 | `docker-compose.yml:32-38`、`.env.example:16-22`、`README.md:56-62,160-161`、`docs/DEPLOYMENT.md:7,14-16`、`docs/ARCHITECTURE.md:43` |
