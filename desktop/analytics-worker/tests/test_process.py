from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(url: str, token: str, method: str = "GET") -> tuple[int, dict]:
    try:
        with urlopen(
            Request(url, method=method, headers={"Authorization": f"Bearer {token}"}),
            timeout=5,
        ) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def test_private_stdin_bootstrap_and_graceful_shutdown(tmp_path: Path) -> None:
    token = "process-token-" + "x" * 40
    command = [sys.executable, "-m", "zhiyun_analytics_worker"]
    assert token not in command
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(
        json.dumps({"token": token, "generation": 3, "workspaceRoot": str(tmp_path)}) + "\n"
    )
    process.stdin.close()
    ready = json.loads(process.stdout.readline())
    assert ready["type"] == "ready"
    assert ready["generation"] == 3
    assert ready["baseUrl"].startswith("http://127.0.0.1:")
    assert request(f"{ready['baseUrl']}/health", "wrong")[0] == 401
    assert request(f"{ready['baseUrl']}/health", token) == (200, {"status": "ok"})
    assert request(f"{ready['baseUrl']}/worker/v1/shutdown", token, "POST")[0] == 202
    deadline = time.monotonic() + 5
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if process.poll() is None:
        process.kill()
    assert process.wait(timeout=2) == 0
