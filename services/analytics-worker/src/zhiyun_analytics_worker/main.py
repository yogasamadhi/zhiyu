from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

import uvicorn
from pydantic import ValidationError

from . import __version__
from .app import create_app
from .models import WorkerBootstrap, WorkerReady

MAX_BOOTSTRAP_BYTES = 64 * 1024


def read_bootstrap() -> WorkerBootstrap:
    line = sys.stdin.buffer.readline(MAX_BOOTSTRAP_BYTES + 1)
    if not line or len(line) > MAX_BOOTSTRAP_BYTES:
        raise ValueError("Missing or oversized Worker bootstrap")
    return WorkerBootstrap.model_validate_json(line)


def prepare_workspace(raw_path: str) -> Path:
    requested = Path(raw_path)
    if not requested.is_absolute():
        raise ValueError("Worker workspace root must be absolute")
    requested.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = requested.resolve(strict=True)
    if root == Path(root.anchor):
        raise ValueError("Worker workspace root cannot be a filesystem root")
    return root


async def serve(bootstrap: WorkerBootstrap) -> None:
    workspace = prepare_workspace(bootstrap.workspaceRoot)
    application = create_app(bootstrap.token, bootstrap.generation, workspace)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(2048)
    listener.setblocking(False)
    port = listener.getsockname()[1]
    config = uvicorn.Config(
        application,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    application.state.worker.shutdown_callback = lambda: setattr(server, "should_exit", True)
    task = asyncio.create_task(server.serve(sockets=[listener]))
    for _attempt in range(400):
        if server.started:
            break
        if task.done():
            await task
            raise RuntimeError("Worker server stopped before becoming ready")
        await asyncio.sleep(0.025)
    else:
        server.should_exit = True
        await task
        raise TimeoutError("Worker server did not become ready")
    ready = WorkerReady(
        baseUrl=f"http://127.0.0.1:{port}",
        generation=bootstrap.generation,
        workerVersion=__version__,
        pid=os.getpid(),
    )
    sys.stdout.write(json.dumps(ready.model_dump(mode="json"), separators=(",", ":")) + "\n")
    sys.stdout.flush()
    await task


def run() -> None:
    try:
        bootstrap = read_bootstrap()
        asyncio.run(serve(bootstrap))
    except (ValidationError, ValueError, RuntimeError, TimeoutError) as error:
        sys.stderr.write(f"analytics worker startup failed: {error}\n")
        raise SystemExit(1) from error


if __name__ == "__main__":
    run()

