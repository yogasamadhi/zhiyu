# 织云云端本地运行与交付

本目录为独立商业平台，服务 Portal、Admin 和 Electron 的云账户/托管 AI。本地 `/api/v2` 继续由 Electron 运行时提供。规则与接口见 [架构规范](../../docs/architecture/ZHIYUN_CLOUD_COMMERCIAL_ARCHITECTURE.md)。

云端源码位于 `platform/server/`，页面应用位于 `platform/portal/` 和 `platform/admin/`。`desktop/analytics-worker/` 随桌面端交付，在用户本机运行；与 `platform/server/src/worker.ts` 的云端后台任务是两个独立进程。

## 开发启动

仓库根目录执行 `bun run-platform.ts --infra`。它检查 Bun 依赖、启动 Compose 基础设施、应用迁移并启动 API、后台任务、Portal 和 Admin。基础设施已运行时省略 `--infra`。也可使用 `bun run platform:dev` / `bun run cloud:dev`；`--skip-install` 和 `--skip-migrate` 用于已准备好的环境。依赖 Bun 1.4、Node 24、Docker；PostgreSQL 17、Redis 7.4 由 Compose 提供。

平台启动器固定使用 `CLOUD_PORT`、`CLOUD_PORTAL_PORT`、`CLOUD_ADMIN_PORT`（默认 3200、3100、3101）。启动应用前会结束占用这些 TCP 监听端口的进程；请勿将它们配置为其他项目正在使用的端口。Ctrl+C 会清理本次启动的 Server、Worker、Portal、Admin 进程树，不会停止 PostgreSQL/Redis 容器。

默认数据库为 `postgres://zhiyun:zhiyun-local@127.0.0.1:55432/zhiyun_cloud`，仅用于本机开发。已有 Postgres volume 的密码不会因修改 Compose 环境变量而自动改变。

首次管理员从终端环境注入 `CLOUD_BOOTSTRAP_EMAIL` / `CLOUD_BOOTSTRAP_PASSWORD`，执行 `bun run --filter @zhiyun/cloud-server admin:create`，导入输出的 TOTP URI。不要把正式密码写进 Git、共享截图或日志。

默认验证码不会向外发送。在 Admin 的测试收件箱查看短期验证码。商品、模型均由 Admin 配置；没有隐藏的自动售卖价格或试用额度。

## 环境变量

| 配置                                               | 用途                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `CLOUD_DATABASE_URL` / `CLOUD_REDIS_URL`           | 独立云数据库与缓存                                                |
| `CLOUD_PORT`                                       | Hono 监听端口，默认 3200                                          |
| `CLOUD_PORTAL_PORT` / `CLOUD_ADMIN_PORT`           | 开发启动的页面端口，默认 3100 / 3101                              |
| `CLOUD_SERVER_URL`                                 | Next/Vite 同源代理目标；默认 `http://127.0.0.1:3200`              |
| `CLOUD_PORTAL_ORIGIN` / `CLOUD_ADMIN_ORIGIN`       | 精确的 Origin/CSRF 检查来源，包含端口                             |
| `CLOUD_MOCK_PAYMENTS`                              | 默认 true；NODE_ENV=production 拒绝 true                          |
| `CLOUD_MFA_KEY`                                    | 至少 32 字符的 MFA 种子加密密钥；正式环境拒绝开发默认值           |
| `CLOUD_REAL_MESSAGES`                              | 默认 false，真实短信/邮件发送总开关                               |
| `CLOUD_MODEL_ORIGINS`                              | 逗号分隔的测试上游 HTTPS origin 允许列表                          |
| `CLOUD_DAILY_TOKEN_BUDGET`                         | 系统每日 Token 上限，默认 1,000,000                               |
| `ZHIYUN_CLOUD_API_URL` / `ZHIYUN_CLOUD_PORTAL_URL` | Electron 主进程访问的地址，生产地址要求 HTTPS，允许本机 HTTP 开发 |
| `NEXT_PUBLIC_DOWNLOAD_MAC / WINDOWS / LINUX`       | Portal 构建时的已发布安装包链接，留空不生成虚假链接               |

真实供应商配置示例见 [.env.example](.env.example)。真实模型 keyRef 引用服务端环境变量名，前端只提交引用，不提交密钥值。

## 容器与 HTTPS 测试栈

```bash
cp platform/deploy/.env.example platform/deploy/.env
# 为新的隔离数据库填写一致的密码、MFA key 和 Origin。
docker compose --env-file platform/deploy/.env -f platform/deploy/compose.yml -f platform/deploy/compose.apps.yml build
docker compose --env-file platform/deploy/.env -f platform/deploy/compose.yml -f platform/deploy/compose.apps.yml up -d
```

Server 镜像包含 Bun 与打包的 Server/Worker/迁移/管理员命令；Portal 使用 Next standalone；Admin 使用 Caddy 静态文件服务。同一 Server 镜像启动两个进程角色。迁移容器完成后才启动 API/Worker。

测试入口为 `https://portal.localhost:8443`、`https://admin.localhost:8443`、`https://api.localhost:8443`。本地 Caddy 内部证书需要在测试客户端建立信任；API/数据库不会自动暴露到公网。公网部署需自行提供受控域名及证书，本轮未执行。

生产配置必须 `NODE_ENV=production` 且 `CLOUD_MOCK_PAYMENTS=false`。本轮没有生产支付和生产模型池，不能通过关闭模拟开关获得真实收费能力。

管理员容器命令：`bun dist/bootstrap-admin.js`；迁移：`bun dist/migrate.js`；Worker：`bun dist/worker.js`。管理员口令应以安全的环境注入方式提供。

## 备份、恢复与故障处理

- `bash platform/tooling/scripts/backup.sh /secure/path/cloud.dump` 生成 PostgreSQL 自定义格式备份，文件权限受 umask 077 保护。
- 两个脚本默认操作 `zhiyun_cloud`，可用 `CLOUD_DATABASE_NAME` 指定隔离备份/恢复库；恢复演练应使用新建测试库，不覆盖日常开发数据。
- 恢复会替换数据库对象。先停 API/Worker，再执行 `CLOUD_RESTORE_CONFIRM=replace-database bash platform/tooling/scripts/restore.sh /secure/path/cloud.dump`，迁移后重启并检查任务、订单、积分与 review 请求。
- 保留并备份 `CLOUD_MFA_KEY`，否则管理员 TOTP 种子无法解密。不要备份 Redis 作为财务恢复依据。
- Redis 丢失：限流回退 PostgreSQL，账本不受影响。
- Worker 崩溃：租约到期后重新领取持久任务，复用相同业务标识。
- AI calling 状态不明：转 review，核查后带原因补偿释放，不重新发模型请求。
- `/api/cloud/v1/health` 提供数据库/缓存状态，`/api/cloud/v1/admin/metrics` 提供 Worker 心跳、任务、请求和积分汇总。

## 验证

`bun run cloud:test` 只使用以 `_test` 结尾的隔离数据库；`bun run cloud:e2e` 使用 `_e2e_test` 数据库及独立端口，不会清空开发库。E2E 测试账户只在显式测试命令中创建。验收命令和结果见 [验收记录](../../docs/verification/zhiyun-cloud-acceptance.md)。
