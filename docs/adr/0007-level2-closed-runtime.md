# ADR 0007: Level 2 Closed Internal Plugin Runtime

## Status

Accepted

## Decision

ZhiYun 1.0 在现有 Client / Runtime / Host 边界内升级为 Level 2 大型封闭项目架构。Core Runtime 使用第一方 Internal Plugin Runtime 组织稳定 Bounded Context 和可替换 Platform Capability，正式组合模型为 Plugin → Bundle → Product Profile → Effective Core Graph Revision。

Kernel 只负责 Graph 解析、生命周期、Effect、Typed Service、迁移、Contribution staging 和诊断。生产 Graph 启动后不可变；所有代码均由 ZhiYun 构建、签名并随产品发布，不支持第三方插件、公共 SDK、Marketplace 或运行期热加载。

## Consequence

任务、数据集、输出、分析、语料、偏好和 AI Assistance 拥有独立 Contract、Repository、迁移、路由、事件和 UI Contribution。禁止跨 Plugin 实现导入和数据库访问。代价是需要维护 Graph、Effect、Migration ownership、Architecture Catalog 和多 Profile conformance。
