from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .security import validate_artifact_ref

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


CleaningField = Annotated[str, Field(min_length=1, max_length=255)]
CleaningFieldType = Literal["string", "int", "float", "bool", "datetime"]


class CleaningModel(StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CleaningFieldsStep(CleaningModel):
    fields: list[CleaningField] = Field(min_length=1, max_length=50)

    @field_validator("fields")
    @classmethod
    def unique_fields(cls, fields: list[str]) -> list[str]:
        if len(set(fields)) != len(fields):
            raise ValueError("Cleaning fields must be unique")
        return fields


class TrimCleaningStep(CleaningFieldsStep):
    type: Literal["trim"]


class NullCleaningStep(CleaningFieldsStep):
    type: Literal["normalize_null"]
    tokens: list[Annotated[str, Field(max_length=1000)]] = Field(
        default_factory=lambda: ["", "null", "NULL", "N/A"], max_length=50
    )


class ConvertCleaningStep(CleaningFieldsStep):
    type: Literal["convert"]
    targetType: Literal["number", "date"]
    onError: Literal["null", "fail"] = "null"


class SplitCleaningStep(CleaningModel):
    type: Literal["split"]
    field: CleaningField
    delimiter: str = Field(min_length=1, max_length=100)
    targets: list[CleaningField] = Field(min_length=2, max_length=10)

    @field_validator("targets")
    @classmethod
    def valid_targets(cls, targets: list[str]) -> list[str]:
        if len(set(targets)) != len(targets) or any(
            name.startswith("__zhiyun_") for name in targets
        ):
            raise ValueError("Split targets must be unique non-reserved fields")
        return targets


class MergeCleaningStep(CleaningFieldsStep):
    type: Literal["merge"]
    fields: list[CleaningField] = Field(min_length=2, max_length=10)
    target: CleaningField
    separator: str = Field(default=" ", max_length=100)

    @field_validator("target")
    @classmethod
    def valid_target(cls, target: str) -> str:
        if target.startswith("__zhiyun_"):
            raise ValueError("Merge target must not be reserved")
        return target


class DedupeCleaningStep(CleaningFieldsStep):
    type: Literal["dedupe"]


CleaningStep = Annotated[
    TrimCleaningStep
    | NullCleaningStep
    | ConvertCleaningStep
    | SplitCleaningStep
    | MergeCleaningStep
    | DedupeCleaningStep,
    Field(discriminator="type"),
]


class CleaningParameters(CleaningModel):
    fingerprint: str = Field(min_length=64, max_length=64, pattern="^[a-f0-9]{64}$")
    manifestArtifactRef: str = Field(min_length=1, max_length=1024)
    steps: list[CleaningStep] = Field(max_length=20)
    expectedFields: dict[CleaningField, CleaningFieldType] = Field(
        default_factory=dict, max_length=1000
    )
    previewLimit: int = Field(default=10, ge=0, le=100)
    facetLimit: int = Field(default=10, ge=1, le=50)

    @field_validator("manifestArtifactRef")
    @classmethod
    def validate_manifest_ref(cls, value: str) -> str:
        if any(part in {"", ".", ".."} for part in value.split("/")):
            raise ValueError("Manifest reference must be a relative Artifact path")
        validate_artifact_ref(value)
        return value


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
    parameters: dict[str, Any] | CleaningParameters = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_method_parameters(self) -> WorkerJobSubmission:
        if self.methodId == "dataset.clean_snapshot":
            self.parameters = CleaningParameters.model_validate(self.parameters).model_dump(
                mode="json"
            )
        elif isinstance(self.parameters, CleaningParameters):
            self.parameters = self.parameters.model_dump(mode="json")
        return self

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
