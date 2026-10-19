# Docker 与 NAS 部署

## 运行要求

- Docker Engine 与 Docker Compose；镜像基于 Node.js 24。
- 持久化挂载 `/data`，SQLite 默认文件为 `/data/app.db`。
- 首次启动必须设置 `ADMIN_PASSWORD`。若部署环境需要代理出网，配置 `HTTP_PROXY` / `HTTPS_PROXY`，并设置 `NODE_USE_ENV_PROXY=1`。

仓库根目录的 `docker-compose.yml` 是部署模板。将 `image:` 改为实际镜像地址，创建 `.env`：

```dotenv
ADMIN_PASSWORD=替换为强密码
GITHUB_TOKEN=
HTTP_PROXY=
HTTPS_PROXY=
NO_PROXY=localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.local
```

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
