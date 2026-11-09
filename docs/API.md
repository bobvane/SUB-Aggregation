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

- 订阅对象包含 `useProxy`：`auto`（跟随全局设置，默认）、`on`（强制走代理）、`off`（强制直连）。创建、编辑、列表和单条查询都会返回该字段。
- `GET /api/settings` 返回 `proxy_mode`（`off` / `env` / `manual`）、脱敏后的 `proxy_url`、`proxy_scope`（`subscription` / `github` / `geo` 数组）、`proxy_bypass`、`proxy_fallback`。`proxy_scope` 在 `env` 模式固定为全部用途；`manual` 模式下未保存过时为全部用途，保存为空数组表示全部直连（只有显式 `on` 的订阅走代理）。
- `PUT /api/settings` 接受上述代理字段；`proxy_url` 只接受 `http://` / `https://`，返回的密码占位符 `***` 可原样回存。
- `POST /api/proxy/test` 使用已保存配置请求固定目标（`https://www.gstatic.com/generate_204`），返回 `ok`、`via`、`status`、`ms` 或 `error`；不接受任意 URL，避免 SSRF。

## 认证与敏感信息

- 管理端使用 `sub_session` HttpOnly Cookie；会话默认 7 天，改密码后旧会话失效。
- `/sub/:format/:token` 的 token 等同密码，不要写入日志、截图或公开工单。
- 反向代理需正确传递 `X-Forwarded-Proto`，HTTPS 请求才会设置 `Secure` Cookie 属性。
