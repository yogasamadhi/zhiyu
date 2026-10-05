# ADR 0004: Separate Python AI service

> 2026-09-10 更新：本文中的浏览器工作台、Headless 启动和独立发行内容属于历史方案，已由 [应用入口收敛决策](0011-desktop-cloud-apps.md) 替代；本地 Runtime、SQLite、插件与 Worker 的边界继续保留。

## Status

Superseded by ADR 0006

## Decision

原决策使用 FastAPI/PydanticAI 服务。桌面 Level 1 架构改为 TypeScript `desktop/packages/ai-runtime`，支持 Mock 和 OpenAI-Compatible provider，并通过 CredentialStore 获取密钥。

## Consequence

Python、uv 与独立服务生命周期已从桌面和 Headless 发布链删除。AI 仍不能写入或自动激活规则。
