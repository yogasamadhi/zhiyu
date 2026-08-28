from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import AsyncIterator
from pathlib import Path

import orjson

from .methods import MethodContext, MethodRegistry, WorkerMethodError
from .models import (
    WorkerJob,
    WorkerJobError,
    WorkerJobEvent,
    WorkerJobSubmission,
    utc_now,
)
from .security import (
    WorkspaceViolation,
    create_job_workspace,
    resolve_input,
    resolve_output,
)


class JobNotFound(KeyError):
    pass


class JobConflict(RuntimeError):
    pass


class MethodNotFound(KeyError):
    pass


class JobManager:
    def __init__(self, workspace_root: Path, methods: MethodRegistry) -> None:
        self.workspace_root = workspace_root.resolve(strict=True)
        self.methods = methods
        self.accepting = True
        self._jobs: dict[str, WorkerJob] = {}
        self._submissions: dict[str, WorkerJobSubmission] = {}
        self._events: dict[str, list[WorkerJobEvent]] = {}
        self._conditions: dict[str, asyncio.Condition] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancellations: dict[str, threading.Event] = {}
        self._semaphore = asyncio.Semaphore(1)

    def get(self, job_id: str) -> WorkerJob:
        try:
            return self._jobs[job_id]
        except KeyError as error:
            raise JobNotFound(job_id) from error

    async def submit(self, submission: WorkerJobSubmission) -> WorkerJob:
        if not self.accepting:
            raise JobConflict("Worker is shutting down")
        existing = self._submissions.get(submission.jobId)
        if existing:
            if existing == submission:
                return self.get(submission.jobId)
            raise JobConflict("Job ID was already used with a different payload")
        descriptor = self.methods.descriptor(submission.methodId)
        if descriptor is None or self.methods.handler(submission.methodId) is None:
            raise MethodNotFound(submission.methodId)
        if descriptor.version != submission.methodVersion:
            raise JobConflict("Requested method version is unavailable")
        workspace = create_job_workspace(self.workspace_root, submission.jobId)
        input_path = (
            resolve_input(workspace, submission.inputArtifactRef)
            if submission.inputArtifactRef is not None
            else None
        )
        resolve_output(workspace, submission.outputArtifactRef)
        job = WorkerJob(
            id=submission.jobId,
            methodId=submission.methodId,
            methodVersion=submission.methodVersion,
            state="queued",
            phase="queued",
            progress=0,
            createdAt=utc_now(),
        )
        self._jobs[job.id] = job
        self._submissions[job.id] = submission
        self._events[job.id] = []
        self._conditions[job.id] = asyncio.Condition()
        self._cancellations[job.id] = threading.Event()
        await self._publish(job)
        self._tasks[job.id] = asyncio.create_task(self._run(submission, workspace, input_path))
        return job

    async def _publish(self, job: WorkerJob) -> None:
        events = self._events[job.id]
        events.append(
            WorkerJobEvent(
                sequence=len(events) + 1,
                jobId=job.id,
                state=job.state,
                phase=job.phase,
                progress=job.progress,
                createdAt=utc_now(),
            )
        )
        condition = self._conditions[job.id]
        async with condition:
            condition.notify_all()

    async def _report(self, job: WorkerJob, phase: str, progress: float) -> None:
        job.phase = phase
        job.progress = min(1, max(0, progress))
        await self._publish(job)

    async def _run(
        self, submission: WorkerJobSubmission, workspace: Path, input_path: Path | None
    ) -> None:
        job = self.get(submission.jobId)
        cancellation = self._cancellations[job.id]
        try:
            async with self._semaphore:
                if cancellation.is_set():
                    raise asyncio.CancelledError
                job.state = "running"
                job.phase = "preparing"
                job.startedAt = utc_now()
                await self._publish(job)
                handler = self.methods.handler(submission.methodId)
                if handler is None:
                    raise MethodNotFound(submission.methodId)
                main_loop = asyncio.get_running_loop()

                async def report_from_worker_thread(phase: str, progress: float) -> None:
                    if cancellation.is_set():
                        raise asyncio.CancelledError
                    future = asyncio.run_coroutine_threadsafe(
                        self._report(job, phase, progress), main_loop
                    )
                    await asyncio.wrap_future(future)
                    if cancellation.is_set():
                        raise asyncio.CancelledError

                context = MethodContext(
                    parameters=submission.parameters,
                    workspace=workspace,
                    input_path=input_path,
                    report=report_from_worker_thread,
                    cancelled=cancellation.is_set,
                )
                result = await asyncio.to_thread(lambda: asyncio.run(handler(context)))
                if cancellation.is_set():
                    raise asyncio.CancelledError
                job.phase = "persisting"
                job.progress = 0.9
                await self._publish(job)
                output = resolve_output(workspace, submission.outputArtifactRef)
                partial = output.with_name(f".{output.name}.partial-{os.getpid()}")
                partial.write_bytes(orjson.dumps(result, option=orjson.OPT_SORT_KEYS))
                partial.replace(output)
                job.state = "succeeded"
                job.phase = "completed"
                job.progress = 1
                job.outputArtifactRef = submission.outputArtifactRef
                job.completedAt = utc_now()
                await self._publish(job)
        except asyncio.CancelledError:
            job.state = "canceled"
            job.phase = "canceled"
            job.completedAt = utc_now()
            await self._publish(job)
        except WorkerMethodError as error:
            job.state = "failed"
            job.phase = "failed"
            job.error = WorkerJobError(
                code=error.code, message=str(error), retryable=error.retryable
            )
            job.completedAt = utc_now()
            await self._publish(job)
        except (WorkspaceViolation, ValueError) as error:
            job.state = "failed"
            job.phase = "failed"
            job.error = WorkerJobError(
                code="INVALID_INPUT", message=str(error), retryable=False
            )
            job.completedAt = utc_now()
            await self._publish(job)
        except Exception:
            job.state = "failed"
            job.phase = "failed"
            job.error = WorkerJobError(
                code="WORKER_JOB_FAILED",
                message="Worker job failed",
                retryable=False,
            )
            job.completedAt = utc_now()
            await self._publish(job)

    async def cancel(self, job_id: str) -> WorkerJob:
        job = self.get(job_id)
        if job.state in {"canceled", "succeeded", "failed"}:
            return job
        was_queued = job.state == "queued"
        job.state = "canceling"
        job.phase = "canceling"
        await self._publish(job)
        self._cancellations[job_id].set()
        if was_queued:
            self._tasks.get(job_id, asyncio.current_task()).cancel()
        return job

    async def events(self, job_id: str, after: int = 0) -> AsyncIterator[WorkerJobEvent]:
        self.get(job_id)
        index = max(after, 0)
        condition = self._conditions[job_id]
        while True:
            events = self._events[job_id]
            while index < len(events):
                event = events[index]
                index += 1
                yield event
            if self.get(job_id).state in {"canceled", "succeeded", "failed"}:
                return
            async with condition:
                await condition.wait()

    async def close(self) -> None:
        self.accepting = False
        pending = [task for task in self._tasks.values() if not task.done()]
        for cancellation in self._cancellations.values():
            cancellation.set()
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
