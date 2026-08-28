# ADR 0004: Separate Python AI service

## Status

Superseded by ADR 0006

## Decision

原决策使用 FastAPI/PydanticAI 服务。桌面 Level 1 架构改为 TypeScript `packages/ai-runtime`，支持 Mock 和 OpenAI-Compatible provider，并通过 CredentialStore 获取密钥。

## Consequence

Python、uv 与独立服务生命周期已从桌面和 Headless 发布链删除。AI 仍不能写入或自动激活规则。
