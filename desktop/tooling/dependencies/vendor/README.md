# Vendor policy

桌面端的 Pi 和 DeepSeek Harness 上游源码通过 Git submodule 保存在此目录。根目录 `.gitmodules` 登记路径和上游 URL，父仓库的 gitlink 固定具体提交；`vendor.lock.json` 记录对应提交和许可证，更新子模块时同步维护。

| 子模块              | 上游                                                                            | 许可证 |
| ------------------- | ------------------------------------------------------------------------------- | ------ |
| `pi/`               | [earendil-works/pi](https://github.com/earendil-works/pi)                       | MIT    |
| `deepseek-harness/` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT    |

## 初始化

克隆主仓库时使用 `git clone --recurse-submodules`，已有 checkout 在仓库根目录执行：

```bash
git submodule update --init --recursive
git submodule status
```

该命令检出父仓库固定的提交。Desktop CI 和 Release checkout 也递归初始化子模块。

## 更新

先获取上游提交，再检出已选定的版本；以 Pi 为例：

```bash
git -C desktop/tooling/dependencies/vendor/pi fetch origin
git -C desktop/tooling/dependencies/vendor/pi checkout --detach <commit>
```

同步更新 `vendor.lock.json` 中的 `revision`，并将子模块路径和清单一起提交到父仓库。上游源码修改需先在子模块仓库形成可获取的提交，再更新父仓库引用。

## 工程边界

两个子模块保留上游目录、许可证和构建约定，不加入 ZhiYun 的 Bun workspaces。本项目的 ESLint、Prettier、TypeScript、Vitest 和依赖边界检查排除子模块源码；商业平台 Docker context 也排除这两份桌面源码。

源码初始化不会安装上游依赖，也不会切换当前运行时的依赖来源。当前助手使用的 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` 仍由本项目的 `package.json` 和 `bun.lock` 固定版本。

Crawlee 和 Stagehand 继续通过正常 package dependency 使用。

不 Vendor Playwright、Chromium、Firecrawl、Crawl4AI、ScrapeGraphAI、Scrapy。
