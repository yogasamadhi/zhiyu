# 红果短剧公开信息采集示例

本示例只采集官网公开的短剧元数据，不访问播放页、视频文件或需要登录的接口。

## 任务设置

- Start URL：`https://hongguoduanju.com/sitemap/hongguoduanju/index.xml`
- CrawlPlan：[hongguo-short-drama-plan.json](./hongguo-short-drama-plan.json)
- Browser：关闭；详情数据直接来自 HTML 中的 `_ROUTER_DATA`
- 请求设置：单并发、零重试、建议至少 1500 ms 域名间隔、开启 `respectRobotsTxt`
- 首次运行建议保持示例的 20 条上限；确认字段和站点规则后再逐步调整

计划先读取 sitemap index 和子 sitemap，仅保留 `/detail?series_id=` URL，再从详情页提取剧名、简介、封面、集数、标签、演员等结构化字段。`json` 字段类型会保留数组或对象，不会把它们转成字符串。

站点结构和 robots.txt 可能变化。运行前应确认目标站点的最新服务条款、robots.txt、授权范围与适用法律；遇到禁止路径时，运行时会跳过或按详情失败策略处理，不应通过修改代码绕过限制。
