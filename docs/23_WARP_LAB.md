# 23 · WARP 实验页（独立模块）

> 版本：v2.50.3 起。**实验功能**，与现有节点/输出链路完全隔离。

## 1. 目的

在节点列表之外，提供一页只做两件事的实验界面：

1. 注册 **Cloudflare WARP MASQUE 设备**（匿名设备注册，不是邮箱/密码登录）。
2. 根据端点生成 **MASQUE H2（TCP/443）** 与 **H3（QUIC/443）** 节点，并复制 mihomo YAML。

## 2. 隔离约定（重要）

本模块**只**读写以下 KV 键：

- `warp_lab:account`
- `warp_lab:nodes`

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
- **生成节点**：
  - 端点文本框（每行 `host:port`，默认 `162.159.198.1:443` 等，最多 20 个）；
  - SNI（默认 `consumer-masque.cloudflareclient.com`）；
  - H2/H3 复选框；
  - “生成节点”仅保存到本页。
- **已生成节点**：名称、传输、端点、SNI、生成时间；每条可复制完整 mihomo YAML（含私钥，页面有提示）。
- **说明**：Cloudflare 条款、AI 可用性不保证、客户端需较新 mihomo。

## 4. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/warp-lab/status` | 设备状态（脱敏）+ 已生成节点 + 默认端点/SNI |
| POST | `/api/warp-lab/register` | 注册/重新注册 MASQUE 设备；清空旧节点 |
| POST | `/api/warp-lab/generate` | 生成 H2/H3 节点（只写 `warp_lab:nodes`） |
| POST | `/api/warp-lab/clear` | 清除实验数据 |

注册请求走项目现有的 `version` 代理通道（`http.asFetch('version')`），以便在被墙网络下也能访问 Cloudflare API。

## 5. 风险

- 免费 WARP 面向个人使用，请遵守 Cloudflare 条款；共享/分发可能违反条款。
- WARP 出口是 Cloudflare 机房 IP，**AI 服务可用性不保证**（可能 captcha/403/地区限制）。
- 生成的 YAML 含设备私钥，请勿公开分享。
- 客户端必须使用较新的 mihomo（支持 `type: masque`）；老版 Clash 不支持。

## 6. 移除方式

按以下顺序删除即可，不影响任何现有功能：

1. `public/index.html`：导航 `data-page="warp"`、`#page-warp` 页面、`loadWarpLab` 等 JS、`pageLabels` 的 `warp`、`switchPage` 中的 `if (page === 'warp')`。
2. `src/api/routes.ts`：`/api/warp-lab/*` 路由与 import。
3. `src/services/warp-lab.service.ts`。
4. `tests/services/warp-lab.test.ts`。
5. 运行 `npm run build:html`，删除残留的 `warp_lab:*` 键（或先在页面点“清除”）。
