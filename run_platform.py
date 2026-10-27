#!/usr/bin/env python3
"""ZhiYun commercial platform development launcher.

Starts the Server API, the cloud background worker, the Admin console and the
Portal, after checking the pnpm dependencies and the database migrations.
"""

from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tooling" / "python"))

from development import (  # noqa: E402
    WORKSPACE_ROOT,
    DevelopmentProcesses,
    PortOwner,
    Service,
    assert_ports_available,
    development_environment,
    read_flags,
    release_occupied_ports,
    requested_port,
    require_command,
)
from test_environment import assert_test_database, test_environment  # noqa: E402

HELP = """织云商业平台开发启动器

用法：pnpm run platform:dev [选项]

启动 Server API、云端后台任务、Admin 和 Portal。
默认检查 pnpm 依赖并应用数据库迁移，需要已有 PostgreSQL 和 Redis。
  --infra         先用 Docker Compose 启动本地 PostgreSQL 和 Redis
  --skip-install  使用现有 node_modules
  --skip-migrate  跳过数据库迁移（数据库必须已经初始化）
  --isolated-test 不读取项目环境文件，使用 Mock，并拒绝终止占用端口的进程
  -h, --help      显示帮助

默认端口：Server 3200、Portal 3100、Admin 3101。
启动前会停止任何占用目标 TCP 监听端口的进程，请确认端口配置无误。
支持 CLOUD_PORT、CLOUD_PORTAL_PORT、CLOUD_ADMIN_PORT 及 CLOUD_* 环境配置。
Ctrl+C 停止本次启动的 Server、Worker、Portal、Admin 及其子进程；Docker 数据库保持运行。
"""

ISOLATED_OVERRIDES = (
    "CLOUD_DATABASE_URL",
    "CLOUD_REDIS_URL",
    "CLOUD_PORT",
    "CLOUD_PORTAL_PORT",
    "CLOUD_ADMIN_PORT",
    "CLOUD_SERVER_URL",
    "CLOUD_PORTAL_ORIGIN",
    "CLOUD_ADMIN_ORIGIN",
)


def main() -> int:
    """Run the commercial platform stack until it is interrupted."""
    flags = read_flags(["--skip-install", "--skip-migrate", "--infra", "--isolated-test"], HELP)
    environment = _launcher_environment("--isolated-test" in flags)
    prepare_ports = assert_ports_available if "--isolated-test" in flags else release_occupied_ports
    processes = DevelopmentProcesses(environment)

    try:
        require_command("pnpm")
        require_command("node")
        if environment.get("NODE_ENV") == "production":
            raise RuntimeError("此脚本用于开发；生产环境请使用 platform/deploy 的构建和部署流程。")
        if "--isolated-test" in flags:
            assert_test_database(environment.get("CLOUD_DATABASE_URL", ""), "e2e")
            if "--infra" in flags:
                raise RuntimeError("隔离测试必须使用本轮专属基础设施。")
        api_port = requested_port("CLOUD_PORT", 3200, environment)
        portal_port = requested_port("CLOUD_PORTAL_PORT", 3100, environment)
        admin_port = requested_port("CLOUD_ADMIN_PORT", 3101, environment)
        if len({api_port, portal_port, admin_port}) != 3:
            raise RuntimeError("CLOUD_PORT、CLOUD_PORTAL_PORT、CLOUD_ADMIN_PORT 必须使用不同端口。")
        prepare_ports(
            [
                PortOwner(name="Server API", port=api_port),
                PortOwner(name="Portal", port=portal_port),
                PortOwner(name="Admin", port=admin_port),
            ]
        )
        api_url = f"http://127.0.0.1:{api_port}"
        portal_url = f"http://localhost:{portal_port}"
        admin_url = f"http://localhost:{admin_port}"
        environment.update(
            {
                "CLOUD_PORT": str(api_port),
                "CLOUD_PORTAL_PORT": str(portal_port),
                "CLOUD_ADMIN_PORT": str(admin_port),
                "CLOUD_SERVER_URL": environment.get("CLOUD_SERVER_URL", api_url),
                "CLOUD_PORTAL_ORIGIN": environment.get("CLOUD_PORTAL_ORIGIN", portal_url),
                "CLOUD_ADMIN_ORIGIN": environment.get("CLOUD_ADMIN_ORIGIN", admin_url),
            }
        )
        if "--skip-install" not in flags:
            processes.step("检查 pnpm 依赖", ["pnpm", "install", "--frozen-lockfile"])
        if "--infra" in flags:
            require_command("docker")
            processes.step(
                "启动本地 PostgreSQL / Redis",
                [
                    "docker",
                    "compose",
                    "-f",
                    "platform/deploy/compose.yml",
                    "up",
                    "-d",
                    "--wait",
                    "postgres",
                    "redis",
                ],
            )
        if "--skip-migrate" not in flags:
            processes.step(
                "应用云端数据库迁移",
                ["pnpm", "exec", "tsx", "platform/server/src/migrate.ts"],
            )

        prepare_ports([PortOwner(name="Server API", port=api_port)])
        processes.start(
            Service(
                name="Server API",
                command=["pnpm", "exec", "tsx", "watch", "platform/server/src/start.ts"],
            )
        )
        processes.ready("Server API（PostgreSQL 需可用）", f"{api_url}/api/cloud/v1/health")
        processes.start(
            Service(
                name="Server Worker",
                command=["pnpm", "exec", "tsx", "watch", "platform/server/src/worker.ts"],
            )
        )
        prepare_ports(
            [
                PortOwner(name="Portal", port=portal_port),
                PortOwner(name="Admin", port=admin_port),
            ]
        )
        processes.start(
            Service(
                name="Portal",
                cwd=str(WORKSPACE_ROOT / "platform/portal"),
                command=["pnpm", "exec", "next", "dev", "-p", str(portal_port)],
            )
        )
        processes.start(
            Service(
                name="Admin",
                cwd=str(WORKSPACE_ROOT / "platform/admin"),
                command=[
                    "pnpm",
                    "exec",
                    "vite",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(admin_port),
                    "--strictPort",
                ],
            )
        )
        _wait_for_all(
            processes,
            [
                ("Portal", portal_url),
                ("Admin", admin_url),
            ],
        )
        print(
            f"\n商业平台已就绪：\n"
            f"  Server: {api_url}/api/cloud/v1\n"
            f"  Portal: {portal_url}\n"
            f"  Admin:  {admin_url}\n"
            f"  云端后台任务已启动。\n\n"
            f"按 Ctrl+C 停止商业平台应用。"
        )
        processes.wait()
    except Exception as error:  # noqa: BLE001 - the launcher reports every failure
        print(f"启动失败：{error}", file=sys.stderr)
        processes.shutdown(1)
    return 0


def _launcher_environment(isolated: bool) -> dict[str, str]:
    """Build the environment for the launcher."""
    if not isolated:
        return development_environment()
    environment = test_environment(os.environ)
    for name in ISOLATED_OVERRIDES:
        if name in os.environ:
            environment[name] = os.environ[name]
    return environment


def _wait_for_all(processes: DevelopmentProcesses, targets: list[tuple[str, str]]) -> None:
    """Wait for every service to become ready, failing on the first error."""
    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        futures = [pool.submit(processes.ready, name, url) for name, url in targets]
        for future in futures:
            future.result()


if __name__ == "__main__":
    raise SystemExit(main())
