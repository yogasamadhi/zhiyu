from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

WorkerJobState = Literal[
    "queued",
    "running",
    "canceling",
    "canceled",
    "succeeded",
    "failed",
]


def utc_now() -> datetime:
    return datetime.now(UTC)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkerBootstrap(StrictModel):
    token: str = Field(min_length=32, max_length=512)
    generation: int = Field(ge=1)
    workspaceRoot: str = Field(min_length=1)


class WorkerReady(StrictModel):
    type: Literal["ready"] = "ready"
    baseUrl: str
    generation: int
    protocolVersion: Literal["worker/v1"] = "worker/v1"
    workerVersion: str
    pid: int


class WorkerVersion(StrictModel):
    protocolVersion: Literal["worker/v1"] = "worker/v1"
    workerVersion: str
    generation: int


class WorkerCapabilities(StrictModel):
    externalNetwork: Literal[False] = False
    arbitraryCodeExecution: Literal[False] = False
    arbitrarySqlExecution: Literal[False] = False
    maxConcurrentJobs: Literal[1] = 1
    workspaceIsolation: Literal[True] = True


class MethodDescriptor(StrictModel):
    id: str
    version: str
    category: str
    titleKey: str
    descriptionKey: str
    parameterSchema: dict[str, Any]
    outputSchema: dict[str, Any]
    supportedFieldTypes: list[str] = Field(default_factory=list)
    recommendedVisualizations: list[str] = Field(default_factory=list)
    resourceLimits: dict[str, Any] = Field(default_factory=dict)
    supportsSampling: bool = False
    internal: bool = False


class WorkerJobSubmission(StrictModel):
    jobId: str = Field(min_length=1, max_length=128)
    methodId: str = Field(min_length=1, max_length=128)
    methodVersion: str = Field(min_length=1, max_length=64)
    inputArtifactRef: str | None = Field(default=None, max_length=1024)
    outputArtifactRef: str = Field(default="result.json", min_length=1, max_length=1024)
    parameters: dict[str, Any] = Field(default_factory=dict)

    @field_validator("jobId")
    @classmethod
    def validate_job_id(cls, value: str) -> str:
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        if any(character not in allowed for character in value):
            raise ValueError("jobId contains unsupported characters")
        return value


class WorkerJobError(StrictModel):
    code: str
    message: str
    retryable: bool = False


class WorkerJob(StrictModel):
    id: str
    methodId: str
    methodVersion: str
    state: WorkerJobState
    phase: str
    progress: float = Field(ge=0, le=1)
    outputArtifactRef: str | None = None
    error: WorkerJobError | None = None
    createdAt: datetime
    startedAt: datetime | None = None
    completedAt: datetime | None = None


class WorkerJobEvent(StrictModel):
    sequence: int = Field(ge=1)
    jobId: str
    state: WorkerJobState
    phase: str
    progress: float = Field(ge=0, le=1)
    createdAt: datetime


class Problem(StrictModel):
    type: str = "about:blank"
    title: str
    status: int
    code: str
    detail: str
