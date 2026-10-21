# 架构与数据流

## 运行结构

```text
浏览器 ── HTTP ──> Node 24 + Hono (`src/server/main.ts`, `src/api/`)
                         │
                         ├── services/：认证、订阅、配置、探测、GeoIP、规则目录
                         ├── parser/：订阅文本 → 统一 Node 模型
                         ├── generator/：节点与规则 → 客户端配置
                         └── storage/：KV 仓储 → SQLite (`/data/app.db`)
```

前端源码是 `public/index.html`，由 `scripts/inline-html.js` 生成 `src/html.js`。不要手改生成文件；改页面后运行 `npm run build:html`。

## 主要目录

| 路径 | 职责 |
|---|---|
| `src/server/`、`src/app.ts` | Node HTTP 入口、Hono 应用装配、定时任务 |
| `src/api/` | 路由、认证中间件、限流 |
| `src/services/` | 业务逻辑 |
| `src/parser/` | 协议识别、解码、节点解析 |
| `src/generator/` | mihomo、sing-box、Shadowrocket、Base64 输出 |
| `src/models/` | 实体类型和 KV 键常量 |
| `src/storage/` | KV 仓储契约及 SQLite 适配 |
| `src/data/` | 固定分流规则、国家码、规则目录数据 |
| `public/` | 单页管理界面和浏览器 API 客户端 |

## 数据与节点生命周期

- `DB_PATH` 默认 `/data/app.db`，生产容器通过 `./data:/data` 持久化。备份时复制整个数据目录。
- 所有持久化访问经 `src/storage/kv.ts` 的仓储接口；新增键先在 `src/models/config.ts` 登记。
- 订阅节点以 `subscriptionId` 分组存放；节点指纹为规范化的 `server:port:protocol`，用于去重及锁定/禁用状态关联。
- 健康数据使用 `health:latest:*` 快照和 `health:hist:*` 历史键。配置缓存带应用版本和配置版本，升级或改配置后会失效。

## 进程与定时任务

`src/server/main.ts` 启动 HTTP 服务并以 30 秒间隔检查定时任务；任务按 UTC 时间执行：订阅更新、规则目录同步和 GeoIP 未识别项重试。具体时刻与门闩逻辑见 `src/app.ts`、`src/services/ip-geo.service.ts`。

订阅常规更新按用户设置的小时数执行。失败订阅会在 1、2、4 小时后有限重试，且每轮只请求到期的失败订阅；达到重试上限后等待下一次常规更新或用户手动重试。失败原因、最近失败时间和下次重试时间保存在订阅记录中，成功更新时清除。

Node 内置 `fetch` 使用代理环境变量时需设置 `NODE_USE_ENV_PROXY=1`。Docker 示例已经提供该设置，且保留 `NO_PROXY` 内网例外。
