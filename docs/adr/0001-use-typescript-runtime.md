# ADR 0001: Bun and TypeScript runtime

## Status

Accepted

## Decision

采集、API、Web、AI 和领域包统一使用 strict TypeScript。Bun 负责 workspace、依赖安装、开发脚本编排，并直接运行 API、fixtures 和数据库迁移；Web 与 Desktop Renderer 由 Vite 构建。Python/uv 发布链已由 ADR 0006 取代。

## Consequence

核心 Schema 通过 Zod 在 Client、Runtime、AI Provider 和存储适配器间复用。Bun 的 Node.js 兼容层需要通过 Crawlee、BullMQ 和 Playwright 集成测试持续验证。
