# 织云单工作区自托管

生产部署由一个织云容器、PostgreSQL、Redis 和 HTTPS 反向代理组成。Web UI 与 API 由织云容器在同一个 Origin 提供；Chromium 和分析 Worker 随镜像发布。

## 首次启动

1. 复制 `deploy/compose.production.yml`、`deploy/Caddyfile` 和 `deploy/env.production.example` 到部署主机；将示例环境文件复制为 `deploy/.env`。
2. 在 `.env` 中设置 `POSTGRES_PASSWORD`、`ZHIYUN_DOMAIN`、`ZHIYUN_PUBLIC_URL`、`ZHIYUN_CREDENTIAL_KEY` 和 `ZHIYUN_BOOTSTRAP_TOKEN`。后三个秘密建议用密码管理器生成；Bootstrap Token 必须至少 32 字节。
3. 执行 `docker compose --env-file deploy/.env -f deploy/compose.production.yml pull`，再执行 `docker compose --env-file deploy/.env -f deploy/compose.production.yml up -d`。Compose 使用明确版本的发布镜像，不要求在部署主机复制源码或预先构建 Linux 产物。
4. `/health` 只检查进程存活；只有 `/ready` 返回 200 后才应接入流量。
5. 打开 HTTPS 地址，用 Bootstrap Token 创建首个管理员。创建成功后 Token 永久失效，应从 `.env` 移除并重建容器；已初始化工作区可在不配置 Bootstrap Token 的情况下继续启动。如果空数据库启动时没有 Token，初始化接口会保持禁用，直到管理员显式配置一个新的 32 字节 Token。

远程监听必须同时配置 HTTPS `ZHIYUN_PUBLIC_URL` 和明确的 `ZHIYUN_ALLOWED_ORIGINS`。不要直接把 3001 端口暴露到公网。

如需从源码制作镜像，应先在 Linux x64 构建主机依次运行 `bun run worker:build`、`bun run --filter @zhiyun/api package:linux` 和 `bun run --filter @zhiyun/api test:packaged`，再使用仓库根目录作为上下文执行 `docker build -f apps/api/Dockerfile .`。生产部署不应使用浮动的 `latest` 标签。

## 数据目录

- PostgreSQL 保存任务、规则、成员、会话、审计和运行元数据。
- `deploy/data` 保存加密凭据、Artifact、作业工作区和本地目录输出。
- Redis 使用 AOF，保存可恢复的队列状态；PostgreSQL 仍是业务事实来源。

## 备份

在停止计划变更后执行：

```bash
mkdir -p backups/2026-08-31
docker compose -f deploy/compose.production.yml exec -T postgres \
  pg_dump -U zhiyun -d zhiyun -Fc > backups/2026-08-31/zhiyun.dump
tar -C deploy -czf backups/2026-08-31/zhiyun-data.tar.gz data
```

将数据库备份、数据目录备份和当时使用的织云镜像版本一起离线保存。不要把 `.env` 放进普通备份；应在独立的秘密管理系统中保存凭据加密密钥。

## 恢复演练

恢复应在隔离主机或隔离 Compose Project 中演练：

1. 使用与备份一致的镜像版本启动空 PostgreSQL 和 Redis。
2. 停止织云服务，恢复 `data` 目录并保留原来的 `ZHIYUN_CREDENTIAL_KEY`。
3. 执行 `pg_restore --clean --if-exists -U zhiyun -d zhiyun` 导入 dump。
4. 启动织云，等待 `/ready`，检查任务数量、最近运行、输出目的地和成员。
5. 触发一个禁用外部输出的测试任务，确认 Chromium、队列和数据快照工作正常。

恢复演练不应复用生产域名或外部输出凭据，以免意外发送 Webhook、覆盖表格或对象。
