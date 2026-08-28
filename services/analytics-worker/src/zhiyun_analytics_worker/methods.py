from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from .models import MethodDescriptor

ProgressReporter = Callable[[str, float], Awaitable[None]]
MethodHandler = Callable[[dict[str, Any], ProgressReporter], Awaitable[dict[str, Any]]]


async def self_test_handler(
    parameters: dict[str, Any], report: ProgressReporter
) -> dict[str, Any]:
    delay_ms = parameters.get("delayMs", 0)
    if not isinstance(delay_ms, int) or isinstance(delay_ms, bool) or not 0 <= delay_ms <= 5_000:
        raise ValueError("delayMs must be an integer between 0 and 5000")
    await report("running", 0.5)
    if delay_ms:
        await asyncio.sleep(delay_ms / 1000)
    return {"ok": True, "echo": parameters.get("echo")}


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
        self._descriptors = {SELF_TEST_METHOD.id: SELF_TEST_METHOD}
        self._handlers: dict[str, MethodHandler] = {SELF_TEST_METHOD.id: self_test_handler}

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
