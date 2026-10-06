"""Shared data structures for configuration and collected cluster status."""

from dataclasses import dataclass, field


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
class AccountingSnapshot:
    """Recent ``sacct`` records fetched during a status refresh.

    ``fingerprint`` is the checksum of the user's queued job IDs and states
    when the records were fetched; while it is unchanged the records are reused
    instead of querying accounting again.
    """

    records: list[dict[str, object]]
    fingerprint: str
    since: str
    fetched_at: str
    fetched_monotonic: float = field(default=0.0, compare=False)


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
    # When partitions/nodes were last collected; they refresh less often than jobs.
    capacity_updated_at: str | None = None
    # Checksum of the user's queued job IDs and states (see slurm.accounting_gate_command).
    user_jobs_fingerprint: str | None = None
    # Server-internal; removed from API payloads.
    accounting: AccountingSnapshot | None = None
