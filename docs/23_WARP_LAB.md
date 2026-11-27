# 23 · WARP 实验页（独立模块）

> 版本：v2.50.4 起。**实验功能**，与现有节点/输出链路完全隔离。

## 1. 目的

在节点列表之外，提供一页只做这些事的实验界面：

1. 注册 **Cloudflare WARP MASQUE 设备**（匿名设备注册，不是邮箱/密码登录）。
2. 从 Cloudflare 已知网段**自动发现候选端点**（不是一份会过期的 IP 清单）。
3. 用 mihomo 核心**真实建链验证存活**（H2 / H3，可勾选端口）。
4. 只把**通过验证**的端点生成 MASQUE 节点，并复制 mihomo YAML。

## 2. 隔离约定（重要）

本模块**只**读写以下 KV 键：

- `warp_lab:account`
- `warp_lab:nodes`
- `warp_lab:last_scan`（最近一次验证结果，用于刷新后回显）

不写入、不读取：

- `nodes:*`（节点列表/订阅）
- `health:*`（测速/健康）
- `settings:*`（项目设置）
- 输出配置、代理组、国家组、调度任务

因此：

- 生成的节点**不会**出现在节点列表；
- **不会**进入 `/api/output/*` 或 `/sub/*`；
- **不会**参与核心测速、抛弃/锁定/国家组；
- 删除本页（导航、页面、JS、路由、服务）后，项目回到原状；残留的 `warp_lab:*` 可在页面“清除”或手动删除。

## 3. 页面内容

- **设备状态**：已注册/未注册、设备 ID（脱敏）、隧道 IPv4/IPv6、注册时间；注册/重新注册/清除。
- **SNI**：默认只读展示官方值；点「修改」打开弹窗，可自定义或恢复默认。弹窗内明确提示 **Cloudflare 官方建议保持默认**，填错会直接握手失败。
- **传输协议**：H2（TCP）/ H3（QUIC）复选。
- **端口**：默认只勾 443；500 / 1701 / 4500 / 4443 / 8443 / 8095 在高级区勾选，组合数上限 150。
- **H2 采样**：每个 `/24` 采样数量（默认 8）。
- **自检（8 组）**：固定测 `162.159.198.1/2`、`162.159.199.1/2` × {H2,H3} × 443，用于确认部署机到 MASQUE 的连通性。
- **发现并验证端点**：任务式执行，弹窗内展示真实进度、实时日志、存活/失败/不确定计数，可取消。
- **验证结果**：存活端点默认勾选；可全选；点「生成选中节点」只生成勾选且验证通过的端点。
- **已生成节点**：名称、传输、端点、SNI、生成时间；每条可复制完整 mihomo YAML（含私钥，页面有提示）。

## 4. 候选与验证口径

| 项 | 规则 |
|---|---|
| H3 候选 | 固定 `162.159.198.1/2`、`162.159.199.1/2`（xehn 实测只有 198.1/.2，本页 199 也一并验证） |
| H2 候选 | `162.159.198.0/24`、`162.159.199.0/24` 各采样 N 个（默认 8） |
| 端口 | 默认 443；可选 500/1701/4500/4443/8443/8095 |
| 验证方式 | 一个 mihomo 核心 + N 个 masque 代理条目，调 `/proxies/<name>/delay` 发起真实 HTTP 请求 |
| 重试 | 每个组合最多 3 次，任一成功即存活 |
| 并发 | 3（共用同一个注册设备，避免触发限流） |
| 结果 | `alive` / `failed` / `unknown` 三态；只有 `alive` 可生成节点 |

> **验证视角**：验证从「运行本项目的这台机器」发起。若项目部署在境外 VPS，只能证明端点「活着、能握手、能传数据」，**不能证明中国墙内可用**。页面与结果弹窗都会标注这一点。

## 5. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/warp-lab/status` | 设备状态（脱敏）+ 已生成节点 + 默认值 + 最近一次验证结果 |
| POST | `/api/warp-lab/register` | 注册/重新注册 MASQUE 设备；清空旧节点 |
| POST | `/api/warp-lab/scan` | 启动发现+验证任务；返回 `jobId` |
| GET | `/api/warp-lab/scan/:jobId` | 轮询任务进度与结果 |
| POST | `/api/warp-lab/scan/:jobId/cancel` | 取消运行中的任务 |
| POST | `/api/warp-lab/generate` | 按 `items`（已验证端点）或旧 `endpoints` 生成节点（只写 `warp_lab:nodes`） |
| POST | `/api/warp-lab/clear` | 清除实验数据 |

注册请求走项目现有的 `version` 代理通道（`http.asFetch('version')`），以便在被墙网络下也能访问 Cloudflare API。

## 6. 风险

- 免费 WARP 面向个人使用，请遵守 Cloudflare 条款；共享/分发可能违反条款。
- WARP 出口是 Cloudflare 机房 IP，**AI 服务可用性不保证**（可能 captcha/403/地区限制）。
- 生成的 YAML 含设备私钥，请勿公开分享。
- 客户端必须使用较新的 mihomo（支持 `type: masque`）；老版 Clash 不支持。
- **验证结果会随时间变化**：anycast 路由、端口可达性、墙的封锁都可能改变，需要时重新验证。

## 7. 移除方式

按以下顺序删除即可，不影响任何现有功能：

1. `public/index.html`：导航 `data-page="warp"`、`#page-warp` 页面、`#warpSniModal`、`loadWarpLab` 等 JS、`pageLabels` 的 `warp`、`switchPage` 中的 `if (page === 'warp')`。
2. `src/api/routes.ts`：`/api/warp-lab/*` 路由与 import。
3. `src/services/warp-lab.service.ts`。
4. `src/services/warp-scan.service.ts`。
5. `tests/services/warp-lab.test.ts`、`tests/services/warp-scan.test.ts`。
6. 运行 `npm run build:html`，删除残留的 `warp_lab:*` 键（或先在页面点“清除”）。

## 8. 节点列表并入准备（v2.50.5）

本页仍保持隔离（不写 `nodes:*`）。但节点列表/输出链路已经为 masque 做好框架准备：

- **模型**：`NodeProtocol` 增加 `masque`；新增 `masquePrivateKey / masquePublicKey / masqueIp / masqueIpv6 / masqueNetwork / masqueUdp / masqueCongestionController / masqueIpStack / masqueHandshakeTimeout`。
- **解析**：Clash YAML 支持 `type: masque`（H2/H3）；同时修正白名单只认 4 种协议、导致 hysteria2/tuic/wireguard/anytls 的 Clash YAML 被误杀的问题。
- **指纹**：masque 追加 `network`（h2/h3）与 SNI，避免同一端点 H2/H3 在入库去重时互相覆盖。
- **mihomo 生成**：`nodeToMihomoProxy` 输出完整 masque 字段；核心测速沿用同一映射，自动可用。
- **其他输出**：sing-box / v2ray 不支持 masque，仍按“客户端不认识就跳过”处理，不额外提示。
- **国家码**：**尚未处理**。masque 的 `server` 是 Cloudflare anycast 入口，不是出口；当前不做 IP 归属地查询，节点归入「其他」，名字降级为 `MASQUE-xx`。出口国家方案待定。
- **UI**：协议标签、筛选、仪表盘识别 MASQUE（H2/H3）。

后续真正并入时，只需把 `WarpLabNode + account` 转成 `Node` 并写入 `nodes:*`（产品决策），不需要再改模型/解析/生成器。
