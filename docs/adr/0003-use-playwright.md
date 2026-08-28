# ADR 0003: Playwright browser runtime

## Status

Accepted

## Decision

JavaScript 动态页面和已知自动化操作使用 Playwright。Stagehand 只作为可选 adapter，不进入默认链路。

## Consequence

普通动态采集可预测、可调试，也不产生不必要的 LLM 调用。
