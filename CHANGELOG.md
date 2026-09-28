# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [2.36.3] - 2026-09-29

### 修复
- **仪表盘「最近动态」显示错误**：前端读的是 `l.detail` / 旧 type 值（`node_disable`/`node_enable`/`manual`），而日志服务实际存的字段是 `message`、type 是 `node_disabled`/`node_recovered`/`manual_action`——字段全错配，卡片渲染出 undefined。已对齐为后端真实字段。
- **仪表盘节点信息与节点列表页不联动**：仪表盘显示的是「已启用/已禁用节点」（配置勾选口径），列表页显示的是「存活/不通/已抛弃/上次测活」（测活口径），两页各说各话。现仪表盘统一改用列表页同一数据源（去重后节点数 + health:latest 测活健康），数字两页一致。

### 新增
- **测活完成落操作日志**：`probeAllNodes` 每轮结束自动写一条「测活完成：N 节点，X 存活 / Y 不通 / Z 已禁用」到「最近动态」，手动测活、订阅刷新、定时更新四个入口共用同一写入点。日志保留 30 天，可在仪表盘清空。

## [2.36.2] - 2026-09-28

### 修复
- **节点列表「协议」列显示 `undefined`**：v2.36.0 改写列表渲染时把 `displayProtocol(node)` 错写成 `displayProtocol(node.protocol)`，函数收节点对象却收到字符串，取 `.protocol` 得 undefined。已改回，并在函数内兼容直接传字符串的调用，防止同类传参错误。
- **CDN 前置节点被误判为不通**：TCP 通、但 TLS 握手 `HANDSHAKE_FAILURE`（如 Cloudflare 节点 `162.159.198.1`。裸握手不带 SNI 必被拒，节点本身是好的）。探测改用节点真实的 `sni` 参数做 servername（旧实现只在 host 为域名时才带 SNI）。

### 变更
- **「不通的节点要抛弃」立即生效**：原来按状态机要连续 3 次失败才 `disabled`，点一次测活永远看不到抛弃效果。现改为**最新一轮探测 dead 即从配置剔除**（列表里仍显示、标 🚫，下一轮通了自动回来）。状态机记录继续用于健康历史与排序。

## [2.36.1] - 2026-09-28

### 修复
- **升级后第一轮评分会被旧引擎的假数据带偏**：v2.36.0 换了探测口径，但 KV 里还留着 v2.35 假探测写下的历史（全量 `dead`）。窗口内可用率≈0 会把新评分整体压低、并可能让节点被连续失败判定熔断而踢出配置。新增 `probe:engine_version` 标记：引擎版本变化时，首轮探测前清空 `health:hist:*` 与 `health:latest:*` 再重新采样（清理只发生一次，之后正常累积）。

## [2.36.0] - 2026-09-28

### 修复
- **延迟列全是 `-`、节点被全量误判为不通**：探测引擎自 v2.32 起用 `new WebSocket("wss://host:port")` 当 TCP 连通性测试——节点端口不是 WebSocket 服务，握手永远失败，导致全量节点 `dead`、延迟恒 `null`、评分恒为冷启动分 50。改为真实握手探测：TCP 用 `node:net`（三次握手 RTT），TLS 节点再叠加 `node:tls` 握手（不校验证书，只测连通与耗时），删除「在本机 fetch Google」的假 HTTP 维度。裸 IP 节点不传 TLS `servername`（传了 Node 直接抛错，会让整轮测活 500）。
- **不通的节点从未被真正抛弃**：`getNodes()` 的过滤条件读的是 `node.status`，而状态机写的是健康记录的 `statusMachine`，两套字段不相干 → 条件恒不成立，熔断节点照样进配置。改为按健康快照过滤（连续失败 3 次 = disabled = 抛弃）。节点记录保留、继续参与测活，恢复一次成功即自动回到配置。
- **测活结果不可见**：`POST /api/nodes/probe` 只回节点数、前端只弹一句提示，测完看不出情况。现在接口返回 `{total, alive, dead, suspect, disabled, avgLatency, minLatency}`，列表页顶部常驻显示「存活 / 不通 / 已抛弃 / 上次测活时间」。
- **评分稳定性维度缩放错误**：`recent.slice(-5).map(h => h.score)` 取的是 0-100 分却当 0-1 维度用，稳定性分被放大 100 倍。已改为除以 100；删除 HTTP 维度后权重重新归一为 可用率 35% / 延迟 30% / TLS 25% / 稳定性 10%。

### 变更
- **节点名不再写延迟**：`🇭🇰 HK VLESS 45ms-01` → `🇭🇰 HK VLESS-01`。延迟每次都变，写进名字会让客户端把同一节点当成新节点；延迟请看列表「延迟」列。
- **节点列表默认排序改为「同国家聚一起、健康分高的在前」**：按国家码分组，组内按评分降序、同分按延迟升序，未识别国家排最后；点「延迟」表头仍可切换延迟排序。
- **被熔断抛弃的节点不再从列表页静默隐藏**（此前用户完全看不到）：仍在列表内显示，标 `🚫 已抛弃` 并置灰，仅不输出到生成的配置。

## [2.35.1] - 2026-09-28

### 修复
- **升级后配置输出仍是旧内容**：快照缓存 key 只含 `config_version`（只随数据变更自增），App 升级不触发失效 → 新镜像上线后仍返回旧镜像生成的配置。现在 App 版本也编进 key，升级即自动重新生成。
- **节点列表页不显示自动命名**：v2.35.0 把「清洗」从订阅更新时改到生成时，节点名不再写库 → 列表页退回订阅原始名（如 `香港01-中转`），与生成的配置不一致。`/api/nodes` 改为走同一套自动命名（`config.autoNamed`），只改展示、不动库中原始名。

## [2.35.0] - 2026-09-28

### 变更
- **统计窗口接设置页**：五维评分的统计窗口改为读取「链接更新时间」`sub_update_interval`（1-24 小时），此前硬编码 24 小时——把刷新间隔调成 6 小时时评分窗口不同步的问题已修复。取值为 0（不自动更新）、缺失或非法时回退 24。
- **新增订阅即触发测活**：`POST /api/subscriptions` 建成后同样后台触发全量测活（此前只有订阅更新/定时任务/手动按钮三处触发）。
- **删除人工清洗规则**（`src/models/clean-rule.ts` 及全部引用）：节点名已由 v2.34 的自动命名在生成时统一产出，清洗规则实际失效。移除 5 个接口（`/api/nodes/clean-rules*`）、订阅解析期的清洗应用、后台注入与前端清洗面板，节点页改为提示自动命名格式。

## [2.34.0] - 2026-09-28

### 新增:节点自动命名(废弃人工清洗规则)
- 生成时对所有输出格式(mihomo/singbox/base64)**统一自动重命名**,格式 `[旗帜] [国家代码] [协议] [延迟ms]-NN`,NN 为批次连续序号(01 起,每个节点都带号)。
- 旗帜+国家码来自已有的 ip-geo 缓存(与地理分组同一数据源,不新增查询);延迟取 `node_health` 实测值(`http_latency`,无则回退 `tcp_latency`,冷启动无数据显示 `--`)。
- 地理组内节点按 `node_health.score` **降序**排列:得分高的在前,未知分靠后,同时同步到「手动切换」扁平顺序。
- 命名示例:`🇭🇰 HK VLESS 45ms-01`

## [2.33.0] - 2026-09-28

### 修复:节点健康/测活失效
- **根因修复**:路由把 `repos.settings`(只有 get/set)强转成 `KVStorage` 传给探测引擎,缺 `list/put` → ①`GET /api/nodes/health` 抛 500 ②订阅更新后的全量测活**静默失败**(异常被 waitUntil 吞掉),一条健康数据都写不进。现统一改用 `deps.storage ?? repos.kv`。
- **回归测试**:新增 `tests/integration/nodes-health-api.test.ts`(旧写法精确复现 500,修复后 200)

### 新增:节点列表页(补齐前端半成品)
- 「⚡ 立即测活」按钮 + `POST /api/nodes/probe` 手动全量测活
- 新增「延迟」列(最新 http_latency,点击表头排序)与「状态」列(alive/dead 图标)
- 点击状态列弹出该节点健康历史折线图(纯前端渲染,读 `node_health_history`)
- 死节点(disabled/removed)UI 完全隐藏,仅隐藏不删除,仍参与后续测活以便恢复

## [2.32.0] - 2026-09-28

### 新增:节点测活/测速/智能评分/自动命名/状态机熔断
- **探测引擎**:TCP → TLS → HTTP 204 三段串行,并发 50,结果写 SQLite(`node_health` + `node_health_history`)
- **五维评分**:Score = 30% 可用率 + 25% 延迟得分 + 20% TLS成功率 + 15% HTTP成功率 + 10% 最近稳定性(均值)
- **状态机**:连续失败 1 次 → suspect(黄色警告);连续失败 3 次 → disabled(隐藏+过滤);连续成功 2 次 → 恢复
- **死节点处理**:永不物理删除,标记 `status='disabled'`,配置生成时 filter;UI 完全隐藏
- **统计窗口**:与 `sub_update_interval` 同步,冷启动各维度 50% 起始分
- **历史保留**:30 天,探测完成后顺手清理(O(n) 前缀扫描),不加独立定时器

### 新增:Subscription Diff + tombstone 机制
- 每次订阅更新计算新增/删除/保持/变化四组节点(按 `nodeFingerprint()`)
- 删除节点标记 `status='removed' + removed_at`,30 天后随历史一起物理清理
- UI 订阅卡片展示 Diff 摘要(+N/-D/~U/ΔC)

### 新增:配置快照缓存 + ETag 条件请求
- 只缓存 mihomo(占 90% 拉取量),singbox/v2ray 直接生成
- 版本来自 `setting:config_version`,失效点:订阅更新/规则保存/分组保存/禁用节点变更/自定义规则增删/清洗规则应用
- 客户端带 `If-None-Match` → 304 Not Modified

### 新增:操作日志
- KV 存储(`op_log:data:{idx}` + `op_log:next_idx`),保留 30 天
- 事件类型:订阅更新/GeoIP 更新/节点禁用/节点恢复/手动操作/缓存失效
- 仪表盘「最近动态」卡片,支持手动清空
- API:`GET /api/operation-log`(列表)、`DELETE /api/operation-log`(清空)

### 新增:健康 API
- `GET /api/nodes/health?fingerprint=xxx` — 返回单个节点的 health snapshot + history
- `GET /api/nodes/health/all` — 返回全部节点最新快照

### 修改:触发时机
- 订阅更新完成后自动触发全量测活(挂在 scheduled handler 同一位置)
- UI「立即测活」按钮可手动触发

### 修改:数据模型
- `Node` 接口扩展:`original_address` / `first_seen_at` / `status`(active/suspect/disabled/removed) / `removed_at`(tombstone)
- `KV_KEYS` 新增:`healthHistory` / `healthLatest` / `operationLog` / `configSnapshot` / `configVersion`

## [2.31.3] - 2026-09-26

### 变更：Google服务 组默认选中改回「手动切换」
- 此前固化策略组硬编码 `default-selected: DIRECT`；用户拍板改为「手动切换」（与设定中 AI 平台默认一致）。
- 修复处：`src/generator/mihomo.ts` 5b 固化组；mihomo.test.ts 补充该默认值断言
  （「default-selected ∈ proxies」既有恒等式校验对全部组继续生效）。

## [2.31.2] - 2026-09-26

### 变更：订阅自动更新改为「每隔 N 小时」
- 原「每天固定时刻（北京时间 0-23 点，默认 07:00）」改为「每隔 1-24 小时自动更新一次」，
  **0 = 不更新**，默认 24 小时。
- 设置页改为「订阅自动更新间隔」，输入 0-24 整数；API 字段 `sub_auto_update_hour` → `sub_update_interval`。
  旧的 `sub_auto_update_hour` 键不再读取（改的是语义，不是取值，留着会误判）。
- 新增设置项 `sub_update_last_at`：记录上次自动更新时刻，间隔从该点起算。
  判定留 1 分钟余量 —— 否则 24 小时的间隔每逢整点 tick 会差几毫秒，空过一次就顺延成
  25 小时并逐日漂移（判定粒度是整点，实际误差不超过 1 小时）。
- 新增单测 `tests/unit/auto-update.test.ts`（7 例：0/非法值不触发、满间隔才触发、不漂移）。

## [2.31.1] - 2026-09-26

### 变更：部署模板与文档改为通用占位符
- `docker-compose.yml` 的 `image` 改为 `docker.io/<你的DockerHub用户名>/sub-aggregation:latest`，
  并注明另一份 GHCR 镜像怎么写 —— 直接抄走的人必须自己填一次，不会拿着别人的镜像名跑。
- README / 部署文档同步说明「两份镜像内容一样、Docker Hub 那份才会被 NAS 检测到更新」，
  顺手把 README 里过期的版本号与测试数徽章改对（2.30.0/487 → 2.31.1/495）。
- 无代码改动，运行行为不变。

## [2.31.0] - 2026-09-26

### 新增：镜像可同时推送到 Docker Hub（给 NAS 的升级检测用）
- 飞牛 fnOS 的「镜像可更新」检测只认 Docker Hub，不检测 GHCR 这类第三方仓库。
- CI 构建时会同时推 GHCR 与 Docker Hub；配了 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`
  两个仓库 secret 才启用，没配则自动跳过，不影响原有构建。
- 版本是否已发布的判断改为「两个 registry 都有该版本的 tag」，任一处缺失就重建，
  避免某次推送失败后两边版本对不上。

### 修复：镜像 tag 不再带 buildx 的 `unknown/unknown` 证明条目
- buildx 默认会给镜像加 provenance 证明清单，于是 `latest` 指向的不是单一镜像，而是一个 index：
  `linux/amd64` + 一个 `unknown/unknown` 的证明条目。
- 一些第三方 registry / NAS 的镜像更新检测解析这种 index 会出问题（飞牛 NAS 检测不到本镜像更新即为一例）。
- 改为 `provenance: false` + `sbom: false`：`latest` 回归单一 `linux/amd64` 镜像，语义干净，推送也更快。
- 运行行为、镜像内容、体积均无变化。

## [2.30.9] - 2026-09-26

### 修复：页面左下角的版本升级提示不再出现
- **现象**：Web 页面左下角的版本号旁边不再冒出「有新版」提示。
- **根因（实测复现）**：升级检测走的是 GitHub REST API `api.github.com/.../releases/latest`，**匿名额度只有 60 次/小时/出口 IP**。实测该出口 IP 已被打满：`{"message":"API rate limit exceeded for 104.28.166.48"}`，HTTP **403**。而旧代码把「非 2xx」和「网络异常」都折叠成 `hasUpdate:false / checked:true` —— **失败被伪装成「已检查、无更新」**，前端自然永远不提示。CF Workers 时代出口是 Cloudflare 边缘 IP，很少撞限流；换成 Docker 走自家旁路由出口后就必撞。
- **修复**：改用 **releases 的 Atom 订阅**（`https://github.com/bobvane/SUB-Aggregation/releases.atom`，免鉴权、无配额，实测 200 + 解析出 `v2.30.8`）；失败时如实返回 `checked:false` 并带 `checkError`（`network` / `http 403`），不再谎报「无更新」；成功缓存 6h 不变，**失败只缓存 10min**（不把一次网络抖动锁 6 小时）。
- 回归测试：`tests/integration/meta-api.test.ts` 由「打真网」改为注入桩（Atom 解析 / 网络异常 / 403 三例），不再依赖外网。

## [2.30.8] - 2026-09-26

### 修复：首页 HTML 一直没被压缩（v2.30.6 的压缩漏网之鱼）
- **根因**：`handleHtml()` 在 `app.fetch()` 之前就短路返回，页面响应根本不进 Hono 的中间件链，`compress()` 看不到它 —— 所以 API 全压了，最大的那个文件（首页 HTML **107 KB**）一直原样传输。hono 的 compress 内部 `await next()` 后检查的是 `ctx.res`，那时还是默认 404（9 B，低于 1 KB 阈值）而直接跳过。
- **修复**：在 `handleHtml()` 里自己压 —— 首次请求用 `CompressionStream('gzip')` 压一次并常驻内存，之后直接复用；带 `Vary: Accept-Encoding`，gzip 表示用 `-gzip` 后缀的 ETag 区分，304 逻辑保持命中。
- 实测：**107,289 B → 29,947 B（-72%）**；解压后与原文逐字节一致；gzip 复访 ETag 命中 304。

## [2.30.7] - 2026-09-26

### 精简（移除死代码 / 修正依赖声明）
- 移除从未被 import 的运行时依赖 **`zod`**（全仓 0 处引用）。
- **`yaml` 从 devDependencies 移到 dependencies**：`src/parser/clash.ts` 与 `src/generator/yaml-serializer.ts` 都在运行时 import 它，声明在 dev 里是隐患（`npm ci --omit=dev` 后构建会失败）。
- 删除死文件 `src/data/rule-format-mapping.ts`（sing-box `.srs` URL 工具，全仓 0 处引用，功能已由 `rule-providers.ts` 承担）。

### 实测记录（本次未改动代码，仅确认现状）
- 单进程启动到首个响应：**113 ms**；228 节点生成完整 mihomo 配置：**14 ms**；`nodes.getAll()` 0.4 ms。
- 镜像体积 58.9 MB（压缩），其中本项目代码仅 **176 KB（0.3%）**，其余全是 Node 24 运行时 —— 体积没有可压缩空间，`--minify` 只能省 44 KB（-0.07%），且会让线上 500 的堆栈不可读，故不做。

## [2.30.6] - 2026-09-26

### 改进
- **站内响应全部启用 gzip 压缩**：此前首页 HTML（107KB）、`/api/nodes`（86KB）、输出配置（120KB）都是明文传输，走 Tailscale 远程访问时会消耗数倍带宽。注册 hono 自带 `compress()` 中间件（零新依赖），实测 237KB 的规则目录响应压缩到 21KB（91%）。
- **规则库标题去掉写死的「1546 个分类」**：上游分类数量会随 MetaCubeX 同步增长（当前 1904），硬编码数字必然过期；页面上已有动态的「共 N 个分类」，故移除标题里的静态数字。

### 修复
- **订阅管理页「链接」列恒显示 `-`**：前端按 `s.url` 渲染该列，但 `GET /api/subscriptions` 返回字段里漏了 `url`，导致改订阅地址 / 复制原链接都无法使用。后端补回 `url` 字段（该接口已有登录保护）。

## [2.30.5] - 2026-09-26

### 修复
- 配置输出页 / 节点列表 / 订阅链接的**复制按钮在明文 http 下点了没反应**：非安全上下文浏览器不提供 `navigator.clipboard`，旧代码 `navigator.clipboard.writeText(...).then().catch()` 会**同步抛 TypeError**，`.catch()` 回退根本没机会执行。新增统一的 `copyText(text, okMsg)`（`public/index.html`），可用则走 Clipboard API，否则回退 `execCommand('copy')`；三处复制入口（`copyNodeLink` / `copyFormatUrl` / `copyUrl`）全部收敛到它。

## [2.30.4] - 2026-09-26

### 修复：明文 http 部署下登录后立刻掉线（大面积 401）

**症状**：NAS 上用 `http://内网IP:20130` 访问，登录成功，但一刷新浏览器就回登录页；仪表盘 / 订阅 / 规则 / CF 统计 / 输出配置全部"加载失败"，规则库刷新报 `Authentication required`，快速预设按钮空白。

**根因**：`createSessionCookie` 无条件写 `Secure`。按 RFC 6265bis §5.4，**浏览器收到非 https 连接下发的 `Secure` cookie 会整条丢弃**（curl 不遵守，所以冒烟测试没抓到）。cookie 一丢，后续每个请求都是未登录 → 401 连锁。此前跑在 Cloudflare 上是 https，从未暴露。

**修复**：`createSessionCookie` / `createClearCookie` 增加 `secure` 参数（默认 `true`，行为不变）；新增 `isHttpsRequest()`（先看 `x-forwarded-proto`，再看请求 URL 协议），三个调用点按请求实际协议决定是否加 `Secure`。

- 明文 http → 不带 `Secure`，浏览器正常保存，登录状态可保持
- https / 反代（`x-forwarded-proto: https`）→ 仍然带 `Secure`，安全属性不降级
- `HttpOnly` + `SameSite=Strict` 两种情况都保留

**实测**：明文 http 登录响应头 `... HttpOnly; SameSite=Strict; Max-Age=604800`；带 `X-Forwarded-Proto: https` 时为 `... HttpOnly; Secure; SameSite=Strict ...`。带 cookie 时首屏全部接口 200（订阅 0 时给空态），无 cookie 时复现 `AUTH_REQUIRED / Authentication required`。

代码逻辑仅此一处改动，另同步 docs/03、docs/12、SECURITY.md 对 cookie 属性的描述。

## [2.30.3] - 2026-09-26

### 文档纠错：`.env.example` 对 `GITHUB_TOKEN` 的说法

- 原文写"注释说这些值只在首次启动初始化时使用"——错，`GITHUB_TOKEN` 每次同步规则目录都读，代理变量每次出网都读，只有 `ADMIN_PASSWORD` / `SESSION_SECRET` 是首次初始化用的
- 补清楚 `GITHUB_TOKEN` 的用途和取舍：只被「规则目录同步」用（每月 1 日、3 次 API 调用）；不填照样跑，区别只是 GitHub API 额度 60/h → 5000/h（按出口 IP 算）；填的话用 fine-grained token 只勾 Public Repositories 只读

代码零改动。

## [2.30.2] - 2026-09-26

### 项目改名：CF-Workers-SUB-Next → SUB-Aggregation

仓库已改名为 `bobvane/SUB-Aggregation`（不再使用 Cloudflare，名字里的 CF-Workers 已名不副实）。同步改了：

- **镜像名** `ghcr.io/bobvane/cf-workers-sub-next` → `ghcr.io/bobvane/sub-aggregation`（CI 从 `github.repository` 推导，自动跟随仓库名）
- `package.json` / `package-lock.json` 包名 → `sub-aggregation`；`src/meta.ts` 的 name / repo / repoShort
- 前端 `public/index.html`：标题、登录页、设置项占位、GitHub 链接；`src/api/routes.ts` 的 `GITHUB_REPO` 与默认 app_name
- User-Agent（`src/app.ts` / `src/api/routes.ts` / `src/engine/fetcher.ts`）→ `sub-aggregation` / `SUB-Aggregation/2.0`
- `docker-compose.yml`：服务名 / 容器名 / 数据目录 `/vol1/1000/Docker/sub-aggregation/` / 镜像名
- README、CONTRIBUTING、SECURITY、design 稿、本地 docs（00 / 11 / 16）

代码逻辑零改动。

## [2.30.1] - 2026-09-26

### 文档同步：定时任务说法与架构图对齐 Docker 版

- README / `11 部署` / `07 定时任务`：定时器实际是 **30 秒一跳、同一分钟去重**（原文写"每分钟检查"），订阅自动更新是"每小时整点检查、只在用户设定时刻真正执行"，两处都改准
- `01 架构总览`：架构图入口 `src/index.ts` → `src/server/main.ts`，存储层补 `sqlite.ts`，删掉 `KvAdapter`/`DATABASE` 绑定，环境变量表按 `DB_PATH`/`PORT` 重写
- `02 数据模型` / `10 测试` / `12 安全` / `14 路线图` / `09 CF 用量`：去掉 Workers 部署口径，CI 步骤按现有两个工作流改写
- `09` 补一句说明：CF 用量统计是**统计你 Cloudflare 账户**的功能，与本项目部署方式无关

代码零改动。

## [2.30.0] - 2026-09-26

### 项目转为 Docker 专用：清掉全部 Cloudflare 部署残留

Cloudflare 侧已于 2026-09-24 停止使用。本次把仓库里仍指向 Workers 的部分全部移除，只保留 Docker / NAS 一条部署路径。

**删除**
- `wrangler.toml`、`.dev.vars.example`
- `src/index.ts`（Workers 入口）与 `KvAdapter`（CF KV 适配器），以及 KvAdapter 专用测试
- CI 里的 `deploy` job（原为仅手动触发）

**改动**
- `package.json`：去掉 `wrangler` / `@cloudflare/workers-types` 依赖与 `deploy` 脚本；`dev` 改为本地跑 Node 产物；`engines` 提到 `>=22.21`（`NODE_USE_ENV_PROXY` 的下限）
- `tsconfig.json`：`types` 只留 `node`（不再需要 workers-types）
- CI 只管测试与发版；镜像构建仍由 `build-image.yml` 负责
- README / CONTRIBUTING / SECURITY 按 Docker 版重写；代码注释与元信息里残留的 Workers 语境改为中性表述

**顺带修掉两处类型问题**（去掉 workers-types 后暴露）
- `src/engine/fetcher.ts`：`RequestInfo` → `string | URL | Request`
- `src/server/main.ts`：`ExecutionContext` 改为从 `hono` 导入

**测试**：490 → 487（移除的 3 项是 KvAdapter 专用；前端 HTML 缓存测试改为直测 `handleHtml`，覆盖未减）。

## [2.29.9] - 2026-09-26

### 部署配置：容器出网走代理（修域名型节点查不出国别）

- **`docker-compose.yml` 增加 `NODE_USE_ENV_PROXY=1` 与 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`**。Node 内置 `fetch` 默认**不读**代理环境变量（undici 行为，与 curl、Python 不同），不开这个开关，容器即使配了代理也是直连。而项目把域名解析成 IP 走的是 DoH（`dns.google` / `cloudflare-dns.com`），从国内直连不通 → 域名型节点拿不到 IP → 查不出国别 → 掉进「其他」组。
- **程序代码零改动**，只改部署配置。实测（同一份订阅，含一个域名节点）：开关关闭时该节点落入「其他」组，开启并走代理后正确归入对应国家组。
- 代理地址可在 `.env` 覆写；`NO_PROXY` 已含内网段，容器自身与本机服务不受影响。
- 新增 `NODE_USE_ENV_PROXY` 需 Node 24.0+/22.21+，本镜像为 `node:24-alpine`。

## [2.29.8] - 2026-09-26

### 同一份代码可跑在 NAS / Docker（Cloudflare Worker 被删后的迁移）

- **拆出共享应用层 `src/app.ts`**：Workers 入口（`src/index.ts`）与新增的 Node 入口（`src/server/main.ts`）共用同一份装配、前端响应与定时任务逻辑，不再各写一份。
- **新增 SQLite 存储适配器 `src/storage/sqlite.ts`**：实现与 CF 的 `KvAdapter` 相同的 `KVStorage` 接口（get/getMany/put/delete/list），仓储/服务/路由/前端零改动；用 Node 内置 `node:sqlite`，零第三方依赖。`list(prefix)` 用 `substr` 精确比较而非 `LIKE`——键名里的下划线在 `LIKE` 中是单字符通配符。
- **Node 入口**：`@hono/node-server` + 30 秒一跳的定时器（只匹配与 `wrangler.toml` 一致的三条 cron，不引 cron 库）；补 Hono 的 `c.executionCtx` shim，否则 `POST /api/subscriptions/:id/update` 直接 500。
- **原有业务代码零改动**：解析器、生成器、服务层、路由、前端一行未动，只新增运行时入口与存储适配器——CF 版与 NAS 版跑的是同一份业务代码。
- **出包**：新增 `.github/workflows/build-image.yml`，push 且版本号变化时构建并推送 `ghcr.io/bobvane/sub-aggregation`（只出 linux/amd64；Dockerfile 内跑测试，不通过不出包）。NAS 侧只 `docker compose pull`，参考 `docker-compose.yml`。
- **CI 调整**：CF 的 `wrangler deploy` 改为仅手动触发（避免 push 把被删的 Worker 重新建上去）；Release 自动打 tag 拆成独立 job，推送即发版的行为不变。

## [2.29.7] - 2026-09-24

### 负载均衡组显式输出 strategy（用户 2026-09-24 指令）

- 所有 `load-balance` 组在 `type` 下方硬编码输出 `strategy: consistent-hashing`（与内核默认值一致，此前依赖默认不输出）。

## [2.29.6] - 2026-09-24

### 仪表盘新增「已启用订阅」卡片（用户 2026-09-24 指令）

- 与「已禁用订阅」对称：`订阅数量 = 已启用订阅 + 已禁用订阅`，两处同用一个判定（`s.enabled`，与停用订阅节点过滤同源）。

## [2.29.5] - 2026-09-24

### 仪表盘统计口径（用户 2026-09-24 指令）

- 新增「已禁用订阅」卡片：停用的订阅链接数量。
- 「节点总数」改为统计**全部订阅**（启用 + 停用）的节点；「已启用节点」保持只算启用订阅的节点（再扣掉手动禁用节点）。「协议分布」与「节点总数」同口径。
- `NodeRepository.getAll()` 增加可选参数 `includeDisabledSubscriptions`（默认 false，行为不变）；注释、去重、输出配置仍走默认口径。

## [2.29.4] - 2026-09-24

### 地理组排序：自动测速+负载均衡地区在前（用户 2026-09-24 指令）

- `geoGroups` 稳定分区排序：`testRegionNames` 内的自动测速地区（及各自 `-负载均衡` 组）整体提到最前，普通 `select` 地区排后；测试组内、普通组内各自保持原相对顺序。
- 一处排序级联生效：地理组定义区（`proxies:`）与所有候选列表（`geoChoices`）同序。

## [2.29.3] - 2026-09-24

### 负载均衡地理组进入各候选列表（用户 2026-09-24 指令）

- 凡候选列表含地理组的组，一律同时给出该地区的负载均衡组，位置紧跟其地区组之后：
  `节点选择`、`自动选择`、`手动切换`外的业务组（`国外媒体`/`Google服务`/`AI 平台`/`GitHub`/`YouTube`/`加密货币`/`社交`/`微软服务`/`苹果服务`/`游戏平台`/`用户规则`/`漏网之鱼`）。
- 实现为派生列表 `geoChoices`（源：`geoGroups` + `testRegionNames`），各处不再各自拼地理组名；`geoGroupNames` 保持纯地区组，下标查找不受影响。
- 「是否自动测速」与「是否产出负载均衡组」改为同源（`testRegionNames`），两处判断不会跑偏；单节点地区两者都不产生。

## [2.29.2] - 2026-09-24

### 香港组：手工选定改为自动测速（用户 2026-09-24 指令）

- `🇭🇰 香港` 由 `select` 手工选定改为 `url-test` 自动测速组，并同其余测速地区一样追加 `🇭🇰 香港-负载均衡`（`load-balance`）。
- 单节点时仍自动降级为 `select`（沿用 v2.28.5 规则，测速对单节点无意义），此时不产出负载均衡组。

## [2.29.1] - 2026-09-24

### 停用订阅的节点全面退出聚合（用户 2026-09-24 反馈修复）

- **修复**：v2.28.9 只让停用订阅退出了「配置输出」，节点列表、总节点统计、重复节点整理仍在统计它。
- **根因修复**：过滤下沉到唯一聚合入口 `KvNodeRepository.getAll()`（节点列表 / 仪表盘统计 / 重复节点去重 / geo 重检 / 配置输出全部经由它），一处生效、无遗漏。
- 原始节点数据仍保留在 KV，重新启用即恢复，无需重新抓取（`getBySubscription` 不受影响）。

## [2.29.0] - 2026-09-24

### 测速组补 `timeout: 5000`（用户 2026-09-24 拍板）

- 所有带 `interval: 300` 的组统一在 `interval` 下方补 `timeout: 5000`（健康检查超时，单位毫秒）：自动选择组、地区 url-test 组、地区负载均衡组共三处。
- 非测速组（如手动切换等 select 组）不受影响。
- 键顺序统一为 `url → interval → timeout → tolerance`，排版更整齐。

## [2.28.9] - 2026-09-24

### 订阅启用/停用（用户 2026-09-24 拍板新增）

- 订阅管理页面新增「⏸ 停用 / ▶ 启用」按钮 + 状态徽标（✅ 已启用 / ⏸ 未启用）；停用的订阅不用删除，留着以后一键启用。
- 新端点 `POST /api/subscriptions/:id/enabled`（body `{enabled}`）；`GET /api/subscriptions` 列表补 `enabled` 字段。
- 停用订阅：不参与每日自动更新（`index.ts` scheduled），也不参与输出配置生成（`config.service.generate` 改用启用订阅的节点；复用已有 `getBySubscriptions` 批量读取）。

## [2.28.8] - 2026-09-24

### 地理负载均衡组（用户 2026-09-24 拍板新增）

- 6 个 url-test 地区（美国/马来西亚/日本/新加坡/台湾/韩国）各**额外**产出一组 `load-balance` 负载均衡组，命名 `<地区>-负载均衡`，紧随其地区组之后，成员与该地区组一致。
- 原 url-test 组保留不动；单节点地区仍按既有规则跳过（测速/均衡均无意义）。
- `strategy` 不写死，走内核默认 `consistent-hashing`（同一目标域名固定走同一节点，不跳 IP）；`tolerance` 是 url-test 专有参数，load-balance 不输出。
- 新增回归测试：断言 url-test 组保留、load-balance 组紧随其后且不带 `tolerance` / `strategy`。

## [2.28.7] - 2026-09-24

### GLOBAL 全量引用（修正面板顺序失效的真因）

- **根因**：zashboard/metacubexd 的面板组顺序 = API 里 `GLOBAL.all` 的下标，不看配置文件 `proxy-groups:` 顺序。原 GLOBAL 只引用 4 组，其余组 `indexOf` 为 -1 → 掉进 Go map 的字母序，故 v2.28.6 的排序在面板上不生效（广告拦截排到国外媒体后、社交/苹果服务排到漏网之鱼后，均为 Unicode 字母序所致）。
- **修法**：全部组生成并排序后，把 `GLOBAL.proxies` 全量回填为「面板顺序的全部组 + DIRECT」。用户 2026-09-24 拍板，推翻 2026-08-30「GLOBAL 只留四组」。
- 顺带修正文件头注释与代码长期不一致的问题（注释早已写明该规则，代码未照做）。

## [2.28.6] - 2026-09-24

### 面板策略组排序调整（用户 2026-09-24 拍板）

- `PANEL_ORDER` 重排：节点选择 → 手动切换 → 自动选择 →（用户规则，仅勾选时出现）→ AI 平台/GitHub/Google服务/YouTube/加密货币/国外媒体/社交 → 漏网之鱼 → 微软服务/苹果服务/游戏平台 → 广告拦截 → 国家地理组 → GLOBAL（压最后）
- 仅改 proxy-groups 输出顺序，不涉及任何分组定义/分流规则逻辑

## [2.28.5] - 2026-09-24

### 优化：url-test 健康判据 + 地理组国旗图标（吸收 Perfect-Rules v1.7）

- 自动选择 / 地理 url-test 组：新增 `expected-status: 204` + `max-failed-times: 3`
  - mihomo 默认 `expected-status` 为 `*`（任何状态都算存活）；限定 204 后，只有 generate_204 返回
    204 才判定节点可用，避免"能连上但响应异常"的节点被误判为正常
  - 默认连续失败 5 次才触发强制复检，收紧为 3 次，更快恢复
- 地理组：按国家码配 Qure IconSet 国旗图标（jsdelivr CDN），无对应图标的回落 Area.png，
  覆盖 26 个常见国家；纯视觉，不涉及分流/规则逻辑

## [2.28.4] - 2026-09-23

### 新增：前端「输出配置」页 Mihomo DNS 泄露提示 + README 标注

- 前端「输出配置」页：Mihomo 配置下方新增红字注释 —— 用 OpenClash 导入时需在
  插件面板关闭「自定义上游 DNS 服务器」，否则会覆盖订阅 DNS 分流导致国内 DNS 明文外发（防泄露）
- README 功能特性：新增「DNS 防泄露」条目，同步标注 OpenClash 关闭自定义上游 DNS 的注意点

## [2.28.3] - 2026-09-23

### 修复：Mihomo 配置补顶层 `ipv6: false`（对齐 Perfect-Rules）

- `BASE_LAYER` 顶层新增 `ipv6: false`：内核不做 AAAA 解析、不建立 IPv6 出站，
  避免 IPv6 侧绕过 TUN 导致的 DNS/IP 双泄漏。

## [2.28.2] - 2026-09-23

### 修复：Mihomo 配置 DNS 泄露防护（参照 Perfect-Rules，仅 BASE_LAYER 硬编码层）

- `dns.default-nameserver` 由 DoH URL 改为明文 IP（官方要求必须为 IP）—— 修复引导解析循环失效回落系统 DNS 的泄露原点
- `fake-ip-filter` 收窄为最小集（LAN/NTP/Apple/captive/连通性），移除 `geosite:cn` / `geolocation-!cn` /
  `private` / `microsoft@cn` / `apple@cn` / `steam@cn` 排除 —— 恢复 fake-ip 全覆盖，漏测站（境外域名）不再走真实 IP 直连
- `sniffer.override-destination` / `force-dns-mapping` 置 true —— 域名还原完整，境外流量按域名判规则
- `tun.strict-route: true`、`tun.mtu: 1280`、`dns.listen: 0.0.0.0:53` —— 强化 TUN 接管、堵路由绕过
- `dns.fallback` 境外双备（cloudflare + google，走漏网之鱼代理）—— 消除 8.8.8.8 单点
- `fallback-filter` 增加 `domain` 白名单（google/openai/anthropic/claude 等强制只走境外 fallback）

无逻辑接口变更；测试基线维持 475/475。

## [2.28.1] - 2026-09-23

### 文档：全面重做技术文档与说明文件

无代码逻辑变更，仅文档。

**公开文档（GitHub）**

- 重写 `README.md`：版本徽章与测试基线更新（404 → **475** 项）；修正过时描述（「9 种输出格式」→ 实际的 **6 种**、「11 组固定分流」→ 实际的 **13 组**）
- 修正 API 表错误：改密/改用户名为 `POST`（原误写 `PUT`）、启用节点为 `/api/nodes/enabled`（原误写 `/disabled`）
- 重写 `SECURITY.md`：支持版本更新至 v2.28.x
- 更新 `CONTRIBUTING.md`：测试基线与生成器格式修正

**文档清理**

- 移除已过时文档：`docs/development.md`、`docs/proxy-group-hierarchy.md`、`docs/rules-sort-current.md`、`docs/rules-sort-plan-v211.md`
- 移除本地内部文档：`PROJECT_CONTEXT.md`、`PLAN.md`、`CURRENT_TASK.md`

**内部技术文档（本地保留，不上传 GitHub）**

- 重建 `docs/00–14` 全套技术规范：导航、架构总览、数据模型、API 规范、协议解析、配置生成、分流规则系统、定时任务、IP 归属识别、Cloudflare 用量统计、测试、部署、安全、前端、路线图

## [2.28.0] - 2026-09-23

### 安全：依赖全面升级，漏洞清零（5 → 0）

GitHub Dependabot 报告的 5 个依赖漏洞全部修复：

| 包 | 升级前 | 升级后 | 说明 |
|---|---|---|---|
| hono | 4.13.1 | **4.13.8** | 运行时框架，涉及 3 条通告 |
| wrangler | 4.122.0 | **4.136.3** | 部署工具 |
| miniflare | 5.20260811.0-alpha | **5.20260921.0-alpha** | wrangler 子依赖 |
| sharp | 0.35.2 | **0.35.4** | libheif 漏洞 |
| js-yaml | 4.3.1 | **4.3.2** | eslint 子依赖 |

- `npm audit`：**0 个漏洞**（升级前 5 个）。
- 新增 `overrides: { "js-yaml": "^4.3.2" }` —— js-yaml 是 `eslint → @eslint/eslintrc` 的传递依赖，无法直接升级，用 npm 官方 overrides 机制强制到修复版。
- `allowScripts` 白名单同步到实际安装版本（workerd 1.20260921.1、esbuild 0.28.1/0.28.2），消除安装告警。
- 验证：lint 干净、`tsc --noEmit` 通过、475 个测试全过、`wrangler deploy --dry-run` 打包正常（738.72 KiB / gzip 160.82 KiB），部署链路未受影响。

### 漏洞影响面的核实结论（升级前已完成）

5 条中只有 `hono` 是运行时依赖，其 3 条通告在本项目**均不可达**：`toSSG()` 与 `parseBody()` 全仓库零调用；查询串解析一条，官方通告原文明确写明「部署在 Cloudflare Workers 等会规范化该目标的运行时上不受影响」，而本项目部署于 Workers。其余 4 条（js-yaml / wrangler / miniflare / sharp）属于 eslint 与 wrangler 的开发期依赖，不随 Worker 上线。

本次升级的目的是消除告警、保持依赖健康，**并非修复已被利用的漏洞**。

## [2.27.9] - 2026-09-22

### 性能：首屏请求合并（4 次 → 1 次）

- **首屏 bootstrap**：`GET /api/auth/session?page=dashboard` 一次返回「登录态 + 用户名 + 仪表盘数据」。首次打开页面原本要串行发 4 个请求，现在 1 个。
- **修复重复请求**：`checkSession()` 内部调用了 `loadDashboard()`，而紧随其后的 `switchPage('dashboard')` 又调一次，导致 `/api/dashboard` 每次打开页面都被请求两遍。已移除 `checkSession()` 里那次，统一由 `switchPage` 负责。
- **不为没看的页面白算**：仅当 `page=dashboard` 时计算仪表盘；从 `#nodes` 等页面进入时不触发多余 KV 读取。
- 后端抽出 `buildDashboard()`，`/api/dashboard` 与 bootstrap 共用同一实现；新增测试断言两者返回值完全一致，防止逻辑漂移。
- 新增 5 个集成测试。

### 评估结论：不做前端文件拆分

曾计划的「前端拆分」经实测放弃：整页 gzip 后仅 28KB（源码 105KB 不是真实传输量）；拆成 HTML/CSS/JS 会多 2 次网络往返；「按页懒加载」项目早已实现（`switchPage` 按需加载），重复访问不重传也已由 v2.27.7 的 304 覆盖。拆 JS 模块需重排 100 个函数、225 个全局变量与 61 处内联事件绑定，风险高而收益≈0。

## [2.27.8] - 2026-09-22

### 测试：补齐 `/` 前端缓存的端到端覆盖

- 新增 `tests/unit/worker-html-cache.test.ts`（4 例），覆盖 v2.27.7 引入的 HTML 缓存行为：200 + ETag 格式 + Cache-Control、`If-None-Match` 命中返回 304 且无响应体、不匹配返回完整 HTML、同一内容 ETag 稳定。
- `/` 在 `buildApp` 之前返回，测试无需 mock KV。
- 纯测试补充，无运行时行为变化。

## [2.27.7] - 2026-09-22

### 性能：开启缓存，减少重复传输与冷读延迟

- **前端 HTML**：`/` 响应新增内容哈希 `ETag` 与 `Cache-Control: public, max-age=0, must-revalidate`。浏览器二次访问命中 `304`，省掉约 105KB 页面传输；HTML 内容变化时 ETag 自动变化，不会读到旧页面。
- **KV 边缘缓存**：读入口统一带 Cloudflare KV 原生 `cacheTtl: 60`（官方文档：最小 30 秒、默认 60 秒），把写少读多的键缓存在边缘节点，省掉回源冷读延迟。改动集中在 `KvAdapter` 一处，未改任何调用点。
- **例外**：`session:` 与 `setting:password_version` 不参与缓存——会话吊销和密码版本必须即时生效。
- 官方文档确认写入会重新校验 KV 内部缓存层，因此不存在「改完读到旧值」的问题。
- 新增 1 个测试覆盖缓存开关分支。

## [2.27.6] - 2026-09-22

### 性能：KV 读取从 N 次串行改为 1 次批量

- **根因**：`KVStorage` 只提供单键 `get()`，6 处仓储方法采用「先 `list()` 列目录、再逐个 `await get()`」的模式——读 N 个键就是 N 次串行网络往返。管理页每次加载要读订阅、节点、规则三组数据，往返次数随订阅数量线性增长，这是页面打开慢的主因。
- **修复**：新增 `KVStorage.getMany(keys)`，走 Cloudflare KV 原生批量读（官方文档：单次最多 100 键），按 100 分片自动分批，1 次请求取回全部。
- 改写 5 处仓储：`KvSubscriptionRepository.list`、`KvNodeRepository.getAll`、`KvNodeRepository.renameAll`、`KvRuleRepository.list`、`KvSessionRepository.listAll`。
- 新增 `NodeRepository.getBySubscriptions(ids)`，修掉 `config.service.applyCleanRulesNow` 循环内逐个读节点的第 6 处 N+1。
- 返回排序、损坏数据跳过、过期 session 清理等原有行为保持不变。
- 新增 4 个测试：批量读正确性、空键列表不触发请求、超过 100 键分片为 100/100/50、多订阅批量读。

## [2.27.5] - 2026-09-20

### 变更：NekoRay / Shadowrocket 输出改为 v2Ray 订阅格式

- NekoRay 原本已走 v2ray base64，无需改动。
- Shadowrocket 输出从私有链接格式改为 v2Ray 订阅（base64），与 v2ray/v2rayNG/NekoRay 统一；文件名 `shadowrocket.conf` → `shadowrocket.txt`。
- `src/generator/shadowrocket.ts` 已无调用点（孤儿），保留待砍除。

## [2.27.4] - 2026-09-20

### 修复：节点名字清洗应用到所有配置输出

- **根因**：`node-to-url.ts` 对带 `originalUrl` 的节点整链直出原链接（参数零丢失），且重建路径优先用 `metadata.originalName`——两个位置都绕过了 `applyCleanRules` 只改 `node.name` 的清洗结果，导致 v2ray/v2rayNG/nekoray（base64）输出沿用未清洗旧名；Mihomo 直接用 `node.name` 所以正常。
- **修复**：`nodeToUrl` 保留原链接全部参数/加密，但名字片段用清洗后的 `node.name` 覆盖；重建路径 `originalName || name` 全部改为 `name`。
- `generateBase64Config` 补 `makeUniqueNames` 去重（v2ray/v2rayNG/nekoray 全走此入口）。
- 新增 2 个回归测试（base64 去重 + originalUrl 名字片段覆盖）。

## [2.27.3] - 2026-09-20

### Mihomo 策略组默认值与顺序（按分流页面）

- **默认切换值调整**（对齐用户最新指令）：
  - AI 平台：手动切换 → **美国地理组**
  - GitHub：手动切换 → 自动选择
  - Google服务：手动切换 → DIRECT
  - YouTube：手动切换 → 自动选择
  - 微软服务：自动选择 → DIRECT
  - 游戏平台：手动切换 → DIRECT
  - 漏网之鱼：手动切换 → 自动选择
- **整组顺位改为与分流页面（RULE_GROUPS）顺序一致**：顶层切换组（节点选择/手动切换/自动选择）→ 业务组（用户规则/广告拦截/AI 平台/YouTube/GitHub/Google服务/微软服务/苹果服务/社交/国外媒体/加密货币/游戏平台）→ 漏网之鱼 → GLOBAL → 地理组
- `src/generator/mihomo.ts`：`groupDefaults` 调整 + AI 默认取美国组实际名 + 末尾 `PANEL_ORDER` 稳定排序

## [2.27.2] - 2026-09-20

### 移除 Surge / Loon / Quantumult X 三种输出格式

- 按用户要求「砍掉不做了」，彻底删除，不保留
- `src/generator/` 删除 `surge.ts`、`loon.ts`、`quantumultx.ts` 三个生成器
- `config.service.ts`：`OutputFormat`、`FORMAT_META`、生成 switch 删除 3 个分支
- `routes.ts`：`/api/sub/` 允许格式数组删除 3 项
- `public/index.html`：两个格式下拉 `<select>`、输出卡片分组、下载文件名表各删除 3 项
- `rule-format-mapping.ts`：删除 blackmatrix7 整套死代码（106 行映射表 + 3 个 URL 函数 + 2 个映射查询函数 + 过滤函数）—— 该表仅被这三个客户端使用
- 测试同步删 3 import + 6 用例；文档 `docs/rules-sort-current.md` 更新客户端清单
- 结论：**此后仅 mihomo 一种输出携带分流规则**，其余（sing-box / v2ray / v2rayn / nekoray / shadowrocket）为纯节点输出

## [2.27.1] - 2026-09-19

### geox-url.mmdb 改用内核默认的 geoip.metadb

- 原指向 `country.mmdb`（GeoLite2-Country，官方文档示例地址），现改为 `geoip.metadb`
- 理由：`geoip.metadb` 是 mihomo 自身的默认下载文件（`config.go` 的 `GeoXUrl.Mmdb`），含国家 + ASN，数据更全；改动后只换了下载域名，**内容与内核默认完全一致**，跨客户端兼容性最保险
- `geox-url.mmdb` 是单个字符串，无法同时填两个 URL；「多客户端兼容」由 **mmdb（metadb）+ geoip（.dat）两种格式各一项** 覆盖，两项均已配置
- 新 URL 已实测 HTTP 200；464 tests pass

## [2.27.0] - 2026-09-19

### AI 平台组补入四家点名规则并锁死

- 用户实测：`GOOGLE-GEMINI` / `PERPLEXITY` / `OPENAI` / `ANTHROPIC` 比聚合分类 `category-ai-!cn` 命中更稳，补入 AI 平台组
- 四条均为 `fixed`（组内锁死，只有「整组取消」生效，与其余内置规则一致），目标 `PROXY` → 出口「AI 平台」
- 输出为原生 `GEOSITE,<小写id>,AI 平台`，排在聚合分类之前；小写 id 对应 MetaCubeX `meta` 分支同名 `.mrs`（四个已实测 HTTP 200，大写形式 404）
- 行为变更：`ruleActionTarget` 对这四个 id 由「无归属 → 漏网之鱼」兜底改为命中「AI 平台」，相关断言同步更新
- 464 tests pass

## [2.26.9] - 2026-09-19

### 补齐 geox-url 为四项同源 CDN

v2.26.8 只覆盖了 `mmdb` 一项，而本项目 DNS 配置大量依赖 `geosite:`（`nameserver-policy` / `fake-ip-filter` 里的 `geosite:cn`、`geosite:private`、`geosite:geolocation-!cn` 等）。若客户端内核工作目录里连 `GeoSite.dat` 都没有，会退回内核默认源下载：

```
https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat
```

内核的四个默认 geox 源**全部指向 github.com**（已核对 `config/config.go`），国内裸内核/路由器首次启动经常下载超时。

现补齐为四项同源 jsdelivr CDN：

```yaml
geox-url:
  geoip:   "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"
  geosite: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"
  mmdb:    "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb"
  asn:     "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb"
```

四个地址均已实测 HTTP 200。该地址即官方文档「自定 GEO 下载地址」一节的示例写法。

**说明：** `geox-url` 只是一张 URL 对照表，**不会主动下载任何文件**——内核仅在自身工作目录缺失对应文件时才按此表获取（`component/geodata/init.go` 以 `os.Stat` 判断）。因此对已预置 Geo 文件的成品客户端（OpenClash / Nikki / Clash Verge 等）零影响、零额外开销，只是为缺失场景铺好国内可达的管道。

## [2.26.8] - 2026-09-19

### 吸收专业配置基础层：geox-url / ntp / tun / sniffer / dns + 连接调优

按用户指令，将专业配置（nikki / OpenClash 官方内核通用版）的基础层**完整硬编码**进 mihomo 输出，所有客户端开箱即得，无需用户手动改配置。

**新增输出块：**

| 块 | 内容 | 作用 |
|---|---|---|
| `geox-url` | MetaCubeX `country.mmdb`（jsdelivr） | 提供 GeoIP 数据库下载源（fallback-filter 依赖） |
| `ntp` | `enable` + `write-to-system` | 时间同步，证书校验/节点握手依赖准确时钟 |
| `tun` | `stack: mixed`、`dns-hijack`、`auto-route`、`auto-redirect`、`auto-detect-interface` | 系统级接管，配合 zashboard 等桌面端 |
| `sniffer` | HTTP/TLS/QUIC 端口 + `parse-pure-ip` + `skip-domain` | 嗅探真实域名，防 IP 直连绕过分流 |
| `dns` | fake-ip + ARC 缓存 + 国内/非国内双路解析 | 国内域名走阿里/腾讯 DoH，非国内走 8.8.8.8（经代理组） |

**同时吸收连接调优字段：** `unified-delay`（统一延迟，测速扣掉 TCP 握手耗时）、`tcp-concurrent`（多 IP 并发连接取最快）、`profile.store-selected`（记住手动选的策略组）、`profile.store-fake-ip`（持久化 fake-ip 映射）。

> 上述 4 项曾于 v2.12.2 按指令移除，本次按用户最新指令恢复。

**三处适配（不能照抄专业配置）：**

1. **DNS 引用的第三方 rule-set 替换为原生 geosite** — 专业配置的 `fakeipfilter_cn` / `fakeipfilter_!cn` 来自 qichiyuhub 第三方规则集，本项目不引入外部依赖，改用 MetaCubeX 原生快捷式：`geosite:cn,private,microsoft@cn,apple@cn,steam@cn`（国内解析）与 `geosite:geolocation-!cn`（代理解析）。
2. **TUN 的 `route-exclude-address-set` 改用原生 `GEOIP,CN`** — 专业配置引用 `cn_ip` rule-provider，本项目使用 mihomo 内置 GEOIP,CN，无需额外规则集。
3. **DNS 走代理的组名改为 `漏网之鱼`** — 专业配置的 `#默认代理` 在本项目不存在（项目兜底组名为 `漏网之鱼`），照抄会导致 mihomo 加载时报「找不到代理组」。

**明确不吸收：** `external-controller` / `secret` / `external-ui`（zashboard，控制 API 裸开在 `0.0.0.0` 且无密码，生成分发配置中存在安全风险）、`authentication`（明文口令写进 URL 分发的配置）、`bind-address`（默认即 `*`）、`proxy-providers`（本项目自身即订阅生成器，节点内联）。

## [2.26.7] - 2026-09-19

### 修复 GitHub 策略组图标不显示

Orz-3/mini 图标库 **无 GitHub 图标**（`Color/GitHub.png` → 404），导致 mihomo 客户端里 GitHub 组图标空白。

改用 Koolson/Qure 图标库的官方 GitHub 图标（同一作者，mihomo/Clash 通用）：

```
https://raw.githubusercontent.com/Koolson/Qure/refs/heads/master/IconSet/Color/GitHub.png
```

图标模板同步支持完整 URL（`groupIconMap` 值以 `http` 开头则直接使用，不再强制拼 Orz-3 前缀）。

已批量验证其余 8 个图标（Microsoft/Apple/GAME/OpenAI/Telegram/Manual/Google/YouTube）均 200 可用，仅 GitHub 一处缺失。网页分流规则页图标为 emoji（🐙），不受影响。

- 测试 **462/462 通过**。

## [2.26.6] - 2026-09-19

### GitHub 组前移至 Google 之前 + TikTok/Netflix 归入国外媒体组 + TikTok QUIC 例外

**① GitHub 移到 Google 之前**

组顺序修正为 `… → AI → YouTube → **GitHub** → Google → 微软 → …`。GitHub 域名先命中本组，不再被 Google 组或漏网之鱼截走（用户 2026-09-19 纠正）。

**② TikTok / Netflix 归入国外媒体组（新增两条锁死规则）**

复核发现国外媒体组原先只有 `category-media` —— 它是**新闻媒体站聚合**（BBC/CNN/NYT/NHK/RTHK 等 178 条），**并不含流媒体**。因此 TikTok / Netflix 的域名流量此前一路漏到最后的 `MATCH` 兜底，实际未被归组。

本次在媒体组补齐两条锁死域名规则：
- `GEOSITE,netflix,国外媒体`（配已有的 `GEOIP,netflix` IP 兜底）
- `GEOSITE,tiktok,国外媒体`

**③ TikTok QUIC 例外（①c，硬编码）**

全局 QUIC 防泄漏 `AND,((GEOSITE,geolocation-!cn),(DST-PORT,443),(NETWORK,UDP)),REJECT` 会拒绝所有非国内域名的 UDP 443。TikTok 重度依赖 QUIC，TCP 回退不畅时表现为「连不上」。现于该拦截**之前**加一条例外：

```
AND,((GEOSITE,tiktok),(DST-PORT,443),(NETWORK,UDP)),国外媒体
```

媒体组被整组取消时该例外不输出（避免引用不存在的策略组）。iOS 端 TikTok 仍有 SIM 卡区域锁限制，与本配置无关。

**关于 TikTok IP 规则**：MetaCubeX **无 `geoip:tiktok`**（404），`geoip:bytedance` 同样不存在，故 TikTok 只有域名规则、无 IP 兜底（专业配置亦然，仅含 `tiktok_domain`）。

- 测试 **462/462 通过**（新增 TikTok/Netflix 归组断言，顺序断言同步 ①c）。

## [2.26.5] - 2026-09-19

### 页面对齐工程：分流规则页按专业配置组顺序重构 + 锁死模型

> 用户提供专业 mihomo 配置，要求分流规则页完整按专业配置的**组顺序 + 规则顺序**展示，组内规则**锁死**（只能整组开关），并吸收 **YouTube 独立组**、**GitHub 域名组**，将 **谷歌 FCM** 并入国内直连组。

**① 页面 = 输出 = 匹配优先级（单一声明源）**

规则页自上而下顺序改为与生成配置完全一致：内网/QUIC(硬) → 用户规则 → 广告拦截 → 国内直连 → AI → **YouTube** → Google → **GitHub** → 微软 → 苹果 → 社交 → 国外媒体 → 加密货币 → 游戏 → GEOIP,CN(硬) → MATCH(硬)。GEOIP IP 兜底（google/telegram/netflix）随各自组输出，不再统一沉底。`buildRules` 由分阶段拼接改为**严格按 RULE_GROUPS 数组顺序展平**。

**② 锁死模型：内置规则只能整组开关**

新增 `disabled_groups` KV：规则页内置规则全部锁死（🔒），不再逐条勾选；整组可开关，关闭的组不输出任何规则（含其内置项与自定义项）。新增接口 `GET/PUT /api/rules/groups/disabled`。前端重写渲染逻辑，快速预设改为整组开关。

**③ YouTube 独立组（Google 之前）**

新建 `youtube` 组（`GEOSITE,youtube`，域名单条，置于 Google 之前），解决 YouTube 域名被 Google 组截留后余量落入漏网之鱼的问题。专业配置同样只含域名规则，无 youtube IP 段（视频流量走 googlevideo.com 已含其中）。

**④ GitHub 独立组**

新建 `github` 组（`GEOSITE,github`），吸收专业配置的 GitHub 域名分流。

**⑤ 谷歌 FCM 并入国内直连组（走 DIRECT）**

`googlefcm`（`mtalk*.google.com` 推送服务器，国内可直连）撤出独立策略组，并入国内直连组走 DIRECT —— 与中国主流配置文件一致（用户拍板：通用多应用规则放 CN 直连组，不占独立策略组）。

**⑥ 策略组净增：YouTube / GitHub**

- 自定义规则仍可逐条勾选/删除，且排在其所属组的位置（不变）。
- 新增 `youtube`/`github` 策略组；移除 `谷歌FCM` 策略组图标与默认。
- **测试 461/461 通过**（更新了顺序断言：google 在 media 前、geoip 随组输出在 GEOIP,CN 前、googlefcm 走 DIRECT）。

## [2.26.3] - 2026-09-19

### 新增：吸收专业配置的规则命中排序（防泄漏 + 区域细分 + IP 兜底）

> 用户提供了一份专业 mihomo 配置，要求吸收其规则层面的优势，同时保持「分流规则」页面可人工管理。
> 本次吸收三项（纯输出结构差异「域名全前 / IP 全后」暂不动）。

**① 新增 ①b QUIC 防泄漏层（硬编码，不可关闭）**

`buildRules` 紧随内网防代理之后输出：

```yaml
- AND,((GEOSITE,geolocation-!cn),(DST-PORT,443),(NETWORK,UDP)),REJECT
```

非国内域名走 UDP 443（QUIC）直接拒绝，强制回落 TCP 走代理——防止浏览器用 QUIC 绕过代理规则直连、泄露真实 IP。这是专业配置的核心防泄露手段。写法依据 mihomo 官方文档 `AND,((规则),(规则),(规则)),动作`，位置放在内网防代理之后以保证内网流量不被劫持。

**② 新增 @cn 区域细分规则（可勾选）**

「国内直连」组新增两条，必须排在同名国际版规则之前，否则会先命中国际版走代理：

| 规则 | 标签 | 出口 |
|---|---|---|
| `GEOSITE,microsoft@cn` | 微软服务(中国区) | DIRECT |
| `GEOSITE,steam@cn` | Steam 中国区 | DIRECT |

**③ 新增 GEOIP IP 段兜底（可勾选）**

吸收专业配置「IP 规则兜底」思路，补齐纯 IP 访问（无域名）时的漏网场景：

| 规则 | 所属组 |
|---|---|
| `GEOIP,telegram` | 社交 |
| `GEOIP,netflix` | 国外媒体 |

同时把原先只针对 google 的 ⑬b 特判**泛化为通用循环**：所有 `tag === 'geoip'` 的勾选项统一在 `GEOIP,CN,DIRECT` 之后、`MATCH` 之前输出，新增 geoip 规则无需再改代码。

**④ 分流规则页面：组顺序显式化**

- 每个大组标题前新增**序号徽章**（1、2、3…），把「组顺序 = 输出匹配顺序」这个隐含事实显式化——这正是上一版自定义规则归组 bug 的认知根源。
- 页面说明改写为：勾选规则集，生成订阅时按本页自上而下的顺序写入分流规则，顺序即匹配优先级，先命中生效；归入某组的自定义规则就排在该组的位置。

**同步修正**：`china-direct` 组的 ④ 输出循环原先不检查勾选状态（假设全组都是承重墙 `fixed`），新增可勾选的 @cn 细分项后改为 `fixed` 无条件输出、非 fixed 项按勾选输出。

**规则总数**：34 条（原 29 条 + 5）。

### 验证

- `npm run lint` 0 error，`npx tsc --noEmit` 通过
- **461/461** 测试通过（新增 1 条规则排序回归测试）
- 实测生成顺序：① 内网 → ①b QUIC → ② 用户规则 → ③ 广告 → ④ 国内直连(含 @cn 细分) → ⑤ 业务组 → ⑬ GEOIP,CN → ⑬b GEOIP 兜底(telegram/netflix/google) → MATCH

## [2.26.4] - 2026-09-19

### 文档订正

订正 2.26.3 变更日志中的规则条数统计：全选状态下实际输出 **34 条**（原 29 条 + 新增 5 条），
上一版误写为「33 条（原 30 条 + 3）」。新增项为 QUIC 防泄漏 1 条、@cn 细分 2 条、GEOIP IP 兜底 2 条。
**仅文档订正，无代码变更，配置输出与 2.26.3 完全一致。**

## [2.26.2] - 2026-09-07

### 修复：自定义分流规则归组后未按组排序位置输出

> 用户反馈：分流规则页面自定义的规则归入「国外媒体」组后，输出配置里被统一置顶到最前，
> 没有按分流规则的排列顺序排到国外媒体组的位置。

**根因**：`buildRules` 里所有 custom 规则被「② 用户规则」整块在 `GEOSITE,private,DIRECT` 之后统一置顶输出，不区分所属规则组。

**修复**：
- 归「用户规则」组的 custom 仍紧随 private 之后最前（保留 2026-09-02 拍板行为）
- 归其它规则组（国外媒体等）的 custom **随所属组位置输出**——在 ⑤ 业务分类按 RULE_GROUPS 顺序遍历时落在对应组位置
- ⑤ 循环跳过 user 组避免重复；orphan 兜底跳过 custom 避免重复

**测试**：+1 条（rule-order.test.ts 验证归 media 组 custom 落在 category-media 之后）；460/460 全过。

### 仪表盘 CF 卡片合并 KV 写统计（用户要求：同账号同表显示）

> v2.26.0 KV 卡片是独立一张，用户实测后要求合并到同账号 CF 请求卡里——
> 「希望这个 KV 计数是跟同账号上面的请求统计在一个表格里面，不是分开」。

#### 改动
- 后端：`/api/cf-usage` 改为每个账户**并发查**请求量 + KV 写（`Promise.all`），KV 数据挂到账户对象的 `kv` 字段返回
- 前端：删除独立 KV 卡片 + `kvUsageSection` DOM + `loadKVUsageDashboard` JS；`renderCFUsageCard` 改为左右两栏布局
  - 左半：今日请求量 1,000,000 / 100,000  + Pages/Workers 拆分
  - 右半：今日 KV 写 N / 1,000 + 读/删/列表 拆分
  - 中间细分割线
- 标题统一为「📊 Cloudflare 统计（今日）」
- 任一查询失败不影响另一半显示（互相独立）
- 性能：原 1 次 GraphQL 调 + 1 次 = 2 次/账户，现在仍是 2 次/账户但用 `Promise.all` 并发，无额外延迟

#### 测试
- 测试基线 **459** 不变（本次仅合并 UI + 后端 endpoint 重构，fetchKVUsage 单元测试保留）

## [2.26.0] - 2026-09-05

### 仪表盘新增「KV 写次数统计（今日）」卡片

> 用户 2026-09-05 实测「每天免费 KV 写 1000 次被耗光、登录失败」后要求在仪表盘做进度条提示。
> 复用现有 CF 账户 token，**零新增配置**。

#### 核心改动
- `cf-usage.service.ts` 新增 `fetchKVUsage(accountId, token)`：调 CF GraphQL `kvOperationsAdaptiveGroups`
  按 `actionType`（write/read/delete/list）维度聚合今日次数
- `routes.ts` 新增 `GET /api/kv-usage`（requireAuth）：复用首个启用 CF 账户的 token 查 KV 写次数
- 前端：仪表盘加 `💾 KV 写次数统计（今日）` 卡片（与 CF 卡片同款横向长条+渐变进度条），80% 黄/90% 红警示
- 底部读/删/列表 3 项辅助统计；超过 1000 自动 clamp 到 100% 不溢出
- 无 CF 账户 → 卡片自动隐藏（不打扰用户）
- **零配置**：用户已配置 CF 账户则直接生效，无需新建任何 key/token

#### 限额对照
- CF Workers 免费版 KV 写：**1,000 次/天**（超出即挂，v2.25.0 GeoRetry 门闩就是为此加的）
- CF Workers 免费版 KV 读：**100,000 次/天**（远宽松，仅 write 进度条主显示）

#### 测试
- 新增 `tests/services/kv-usage.test.ts` 7 用例：4 种 actionType 解析、空数据 0、缺失字段降级、HTTP 错、GraphQL 错、无账户、未知 actionType 忽略
- 测试基线：452 → **459**

## [2.25.0] - 2026-09-05

### 修复 GeoRetry 每天耗尽 KV 免费写额度（用户实测「登录不了、KV 写次数不够」）

> **根因**：`* * * * *` 每分钟 cron 永久跑 GeoRetry，即使**所有 IP 已全部识别**，
> 依然全量 `getAll()` + `filterUnlocatedServers`，发现 `unlocated.length===0` 后
> 仍写 `geo_pending_retry={count:0}` + `geo_pending_result=[]` 两个 setting，
> 每天 **1440 分钟 × 2 次写 ≈ 2880 次无意义 KV 写**，再加登录限流 `createKvRateLimit`
> 也写 KV，直接吃光 CF 免费每天 1000 次写额度 → 登录/限流全挂。

#### 核心改动：任务门闩（active 哨兵）
- `geo_pending_retry` 结构升级为 `{ ts, count, active }`，新增 `active` 布尔门闩
- **正常态（无未识别 IP）**：cron 读一次 `active=false` → **直接 return，0 KV 写、不跑 getAll、不查 IP**
- **发现未识别 IP**（订阅更新/每日预热/手动 geo-redetect 三入口）→ `activateGeoRetry` 拨 `active=true` 唤醒 cron
- 每分钟重试；全部识别成功 → `deactivateGeoRetry` 置 `active=false` 回到睡眠
- 连续重试 ≥10 次仍未识别 → 置 `active=false` 停止，保留剩 IP 供前端提示「建议检查节点正确性」

#### 效果
- 健康态 KV 写：**≈0/天**（原来 ~2880/天）；读=每分钟 1 次 gate（1440/天，读额度宽松）
- 前向兼容：旧格式 `{ts,count}` 无 active 字段 → 视为 active=false（升级后门闩默认闭合）

#### 其他
- 每日订阅自动更新 IP 地理预热的 cache 统一走 `repos.settings`（`setting:` 前缀，与手动更新/前端统计同口径），修正此前裸 `kv.get/put` 前缀不一致
- 新增 `tests/services/ip-geo-gate.test.ts` 6 用例。测试基线：446 → **452**

## [2.24.0] - 2026-09-04

### 节点聚合格式全面补全

> 无分流规则格式（Sing-box / Shadowrocket / Base64）按官方参数表全面补全，
> 覆盖全部协议（Hysteria2 / TUIC / WireGuard / AnyTLS / VMess / VLESS / Trojan / SS），
> 有参数输出，无参数跳过。测试基线：428 → **446**。

#### 变更
- `singbox.ts`：重写全部协议生成逻辑，新增 Hysteria2 / TUIC / WireGuard / AnyTLS / Shadowsocks 完整字段
- `shadowrocket.ts`：重写，独立实现所有协议（不再依赖 Surge），新增 Hysteria2 / TUIC / WireGuard
- `config.service.ts`：singbox/shadowrocket 调用去掉 rules/groups 参数（纯节点聚合）
- 新增测试：singbox 9 个新用例 + shadowrocket 10 个新用例

### UI
- 输出配置页面增加分组标签：分流配置（含策略组+规则）/ 节点聚合（无分流规则）

### 安全加固（Perplexity 审查修复）

> 依据 Perplexity 对项目安全审查结论修复。测试基线：423 → **428**。

**SSRF IP 校验强化（核心）**
- `isBlockedIp` 从字符串前缀匹配改为**数值 CIDR 判断**，覆盖全部保留网段：
  - 新增 CGNAT `100.64.0.0/10`、基准测试 `198.18.0.0/15`、IETF PI `192.0.0.0/24`、TEST-NET-1/2/3、组播 `224.0.0.0/4`、保留 `240.0.0.0/4`
- 拦截**非标准 IPv4 写法**：段值 >255（如 `999.1.1.1`）、IPv4-mapped IPv6（`::ffff:127.0.0.1`、`::ffff:10.0.0.1`）
- IPv6 保留段用字符串前缀（`::`、`::1`、`fc00:`、`fd00:`、`fe80~feb`、`ff00:`）

**地理定位 isPureIP 补段值校验**
- `isPureIP` 现在每段需 ≤255，避免 `2130706433` 十进制 / `999.1.1.1` 等非标准 IP 被当作域名去真解析

**订阅更新接口加 KV 限流**
- `POST /api/subscriptions/:id/update` 复用敏感操作 KV 限流（5 次/分），防资源滥用

**订阅更新顺序微调**
- 先写节点缓存，再更新订阅状态为 active——避免「状态已 active 但节点写入失败」的中间态

**清洗规则输入长度限制**
- `pattern` ≤256 字符、`replacement` ≤512 字符，防规则过大造成 CPU 消耗/超大配置

**新增 SSRF 测试（5 个用例）**
- CGNAT / benchmark / test-net / 组播 / 保留段 / 段值非法 / IPv4-mapped IPv6

## [2.22.0] - 2026-09-04

### 安全加固 + KV 分页（Codex 审查修复）

> 依据 Codex 对项目安全审查结论修复。测试基线：404 → 407 → **423**。

**KV `list()` 分页（🔴 关键修复）**
- `KvAdapter.list()` 改用 cursor 循环拉全量，不再只读第一页（limit 1000）
- 修复 >1000 条节点/订阅/规则时静默漏数据的问题（直接导致「1000+ 节点后生成配置不全」）
- 影响：`nodes.getAll()`、`subscriptions.list()`、`sessions.listAll()` 等所有依赖 `list()` 的仓储

**登录/敏感接口限流切到 KV（跨实例共享）**
- 登录（10 次/分）、改密/改用户名（5 次/分）由单实例内存计数器改为 KV 限流
- `createKvRateLimit` 已存在但未启用，现在 `createApp` 注入 `storage` 后自动启用
- 未注入 storage（如测试）时自动回退到内存限流，保持测试简单
- 生产环境多实例并发下限流不再形同虚设

**订阅令牌恒定时间比较**
- `/sub/:format/:token` 的 `sub_key` 比较由 `===` 改为 `constantTimeEqual`（逐字节异或）
- 防时序侧信道（Cloudflare Workers 无 crypto.subtle，自实现）

**executionCtx 空值防御**
- 订阅更新后的 `c.executionCtx?.waitUntil(...)` 加空值防御，防 Hono 未传第三参时抛 `'This context has no ExecutionContext'` 致 update 502

**升级检测加缓存**
- `/api/meta/check-upgrade` 加 6h 内存缓存，避免每次请求外呼 GitHub API（无鉴权端点防被作匿名流量放大器）

**新增鉴权矩阵测试（16 个用例）**
- 未登录访问受保护端点（订阅/节点/规则/仪表盘/设置/密码/用户名）→ 应 401
- 公开端点（health/meta/login）→ 不应 401
- 正常登录后访问受保护端点 → 200
- /sub 订阅令牌校验正反用例

## [2.21.0] - 2026-09-04

### 安全：密码改密后会话吊销机制（passwordVersion）

**修复：** v2.21.0 之前的版本，修改管理密码后旧登录会话仍然有效（无法吊销）。

- **Session 模型**新增 `passwordVersion` 字段（签发时携带当前密码版本号）
- **`setting:password_version`** 新 KV 键：存储当前密码哈希的版本号，初始化为 `0`
- **`changePassword`** 行为：改密时递增版本号 + 主动删除所有旧 session，旧 token 立即失效
- **`validateSession`** 行为：检查 session 的 `passwordVersion` 是否与当前版本一致，不一致则自动清理并返回 false
- **向后兼容**：首次启动若 `setting:password_version` 不存在，自动写入 `0`，不破坏现有部署
- **测试**：新增 3 个测试用例验证密码版本失效逻辑；全部 407 测试通过

## [2.19.5] - 2026-09-03

### 修改：三组策略组 default-selected 调整

- **微软服务**：`default-selected` 从 `DIRECT` 改为 `自动选择`（用户需求：微软服务走自动选择）
- **漏网之鱼**：`default-selected` 从 `自动选择` 改为 `手动切换`（用户需求：兜底组用手动切换）
- **GLOBAL**：`default-selected` 从 `DIRECT` 改为 `自动选择`（用户需求：全局默认自动选择）
- 同步更新 `tests/verify-v31.test.ts`、`tests/generator/mihomo.test.ts` 断言为新值
- 404 测试全绿，lint/tsc/build 全绿

## [2.19.4] - 2026-09-03

### 修改：自动选择组 proxies 从扁平节点名改为国家地理组名

- `src/generator/mihomo.ts` 的「自动选择」策略组（url-test 类型）`proxies` 由 `allGeoNodes`（扁平节点名数组）改为 `geoGroupNames`（地理组名数组）
- 效果：url-test 测速对象从「具体节点」变为「有节点的国家地理组」——自动选择会按地理组（🇭🇰 香港 / 🇯🇵 日本 / 🇸🇬 新加坡 等）整体测速并选出最优地区，而不是在所有节点里挑最快单节点
- 兜底逻辑保留：无节点时 `proxies: ['DIRECT']`
- 不影响「节点选择」组（其 proxies 本来就是 `['自动选择', ...geoGroupNames, ...]`，已经按地理组划分）
- 现有 404 测试仅断言「自动选择」组存在性，未断言具体 proxies 内容，回归全绿，lint/tsc/build 全绿

## [2.19.3] - 2026-09-03

### 修改：Mihomo 配置输出 mixed-port 改 7893

- `src/generator/mihomo.ts` 硬编码段 `mixed-port` 由 7890 改为 7893，与旁路由（192.168.2.5）的 Mixed 端口对齐
- `port: 7890` / `socks-port: 7891` / `allow-lan: true` / `mode: Rule` / `log-level: info` 不变
- 现存 404 测试无相关 mixed-port 断言，回归测试全绿，lint/tsc/build 全绿

## [2.19.2] - 2026-09-03

### 移除：广告拦截组 geosite:tracker 规则

- `src/data/metacubex-rules.ts` 的 `ads` 组原本包含 2 条固定规则：`category-ads-all`（广告拦截通用合集）和 `tracker`（追踪器）。本次删除 `tracker`，仅保留 `category-ads-all` 一条
- 效果：
  - 分流规则页面的「广告拦截」组不再显示「追踪器(Tracker)」选项（前端从同一数据源渲染 `adsGroup.items`）
  - `ruleSetLine` 不再为 `tracker` 输出原生 `GEOSITE,tracker,广告拦截` 行（因为 `buildRules` 遍历 ads 组时该项已不存在）
  - Mihomo 配置 `rules` 段不再包含 `GEOSITE,tracker,广告拦截`
- 同步修正 `src/generator/rule-providers.ts` 的注释文案（去掉 "TRACKER" 字样，避免误导后续维护者）
- 测试 404 全绿，lint/tsc/build 全绿

## [2.19.1] - 2026-09-02

### 新增：未识别国家码自动重试 + 界面提示（替代手动反复点重新检测）

**背景**：部分节点首次查询国家码失败后成为「未识别」，此前只能等每日定时更新或手动点「重新检测」才重试。本次改为自动周期重试，识别率达到零残留前持续尝试。

**逻辑（完全按批量模式，不采用单 IP）**
- wrangler.toml 新增每分钟 Cron `* * * * *`，scheduled handler 进入 geo 重试分支
- 每分钟检查：取全量节点 server，`filterUnlocatedServers` 筛出未识别 IP（**所有未识别都在池子里，全量批量重查**）
- 重查复用 `prewarmIpGeo`/`batchQuery` 批量接口（每次最多 100 IP，batchQuery 内部 15 次/分钟限流兜底，分钟吞吐 1500 IP）
- **连续重试 10 次**：每次 cron 发现仍有未识别则计数 +1；某次查完清零则重置；计到 10 次仍未清空则停止自动重试
- 停止后剩余 IP 写入 KV `setting:geo_pending_result`，供前端展示

**界面提示**
- 节点列表页新增提示横幅（红色左边线）：连续重试 10 次后仍剩的未识别 IP 逐个列出，并提示「建议检查这些节点的 IP/域名是否正确」
- 新增接口 `GET /api/nodes/geo-pending`（需认证）返回 `{ retryCount, unlocatedServers[], lastRetryTs, resultTs }`，前端 `loadNodes` 时自动拉取显示
- 查完清零自动隐藏横幅，不打扰

### 测试
- 新增 `tests/integration/geo-pending-api.test.ts`（5 用例）：空状态 / 10次提示 / 重试中 / 未登录401 / 损坏KV降级
- 全量 404 测试通过，lint / tsc / build 全绿

## [2.19.0] - 2026-09-02

### 界面视觉整体升级（设计系统精修）

**色彩与阴影**
- 新增 `--accent-soft` / `--accent-soft-d` 语义色（悬停/hover 统一用主题色，去除硬编码 rgba）
- 阴影系统重做：双层阴影（1px 贴边 + 大范围柔和扩散），暗色主题独立调参
- 新增 `--radius` / `--radius-sm` / `--radius-lg` 圆角变量，全站组件统一引用

**组件精修**
- 侧边栏导航：激活态改实心主色胶囊 + 光晕阴影，悬停用语义色
- 删除 `.nav-tab` 重复定义块（旧样式覆盖问题）
- 按钮：`font-weight` 500、点击 `scale(0.97)` 按压反馈、缓动曲线统一 cubic-bezier(0.16,1,0.3,1)
- 卡片：hover 阴影加深过渡，标题字距收紧
- 表单：focus 光圈改 3px 主题语义色
- 表格行悬停改主题语义色
- 登录页：渐变角度 135°、光斑透明度调低更雅致、卡片加白色描边
- 弹窗：圆角升级 12px、阴影更柔
- 正文字号 19→18px、行高 1.5、字距收紧，更接近现代 SaaS 控制台

## [2.18.1] - 2026-09-02

### 修复：CF 请求统计卡片仅仪表盘显示 + 横向长条布局

- 统计区块 `cfUsageSection` 移入 `page-dashboard` 容器内 —— 之前放在 dashboard 外导致**所有页面都显示**，现仅仪表盘页显示（其他页面随 `.page` 隐藏）
- 卡片改为**横向长条**：左侧账户名 + 今日请求量 + 百分比，右侧进度条 + Pages/Workers 拆分，`flex-wrap` 自适应窄屏
- 进度条区域纵向（多账户时上下堆叠）与仪表盘小卡片左右对齐，宽度一致

## [2.18.0] - 2026-09-02

### 新增：Cloudflare 请求数统计（仪表盘显示今日请求量）

借鉴 cmliu/edgetunnel 的 `getCloudflareUsage`（CF GraphQL 取今日请求数）。

**功能**
- **设置页**新增「📊 Cloudflare 请求统计」卡片：可添加最多 **3** 个 CF 账户（自定义名 + Account ID + API Token），支持编辑/删除，Account ID 掩码显示
- **仪表盘**新增「📊 Cloudflare 请求数统计（今日）」区块：每个账户一张卡片，显示今日请求 `total/100000` + 百分比 + 进度条 + Pages/Workers 拆分；>80% 变红、>90% 深红警示
- 未配置任何账户时仪表盘隐藏该区块，显示跳转「前往设置」链接

**统计口径**
- 周期：今日 0 点（UTC = 北京时间 8 点）→ 当前
- 上限：100000（CF Workers 免费额度）
- 只支持 API Token 认证（不用 Global API Key）

**安全**
- API Token 仅存 KV、仅服务端调 CF GraphQL 时使用
- `GET /api/cf-usage` 与 `/cf-usage/accounts` **不回传 token**，前端只见自定义名 + 掩码 Account ID
- 新增时必填 token；编辑时 token 留空 = 保留原值

**后端接口**
- `GET /api/cf-usage`（鉴权）：逐账户并发调 CF GraphQL，返回今日请求数数组
- `GET/POST /api/cf-usage/accounts`、`DELETE /api/cf-usage/accounts/:id`：账户 CRUD
- `POST /api/cf-usage/test`：测试单账户连接（验证 token/accountId）
- 新增 `src/services/cf-usage.service.ts`：`fetchCfUsage` 封装 GraphQL query + 账户持久化

**测试**：新增 8 用例（fetchCfUsage 解析/空/HTTP错/GraphQL错 + config CRUD/上限3/编辑保留token/删除），399 全过。

## [2.17.0] - 2026-09-02

### 修复：订阅更新返回 502 "This context has no ExecutionContext"

- **根因**：v2.16.0 把 IP 地理预填充移到 `c.executionCtx.waitUntil()`，但 `index.ts` 的 `app.fetch(request, env)` 只传了两个参数——Hono v4 需要第三参 `executionCtx` 才会填充 `c.executionCtx`。未传时 `waitUntil` 抛 "This context has no ExecutionContext"，导致整个 update 接口 502，前端弹「更新失败」。
- **修复**：`index.ts` fetch 签名加第三参 `executionCtx: ExecutionContext` 并透传给 `app.fetch(request, env, executionCtx)`。
- 说明：用户反馈「国家检测成功但订阅更新还是提示」——geo-redetect 接口未用 executionCtx 所以正常；update 用了所以报错。本修复解决 update。

### 新增：大刷新/拉取操作居中进度条（订阅更新 / 重新检测国家码）

- 新增居中进度弹窗：标题 + 进度条 + 状态文字 + 计时（`00:00 / 02:00`）
- 非确定进度从 10% 缓慢爬升至 95%，示意「仍在跑」；真实完成时跳 100%
- **120s 长时限**（`c.executionCtx` 修复后 update 即时返回；进度条覆盖等待期）
- 硬性超时（120s+) → 进度条红色置满 + 显示「操作超时，请稍后重试」
- 请求侧 `AbortError` → 中文「请求超时，请重试」（替代英文原生 message）
- `updateSub` 与 `redetectGeo` 均接入，按钮带 loading 态防重复点

## [2.16.0] - 2026-09-02

### 性能修复：节点列表与订阅更新超时（实测根因）

**问题一：`GET /api/nodes` 实测 22.9s » 前端 15s 超时 → 弹「加载节点失败」/节点列表空白**
- 根因：`filterUnlocatedServers`（供 `/nodes` 统计 `geoUnlocated`）对每个节点 server **逐条串行**读 KV，节点数百个时轻松拖到 20s+
- 修复：改为分批并发（每批 20 个 `Promise.all`），逻辑不变，`/nodes` 预计降到 <1s

**问题二：`POST /api/subscriptions/:id/update` 实测 >40s » 15s 超时 → 弹「更新失败: signal is aborted without reason」**
- 根因：订阅更新后**同步**执行 `prewarmIpGeo`（逐批查 ip-api + 15次/min 限流），Edgetunnel 108 节点叠加拖超 40s；前端 AbortController 掐断后 catch 直接弹浏览器原生英文 message
- 修复①：`prewarmIpGeo` 移到 `c.executionCtx.waitUntil()` 后台执行，update 立即返回（逻辑不变，仅异步化）
- 修复②：前端 `api()` 捕获 `AbortError` 转友好中文「请求超时，请重试」
- 修复③：`api()` 支持 per-call `timeout`；订阅更新给 90s 预算（此时只等订阅本体抓取+解析，后台 prewarm 已异步）

**体验改善（前端）**
- 订阅更新按钮加 loading 态（⏳ 更新中 + 禁用）防重复点击
- `loadNodes()` 在途合并：同一时刻只允许一个 `/nodes` 请求在飞，避免切页/刷新连点并发打爆 KV

### 说明

- 未改变任何分流/策略组/规则逻辑，仅优化 KV 读取并发度与请求时序
- `filterUnlocatedServers` 分批并发是纯实现细节，行为与口径完全一致（已有测试覆盖，391 pass）

## [2.15.1] - 2026-09-02

### 修复：用户自定义规则删除按钮排版

- 垃圾桶 `🗑` 移到规则名字右边同一行（原在名字下方，因 `.rules-item` 是 2 列网格、删除 span 是第 3 个子项被换行）
- 修复：删除按钮移入 `.rule-label` 内，`.rule-label` 改 flex 行布局（主文字 + 删除按钮同行），删除按钮 `flex:none` 不收缩

## [2.15.0] - 2026-09-02

### 新增：Google服务 分流组（用户 2026-09-02 拍板）

- 分流规则页新增「Google服务」组，位置在「国外媒体」之后
- 组内 7 条规则（全部原生 GEOSITE/GEOIP 输出，默认在预设勾选、可取消）：
  - geosite: `google` / `google-gemini` / `google-deepmind` / `google-play` / `google-scholar` / `google-trust-services`
  - geoip: `google`（内部 id `google-geoip` 避开与 geosite:google 同名冲突）
- 该组加入全部 6 个快速预设（极简 / 极简+加密 / 标准 / 标准+加密 / 完全体 / 完全+加密）

### Mihomo 输出

- 新增「Google服务」固定策略组，放在国外媒体之后，`default-selected: 手动切换`
- `rules:` 段落：6 条 `GEOSITE,google*` 就近输出在国外媒体（⑧）之后；`geoip:google` 单独放 `GEOIP,CN,DIRECT`（⑬）之后作 IP 兜底（⑬b）
- `buildRules` step⑤ 跳过 geoip 项；orphan 去重跳过 geoip 项，避免用错误 id（google-geoip）重复输出

### UI

- 用户添加规则删除按钮：`✕` → 垃圾桶 `🗑`，位置移到规则标签后面（排版更整洁）

## [2.14.0] - 2026-09-02

### 变更：策略组默认出口（用户 2026-09-02 拍板）

- **手动切换** default-selected 取「美国」组第一个节点（本订阅为 `美国bob-bob@gmail.com`），无美国组则回退第一个地理节点
- **国外媒体** default-selected → `自动选择`（原 DIRECT）
- **AI 平台** default-selected → `手动切换`（原 DIRECT）
- **社交** default-selected → `自动选择`（原 DIRECT）
- **加密货币** default-selected → `🇹🇼 台湾`（原 DIRECT）
- **GLOBAL** 删除 `url: https://cp.cloudflare.com/generate_204`（GLOBAL 为 select，不需要测速）

### 调整：url-test 地理组参数排版（用户 2026-09-02 拍板）

- 自动生成的地理组（url-test）的 `url` / `interval` / `tolerance` 三个参数移到 `type: url-test` 正下方、`proxies` 之前，排版更清晰

### 调整：rules 段落用户规则顺序（用户 2026-09-02 拍板）

- 用户规则从「最前」移到 `- GEOSITE,private,DIRECT` 之后、广告拦截之前
- 优先级：① 内网防代理（lan + private）→ ② 用户规则 → ③ 广告拦截 …

## [2.13.1] - 2026-09-02

### 修复：用户规则组输出逻辑

- **用户规则组 default-selected 改为「手动切换」**（之前硬编码 `DIRECT`，用户添加规则后默认应能手动切换节点）
- **用户自定义规则统一走 GEOSITE 原生输出**（不再用 `RULE-SET` + `rule-providers` 方式），与 native 规则输出方式一致
- **修复自定义规则重复输出问题**：orphan 去重步骤现在跳过 custom 规则（已在 step ① 置顶输出），且 `matchedIds` 统一用小写匹配，避免大小写不一致导致重复

### 技术细节

- `ruleSetLine()`: `rule.native || rule.custom` → GEOSITE/GEOIP 原生输出
- `buildRuleProviders()`: 跳过 `rule.custom`，不生成 provider
- `buildRules()` orphan 步骤：`!r.custom && !matchedIds.has(r.id.toLowerCase())` 双重过滤
- `generateMihomoConfig()`: `nonNativeRules` 过滤加上 `!r.custom`

## [2.13.0] - 2026-09-01

### 新增：mihomo 配置输出恢复必要头部

- 在 `proxies:` 前硬编码输出 `port: 7890` / `socks-port: 7891` / `allow-lan: true` / `mode: Rule` / `log-level: info`，与硬编码规则集一起构成 Mihomo 完整可运行配置（v2.12.3 曾去除全部硬编码头字段，本次按用户指令恢复 5 行必要头部；`dns:` / `sniffer:` / `profile:` 三段仍保持去除状态）

### 变更：url-test 组参数整理

- **砍掉 `lazy: false`**（v2.12.9 引入，本次移除）
- **参数顺序调整**：`url` / `interval` / `tolerance` 移到 `type` 下方，便于阅读
- **测速地址统一**：`https://cp.cloudflare.com/generate_204` → `http://www.gstatic.com/generate_204`（与 v2.12.10+ geo 预填充阶段保持一致）
- **interval 统一为 300**（v2.12.8 之前 自动选择=1800、地理=300；v2.12.8 统一为 600；本次改回 300）
- **修复 GLOBAL / 手动切换 误带 `url` 问题**：这两类 select 组被错误地纳入 `urlTestGeoGroupNames`，加了 url 字段。Mihomo 校验拒绝 url-test 专属字段出现在 select 组。修复：剔除 GLOBAL 和 手动切换，只保留六国地理 url-test 组

### 测试

- `tests/generator/mihomo.test.ts`：4 处断言反向更新（旧断言验 v2.12.2 移除头部，现改为验 v2.13.0 恢复头部；旧断言验 v2.12.2 移 DNS/sniffer，现改为验 v2.13.0 仍无 DNS/sniffer + 有 5 行头部）
- `tests/verify-v31.test.ts`：1 处注释更新
- 新增 1 个参考文档 `references/mihomo-hardcode-rules.md` 记录 v2.13.0 完整规范与历史对比表
- **测试基线保持 390 tests**
- 不新增 `mixed-port` / `external-controller` / `secret` / `ipv6` / `profile` / `dns` / `sniffer` 字段（仍按 v2.12.2 保持精简）

### 变更：自动选择 + 自动测速地理组的 url-test 参数

- 移除 `lazy: false` 参数
- 将 `url` / `interval` / `tolerance` 三个参数移到 `type` 行之后（视觉顺序更直观）
- 测速地址全部统一为 `http://www.gstatic.com/generate_204`（与 v2.12.10+ 预填充 geo 阶段保持一致）

### 修复：GLOBAL select 组误加 url 字段

- GLOBAL（最终组）和手动切换组类型均为 `select`，不应有 `url`；本次修复从 `urlTestGeoGroupNames` 中剔除 `GLOBAL` 和 `手动切换`，避免 Mihomo 校验拒绝
- 测试断言同步更新，验证上述四组变更

## [2.12.17] - 2026-09-01

### 修复：__NULL__ 负缓存卡死——batchQuery 命中 __NULL__ 仍无条件 continue 跳过重查

- **根因**：`batchQuery` 缓存命中 `__NULL__` 后，无论是否有效都执行 `continue`，
  `__NULL__` 永远不会被加入 uncached，导致 ip-api 请求永远发不出去，节点国家
  码永久卡死在「未识别」状态
- **修复**：`batchQuery` 命中 `__NULL__` 时不再写入 result，但 push 到 uncached
  重新查询；`prewarmIpGeo` 同步修复——`__NULL__` 不写入 ipToCountry、不计
  cached，落入 uncached 由 batchQuery 重查
- **测试**：新增 batchQuery `__NULL__` 重查并写入有效缓存、prewarmIpGeo
  `__NULL__` 重查后 resolved=2 两用例；全套 390 通过
- 顺带：`.gitignore` 排除 PROJECT_CONTEXT.md / CURRENT_TASK.md（本地会话固化
  文档不入库）

## [2.12.16] - 2026-09-01

### 增强：geo-redetect 响应携带未识别节点列表，一键诊断 14 个"死活查不出"的节点

- **根因分析**：剩余 14 个节点反复重检仍无法识别，大概率是「ip-api 返回 fail（保
 留段/内网 IP）」或「国家码不在映射表 → countryDisplayName 返回 null → 不写缓存
 → 每次重检重复查询、永远失败」
- **诊断手段**：geo-redetect 响应新增 `unlocatedServers` 字段（前 50 个未识别
  server），前端 toast 同步展示，部署后点一次重检就能看到 14 个节点的原始
  server 字符串（域名？IP？保留段？），无需猜测
- 后端 `routes.ts` 重检后调用 `getUnlocatedServers` 获取列表，slice(0,50)
- 前端 `redetectGeo` toast 追加「：server1, server2 …」行

## [2.12.15] - 2026-09-01

### 修复：域名节点反复重检仍无法识别国家码（缓存 key 口径不一致）

- **根因**：`prewarmIpGeo` 写缓存用的是「解析后的 IP」（`ip_geo:{IP}`），而统计/重检筛选 `hasGeoCountry` 用的是「原始 server」（`ip_geo:{域名}`）。域名节点每次重检都写入成功，但统计侧永远查不到对应 key → 死循环，表现为「反复检测、死活剩 16 个节点识别不出来」
- **修复**：`prewarmIpGeo` 批量查询后**同时回写 `ip_geo:{server}` 缓存**（与统计口径 key 一致），域名节点即被统计侧识别为已识别
- 存量修复前只写了 IP key 的节点，重检时也会自动补上 server key（统一回写路径）
- 纯 IP 节点（server = IP）行为不变

## [2.12.14] - 2026-09-01

### 优化：重新检测国家码的分批逻辑

- `prewarmIpGeo` 批量查询改为**按 ≤100 IP/批 循环分包**，单次最多 5 批（500 个 IP），不再降级为逐条单查
- 101-200 个未识别 IP 打 2 包、201-300 打 3 包、301-400 打 4 包、401-500 打 5 包；超过 500 的部分保持未识别，等下次触发重检
- 每批前检查 15 次/分钟滑动窗口限流，超限即停止后续批次（剩余等下次）
- 本批请求失败跳过该批，不阻塞后续批次，失败结果不写缓存允许重试

## [2.12.13] - 2026-09-01

### 新增：节点未识别国家码统计与手动重检

- 节点列表统计栏新增「未识别国家码 N 个」，口径与生成器归「其他」组判定严格一致（查 ip_geo 缓存，TTL 内且非 `__NULL__` 才算已识别）
- 新增手动触发重新检测 IP 国家码按钮（`POST /api/nodes/geo-redetect`），复用 prewarmIpGeo 批次+限流管线
- 默认仅重检未识别项（省 ip-api 免费额度），全量重检为次级选项
- KV 锁保证并发幂等（60s TTL），冲突返回 409

## [2.12.12] - 2026-09-01

### 修复节点落「其他」组两类盲区

**A. 域名 server 支持 DoH 解析成 IP**（`src/services/ip-geo.service.ts`）
- 新增 `resolveDomainToIP(server)`：用 Google/Cloudflare DoH 端点解析域名→IPv4，单域名独立请求（5s 超时），解析失败跳过该 server 不阻塞整体
- `prewarmIpGeo` 在批量查询前先对全部 server 做 DNS 解析，域名节点现在可正确归入地理组

**B. 失败结果不缓存，存量 `__NULL__` 视为过期重查**（`src/services/ip-geo.service.ts`）
- 移除所有写 `__NULL__` 的缓存写入点：ip-api 限流回退、批量请求失败、单个查询失败、无 countryCode 均不写缓存
- 存量旧格式 `__NULL__` 缓存（无时间戳版本）也视为无效，下次 resolver 触发时自动重查
- 根因：之前失败结果写 30 天 `__NULL__` 缓存后永久锁死在「其他」组，任何重试机制均被绕过

### 测试
- 新增 3 个测试：`__NULL__` 重查、失败不写缓存、仅成功结果写缓存（共 8 个 ip-geo 测试，全量 381 个测试 ✅）

## [2.12.11] - 2026-09-01

### Mihomo 所有 url-test 测速组 interval 调整为 300
- 「自动选择」url-test 组 `interval: 600` → `interval: 300`
- 地理 url-test 组（美国/马来西亚/日本/新加坡/台湾/韩国）`interval: 600` → `interval: 300`

## [2.12.10] - 2026-09-01

### IP 地理定位主动预填充（批量合并查询）
- 新增 `prewarmIpGeo(servers, cache)`：全量 server 先查 KV 缓存，未命中合并为单次 batch 查询，写回 KV（TTL 30 天固定）
- 3 处触发点：① `src/index.ts` scheduled() 每日订阅自动更新后 ② `src/api/routes.ts` POST /api/subscriptions/:id/update ③ `src/api/routes.ts` POST /api/subscriptions
- 查询与配置生成解耦：配置生成时不再惰性查 IP，改为订阅更新时批量预填充，根治 ip-api 15 次/分钟限流导致「其他」组异常

### Mihomo 所有 url-test 测速组显式加入 lazy: false
- 「自动选择」url-test 组加入 `lazy: false`
- 地理 url-test 组（美国/马来西亚/日本/新加坡/台湾/韩国）加入 `lazy: false`

## [2.12.9] - 2026-09-01

### Mihomo 所有 url-test 测速组加入 lazy: false
- 「自动选择」url-test 组加入 `lazy: false`
- 地理 url-test 组（美国/马来西亚/日本/新加坡/台湾/韩国）加入 `lazy: false`
- 所有 url-test 组显式声明 `lazy: false`（不惰性启动测速）
- 测试基线 378 ✅

## [2.12.8] - 2026-09-01

### Mihomo 所有测速组 interval 统一为 600
- 「自动选择」url-test 组 `interval: 1800` 改为 `interval: 600`
- 至此所有 url-test 测速组（自动选择 + 地理组）interval 均为 600
- 测试基线 378 ✅

---

## [2.12.7] - 2026-09-01

### 退出重登后默认进入仪表盘页
- 修复：退出登录后再登入，仍停留在上一次查看的页面
- 登录成功后调用 `switchPage('dashboard')`，始终默认进入仪表盘页
- 测试基线 378 ✅

---

## [2.12.6] - 2026-09-01

### Mihomo 测速部分去掉 lazy 参数
- 地理测速组（美国/马来西亚/日本/新加坡/台湾/韩国）去掉 `lazy: true`
- 至此测速组仅保留：url / interval:600 / tolerance
- 测试基线 378 ✅

---

## [2.12.5] - 2026-09-01

### Mihomo 测速部分彻底去掉 timeout 参数
- 地理测速组（美国/马来西亚/日本/新加坡/台湾/韩国）去掉 `timeout: 5000`
- 至此所有 url-test 测速组的 `timeout` 参数全部移除（自动选择组的 `timeout: 3000` 已在 v2.12.4 去掉）
- 测速组保留：url / interval:600 / tolerance / lazy
- 测试基线 378 ✅

---

## [2.12.4] - 2026-09-01

### Mihomo 测速参数调整
- 去除「自动选择」url-test 组的 `timeout: 3000` 参数
- 地理测速组（美国/马来西亚/日本/新加坡/台湾/韩国）`interval: 300` 改为 `interval: 600`
- 测试基线 378 ✅

---

## [2.12.3] - 2026-09-01

### Mihomo 配置输出硬编码精简（去除 profile/dns/sniffer 及全部头字段）
- 按用户指令去除 mihomo 配置输出的全部硬编码内容，配置仅输出 `proxies` / `proxy-groups` / `rules` 三段
- 去除 `profile:` 段（store-selected）
- 去除 `dns:` 段（fake-ip / DoH / nameserver-policy / 国内DNS分流等，含 `DEFAULT_DNS_CONFIG`）
- 去除 `sniffer:` 段（含 `DEFAULT_SNIFFER_CONFIG`）
- 去除 `profile:` 之上的头字段：mixed-port / allow-lan / mode / log-level / ipv6 / external-controller / secret / unified-delay / tcp-concurrent / geodata-mode / geodata-loader / geosite-matcher / geo-auto-update / geo-update-interval
- 删除死代码：`MihomoTemplate` 接口、`DEFAULT_MIHOMO_TEMPLATE`、`DEFAULT_DNS_CONFIG`、`DEFAULT_SNIFFER_CONFIG`
- `generateMihomoConfig` 签名由 5 参数精简为 4 参数（移除 `template`），`config.service.ts` 调用点同步更新
- 测试同步：`mihomo.test.ts` / `verify-v31.test.ts` 相关断言改为断言已移除字段不出现
- 测试基线 378 ✅

---

## [2.12.2] - 2026-09-01

### 分流规则精简（删除指定 geosite 规则，保留分组结构）
- 按用户指令从 8 个分组中删除点名的 67 条 geosite 规则，**不删除组本身**
- 国内直连：删 apple-cn / microsoft@cn / steam@cn / category-games@cn / onedrive / icloud@cn，保留 `cn`
- AI 平台：删 openai / anthropic / google-gemini / github-copilot / perplexity / poe / bytedance-ai-!cn / jetbrains-ai，保留 `category-ai-!cn` / `category-ai-chat-!cn`
- 社交：删 telegram / discord / twitter / x / meta / facebook / instagram / tiktok / reddit / line / whatsapp / signal / linkedin / pinterest，保留 `category-communication` / `category-social-media-!cn`
- 国外媒体：删 youtube / netflix / biliintl / bahamut / pixiv / abema / spotify / disney / ehentai，保留 `category-media`
- 游戏平台：删 steam / epicgames / ea / origin / ubisoft / gog / blizzard / riot / xbox / playstation / nintendo，保留 `category-games-!cn`
- 微软服务：删 azure / bing / msn，保留 `microsoft` / `microsoft-dev` / `microsoft-pki`
- 苹果服务：删 apple-podcasts / apple-tvplus / apple-intelligence / icloud / itunes，保留 `apple` / `apple-music` / `apple-dev` / `apple-update` / `apple-pki`
- 加密货币：删 binance / okx / bybit / gateio / kraken / kucoin / huobi / onekey / trustwallet / deribit / safepal，保留 `category-cryptocurrency`
- 谷歌 FCM 组未点名，完整保留
- 测试同步：`rule-providers.test.ts` / `rules-data.test.ts` / `rule-order.test.ts` / `mihomo.test.ts` / `verify-v31.test.ts` 中引用已删规则的断言改为仍存在的规则（category-ai-!cn 等）
- 测试基线 378 ✅

---

## [2.12.1] - 2026-08-31

### 纯IP地理定位重构
- **detectGeo 简化**：去掉所有域名识别层（emoji旗标/IATA三字码/二字码/中文名），直接使用 IP 定位器
- **groupNodesByGeo 批量化**：从逐节点调用改为收集所有 server → 去重 → batchIpToGeoBatch 批量查询 → 组织输出
- **ip-geo.service.ts**：更新文件头注释为「纯 IP 批量」定位服务
- **测试同步**：`verify-v31.test.ts`、`mihomo.test.ts`、`ip-geo.service.test.ts`、`subscription.test.ts` 均适配新逻辑

### 测试基线
- 378 ✅（不变）

---

## [2.12.0] - 2026-08-31

### Mihomo DNS 配置精调（fake-ip 模式）
- `proxy-server-nameserver` 由 DoH 改为纯 IP 引导（`223.5.5.5` / `119.29.29.29`），解析节点服务器域名更快更稳、防污染
- 移除 `fake-ip-filter` 块（STUN/Apple 推送等条目），按用户指定精简 DNS 硬编码
- 其余保持：`nameserver` 国内 DoH（223.5.5.5/doh.pub）、`nameserver-policy` 国内 cn/private 走国内 DoH、国外 geolocation-!cn 走 `1.1.1.1`/`8.8.8.8#节点选择`
- 同步更新 `tests/verify-v31.test.ts` DNS 断言（去掉 fake-ip-filter 断言，新增 proxy-server-nameserver 纯 IP 断言）
- 测试基线 378 ✅

## [2.11.9] - 2026-08-31

### 安全测试空壳修复（⑥）
- `tests/security/security.test.ts` 不再测 escHtml 的复制副本，改为直接从真源 `public/index.html` 提取前端实际运行的 escHtml 实例化测试
- 新增产物接线校验：断言 `src/html.js`（已生成的前端代码）在 `renderRulesTree` 中确实把 `escHtml` 接进 `it.id`/`it.label`，且不得出现未转义直接内插的 `${it.id}`/`${it.label}`（防回归）
- 测试基线 378 ✅（+2）

## [2.11.8] - 2026-08-31

### 稳定/安全补丁（对抗式审查产出）
- **白屏根因修复（事故①同类问题）**：`api()` 新增 `fetchWithTimeout`（15s AbortController 超时），杜绝网络黑洞导致 `checkSession()` 永不返回；Init 处新增 5 秒 `Promise.race` 硬性兜底，保证 `switchPage` 5s 内必执行 → 永不白屏
- **自定义规则 ID 防注入（XSS + 配置损坏）**：后端 `POST /api/rules/custom` 校验 id 字符集（`[A-Z0-9][A-Z0-9_-]{0,63}`）；前端 `renderRulesTree` 对 `id/label/tag` 统一 `escHtml` 转义（对照 catalog 渲染）
- **测速地址统一为国内可达**：`cp.cloudflare.com/generate_204`（自动选择/六国地理组/singbox auto），并给自动选择组加 `timeout: 3000`；清理 `DEFAULT_SNIFFER_CONFIG['skip-domain']` 中无意义的 `'Mijia Cloud'` 行
- 测试同步：verify-v31 六国 URL 断言、新增非法 id 400 用例；测试基线 376 ✅

## [2.11.7] - 2026-08-30

### GLOBAL 组精简为四组（用户 2026-08-30 拍板）
- GLOBAL proxies 从全量列表（含广告拦截/国外媒体/业务组/漏网之鱼/地理组）精简为仅四项：节点选择、手动切换、自动选择、DIRECT
- 移除 `globalOrder` 常量，GLOBAL 直接内联四项 proxies

## [2.11.6] - 2026-08-30

### 四项策略组/规则修正（用户 2026-08-30 拍板）
- 六国 url-test 地理组单节点自动降级为 select（`geo.nodes.length > 1` 才启用 url-test 测速，单节点测速无意义）
- 广告拦截组 proxies 精简为 `['REJECT', 'DIRECT']`（去掉子组引用）
- 漏网之鱼默认改为「自动选择」；GLOBAL 组默认改为「DIRECT」
- GLOBAL 组新增国内可达测速 URL `https://cp.cloudflare.com/generate_204`——修复 OpenClash 面板 DIRECT 测速无反馈（原默认 gstatic generate_204 国内直连不通）
- google-fcm 规则改原生 GEOSITE：`metacubex-rules.ts` googlefcm 条目加 `native: true`，输出 `GEOSITE,googlefcm,谷歌FCM`，不再生成 rule-provider 硬编码段（用户前提：Mihomo 客户端已有全面 GeoIP/GeoSite 数据库）
- 测试同步：verify-v31 / mihomo / config-rules 断言更新
- 测试基线：375 ✅

## [2.11.5] - 2026-08-30

### 地理组自动测速 — 美国/马来西亚/日本/新加坡/台湾/韩国 六组 url-test
- 用户指定六国/地区地理组启用 url-test 自动测速（2026-08-30）
- 测速参数：`url: https://www.gstatic.com/generate_204`、`interval: 300`、`tolerance: 50`、`lazy: true`、`timeout: 5000`
- 其余地理组（含"全部/其他"）保持 select 手动选择
- verify-v31.test.ts 六国断言补全（马来西亚/台湾/韩国），DNS 测试过时 `interval: 300` 断言移除
- 测试基线：375 ✅

## [2.11.4] - 2026-08-30

### XHTTP 支持暂停 — 降级为普通 VLESS 输出
- 用户决定暂停 XHTTP 支持（2026-08-30），Mihomo 生成器不再输出 XHTTP 特有配置
- `network: xhttp` + `xhttp-opts` 整块移除：XHTTP 节点降级为普通 VLESS TLS 输出
- XHTTP 缺省 alpn `[h2]` 默认逻辑移除（链接带 alpn 参数仍保留输出）
- ECH(encrypted-client-hello)，x-padding-* 等 XHTTP 配套字段一并移除
- 解析器/协议显示/node-to-url/前端标签保留 XHTTP 识别与展示（节点列表仍可见）
- 测试基线：375 ✅

## [2.11.3] - 2026-08-30

### XHTTP alpn 支持 — HTTP/2 握手必需
- VLESS 解析器新增 `alpn` 参数读取（逗号分隔转数组，如 `alpn=h2,http/1.1`），不再落入 extra
- Mihomo 生成器 VLESS 段输出 alpn：链接带 `alpn` 参数时原样输出；XHTTP 缺省时默认 `[h2]`
- 依据 Mihomo 官方文档：alpn 为 TLS 握手 ALPN 列表，位于代理顶层（`tls: true` 同层）

## [2.11.2] - 2026-08-30

### XHTTP x-padding 参数解析修复（3X-UI/v2rayN 封装格式）
- **根因**：3X-UI/v2rayN 链接把 x-padding 参数封装在 `extra=JSON`(camelCase 键) 中，生成器只读顶层 kebab-case 键，导致整个 x-padding 块丢失。
- **修复**：生成器解析 `extra` JSON，camelCase → kebab-case 映射到 xhttp-opts（x-padding-obfs-mode/method/placement/header/key/bytes）；顶层同名参数优先覆盖。

## [2.11.1] - 2026-08-30

### VLESS 输出补全（XHTTP 节点连接排查）
- **强制输出 `udp: true` + `encryption: none`**：所有 VLESS 节点固定输出，不再依赖链接参数。
- **client-fingerprint 默认 chrome**：非 Reality 的 TLS VLESS 节点即使链接不带 `fp` 也默认输出 `chrome`（链接带 `fp` 时以链接为准）。
- **ECH query-server-name 恢复**：从链接 `ech=域名+DoH` 参数拆分读取（取 `+` 前域名），`config` DoH 不输出。

## [2.11.0] - 2026-08-30

### 规则排序重构（V3.2 冻结版）
- **14 步优先级定稿**：用户规则 → 内网防代理 → 广告拦截 → 国内直连 → FCM → AI → 社交 → 国外媒体 → 游戏 → 微软 → 苹果 → 加密货币 → GEOIP,CN,DIRECT → MATCH。
- **内网防代理拆两条**：`GEOIP,lan,DIRECT,no-resolve` + `GEOSITE,private,DIRECT`（lan 在前、private 在后，替代原单一 `GEOIP,private,DIRECT`）。
- **国内直连拆分**：china-direct 组输出 7 条 GEOSITE（cn/apple-cn/microsoft@cn/steam@cn/category-games@cn/onedrive/icloud@cn）→ DIRECT；`GEOIP,CN,DIRECT` 从组内剥离，排到 crypto 之后、MATCH 之前。
- **组顺序调换**：国外媒体提前到游戏前；加密货币移至苹果服务之后（末尾）。
- **apple-music 归属**：从国外媒体组移除，只保留在苹果服务组（DIRECT）。
- **策略组默认值全部 DIRECT**：AI/社交/加密货币/用户规则 从「节点选择」改「DIRECT」，国外媒体从「自动选择」改「DIRECT」（面板仍可切换）。

### XHTTP ECH 简化
- `ech-opts` 只保留 `enable: true`，去掉 `query-server-name` / `config`（XHTTP 节点 Clash 连接不上，简化后重试）。

### 其他
- 版本号 v2.10.3 → v2.11.0。

## [2.0.2] - 2026-08-21

### 修复与优化
- **规则库分类筛选（方案 A）**：设置页规则库新增「全部 / 🎯 聚合 / 🌐 站点 / 🌍 顶级域」分类 chips，按类型缩小范围再挑，避免平铺几千条。
- **后端 type 过滤**：`/api/rules/catalog?type=` 支持按 `aggregate`/`site`/`tld` 过滤，并返回各类型计数。
- **默认计数展示**：chips 上直接显示各分类数量（聚合 118 / 站点 1424 / 顶级域 4），用户一眼知道从哪入手。
- **补充测试**：覆盖 catalog 按 type 过滤与类型计数返回。

## [2.0.1] - 2026-08-21

### 修复与优化
- **Mihomo P0 策略组重构**：补齐节点选择、手动切换、自动选择、广告拦截、应用净化、国内媒体、国外媒体、漏网之鱼与 GLOBAL。
- **显式默认策略**：使用 Mihomo 官方 `default-selected` 字段，确保节点选择默认自动选择、广告/应用净化默认 REJECT、国内媒体与 GLOBAL 默认 DIRECT、国外媒体默认自动选择。
- **MetaCubeX 规则分工**：`CATEGORY-ADS-ALL` 路由到广告拦截，`CATEGORY-ADS` 路由到应用净化。
- **补充测试**：覆盖策略组存在性、默认策略和规则出口映射。

## [2.0.0] - 2026-08-17

### 🎉 V2.0.0 - 规则库扩展版

### 新增
- **规则库（动态目录）**：从 MetaCubeX 分类中搜索挑选（全量同步，支持 GitHub Token 防 403、分步拉取避免截断）
- **自定义规则**：一键加入分流规则，自动根据分组决定目标策略（广告→REJECT / 国内→DIRECT / 其余→PROXY）
- **自定义规则删除**：分流规则页支持移除已添加的规则
- **输出配置联动**：自定义规则直接写入 Mihomo YAML / Sing-box JSON 输出
- **CI/CD 自动注入**：`WORKER_GITHUB_TOKEN` → Cloudflare Secrets，简化部署

### 优化
- 加入规则弹窗移除「目标策略」下拉，用户无需手动选策略
- 规则库状态展示（正常/过期/未同步）+ 立即刷新按钮

## [0.1.0] - 2026-08-13

### 新增
- **项目基础**：Cloudflare Worker 骨架、TypeScript strict 配置、Wrangler 配置
- **测试框架**：Vitest + 169 个测试用例
- **CI/CD**：GitHub Actions 自动测试 + 部署到 Cloudflare Workers
- **后端核心**：Repository Pattern KV 仓储、PBKDF2 认证 + Session、Hono API 路由
- **订阅系统**：创建/删除/更新订阅，Fetch→Parse→Normalize→Cache 完整管线
- **Parser 引擎**：VMess / VLESS / Trojan / Shadowsocks 四协议解析 + 去重 + 规则引擎
- **配置生成**：Mihomo YAML + Sing-box JSON 双格式输出
- **订阅端点**：`/sub/mihomo/:token`、`/sub/singbox/:token`
- **前端 SPA**：仪表盘 / 订阅管理 / 节点列表 / 输出配置 / 设置
- **安全加固**：SSRF 防护、XSS 转义、登录限流、Secrets 管理

### 安全
- 密码使用 PBKDF2-SHA256（10 万次迭代）+ 随机盐
- Session Cookie 设置 HttpOnly / Secure / SameSite=Strict
- 订阅抓取做 SSRF 防护（拒绝内网/私有 IP）
- 登录接口限流 10 次/分钟/IP