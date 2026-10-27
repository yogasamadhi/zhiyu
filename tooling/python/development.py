"""Shared support code for the ZhiYun development launchers.

The launchers (``run_desktop.py`` and ``run_platform.py``) orchestrate long
running Node.js services, so this module keeps the guarantees of the original
TypeScript implementation: deterministic environment loading, explicit port
checks, readiness polling and process-tree cleanup on shutdown.

The TypeScript twin lives in ``tooling/scripts/development.ts`` and is still
used by the test infrastructure; keep both implementations in sync.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]


def sleep(milliseconds: float) -> None:
    """Pause the current thread for the given number of milliseconds."""
    time.sleep(milliseconds / 1000)


def read_flags(allowed: Sequence[str], help_text: str) -> set[str]:
    """Parse the launcher flags and reject unknown ones."""
    flags = {argument for argument in sys.argv[1:] if argument != "--"}
    if "--help" in flags or "-h" in flags:
        print(help_text)
        raise SystemExit(0)
    unknown = sorted(flag for flag in flags if flag not in allowed)
    if unknown:
        print(
            f"未知参数：{', '.join(unknown)}。使用 --help 查看可用选项。",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return flags


def parse_env_file(content: str) -> dict[str, str]:
    """Parse a ``.env`` file into a mapping.

    Blank lines and ``#`` comments are ignored. Values may be quoted with single
    or double quotes; double quoted values expand the usual escape sequences.
    """
    environment: dict[str, str] = {}
    for raw_line in content.lstrip("﻿").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        environment[key] = _parse_env_value(value.strip())
    return environment


def _parse_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return _expand_env_escapes(value[1:-1])
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    comment = value.find(" #")
    if comment != -1:
        value = value[:comment].rstrip()
    return value


def _expand_env_escapes(value: str) -> str:
    result: list[str] = []
    index = 0
    escapes = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", '"': '"'}
    while index < len(value):
        character = value[index]
        if character == "\\" and index + 1 < len(value):
            following = value[index + 1]
            if following in escapes:
                result.append(escapes[following])
                index += 2
                continue
        result.append(character)
        index += 1
    return "".join(result)


def development_environment() -> dict[str, str]:
    """Load the workspace environment files and overlay the process environment."""
    environment: dict[str, str] = {}

    def read(name: str) -> None:
        path = WORKSPACE_ROOT / name
        if path.is_file():
            environment.update(parse_env_file(path.read_text(encoding="utf-8")))

    read(".env")
    mode = os.environ.get("NODE_ENV") or environment.get("NODE_ENV") or "development"
    read(f".env.{mode}")
    if mode != "test":
        read(".env.local")
    read(f".env.{mode}.local")
    resolved = dict(environment)
    resolved["NODE_ENV"] = mode
    resolved.update(os.environ)
    return resolved


def which_command(command: str) -> str | None:
    """Locate an executable on ``PATH``."""
    if os.name == "nt":
        extensions = (os.environ.get("PATHEXT") or ".EXE;.CMD;.BAT").split(";")
    else:
        extensions = [""]
    for directory in (os.environ.get("PATH") or "").split(os.pathsep):
        if not directory:
            continue
        for extension in extensions:
            candidate = Path(directory) / f"{command}{extension}"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def require_command(command: str) -> None:
    """Fail with a readable message when a required tool is missing."""
    if not which_command(command):
        raise RuntimeError(f"缺少 {command}，请安装后重试。")


def _accepts_connections(host: str, port: int) -> bool:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.3)
            probe.connect((host, port))
            return True
    except OSError:
        return False


def port_available(port: int) -> bool:
    """Report whether the port can be bound exclusively."""
    if _accepts_connections("127.0.0.1", port) or _accepts_connections("::1", port):
        return False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("0.0.0.0", port))
    except OSError:
        return False
    return True


def requested_port(name: str, fallback: int, environment: Mapping[str, str]) -> int:
    """Read a port from the environment and validate its range."""
    raw = environment.get(name, str(fallback))
    try:
        port = int(str(raw).strip())
    except ValueError as error:
        raise RuntimeError(f"{name} 必须是 1 到 65535 之间的整数。") from error
    if port < 1 or port > 65535:
        raise RuntimeError(f"{name} 必须是 1 到 65535 之间的整数。")
    return port


@dataclass(frozen=True)
class PortOwner:
    """A named TCP port the launcher needs."""

    name: str
    port: int


def _command_output(command: Sequence[str]) -> tuple[str, int]:
    try:
        completed = subprocess.run(
            list(command),
            cwd=str(WORKSPACE_ROOT),
            capture_output=True,
            text=True,
        )
    except OSError:
        return "", 1
    return completed.stdout, completed.returncode


def listening_processes(port: int) -> list[int]:
    """Return the process identifiers listening on the given TCP port."""
    if os.name == "nt":
        powershell = which_command("powershell.exe") or which_command("pwsh.exe")
        if not powershell:
            raise RuntimeError(f"端口 {port} 已占用，但找不到 PowerShell 来定位进程。")
        stdout, exit_code = _command_output(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                (
                    "Get-NetTCPConnection -State Listen -LocalPort "
                    f"{port} -ErrorAction SilentlyContinue | "
                    "Select-Object -ExpandProperty OwningProcess -Unique"
                ),
            ]
        )
    else:
        lsof = which_command("lsof")
        if lsof:
            stdout, exit_code = _command_output(
                [lsof, "-nP", "-t", "-a", f"-iTCP:{port}", "-sTCP:LISTEN"]
            )
        else:
            fuser = which_command("fuser")
            if not fuser:
                raise RuntimeError(f"端口 {port} 已占用，但找不到 lsof 或 fuser 来定位进程。")
            stdout, exit_code = _command_output([fuser, "-n", "tcp", str(port)])
    if exit_code not in (0, 1):
        raise RuntimeError(f"查询端口 {port} 的占用进程失败，退出码 {exit_code}。")
    pids: list[int] = []
    for token in stdout.split():
        try:
            pid = int(token)
        except ValueError:
            continue
        if pid > 1 and pid != os.getpid():
            pids.append(pid)
    return list(dict.fromkeys(pids))


def _process_tree(roots: Sequence[int]) -> list[int]:
    if os.name == "nt" or not roots:
        return list(roots)
    stdout, exit_code = _command_output(["ps", "-axo", "pid=,ppid="])
    if exit_code != 0:
        return list(roots)
    relationships: list[tuple[int, int]] = []
    for line in stdout.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            relationships.append((int(parts[0]), int(parts[1])))
        except ValueError:
            continue
    tree = set(roots)
    changed = True
    while changed:
        changed = False
        for pid, parent in relationships:
            if parent not in tree or pid in tree or pid == os.getpid():
                continue
            tree.add(pid)
            changed = True
    return sorted(tree, reverse=True)


def _terminate_processes(pids: Sequence[int], force: bool) -> None:
    if not pids:
        return
    if os.name == "nt":
        for pid in pids:
            _command_output(["taskkill", "/PID", str(pid), "/T"] + (["/F"] if force else []))
        return
    for pid in _process_tree(pids):
        try:
            os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            continue


def _wait_for_free_port(port: int, timeout_ms: int) -> bool:
    deadline = time.monotonic() + timeout_ms / 1000
    free_since: float | None = None
    while time.monotonic() < deadline:
        if port_available(port):
            if free_since is None:
                free_since = time.monotonic()
            # Watchers can restart a listener shortly after its child receives
            # SIGTERM. Require a quiet period before handing the port over.
            if time.monotonic() - free_since >= 1.2:
                return True
        else:
            free_since = None
        sleep(100)
    return False


def release_occupied_ports(ports: Sequence[PortOwner]) -> None:
    """Stop the processes that hold the requested ports."""
    for owner in ports:
        if port_available(owner.port):
            continue
        owners = listening_processes(owner.port)
        if not owners:
            raise RuntimeError(f"{owner.name} 端口 {owner.port} 已占用，但无法确定监听进程。")
        owners_text = ", ".join(str(pid) for pid in owners)
        print(
            f"→ {owner.name} 端口 {owner.port} 已占用，停止进程 {owners_text}",
            flush=True,
        )
        _terminate_processes(owners, False)
        if _wait_for_free_port(owner.port, 3_000):
            continue
        remaining = listening_processes(owner.port)
        if remaining:
            print(
                f"→ {owner.name} 端口 {owner.port} 仍被占用，强制停止进程 "
                f"{', '.join(str(pid) for pid in remaining)}",
                flush=True,
            )
            _terminate_processes(remaining, True)
        if not _wait_for_free_port(owner.port, 2_000):
            raise RuntimeError(
                f"{owner.name} 端口 {owner.port} 无法释放，请检查进程权限或进程管理器。"
            )


def assert_ports_available(ports: Sequence[PortOwner]) -> None:
    """Fail when a port is already in use, without touching the owner."""
    for owner in ports:
        if not port_available(owner.port):
            raise RuntimeError(f"{owner.name} 端口 {owner.port} 已占用；隔离测试不会终止现有进程。")


def select_port(
    name: str,
    fallback: int,
    environment: Mapping[str, str],
    reserved: set[int],
) -> int:
    """Pick a free port, honouring an explicit configuration value."""
    configured = environment.get(name)
    requested = requested_port(name, fallback, environment)
    last = min(requested + 200, 65535) if configured is None else requested
    for port in range(requested, last + 1):
        if port in reserved or not port_available(port):
            continue
        reserved.add(port)
        if port != requested:
            print(f"→ {name} 默认端口 {requested} 已占用，改用 {port}", flush=True)
        return port
    raise RuntimeError(f"{name} 端口 {requested} 已占用或没有可用端口，请修改该环境变量。")


@dataclass
class Service:
    """A managed child process of the launcher."""

    name: str
    command: Sequence[str]
    cwd: str | None = None
    allow_clean_exit: bool = False


@dataclass
class DevelopmentProcesses:
    """Start, supervise and clean up the development processes."""

    environment: dict[str, str] = field(default_factory=dict)
    _children: list[subprocess.Popen] = field(default_factory=list)
    _shutting_down: bool = False
    _shutdown_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        # Keep the handlers installed while the cleanup runs, so repeated
        # Ctrl+C cannot bypass the final process-tree kill.
        for received in (signal.SIGINT, signal.SIGTERM):
            signal.signal(received, self._handle_signal)

    def _handle_signal(self, _signum: int, _frame: object) -> None:
        self.shutdown(0)

    def _spawn(self, service: Service) -> subprocess.Popen:
        if self._shutting_down:
            raise RuntimeError("启动器正在停止。")
        print(f"→ {service.name}", flush=True)
        options: dict[str, object] = {}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            # Own process groups include watch/build grandchildren, never
            # unrelated services.
            options["start_new_session"] = True
        child = subprocess.Popen(
            list(service.command),
            cwd=service.cwd or str(WORKSPACE_ROOT),
            env=dict(self.environment),
            **options,  # type: ignore[arg-type]
        )
        self._children.append(child)
        return child

    def step(self, name: str, command: Sequence[str], cwd: str | None = None) -> None:
        """Run a command to completion and fail when it exits non-zero."""
        child = self._spawn(Service(name=name, command=command, cwd=cwd))
        exit_code = child.wait()
        if exit_code != 0:
            raise RuntimeError(f"{name}失败，退出码 {exit_code}。")
        if child in self._children:
            self._children.remove(child)

    def start(self, service: Service) -> None:
        """Start a long running service and stop the launcher when it dies."""
        child = self._spawn(service)
        threading.Thread(target=self._watch, args=(child, service), daemon=True).start()

    def _watch(self, child: subprocess.Popen, service: Service) -> None:
        exit_code = child.wait()
        if self._shutting_down:
            return
        expected = service.allow_clean_exit and exit_code == 0
        if not expected:
            print(f"{service.name} 意外退出，退出码 {exit_code}。", file=sys.stderr, flush=True)
        self.shutdown(0 if expected else (exit_code or 1))

    def ready(self, name: str, url: str, timeout_ms: int = 90_000) -> None:
        """Wait until the given URL answers with a successful status."""
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            if self._shutting_down:
                raise RuntimeError("启动器正在停止。")
            if _http_ok(url):
                return
            sleep(300)
        raise RuntimeError(f"{name} 未在 {timeout_ms // 1000} 秒内就绪：{url}")

    def _signal(self, child: subprocess.Popen, received: int) -> None:
        try:
            if os.name == "nt":
                if child.poll() is None:
                    _command_output(
                        ["taskkill", "/PID", str(child.pid), "/T"]
                        + (["/F"] if received == signal.SIGKILL else [])
                    )
            else:
                os.killpg(os.getpgid(child.pid), received)
        except (ProcessLookupError, PermissionError, OSError) as error:
            print(f"无法停止子进程 {child.pid}：{error}", file=sys.stderr, flush=True)

    def _tree_alive(self, child: subprocess.Popen) -> bool:
        if os.name == "nt":
            return child.poll() is None
        try:
            os.killpg(os.getpgid(child.pid), 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def _wait_for_trees(self, children: Sequence[subprocess.Popen], timeout_ms: int) -> bool:
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            if not any(self._tree_alive(child) for child in children):
                return True
            sleep(100)
        return not any(self._tree_alive(child) for child in children)

    def wait(self) -> None:
        """Block until the launcher is asked to stop."""
        while not self._shutting_down:
            sleep(200)

    def shutdown(self, exit_code: int) -> None:
        """Stop every managed process tree and exit the launcher."""
        with self._shutdown_lock:
            if self._shutting_down:
                return
            self._shutting_down = True
        print("\n正在停止开发进程…", flush=True)
        children = list(self._children)
        for child in children:
            self._signal(child, signal.SIGTERM)
        self._wait_for_trees(children, 5_000)
        # A watcher may exit before its grandchildren, so also clean the groups
        # whose leader already exited.
        remaining = [child for child in children if self._tree_alive(child)]
        for child in remaining:
            self._signal(child, signal.SIGKILL)
        cleaned = self._wait_for_trees(remaining, 2_000)
        if not cleaned:
            print("部分开发子进程未能确认退出。", file=sys.stderr, flush=True)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1 if (not cleaned and exit_code == 0) else exit_code)


def _http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return 200 <= response.status < 300
    except urllib.error.HTTPError:
        return False
    except (urllib.error.URLError, OSError, ValueError):
        # A listening socket does not imply that the application finished starting.
        return False
