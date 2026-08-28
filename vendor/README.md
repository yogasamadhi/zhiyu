# Vendor policy

第一阶段通过正常 package dependency 使用 Crawlee 和 Stagehand seam，不同步上游源码。只有确认需要长期维护的上游修改时，才将固定提交同步至此目录并更新 `vendor.lock.json`。

不 Vendor Playwright、Chromium、Firecrawl、Crawl4AI、ScrapeGraphAI、Scrapy。
