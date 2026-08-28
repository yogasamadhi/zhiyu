# ADR 0002: Crawlee adapter

## Status

Accepted

## Decision

HTTP 与 Browser crawling 使用 Crawlee，但业务只依赖 `CrawlerRuntime`、`CrawlRequest` 和 `CrawlResult`。

## Consequence

获得队列、重试、并发和 session 生命周期能力，同时保留替换底层实现的边界。
