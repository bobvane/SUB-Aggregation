# Docker 与 NAS 部署

## 运行要求

- Docker Engine 与 Docker Compose；镜像基于 Node.js 24。
- 持久化挂载 `/data`，SQLite 默认文件为 `/data/app.db`。
- 首次启动必须设置 `ADMIN_PASSWORD`。出网代理为可选项：在面板「设置 → 网络代理」配置；不配置代理时全部直连。

仓库根目录的 `docker-compose.yml` 是部署模板。将 `image:` 改为实际镜像地址，创建 `.env`：

```dotenv
ADMIN_PASSWORD=替换为强密码
GITHUB_TOKEN=
```

### 代理设置与用途

设置页「网络代理」分三段：① 代理地址（协议 + IP + 端口，留空即不使用代理）② 使用代理节点 ③ 绕过代理地址。

**不填地址 = 全部直连**，零配置即可运行，网络通顺的 VPS 不需要任何设置。填了地址后，五项目标各自可选三态：

| 策略 | 行为 |
|---|---|
| 自动 `auto`（默认） | 先直连，3 秒内拿不到响应头再改走代理；两路都失败时报错 |
| 代理 `on` | 直接走代理 |
| 直连 `off` | 只走直连 |

五项目标是：订阅拉取、规则目录同步、版本检查、域名解析（DoH）、IP 归属（ip-api）。默认全部「自动」，因此填上地址后 GitHub 规则库与地理查询在国内会自动落到代理，而订阅在直连可用时仍走直连（保留 30 秒业务超时）。命中绕过列表的地址始终直连，不受目标策略影响。

代理密码保存在 `app.db` 的 settings 表中，界面以 `***` 脱敏显示；备份数据库即包含该密码，请妥善保管备份文件。

**节点测活与测速始终直连**（裸 TCP/TLS），不经过上述代理。

启动和升级：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 sub-aggregation
```

端口默认 `20130`。如需改宿主机端口，可调整映射左侧端口；容器端口保持 `20130`。

## 备份与恢复

升级前停止或暂停写入，然后备份宿主机挂载目录（至少包含 `app.db`）。恢复时将数据库放回相同挂载位置，再启动容器。不要把运行数据库放在临时容器文件系统中。

## 本地开发

```bash
npm ci
npm run build:server
npm start
```

开发期间可用 `npm run dev`。修改前端源码后执行 `npm run build:html`。应用需要 Node `>=22.21`；生产镜像使用 Node 24。

## 发布

GitHub Actions 工作流位于 `.github/workflows/`。镜像版本取自 `package.json`，并应与 `src/meta.ts`、`package-lock.json` 一致。发布前备份生产数据，先拉取目标镜像并检查容器健康状态，再确认订阅与配置输出正常。

不要把 NAS 地址、代理地址、真实订阅 URL、密码或 token 提交到仓库；个人部署值留在未跟踪的 `.env` 中。
