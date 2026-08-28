# 核心概念

## Task

一个可重复执行的采集配置，包含入口 URL、自然语言需求、请求控制、浏览器、分页、调度和输出设置。

## Rule 与 RuleVersion

Rule 是任务中的规则身份；RuleVersion 保存不可变定义。修改规则会创建下一版本并更新 activeVersionId，而不是覆盖历史。MVP 支持 CSS、XPath 和 JSONPath。

## Analysis 与 Test

Analysis 获取页面并给出 Candidate Rule，但不持久化。Test 使用候选规则抓取最多 10 条记录，也不修改数据库。只有用户确认 Save Rule 后才创建 RuleVersion。

## Run 与 Record

Run 是一次确定的执行，状态为 queued、running、succeeded 或 failed。Record 保存 sourceUrl 和 JSONB data。日志与 Run metadata 同时保留引擎、耗时、请求数、记录数以及 AI/Browser 使用情况。

## 确定性优先

路由顺序是 JSON/API、HTTP/DOM、Playwright、AI 辅助。AI 适合首次生成候选，而不是每次重复运行。
