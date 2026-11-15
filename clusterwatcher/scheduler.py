"""Select a remote workload manager and dispatch normalized collection.

The optional ``machine.scheduler`` value is authoritative. Automatic selection
checks commands on the final submission host and is cached for the process;
when both clients are installed, the user must resolve the ambiguity in TOML.
"""

from __future__ import annotations

from functools import lru_cache

from .models import ClusterStatus, Machine
from .ssh import run_remote


@lru_cache(maxsize=128)
def detected_scheduler(machine: Machine, timeout: int) -> str:
    """Detect exactly one available scheduler client on the remote endpoint."""
    if machine.scheduler != "auto":
        return machine.scheduler
    output = run_remote(
        machine, timeout,
        "for tool in sinfo condor_q; do if command -v \"$tool\" >/dev/null 2>&1; "
        "then printf '%s\\n' \"$tool\"; fi; done",
    )
    found = set(output.splitlines())
    if found == {"sinfo"}:
        return "slurm"
    if found == {"condor_q"}:
        return "condor"
    if found == {"sinfo", "condor_q"}:
        raise RuntimeError(
            f"both Slurm and HTCondor clients exist on {machine.name}; "
            "set scheduler = 'slurm' or 'condor' in clusters.toml"
        )
    raise RuntimeError(
        f"no Slurm or HTCondor client found on {machine.name}; "
        "check submission_host and your remote PATH"
    )


def collect_status(machine: Machine, timeout: int, include_jobs: bool, *args: object, **kwargs: object) -> ClusterStatus:
    """Collect a scheduler-neutral status using the selected backend."""
    try:
        scheduler = detected_scheduler(machine, timeout)
    except (OSError, RuntimeError) as exc:
        return ClusterStatus(machine.name, machine.host, machine.username, error=str(exc), scheduler=machine.scheduler)
    if scheduler == "condor":
        from .condor import collect_status as collect_condor_status
        return collect_condor_status(machine, timeout, include_jobs, *args, **kwargs)
    from .slurm import collect_status as collect_slurm_status
    return collect_slurm_status(machine, timeout, include_jobs, *args, **kwargs)


def collect_user_job_status(machine: Machine, timeout: int) -> ClusterStatus:
    """Collect only active personal jobs on the selected scheduler."""
    try:
        scheduler = detected_scheduler(machine, timeout)
    except (OSError, RuntimeError) as exc:
        return ClusterStatus(machine.name, machine.host, machine.username, error=str(exc), scheduler=machine.scheduler)
    if scheduler == "condor":
        from .condor import collect_user_job_status as collect_condor_jobs
        return collect_condor_jobs(machine, timeout)
    from .slurm import collect_user_job_status as collect_slurm_jobs
    return collect_slurm_jobs(machine, timeout)
