# SUB-Aggregation

订阅聚合与配置生成平台的 V2 实现（v2.35.0）。

把机场订阅聚合、解析，并按 mihomo / sing-box / shadowrocket 等格式在线生成客户端可用的配置。以 **Docker 容器**运行（NAS / VPS / 任意 x86_64 Linux），数据落本机 SQLite，不依赖任何第三方托管服务。

![Version](https://img.shields.io/badge/版本-2.35.0-blue)
![Tests](https://img.shields.io/badge/测试-495%20passed-green)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 工作流程（用户视角）

```
添加订阅 URL
  ↓
每日自动抓取（默认北京 07:00，设置页可调）
  ↓
按 12 种协议解析节点  →  节点去重 + 自动命名 + 启用管理
  ↓
识别节点国家归属（GeoIP）→ 按国家/协议生成策略组
  ↓
输出 mihomo / sing-box / shadowrocket / v2ray 等配置
  ↓
/sub/:format/:token 供客户端直接订阅
```

## 快速部署（Docker）

镜像由 GitHub Actions 构建，同时发布到 **GHCR** 和 **Docker Hub**（两份内容相同），**部署端不需要构建**，拉下来就能跑：

```bash
mkdir -p /vol1/1000/Docker/sub-aggregation && cd /vol1/1000/Docker/sub-aggregation
# 1) 放好 docker-compose.yml（仓库根目录那份）
#    并把 image 那行的 <你的DockerHub用户名>（或 GHCR 那行的 <你的GitHub用户名>）换成自己的
# 2) 建 .env，至少填 ADMIN_PASSWORD（参考 .env.example）
docker compose pull
docker compose up -d
```

> **选哪个 registry**：飞牛 fnOS 的「镜像可更新」提示只认 **Docker Hub**，想让它检测到升级就用 Docker Hub 那份。
> Docker Hub 那份要 CI 推得上去，需先在仓库配 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 两个 secret；
> 不配也能构建，只是不会有 Docker Hub 镜像，此时用 GHCR 那份（`ghcr.io/<你的GitHub用户名>/sub-aggregation`）。

- 默认端口 **20130**，数据落在挂载目录（SQLite 单文件，**备份＝复制这个目录**）
- 默认监听 `0.0.0.0`，走 http 即可；要外部访问可 `tailscale serve --http=80 http://127.0.0.1:20130`
- 首次访问用 `admin` + `ADMIN_PASSWORD` 登录，登录后可在设置页改密码
- 容器出网默认走旁路由代理（compose 里已配 `NODE_USE_ENV_PROXY=1`）。**这一项不要删**：Node 内置 fetch 不认 `HTTP_PROXY`，删了以后 server 字段填域名的节点解析不到 IP，会掉进「其他」组

完整部署说明见 [11 部署](./docs/11_DEPLOYMENT.md) 与 NAS 落地记录 `docs/16_NAS_DEPLOY.md`（后者仅本地）。

## 功能特性

- **多订阅聚合**：添加 / 删除 / 手动更新任意数量订阅，定时自动重抓
- **节点解析**：内置 12 种协议解析器，自动识别 vmess / vless / trojan / ss / ssr / hysteria2 / tuic / wireguard / anytls，兼容 Clash YAML
- **节点去重与命名**：按 `server:port:protocol` 去重；节点名按「旗帜 国家码 协议-序号」自动生成（如 `🇭🇰 HK VLESS-01`，延迟不写进名字，见列表「延迟」列）；节点启用管理
- **分流规则引擎**：13 组固定策略组（全部原生 GEOSITE）+ 动态规则目录（MetaCubeX 分类）+ 自定义规则，Web 面板可切换
- **IP 归属识别**：自动解析节点 IP → GeoIP → 国家归属；后台自动重试未识别 IP
- **多格式输出**：mihomo / sing-box / shadowrocket / v2ray / v2rayN / nekoray，不支持的协议自动跳过
- **DNS 防泄露**：生成配置内置「国内域名→国内 DoH / 国外域名→国外 DoH」分流 + fake-ip 全接管 + 严格路由；若经 OpenClash 导入，请在面板关闭「自定义上游 DNS 服务器」以免覆盖订阅 DNS 段
- **内置管理后台**：仪表盘 / 订阅 / 节点 / 规则 / 输出 / 设置，自带鉴权

## 支持的协议

`vmess` · `vless`（含 Reality/XTLS）· `trojan` · `ss` · `ssr` · `hysteria2` · `tuic` · `wireguard` · `anytls`，以及 Clash YAML 订阅的整包解析。

## API

核心端点：

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/meta` | 项目信息 | ❌ |
| POST | `/api/auth/login` | 登录 | ❌ |
| GET | `/api/dashboard` | 仪表盘统计 | ✅ |
| GET/POST/DELETE | `/api/subscriptions` | 订阅管理 | ✅ |
| GET | `/api/nodes` | 节点列表 | ✅ |
| GET | `/api/rules/*` | 分流规则 | ✅ |
| GET | `/sub/:format/:token` | 客户端订阅链接 | Token* |

\* `/sub` 使用长随机 token 鉴权，等价于密码，请勿泄露。

## 定时任务

进程内定时器（30 秒一跳，同一分钟去重），三个固定时刻：

| 任务 | 触发 | 说明 |
|---|---|---|
| 订阅自动更新 | 每小时整点检查 | 距上次自动更新满「设定间隔（1-24 小时，0 = 不更新，默认 24）」才真正执行，抓取全部订阅并预填充 IP 地理缓存 |
| 规则目录同步 | 每月 1 日 03:00 | 同步 MetaCubeX 最新分类清单 |
| Geo 重试 | 每分钟 | 批量重查未识别 IP，10 次上限后停止 |

## 项目结构

```
src/
├── server/main.ts      # Node 入口（HTTP + 定时器）
├── app.ts              # 共享应用层（装配 / 前端响应 / 定时任务）
├── api/                # Hono 路由 / 中间件 / 限流
├── services/           # 业务服务（auth/订阅/配置/IP地理/CF用量/规则目录）
├── parser/             # 12 种协议解析 + 订阅格式检测
├── generator/          # mihomo/singbox/shadowrocket/base64 + 序列化
├── data/               # 策略组定义 / 国家码 / 格式映射
├── storage/
│   ├── kv.ts           # 存储契约 + 仓储层（统一键管理）
│   └── sqlite.ts       # SQLite 适配器（node:sqlite 内置）
├── models/             # 数据模型
└── html.js             # 构建生成的前端内嵌（勿手改）
public/index.html       # 前端单文件源码
tests/                  # vitest 测试
Dockerfile              # 多阶段构建（构建层跑测试，运行层只有单文件）
docker-compose.yml      # 部署模板
```

## 开发与测试

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run（487 项）
npm run build:server  # 打单文件产物 dist/server.mjs
npm run dev         # 打产物并本地启动（默认 :20130）
```

## License

[MIT](./LICENSE) · 作者 [Bob Vane](https://github.com/bobvane)
