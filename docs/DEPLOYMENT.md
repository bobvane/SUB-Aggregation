# Docker 与 NAS 部署

## 运行要求

- Docker Engine 与 Docker Compose；镜像基于 Node.js 24。
- 持久化挂载 `/data`，SQLite 默认文件为 `/data/app.db`。
- 首次启动必须设置 `ADMIN_PASSWORD`。出网代理为可选项：优先在面板「设置 → 网络代理」配置；也可以使用 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量并选择「跟随环境变量」模式。不配置代理时全部直连。

仓库根目录的 `docker-compose.yml` 是部署模板。将 `image:` 改为实际镜像地址，创建 `.env`：

```dotenv
ADMIN_PASSWORD=替换为强密码
GITHUB_TOKEN=
# 仅「跟随环境变量」模式需要；留空即直连
HTTP_PROXY=
HTTPS_PROXY=
NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,.local
```

### 代理模式与用途

设置页「网络代理」提供三种模式：

| 模式 | 行为 |
|---|---|
| 直连 `off` | 所有出网请求直连（默认，没有代理也能运行） |
| 跟随环境变量 `env` | 读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 作为代理地址，用途仍由勾选决定 |
| 手动 `manual` | 使用设置页保存的代理地址，可分别勾选用途 |

用途分为订阅抓取、升级检测/规则目录、地理归属查询。**默认只勾选后两项**，即代理只用于 GitHub 规则库/升级检测与国家码测定；订阅抓取默认直连，因为订阅 URL 与订阅里的节点地址必须能被没有代理的手机 / App 直接使用。单条订阅仍可单独选择「自动 / 强制走代理 / 强制直连」作为逃生口。代理请求失败时会自动回退直连（超时不回退，显式强制时不回退）；直连失败不会再改用代理，未勾选的用途始终直连。订阅抓取超时为 30 秒。

**节点测活与测速始终直连**（裸 TCP/TLS），不经过上述代理。代理密码保存在 `app.db` 的 settings 表中，界面以 `***` 脱敏显示；备份数据库即包含该密码，请妥善保管备份文件。

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
