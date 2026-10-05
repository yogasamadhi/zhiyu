from __future__ import annotations

import asyncio
import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import orjson
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response, StreamingResponse

from . import __version__
from .jobs import JobConflict, JobManager, JobNotFound, MethodNotFound
from .methods import MethodRegistry
from .models import (
    MethodDescriptor,
    Problem,
    WorkerCapabilities,
    WorkerJob,
    WorkerJobSubmission,
    WorkerVersion,
)
from .security import WorkspaceViolation


class WorkerApplicationState:
    def __init__(self, token: str, generation: int, workspace_root: Path) -> None:
        self.token = token
        self.generation = generation
        self.methods = MethodRegistry()
        self.jobs = JobManager(workspace_root, self.methods)
        self.shutdown_callback: Callable[[], None] | None = None


def problem(status_code: int, code: str, detail: str) -> Response:
    body = Problem(
        title=code.replace("_", " ").title(),
        status=status_code,
        code=code,
        detail=detail,
    )
    return Response(
        status_code=status_code,
        content=orjson.dumps(body.model_dump(mode="json")),
        media_type="application/problem+json",
    )


def create_app(token: str, generation: int, workspace_root: Path) -> FastAPI:
    state = WorkerApplicationState(token, generation, workspace_root)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        await state.jobs.close()

    app = FastAPI(
        title="ZhiYun Analytics Worker",
        version=__version__,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        responses={
            400: {"model": Problem},
            401: {"model": Problem},
            404: {"model": Problem},
            409: {"model": Problem},
            422: {"model": Problem},
            503: {"model": Problem},
        },
        lifespan=lifespan,
    )
    app.state.worker = state

    async def authenticate(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {state.token}"
        if authorization is None or not secrets.compare_digest(authorization, expected):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, error: HTTPException) -> Response:
        code = "UNAUTHORIZED" if error.status_code == 401 else "WORKER_REQUEST_FAILED"
        return problem(error.status_code, code, str(error.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _error: RequestValidationError) -> Response:
        return problem(422, "INVALID_INPUT", "Worker request validation failed")

    @app.exception_handler(WorkspaceViolation)
    async def workspace_error(_request: Request, error: WorkspaceViolation) -> Response:
        return problem(400, "ARTIFACT_PATH_INVALID", str(error))

    protected = [Depends(authenticate)]

    @app.get("/health", dependencies=protected, operation_id="getHealth")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get(
        "/worker/v1/version",
        dependencies=protected,
        response_model=WorkerVersion,
        operation_id="getWorkerVersion",
    )
    async def version() -> WorkerVersion:
        return WorkerVersion(workerVersion=__version__, generation=state.generation)

    @app.get(
        "/worker/v1/capabilities",
        dependencies=protected,
        response_model=WorkerCapabilities,
        operation_id="getWorkerCapabilities",
    )
    async def capabilities() -> WorkerCapabilities:
        return WorkerCapabilities()

    @app.get(
        "/worker/v1/methods",
        dependencies=protected,
        response_model=list[MethodDescriptor],
        operation_id="listWorkerMethods",
    )
    async def methods() -> list[MethodDescriptor]:
        return state.methods.list()

    @app.post(
        "/worker/v1/jobs",
        dependencies=protected,
        response_model=WorkerJob,
        status_code=202,
        operation_id="submitWorkerJob",
    )
    async def submit_job(submission: WorkerJobSubmission) -> WorkerJob | Response:
        try:
            return await state.jobs.submit(submission)
        except MethodNotFound:
            return problem(404, "METHOD_NOT_FOUND", "Requested method is unavailable")
        except JobConflict as error:
            return problem(409, "ANALYSIS_JOB_CONFLICT", str(error))
        except WorkspaceViolation as error:
            return problem(400, "ARTIFACT_PATH_INVALID", str(error))

    @app.get(
        "/worker/v1/jobs/{job_id}",
        dependencies=protected,
        response_model=WorkerJob,
        operation_id="getWorkerJob",
    )
    async def get_job(job_id: str) -> WorkerJob | Response:
        try:
            return state.jobs.get(job_id)
        except JobNotFound:
            return problem(404, "JOB_NOT_FOUND", "Worker Job does not exist")

    @app.get(
        "/worker/v1/jobs/{job_id}/events",
        dependencies=protected,
        response_model=None,
        operation_id="streamWorkerJobEvents",
    )
    async def job_events(job_id: str, last_event_id: int = 0) -> Response:
        try:
            state.jobs.get(job_id)
        except JobNotFound:
            return problem(404, "JOB_NOT_FOUND", "Worker Job does not exist")

        async def stream() -> AsyncIterator[bytes]:
            async for event in state.jobs.events(job_id, last_event_id):
                payload = orjson.dumps(event.model_dump(mode="json"))
                yield b"id: " + str(event.sequence).encode() + b"\n"
                yield b"event: progress\n"
                yield b"data: " + payload + b"\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post(
        "/worker/v1/jobs/{job_id}/cancel",
        dependencies=protected,
        response_model=WorkerJob,
        status_code=202,
        operation_id="cancelWorkerJob",
    )
    async def cancel_job(job_id: str) -> WorkerJob | Response:
        try:
            return await state.jobs.cancel(job_id)
        except JobNotFound:
            return problem(404, "JOB_NOT_FOUND", "Worker Job does not exist")

    @app.post(
        "/worker/v1/shutdown",
        dependencies=protected,
        status_code=202,
        operation_id="shutdownWorker",
    )
    async def shutdown() -> dict[str, bool]:
        state.jobs.accepting = False
        if state.shutdown_callback is not None:
            asyncio.get_running_loop().call_later(0.05, state.shutdown_callback)
        return {"accepted": True}

    return app
