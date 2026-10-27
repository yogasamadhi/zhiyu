#!/usr/bin/env python3
"""ZhiYun desktop development launcher.

Starts the local fixture server, the Vite renderer and Electron, after
checking the pnpm dependencies and the Python worker environment.
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
    Service,
    development_environment,
    read_flags,
    require_command,
    select_port,
)

HELP = """织云桌面开发启动器

用法：pnpm run dev [--skip-install]
      pnpm run desktop:dev

默认检查 pnpm 依赖、同步 Python 环境、构建并启动 Electron、Renderer 和本地测试站点。
  --skip-install  使用现有 node_modules 和 Python 虚拟环境
  -h, --help      显示帮助

端口可通过 DESKTOP_RENDERER_PORT、FIXTURE_PORT 配置。
首次开发请先执行 pnpm run desktop:browser 安装本地 Chromium。
"""


def main() -> int:
    """Run the desktop development stack until it is interrupted."""
    flags = read_flags(["--skip-install", "--desktop"], HELP)
    environment = development_environment()
    processes = DevelopmentProcesses(environment)

    try:
        require_command("pnpm")
        require_command("node")
        reserved: set[int] = set()
        fixture_port = select_port("FIXTURE_PORT", 45100, environment, reserved)
        renderer_port = select_port("DESKTOP_RENDERER_PORT", 45174, environment, reserved)
        fixture_url = f"http://127.0.0.1:{fixture_port}"
        renderer_url = f"http://127.0.0.1:{renderer_port}"
        environment.update(
            {
                "FIXTURE_PORT": str(fixture_port),
                "DESKTOP_RENDERER_PORT": str(renderer_port),
                "VITE_FIXTURE_URL": fixture_url,
                "ZHIYUN_DESKTOP_DEV_URL": renderer_url,
            }
        )

        if "--skip-install" not in flags:
            require_command("uv")
            processes.step("检查 pnpm 依赖", ["pnpm", "install", "--frozen-lockfile"])
            processes.step(
                "同步 Python Worker",
                ["uv", "sync", "--frozen"],
                str(WORKSPACE_ROOT / "desktop/analytics-worker"),
            )
        python = (
            WORKSPACE_ROOT
            / "desktop/analytics-worker/.venv"
            / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        )
        if not python.exists():
            raise RuntimeError("Python 环境缺失，请先执行 pnpm run worker:sync。")

        desktop_root = WORKSPACE_ROOT / "desktop"
        processes.step(
            "构建桌面应用", ["pnpm", "exec", "tsx", "scripts/build.ts"], str(desktop_root)
        )
        processes.start(
            Service(
                name="Fixtures",
                command=["pnpm", "exec", "tsx", "watch", "src/server.ts"],
                cwd=str(WORKSPACE_ROOT / "desktop/tooling/fixtures"),
            )
        )
        processes.start(
            Service(
                name="Desktop Renderer",
                command=["pnpm", "exec", "vite", "--host", "127.0.0.1"],
                cwd=str(desktop_root),
            )
        )
        _wait_for_all(
            processes,
            [
                ("Fixtures", f"{fixture_url}/products"),
                ("Desktop Renderer", renderer_url),
            ],
        )
        processes.start(
            Service(
                name="Electron",
                command=["node", "node_modules/electron/cli.js", "."],
                cwd=str(desktop_root),
                allow_clean_exit=True,
            )
        )
        print(
            f"\n桌面开发服务已启动：\n"
            f"  Renderer: {renderer_url}\n"
            f"  本地测试站点: {fixture_url}/products\n"
            f"  Python Worker 与本地运行时由 Electron 管理。\n\n"
            f"按 Ctrl+C 停止桌面开发进程。"
        )
        processes.wait()
    except Exception as error:  # noqa: BLE001 - the launcher reports every failure
        print(f"启动失败：{error}", file=sys.stderr)
        processes.shutdown(1)
    return 0


def _wait_for_all(processes: DevelopmentProcesses, targets: list[tuple[str, str]]) -> None:
    """Wait for every service to become ready, failing on the first error."""
    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        futures = [pool.submit(processes.ready, name, url) for name, url in targets]
        for future in futures:
            future.result()


if __name__ == "__main__":
    raise SystemExit(main())
