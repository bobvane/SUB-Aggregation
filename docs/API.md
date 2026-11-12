# HTTP API

路由定义在 `src/api/routes.ts`。除健康检查、元信息、登录及带订阅 token 的 `/sub` 外，管理接口使用会话认证。成功响应通常为 `{ "success": true, "data": ... }`；错误由中间件统一返回 `{ "success": false, "error": { "code", "message" } }`。

## 路由索引

| 范围 | 路径 | 用途 |
|---|---|---|
| 元信息 | `GET /api/health`, `/api/meta`, `/api/meta/check-upgrade` | 健康状态、应用信息和版本检查 |
| 认证 | `/api/auth/*` | 登录、登出、会话、用户名和密码 |
| 订阅 | `/api/subscriptions`、`/api/subscriptions/:id/*` | 列表、新增、编辑、删除、启停、更新 |
| 节点 | `/api/nodes*` | 节点列表、启停、锁定、探测、健康和 GeoIP |
| 规则 | `/api/rules*` | 自定义规则、固定组、目录和选择状态 |
| 配置 | `GET /api/output/:format` | 管理界面预览/下载生成配置 |
| 设置与日志 | `/api/settings`、`/api/proxy/test`、`/api/operation-log` | 应用设置、代理连通性测试及操作日志 |
| 客户端订阅 | `GET /sub/:format/:token` | 通过长随机 token 获取订阅配置 |

路由完整列表、参数校验和各端点的认证要求以 `src/api/routes.ts` 为准。修改 API 时同步更新浏览器端 `public/api.js`、相关集成测试和本页。

仪表盘数据包含 `failedSubscriptions`，表示启用且最近一次更新失败的订阅数，供首页关注概览定位问题。

`GET /api/meta/check-upgrade` 在页面打开或刷新时从 GitHub Releases Atom 源读取版本；该接口及浏览器请求均禁用缓存，并对上游请求设置 5 秒超时。GitHub 不可达时返回 `checked: false`，前端应显示暂时无法检查。

## 代理相关字段

- 订阅对象**不再包含** `useProxy`（v2.46.0 移除）：订阅抓取策略统一由设置页的「订阅拉取」目标控制。请求里带旧字段会被忽略，响应中也不会返回。
- `GET /api/settings` 返回的代理字段：
  - `proxy_url`：用户保存过的地址（密码脱敏为 `***`），空串表示未配置 = 全部直连。
  - `proxy_targets`：五项目标的策略对象，键为 `subscription` / `rules` / `version` / `dns` / `geo`，值为 `auto`（默认，先直连不通再走代理）/ `on`（直接走代理）/ `off`（只直连）。
  - `proxy_bypass`：用户保存的绕过列表（逗号分隔字符串，不含内置默认）。
  - `proxy_meta`：只读的渲染元数据，含 `targets`（`key` / `label` / `hint`）、`bypassPresets`、`bypassDefaults`（内置默认列表，始终生效）、`probeTimeoutMs`（自动模式的直连探测时限，3000）。
- `PUT /api/settings` 接受 `proxy_url` / `proxy_targets` / `proxy_bypass`，字段均可省略（只写传入的项）；`proxy_targets` 支持部分更新（与已存值合并）。`proxy_url` 只接受 `http://` / `https://`，已保存地址的密码占位符 `***` 可原样回存。
- 设置页只提交用户真正改动过的字段；把脱敏地址原样回存是允许的（服务端会还原成原密码），但前端已做脏字段判断，正常情况下不会提交未改动的项。
- `POST /api/proxy/test` **固定走代理**（不受目标策略与 bypass 影响），请求固定目标 `https://www.gstatic.com/generate_204`，返回 `ok`、`via`、`status`、`ms` 或 `error`；不接受任意 URL，避免 SSRF。

## 认证与敏感信息

- 管理端使用 `sub_session` HttpOnly Cookie；会话默认 7 天，改密码后旧会话失效。
- `/sub/:format/:token` 的 token 等同密码，不要写入日志、截图或公开工单。
- 反向代理需正确传递 `X-Forwarded-Proto`，HTTPS 请求才会设置 `Secure` Cookie 属性。
