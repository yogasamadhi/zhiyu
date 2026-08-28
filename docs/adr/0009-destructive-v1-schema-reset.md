# ADR 0009: Destructive ZhiYun 1.0 Schema Reset

## Status

Accepted

## Decision

ZhiYun 1.0 使用全新 Product Schema 和 `/api/v2`，不兼容 0.x API 和数据。首次启动检测到明确的 0.x legacy signature 时，自动清空已知 ZhiYun 数据库对象、Artifact、Credential 和 Job Workspace，不备份、不导入、不请求确认。

删除必须使用 Architecture Catalog 或固定 allowlist 精确解析目标。Desktop 只能处理 Electron `userData` 下的已知子路径；PostgreSQL 只能删除已知 ZhiYun 表；Redis 只能删除已知 Queue/Key prefix。未知 Schema 必须拒绝启动，禁止猜测性删除或清空整个数据库/Schema/Redis DB。

## Consequence

1.0 升级会永久丢失 0.x 业务数据和凭据。Reset 必须具有 marker、幂等恢复、路径安全和故障测试。1.0 Schema 建立后只执行 forward-only Plugin Migration。
