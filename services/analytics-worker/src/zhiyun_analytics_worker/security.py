from __future__ import annotations

import re
from pathlib import Path, PurePosixPath

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")


class WorkspaceViolation(ValueError):
    pass


def validate_artifact_ref(value: str) -> PurePosixPath:
    if not value or "\\" in value or _WINDOWS_DRIVE.match(value):
        raise WorkspaceViolation("Artifact reference must be a relative POSIX path")
    reference = PurePosixPath(value)
    if reference.is_absolute() or any(part in {"", ".", ".."} for part in reference.parts):
        raise WorkspaceViolation("Artifact reference escapes its Job Workspace")
    return reference


def ensure_within(path: Path, root: Path) -> Path:
    resolved_root = root.resolve(strict=True)
    resolved = path.resolve(strict=False)
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise WorkspaceViolation("Resolved path escapes its Job Workspace")
    return resolved


def create_job_workspace(workspace_root: Path, job_id: str) -> Path:
    root = workspace_root.resolve(strict=True)
    workspace = root / job_id
    workspace.mkdir(mode=0o700, parents=False, exist_ok=True)
    return ensure_within(workspace, root)


def resolve_input(workspace: Path, artifact_ref: str) -> Path:
    reference = validate_artifact_ref(artifact_ref)
    candidate = ensure_within(workspace.joinpath(*reference.parts), workspace)
    if not candidate.is_file():
        raise WorkspaceViolation("Input Artifact does not exist")
    return candidate.resolve(strict=True)


def resolve_output(workspace: Path, artifact_ref: str) -> Path:
    reference = validate_artifact_ref(artifact_ref)
    candidate = workspace.joinpath(*reference.parts)
    candidate.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    ensure_within(candidate.parent, workspace)
    if candidate.exists():
        ensure_within(candidate.resolve(strict=True), workspace)
    return ensure_within(candidate, workspace)

