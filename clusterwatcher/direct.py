"""Launch and monitor unscheduled jobs on explicitly configured SSH hosts.

Each job has a private manifest and a tmux session on its chosen host. The
manifest remains after tmux exits, so a separate Cluster Watcher process can
recover terminal state and the two log paths without a local database. Slurm
``#SBATCH`` lines supply names and log filenames; they do not allocate or
enforce CPU, GPU, memory, or wall-time limits on these unmanaged machines.
"""

from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import posixpath
import re
import secrets
import shlex
import subprocess
import time

from .models import ClusterStatus, Machine
from .ssh import run_remote


STATE_DIRECTORY = ".local/share/cluster-watcher/direct-jobs"
_MAX_SCRIPT_HEADER_BYTES = 65536
_JOB_ID = re.compile(r"[0-9]+")


def _member(machine: Machine, host: str) -> Machine:
    """Select one named host without the login-node failover used by Slurm."""
    if machine.scheduler != "direct" or host not in machine.candidate_hosts:
        raise ValueError(f"{host!r} is not a direct SSH member of {machine.name!r}")
    return machine.for_host(host)


def _remote_path(value: str, label: str) -> str:
    """Accept one absolute remote path without control characters."""
    if not isinstance(value, str) or not value.startswith("/") or any(ord(char) < 32 for char in value):
        raise ValueError(f"{label} must be an absolute remote path without control characters")
    return posixpath.normpath(value)


def _script_name(value: str) -> str:
    """Accept a filename within the separately supplied working directory."""
    if (not isinstance(value, str) or value in {"", ".", ".."}
            or "/" in value or any(ord(char) < 32 for char in value)):
        raise ValueError("script must be a filename in the remote directory")
    return value


def _directives(header: str) -> dict[str, str]:
    """Read Slurm-style header options until the first executable line."""
    values: dict[str, str] = {}
    aliases = {"-J": "--job-name", "-o": "--output", "-e": "--error",
               "-c": "--cpus-per-task", "-n": "--ntasks", "-N": "--nodes",
               "-t": "--time", "-a": "--array", "-d": "--dependency"}
    for line in header.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") and not stripped.startswith("#SBATCH"):
            continue
        if not stripped.startswith("#SBATCH"):
            break
        try:
            tokens = shlex.split(stripped[len("#SBATCH"):].strip())
        except ValueError as exc:
            raise ValueError(f"invalid #SBATCH directive: {exc}") from exc
        if not tokens:
            continue
        option, separator, attached = tokens[0].partition("=")
        option = aliases.get(option, option)
        if option in {"--array", "--dependency"}:
            raise ValueError(f"{option} is not supported for direct SSH jobs")
        if option not in {"--job-name", "--output", "--error", "--cpus-per-task",
                          "--ntasks", "--nodes", "--gpus", "--gres", "--time"}:
            continue
        value = attached if separator else (tokens[1] if len(tokens) > 1 else "")
        if not value:
            raise ValueError(f"{option} needs a value")
        values[option] = value
    if _positive_int(values.get("--nodes"), "--nodes", 1) != 1:
        raise ValueError("direct SSH jobs run on exactly one selected host; --nodes must be 1")
    return values


def _positive_int(value: str | None, label: str, default: int) -> int:
    """Parse an advisory resource request without treating it as a reservation."""
    if value is None:
        return default
    if not value.isdecimal() or int(value) < 1:
        raise ValueError(f"{label} must be a positive integer")
    return int(value)


def _gpu_request(values: dict[str, str]) -> int:
    """Read an advisory GPU count from one common Slurm option form."""
    if "--gpus" in values:
        return _positive_int(values["--gpus"], "--gpus", 0)
    gres = values.get("--gres")
    if not gres:
        return 0
    entries = [entry for entry in gres.split(",") if entry.startswith("gpu:")]
    if not entries:
        return 0
    return sum(_positive_int(entry.rsplit(":", 1)[-1], "--gres gpu count", 0) for entry in entries)


def _log_path(pattern: str, directory: str, job_id: str, name: str, host: str, username: str) -> str:
    """Expand supported Slurm filename tokens and resolve against workdir."""
    substitutions = {"%": "%", "j": job_id, "x": name, "N": host.split(".")[0], "u": username}

    def replace(match: re.Match[str]) -> str:
        token = match.group(1)
        if token not in substitutions:
            raise ValueError(f"unsupported direct-job log filename token: %{token}")
        return substitutions[token]

    expanded = re.sub(r"%(.)", replace, pattern)
    if "%" in re.sub(r"%.", "", pattern):
        raise ValueError("incomplete % token in direct-job log filename")
    return _remote_path(posixpath.join(directory, expanded), "log filename")


def _runner(directory: str, script: str, stdout: str, stderr: str) -> str:
    """Return the remote process wrapper that records actual exit status."""
    output = shlex.quote(stdout)
    error = shlex.quote(stderr)
    execution = (f"bash -- {shlex.quote(script)} > {output} 2>&1" if stdout == stderr
                 else f"bash -- {shlex.quote(script)} > {output} 2> {error}")
    return "\n".join((
        "#!/bin/sh",
        'state_dir=$(dirname "$0")',
        f"cd {shlex.quote(directory)} || exit 125",
        "date -u +%Y-%m-%dT%H:%M:%SZ > \"$state_dir/start_at\"",
        execution,
        "code=$?",
        "date -u +%Y-%m-%dT%H:%M:%SZ > \"$state_dir/end_at\"",
        "printf '%s\\n' \"$code\" > \"$state_dir/exit_code\"",
        'exit "$code"',
    )) + "\n"


def submit_job(machine: Machine, host: str, directory: str, script: str, timeout: int = 15) -> dict[str, object]:
    """Start one existing remote script inside a detached tmux session.

    A transport failure is never replayed on another host: the job may have
    started even if the acknowledgement was lost. The generated ID is returned
    in the error so callers can inspect the remote state before retrying.
    """
    endpoint = _member(machine, host)
    directory = _remote_path(directory, "directory")
    script = _script_name(script)
    script_path = posixpath.join(directory, script)
    preflight = (f"test -d {shlex.quote(directory)} && test -f {shlex.quote(script_path)} "
                 "&& command -v tmux >/dev/null && command -v bash >/dev/null "
                 f"&& head -c {_MAX_SCRIPT_HEADER_BYTES} {shlex.quote(script_path)}")
    header = run_remote(endpoint, timeout, preflight, failover=False)
    values = _directives(header)
    job_id = f"{time.time_ns() // 1000}{secrets.randbelow(10000):04d}"
    name = values.get("--job-name") or posixpath.splitext(script)[0]
    if any(ord(char) < 32 for char in name):
        raise ValueError("--job-name must not contain control characters")
    stdout = _log_path(values.get("--output", "slurm-%j.out"), directory, job_id, name, host, machine.username)
    stderr = _log_path(values.get("--error", values.get("--output", "slurm-%j.out")),
                       directory, job_id, name, host, machine.username)
    cpus = _positive_int(values.get("--cpus-per-task"), "--cpus-per-task", 0) * _positive_int(
        values.get("--ntasks"), "--ntasks", 1)
    gpus = _gpu_request(values)
    submitted = datetime.now(timezone.utc).isoformat()
    metadata = {
        "job_id": job_id, "name": name, "host": host, "workdir": directory,
        "script": script_path, "stdout": stdout, "stderr": stderr,
        "submit_at": submitted, "cpus": cpus, "gpus": gpus,
    }
    manifest = json.dumps(metadata, ensure_ascii=True, separators=(",", ":"))
    runner = _runner(directory, script, stdout, stderr)
    root = f'"$HOME/{STATE_DIRECTORY}"'
    command = "\n".join((
        "set -eu", "umask 077",
        f"mkdir -p {root} {shlex.quote(posixpath.dirname(stdout))} {shlex.quote(posixpath.dirname(stderr))}",
        f'jobdir="$HOME/{STATE_DIRECTORY}/{job_id}"',
        'mkdir "$jobdir"',
        f"printf '%s' {shlex.quote(manifest)} > \"$jobdir/meta.json\"",
        f"printf '%s' {shlex.quote(runner)} > \"$jobdir/run.sh\"",
        'chmod 700 "$jobdir/run.sh"',
        f'tmux new-session -d -s {shlex.quote("cw-" + job_id)} "sh \\"$jobdir/run.sh\\""',
        f"printf '%s\\n' {shlex.quote(job_id)}",
    ))
    try:
        response = run_remote(endpoint, timeout, f"sh -c {shlex.quote(command)}", failover=False)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"direct job {job_id} may have started on {host}; check tmux before retrying: {exc}") from exc
    if response.strip() != job_id:
        raise RuntimeError(f"direct job {job_id} returned an unexpected acknowledgement from {host}")
    return {**metadata, "cluster": machine.name, "tmux_session": f"cw-{job_id}"}


_INVENTORY_COMMAND = "\n".join((
    "set -eu",
    "command -v tmux >/dev/null",
    f'root="$HOME/{STATE_DIRECTORY}"',
    'test -d "$root" || exit 0',
    'sessions=$(tmux list-sessions -F "#S" 2>/dev/null || :)',
    'for jobdir in "$root"/*; do',
    '  test -f "$jobdir/meta.json" || continue',
    '  printf "CW\\t"; cat "$jobdir/meta.json"',
    '  for key in start_at end_at exit_code cancelled; do',
    '    printf "\\t"',
    '    if test -f "$jobdir/$key"; then tr -d "\\r\\n\\t" < "$jobdir/$key"; fi',
    '  done',
    '  printf "\\t"',
    '  if printf "%s\\n" "$sessions" | grep -Fxq "cw-${jobdir##*/}"; then printf 1; else printf 0; fi',
    '  printf "\\n"',
    'done',
))


def _parse_time(value: object) -> datetime | None:
    """Parse recorded remote timestamps for elapsed-time reporting."""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


def _parse_inventory(output: str, host: str) -> list[dict[str, object]]:
    """Convert one host's manifest and tmux-state lines into public jobs."""
    jobs: list[dict[str, object]] = []
    now = datetime.now(timezone.utc)
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 7 or fields[0] != "CW":
            continue
        try:
            meta = json.loads(fields[1])
        except json.JSONDecodeError:
            continue
        if not isinstance(meta, dict) or meta.get("host") != host or not _JOB_ID.fullmatch(str(meta.get("job_id", ""))):
            continue
        started = _parse_time(fields[2])
        ended = _parse_time(fields[3])
        exit_code = int(fields[4]) if fields[4].lstrip("-").isdigit() else None
        cancelled = bool(fields[5])
        running = fields[6] == "1"
        submitted = _parse_time(meta.get("submit_at"))
        if cancelled:
            state = "CANCELLED"
        elif exit_code is not None:
            state = "COMPLETED" if exit_code == 0 else "FAILED"
        elif running:
            state = "RUNNING"
        elif submitted is not None and (now - submitted).total_seconds() < 30:
            state = "CONFIGURING"
        else:
            state = "FAILED"
        elapsed = max(0, int(((ended or now) - started).total_seconds())) if started else None
        jobs.append({
            "id": str(meta["job_id"]), "job_id": str(meta["job_id"]),
            "name": str(meta.get("name") or meta["job_id"]), "state": state,
            "partition": host, "nodes": [host], "node_count": 1,
            "cpus": int(meta.get("cpus") or 0), "gpus": int(meta.get("gpus") or 0),
            "gpu_total": int(meta.get("gpus") or 0), "submit_at": meta.get("submit_at"),
            "submit_time": meta.get("submit_at"),
            "start_at": started.isoformat() if started else None,
            "start_time": started.isoformat() if started else None,
            "end_at": ended.isoformat() if ended else None,
            "end_time": ended.isoformat() if ended else None,
            "elapsed_seconds": elapsed, "time_limit_seconds": None,
            "time_left_seconds": None, "exit_code": exit_code,
            "reason": None if state != "FAILED" or exit_code is not None else "tmux session ended without an exit record",
            "_host": host, "_stdout": meta.get("stdout"),
            "_stderr": meta.get("stderr"), "_script": meta.get("script"),
        })
    return jobs


def collect_status(
    machine: Machine, timeout: int, include_jobs: bool, *args: object,
    **kwargs: object,
) -> ClusterStatus:
    """Collect every direct member concurrently, retaining persistent jobs."""
    del args, kwargs
    status = ClusterStatus(machine.name, machine.host, machine.username,
                           hosts=machine.candidate_hosts, scheduler="direct")

    def inspect(host: str) -> list[dict[str, object]]:
        endpoint = _member(machine, host)
        output = run_remote(endpoint, timeout, f"sh -c {shlex.quote(_INVENTORY_COMMAND)}", failover=False)
        return _parse_inventory(output, host)

    try:
        with ThreadPoolExecutor(max_workers=min(8, len(machine.candidate_hosts))) as pool:
            results = list(pool.map(inspect, machine.candidate_hosts))
        status.user_jobs = [job for result in results for job in result]
        status.partitions = []
        status.nodes = []
        status.capacity_updated_at = datetime.now(timezone.utc).isoformat()
        status.scheduling = {"scheduler": "direct", "note": "Jobs run immediately in tmux; resources are not reserved or scheduled."}
        if include_jobs:
            status.jobs = dict(Counter(str(job["state"]) for job in status.user_jobs))
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        status.error = str(exc)
        status.user_jobs = []
    return status


def collect_user_job_status(machine: Machine, timeout: int) -> ClusterStatus:
    """Return direct-job state without a separate capacity probe."""
    return collect_status(machine, timeout, True)
