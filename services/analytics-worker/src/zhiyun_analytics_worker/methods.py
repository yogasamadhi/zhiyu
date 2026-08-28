from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .analytics import (
    ANALYSIS_METHODS,
    AnalysisResourceError,
    AnalysisValidationError,
    execute_analysis,
)
from .corpus import (
    CORPUS_BUILD_METHOD,
    CorpusResourceError,
    CorpusValidationError,
    build_corpus,
)
from .models import MethodDescriptor
from .normalization import (
    NORMALIZE_SNAPSHOT_METHOD,
    NormalizationResourceError,
    normalize_snapshot,
)

ProgressReporter = Callable[[str, float], Awaitable[None]]


@dataclass(frozen=True)
class MethodContext:
    parameters: dict[str, Any]
    workspace: Path
    input_path: Path | None
    report: ProgressReporter
    cancelled: Callable[[], bool]


MethodHandler = Callable[[MethodContext], Awaitable[dict[str, Any]]]


class WorkerMethodError(ValueError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


async def self_test_handler(context: MethodContext) -> dict[str, Any]:
    delay_ms = context.parameters.get("delayMs", 0)
    if not isinstance(delay_ms, int) or isinstance(delay_ms, bool) or not 0 <= delay_ms <= 5_000:
        raise ValueError("delayMs must be an integer between 0 and 5000")
    await context.report("running", 0.5)
    remaining = delay_ms / 1000
    while remaining > 0:
        if context.cancelled():
            raise asyncio.CancelledError
        interval = min(remaining, 0.05)
        await asyncio.sleep(interval)
        remaining -= interval
    return {"ok": True, "echo": context.parameters.get("echo")}


async def normalize_snapshot_handler(context: MethodContext) -> dict[str, Any]:
    if context.input_path is None:
        raise WorkerMethodError(
            "INVALID_INPUT", "Snapshot normalization requires an input Artifact"
        )
    try:
        return await normalize_snapshot(
            input_path=context.input_path,
            workspace=context.workspace,
            parameters=context.parameters,
            report=context.report,
            cancelled=context.cancelled,
        )
    except NormalizationResourceError as error:
        raise WorkerMethodError("RESOURCE_LIMIT_EXCEEDED", str(error)) from error
    except WorkerMethodError:
        raise
    except OSError as error:
        if error.errno == 28:
            raise WorkerMethodError(
                "RESOURCE_LIMIT_EXCEEDED", "Insufficient temporary disk for Snapshot normalization"
            ) from error
        raise


def analysis_handler(method_id: str) -> MethodHandler:
    async def run(context: MethodContext) -> dict[str, Any]:
        try:
            return await execute_analysis(context, method_id)
        except AnalysisResourceError as error:
            raise WorkerMethodError("RESOURCE_LIMIT_EXCEEDED", str(error)) from error
        except AnalysisValidationError as error:
            raise WorkerMethodError("METHOD_INCOMPATIBLE", str(error)) from error

    return run


async def corpus_build_handler(context: MethodContext) -> dict[str, Any]:
    if context.input_path is None:
        raise WorkerMethodError("INVALID_INPUT", "Corpus build requires a Snapshot Artifact")
    try:
        return await build_corpus(
            input_path=context.input_path,
            workspace=context.workspace,
            parameters=context.parameters,
            report=context.report,
            cancelled=context.cancelled,
        )
    except CorpusResourceError as error:
        raise WorkerMethodError("RESOURCE_LIMIT_EXCEEDED", str(error)) from error
    except CorpusValidationError as error:
        raise WorkerMethodError("METHOD_INCOMPATIBLE", str(error)) from error


SELF_TEST_METHOD = MethodDescriptor(
    id="worker.self_test",
    version="1.0.0",
    category="internal",
    titleKey="worker.methods.selfTest.title",
    descriptionKey="worker.methods.selfTest.description",
    parameterSchema={
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "echo": {"type": ["string", "number", "boolean", "null"]},
            "delayMs": {"type": "integer", "minimum": 0, "maximum": 5000},
        },
    },
    outputSchema={
        "type": "object",
        "required": ["ok", "echo"],
        "properties": {"ok": {"type": "boolean"}, "echo": {}},
    },
    internal=True,
)


class MethodRegistry:
    def __init__(self) -> None:
        self._descriptors = {
            SELF_TEST_METHOD.id: SELF_TEST_METHOD,
            NORMALIZE_SNAPSHOT_METHOD.id: NORMALIZE_SNAPSHOT_METHOD,
            CORPUS_BUILD_METHOD.id: CORPUS_BUILD_METHOD,
            **{item.id: item for item in ANALYSIS_METHODS},
        }
        self._handlers: dict[str, MethodHandler] = {
            SELF_TEST_METHOD.id: self_test_handler,
            NORMALIZE_SNAPSHOT_METHOD.id: normalize_snapshot_handler,
            CORPUS_BUILD_METHOD.id: corpus_build_handler,
            **{item.id: analysis_handler(item.id) for item in ANALYSIS_METHODS},
        }

    def list(self, *, include_internal: bool = False) -> list[MethodDescriptor]:
        methods = self._descriptors.values()
        return sorted(
            [item for item in methods if include_internal or not item.internal],
            key=lambda item: item.id,
        )

    def descriptor(self, method_id: str) -> MethodDescriptor | None:
        return self._descriptors.get(method_id)

    def handler(self, method_id: str) -> MethodHandler | None:
        return self._handlers.get(method_id)
