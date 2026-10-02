"""Shared data structures for configuration and collected cluster status."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Machine:
    """Connection and security settings for one configured Slurm cluster."""

    name: str
    host: str
    username: str
    port: int = 22
    identity_file: str | None = None
    interactive_auth: bool = False
    control_persist: str = "8h"
    credential_group: str | None = None
    job_log_roots: tuple[str, ...] = ()
    default_partition_max_time_minutes: int = 1440
    partition_max_time_minutes: tuple[tuple[str, int], ...] = ()

    def max_time_minutes(self, partition: str) -> int:
        """Return the configured maximum runtime for a Slurm partition."""
        return dict(self.partition_max_time_minutes).get(
            partition,
            self.default_partition_max_time_minutes,
        )


@dataclass(frozen=True)
class RemoteCommandResult:
    """Bounded output and process metadata from one remote SSH command."""

    returncode: int
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool
    duration_seconds: float


@dataclass
class ClusterStatus:
    name: str
    host: str
    username: str
    partitions: list[dict[str, str]] | None = None
    nodes: list[dict[str, object]] | None = None
    partition_compute: list[dict[str, object]] | None = None
    wait_estimates: dict[str, list[dict[str, object]]] | None = None
    wait_estimates_updated_at: str | None = None
    user_jobs: list[dict[str, object]] | None = None
    jobs: dict[str, int] | None = None
    resource_error: str | None = None
    error: str | None = None
