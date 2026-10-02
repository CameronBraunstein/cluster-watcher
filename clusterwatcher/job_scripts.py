"""Retrieve the batch script behind a Slurm job.

Slurm keeps an exact copy of a batch script only while the job is queued or
running (``scontrol write batch_script``), and in accounting only on sites
configured with ``AccountingStoreFlags=job_script`` (``sacct --batch-script``).
Otherwise the script file is located from the recorded ``sbatch`` command line
(``SubmitLine``) and working directory, and the current file is read. That
file may have been edited since submission, so every result names its
``source``:

* ``"slurm"`` - the exact submitted script, held by the controller;
* ``"accounting"`` - the exact submitted script, stored by ``sacct``;
* ``"file"`` - the script file as it exists now on the cluster.
"""

from __future__ import annotations

import posixpath
import re
import shlex
import subprocess

from .models import Machine
from .ssh import run_remote

MAX_SCRIPT_BYTES = 1024 * 1024
_JOB_ID_PATTERN = re.compile(r"\d+(?:_\d+)?")

# sbatch options that never take a separate value. Every other option written
# without ``=`` consumes the next token (``-p gpu``, ``--time 10``).
_FLAG_ONLY_LONG = {
    "--contiguous", "--exclusive", "--get-user-env", "--hold", "--ignore-pbs", "--no-kill",
    "--no-requeue", "--overcommit", "--oversubscribe", "--parsable", "--quiet", "--requeue",
    "--spread-job", "--test-only", "--use-min-nodes", "--verbose", "--wait",
}
_FLAG_ONLY_SHORT = set("HkOQsvW")


class JobScriptNotFound(RuntimeError):
    """Indicate that no batch script can be located for a job."""


def submitted_script_path(submit_line: str) -> str | None:
    """Return the script argument of a recorded ``sbatch`` command line.

    Returns ``None`` for ``--wrap`` jobs, scripts read from standard input,
    and lines that cannot be parsed.
    """
    try:
        tokens = shlex.split(submit_line)
    except ValueError:
        return None
    if not tokens or posixpath.basename(tokens[0]) != "sbatch":
        return None
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            break
        if not token.startswith("-") or token == "-":
            break
        name = token.split("=", 1)[0]
        if name == "--wrap":
            return None
        if token.startswith("--"):
            takes_value = "=" not in token and token not in _FLAG_ONLY_LONG
        else:
            # Short options: ``-pgpu`` carries its value; ``-p gpu`` does not.
            takes_value = len(token) == 2 and token[1] not in _FLAG_ONLY_SHORT
        index += 2 if takes_value else 1
    if index >= len(tokens) or tokens[index] == "-":
        return None
    return tokens[index]


def parse_accounting_script(output: str) -> str | None:
    """Extract the script from ``sacct --batch-script`` output, if one was stored."""
    lines = output.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.strip() and set(line.strip()) == {"-"}:
            script = "".join(lines[index + 1:])
            return None if script.strip() in {"", "NONE"} else script
    return None


def _bounded(content: str) -> tuple[str, bool]:
    """Trim script text to ``MAX_SCRIPT_BYTES`` and report whether it was cut."""
    encoded = content.encode()
    if len(encoded) <= MAX_SCRIPT_BYTES:
        return content, False
    return encoded[:MAX_SCRIPT_BYTES].decode(errors="ignore"), True


def fetch_batch_script(machine: Machine, timeout: int, job_id: str) -> dict[str, object]:
    """Return ``{source, path, content, truncated}`` for one of the user's jobs."""
    if not _JOB_ID_PATTERN.fullmatch(job_id):
        raise ValueError("job_id must be a numeric Slurm job or array-task identifier")
    quoted_id = shlex.quote(job_id)
    limit = MAX_SCRIPT_BYTES + 1

    # 1. Queued or running: the controller still holds the exact script.
    try:
        content = run_remote(machine, timeout, f"scontrol write batch_script {quoted_id} - | head -c {limit}")
        if content.strip():
            text, truncated = _bounded(content)
            return {"source": "slurm", "path": None, "content": text, "truncated": truncated}
    except (RuntimeError, subprocess.TimeoutExpired):
        pass

    user = shlex.quote(machine.username)
    # 2. Finished, on sites that store scripts in accounting.
    try:
        stored = parse_accounting_script(run_remote(
            machine, timeout, f"sacct --jobs={quoted_id} --user={user} --batch-script | head -c {limit + 4096}",
        ))
        if stored:
            text, truncated = _bounded(stored)
            return {"source": "accounting", "path": None, "content": text, "truncated": truncated}
    except (RuntimeError, subprocess.TimeoutExpired):
        pass

    # 3. Otherwise read the script file named on the recorded sbatch line.
    record = run_remote(
        machine, timeout,
        f"sacct --jobs={quoted_id} --user={user} --allocations --noheader --parsable2 --format=SubmitLine,WorkDir",
    ).strip().splitlines()
    if not record:
        raise JobScriptNotFound(f"Slurm has no record of job {job_id}")
    submit_line, _, workdir = record[0].rpartition("|")
    script = submitted_script_path(submit_line)
    if script is None:
        raise JobScriptNotFound(
            f"Job {job_id} was not submitted from a script file (sbatch line: {submit_line or 'unavailable'})"
        )
    path = script if script.startswith("/") or not workdir else posixpath.join(workdir, script)
    path = posixpath.normpath(path)
    quoted_path = shlex.quote(path)
    try:
        content = run_remote(
            machine, timeout,
            f"test -f {quoted_path} -a -r {quoted_path} || {{ echo 'Script is not readable' >&2; exit 1; }}; "
            f"head -c {limit} -- {quoted_path}",
        )
    except RuntimeError as exc:
        raise JobScriptNotFound(f"The script file for job {job_id} no longer exists or is not readable: {path}") from exc
    text, truncated = _bounded(content)
    return {"source": "file", "path": path, "content": text, "truncated": truncated}
