FROM --platform=linux/amd64 mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /opt/zhiyun
COPY apps/api/dist/headless/linux-x64/ ./

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ZHIYUN_ANALYTICS_WORKER_PATH=/opt/zhiyun/analytics-worker/linux-x64/analytics-worker/analytics-worker

RUN chmod 0755 /opt/zhiyun/zhiyun-api \
    /opt/zhiyun/analytics-worker/linux-x64/analytics-worker/analytics-worker

EXPOSE 3001
ENTRYPOINT ["/opt/zhiyun/zhiyun-api"]
