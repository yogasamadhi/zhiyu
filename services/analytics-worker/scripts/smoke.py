from __future__ import annotations

import json
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[1]
system = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}.get(
    platform.system(), platform.system().lower()
)
architecture = (
    "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else "x64"
)
executable_name = "analytics-worker.exe" if system == "windows" else "analytics-worker"
default_executable = (
    root
    / "dist"
    / f"{system}-{architecture}"
    / "analytics-worker"
    / executable_name
)
executable = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else default_executable
if not executable.is_file():
    raise SystemExit(f"Packaged Worker executable not found: {executable}")

token = "smoke-token-" + "x" * 48
with tempfile.TemporaryDirectory(prefix="zhiyun-worker-smoke-") as workspace:
    process = subprocess.Popen(
        [str(executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(
        json.dumps({"token": token, "generation": 1, "workspaceRoot": workspace})
        + "\n"
    )
    process.stdin.close()
    ready = json.loads(process.stdout.readline())
    headers = {"Authorization": f"Bearer {token}"}
    with urlopen(Request(f"{ready['baseUrl']}/health", headers=headers), timeout=5) as response:
        if json.load(response) != {"status": "ok"}:
            raise RuntimeError("Packaged Worker health response was invalid")
    with urlopen(
        Request(f"{ready['baseUrl']}/worker/v1/shutdown", headers=headers, method="POST"),
        timeout=5,
    ) as response:
        if response.status != 202:
            raise RuntimeError("Packaged Worker rejected shutdown")
    deadline = time.monotonic() + 10
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if process.poll() is None:
        process.kill()
        raise RuntimeError("Packaged Worker exceeded shutdown budget")
    if process.returncode != 0:
        assert process.stderr is not None
        raise RuntimeError(process.stderr.read())

print(json.dumps({"status": "ok", "executable": str(executable)}))

