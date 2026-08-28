# ADR 0006: Electron Level 1 Runtime

## Status

Accepted

## Decision

桌面版使用 Electron Host + `utilityProcess` Runtime + 沙箱 Renderer。业务继续通过本地 HTTP `/api/v1` 调用，不通过业务 IPC。Desktop 使用 SQLite/Local Queue，Headless 保留 PostgreSQL/Redis/BullMQ；两者实现相同 conformance contracts。

AI Provider 迁移到 TypeScript。凭据、保存对话框、通知、外链和窗口状态属于 Host Capability，不进入 Renderer。

## Consequence

安装包在干净系统不依赖 Bun、Node、Python、Docker、PostgreSQL 或 Redis。Runtime 可以独立崩溃恢复，Web 与 Desktop 复用 UI 和 Client。代价是需要维护 Electron ABI rebuild、Chromium 平台资源与双 Repository conformance。
