# 自托管入口调整

2026-09-10 起，原浏览器工作台与 Headless 产品服务已经移除，不再发布该形态的 Linux tar 或 Docker 镜像。采集、统计分析、语料处理和助手工具由 Electron 桌面执行。

需要部署官网、管理后台和商业服务时，请使用 [云端运行与交付手册](../platform/deploy/README.md)。该服务负责账户、模拟支付、订阅、积分与托管 AI，不替代桌面的本地业务运行时。

原 SQLite、凭据与 Artifact 数据不随应用源码删除；数据保留和测试迁移说明见 [应用入口收敛决策](adr/0011-desktop-cloud-apps.md)。
