# ADR 0005: Own the extraction rule schema

## Status

Accepted

## Decision

数据库持久化 ZhiYun 的 CSS、XPath、JSON Rule Schema，不保存 Crawlee、Cheerio 或 Playwright 内部对象。

## Consequence

规则可版本化、测试、回滚和跨 Runtime 执行，并为未来修复建议保留稳定接口。
