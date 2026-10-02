"""Collect and render a live terminal board of the user's recent Slurm jobs."""

from __future__ import annotations

from datetime import datetime, timezone, tzinfo
import shutil
import sys
import time
from typing import Callable, TextIO

from .jobs import ACTIVE_JOB_STATES, JobService
from .models import Machine
from .slurm import collect_user_job_status, normalize_job_state
from .terminal_ui import (
    draw_live_view as _draw_live_view,
    navigation_result as _navigation_result,
    run_live_board,
)


ANSI_BLUE = "\033[34m"
ANSI_RED = "\033[31m"
ANSI_RESET = "\033[0m"
_FAILURE_STATES = {
    "BOOT_FAIL", "DEADLINE", "FAILED", "NODE_FAIL", "OUT_OF_MEMORY",
    "PREEMPTED", "REVOKED", "SPECIAL_EXIT", "TIMEOUT",
}


def collect_personal_jobs(machines: list[Machine], timeout: int) -> dict[str, object]:
    """Collect active and recent accounting jobs without full node inventory queries."""
    statuses = [collect_user_job_status(machine, timeout) for machine in machines]
    service = JobService(machines, timeout, 0, lambda: statuses)
    return service.query()


def _state_rank(state: object) -> int:
    """Map detailed Slurm states onto the board's requested state ordering."""
    normalized = normalize_job_state(str(state))
    if normalized == "RUNNING":
        return 0
    if normalized == "PENDING" or normalized in ACTIVE_JOB_STATES:
        return 1
    if normalized == "COMPLETED":
        return 2
    if normalized in _FAILURE_STATES:
        return 3
    if normalized == "CANCELLED":
        return 4
    return 5


def _state_group(state: object) -> str:
    """Return the visible separator group for a detailed Slurm state."""
    rank = _state_rank(state)
    return ("RUNNING", "PENDING", "COMPLETED", "FAILED", "CANCELLED", "OTHER")[rank]


def _parse_time(value: object) -> datetime | None:
    """Parse Slurm's ISO-like timestamps while retaining their stated timezone."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _submitted(job: dict[str, object]) -> object:
    """Return the submission timestamp from either live or accounting data."""
    return job.get("submit_at") or job.get("submit_time")


def _sort_key(job: dict[str, object]) -> tuple[object, ...]:
    """Sort by state group, then newest submission, cluster, and numeric job ID."""
    submitted = _parse_time(_submitted(job))
    if submitted is None:
        submitted_value = 0.0
    elif submitted.tzinfo is None:
        submitted_value = submitted.replace(tzinfo=timezone.utc).timestamp()
    else:
        submitted_value = submitted.timestamp()
    job_id = str(job.get("job_id") or job.get("id") or "")
    numeric_id = tuple(int(value) for value in job_id.replace("_", ".").split(".") if value.isdigit())
    return (
        _state_rank(job.get("state")), -submitted_value,
        str(job.get("cluster", "")).casefold(), numeric_id, job_id,
    )


def _format_duration(seconds: object) -> str:
    """Format a Slurm duration compactly for progress labels."""
    try:
        remaining = max(0, int(seconds))
    except (TypeError, ValueError):
        return "unknown"
    days, remaining = divmod(remaining, 86400)
    hours, remaining = divmod(remaining, 3600)
    minutes, seconds = divmod(remaining, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    if minutes or hours or days:
        parts.append(f"{minutes}m")
    if not parts:
        parts.append(f"{seconds}s")
    return "".join(parts)


def _local_now_for(value: datetime, now: datetime) -> datetime:
    """Return ``now`` with timezone awareness compatible with a parsed timestamp."""
    if value.tzinfo is None:
        return now.astimezone().replace(tzinfo=None) if now.tzinfo else now
    if now.tzinfo is None:
        return now.astimezone(value.tzinfo)
    return now.astimezone(value.tzinfo)


def _colored_bar(fraction: float, width: int, color: str, use_color: bool) -> tuple[str, str]:
    """Return styled and plain discrete progress bars of equal visible width."""
    completed = min(width, max(0, round(max(0.0, min(1.0, fraction)) * width)))
    plain = f"[{'█' * completed}{'░' * (width - completed)}]"
    styled = f"[{color}{plain[1:-1]}{ANSI_RESET}]" if use_color else plain
    return styled, plain


def _progress(job: dict[str, object], now: datetime, use_color: bool, width: int = 12) -> tuple[str, str]:
    """Render state-appropriate progress and return styled/plain variants."""
    state = normalize_job_state(str(job.get("state", "UNKNOWN")))
    elapsed = int(job.get("elapsed_seconds") or 0)
    if state == "RUNNING":
        limit = int(job.get("time_limit_seconds") or 0)
        fraction = elapsed / limit if limit > 0 else 0.0
        styled_bar, plain_bar = _colored_bar(fraction, width, ANSI_BLUE, use_color)
        label = f"{_format_duration(elapsed)} / {_format_duration(limit)}" if limit else f"{_format_duration(elapsed)} elapsed"
    elif state == "PENDING" or state in ACTIVE_JOB_STATES:
        submitted = _parse_time(_submitted(job))
        expected = _parse_time(job.get("expected_start_at") or job.get("start_at") or job.get("start_time"))
        current = _local_now_for(submitted or expected, now) if submitted or expected else now
        waited = max(0, round((current - submitted).total_seconds())) if submitted else 0
        if submitted and expected and expected > submitted:
            total_wait = max(1, round((expected - submitted).total_seconds()))
            remaining = max(0, round((expected - current).total_seconds()))
            fraction = waited / total_wait
            label = (
                f"{_format_duration(waited)} waited · {_format_duration(remaining)} left"
                if remaining else "start estimate passed"
            )
        else:
            fraction = 0.0
            reason = str(job.get("reason") or "")
            label = "waiting for dependency" if reason.startswith("Dependency:") else f"{_format_duration(waited)} waiting"
        styled_bar, plain_bar = _colored_bar(fraction, width, ANSI_RED, use_color)
    else:
        return f"{_format_duration(elapsed)} elapsed", f"{_format_duration(elapsed)} elapsed"
    return f"{styled_bar} {label}", f"{plain_bar} {label}"


def _resources(job: dict[str, object]) -> str:
    """Format requested node, GPU, and CPU counts without hiding zero values."""
    nodes = int(job.get("node_count") or 0) or len(job.get("nodes") or [])
    return f"{nodes} node · {int(job.get('gpus') or 0)} GPU · {int(job.get('cpus') or 0)} CPU"


def _fit(value: object, width: int) -> str:
    """Truncate and pad plain terminal text to an exact display width."""
    text = str(value or "-").replace("\n", " ")
    if len(text) > width:
        text = text[: max(1, width - 1)] + "…"
    return text.ljust(width)


def _fit_styled(styled: str, plain: str, width: int) -> str:
    """Pad ANSI-styled text according to the equivalent plain display length."""
    if len(plain) > width:
        # Labels may be shortened, but never cut through an ANSI escape sequence.
        bar_end = plain.find("]") + 1
        keep_label = max(0, width - bar_end - 1)
        plain = plain[:bar_end] + (" " + plain[bar_end + 1:bar_end + 1 + keep_label] if keep_label else "")
        styled_end = styled.find("]") + 1
        styled = styled[:styled_end] + (" " + styled[styled_end + 1:styled_end + 1 + keep_label] if keep_label else "")
    return styled + " " * max(0, width - len(plain))


def _timestamp_text(value: object, local_timezone: tzinfo | None = None) -> str:
    """Format one Slurm timestamp in the requested or system-local timezone."""
    parsed = _parse_time(value)
    if parsed and parsed.tzinfo is not None:
        parsed = parsed.astimezone(local_timezone)
    return parsed.strftime("%Y-%m-%d %H:%M") if parsed else "unavailable"


def _submission_text(job: dict[str, object], local_timezone: tzinfo | None = None) -> str:
    """Format a submission date in the requested or system-local timezone.

    Accounting and current ``squeue`` records carry explicit UTC timestamps.
    The optional timezone exists primarily for deterministic tests; normal
    terminal rendering uses the machine's configured local timezone.
    """
    return _timestamp_text(_submitted(job), local_timezone)


def _lifecycle_text(job: dict[str, object], event: str, local_timezone: tzinfo | None = None) -> str:
    """Format a launch/end event only for states where it is meaningful."""
    group = _state_group(job.get("state"))
    visible_groups = {"RUNNING", "COMPLETED", "FAILED"} if event == "launched" else {"COMPLETED", "FAILED"}
    if group not in visible_groups:
        return "—"
    value = job.get("start_at") or job.get("start_time") if event == "launched" else job.get("end_at")
    return _timestamp_text(value, local_timezone)


def _wide_column_widths(rows: list[dict[str, str]], terminal_width: int) -> tuple[int, ...]:
    """Size table columns from their contents without filling unused terminal space.

    Natural widths keep ordinary output compact and expand for longer values.
    If the table approaches the terminal edge, less important text columns are
    reduced to bounded minimums before the renderer switches to its narrow
    two-line layout.
    """
    keys = ("job_id", "name", "cluster", "partition", "resources", "progress", "submitted", "launched", "ended")
    headings = ("JOB ID", "JOB NAME", "CLUSTER", "PARTITION", "RESOURCES", "PROGRESS", "SUBMITTED", "LAUNCHED", "ENDED")
    caps = (18, 32, 18, 24, 30, 48, 16, 16, 16)
    widths = [
        min(cap, max(len(heading), *(len(row[key]) for row in rows)))
        for key, heading, cap in zip(keys, headings, caps)
    ]
    separator_width = 2 * (len(widths) - 1)
    overflow = sum(widths) + separator_width - terminal_width
    # Preserve identifiers and timestamps where possible. Progress retains
    # enough space for its complete block bar even when its label is shortened.
    minimums = (6, 8, 7, 9, 12, 16, 16, 16, 16)
    for index in (1, 5, 3, 2, 4, 0):
        if overflow <= 0:
            break
        reduction = min(overflow, widths[index] - minimums[index])
        widths[index] -= reduction
        overflow -= reduction
    return tuple(widths)


def render_job_board(
    payload: dict[str, object],
    *,
    now: datetime | None = None,
    use_color: bool = False,
    width: int | None = None,
    refresh_seconds: int | None = None,
) -> str:
    """Render a complete job payload as a wide table or compact two-line rows."""
    observed_at = now or datetime.now().astimezone()
    terminal_width = width or shutil.get_terminal_size((140, 24)).columns
    jobs = sorted((dict(job) for job in payload.get("jobs", [])), key=_sort_key)
    suffix = f" · refreshing every {refresh_seconds}s" if refresh_seconds else ""
    lines = [f"My jobs · updated {observed_at.strftime('%Y-%m-%d %H:%M:%S')}{suffix}"]
    warnings = [
        f"WARNING {cluster.get('name', 'unknown')}: {cluster['error']}"
        for cluster in payload.get("clusters", [])
        if cluster.get("error")
    ]
    lines.extend(warnings)
    if not jobs:
        lines.append("No jobs found in the last 24 hours.")
        return "\n".join(lines) + "\n"

    if terminal_width < 136:
        previous_group: str | None = None
        for job in jobs:
            group = _state_group(job.get("state"))
            if group != previous_group:
                lines.append(f"### {group} ###")
                previous_group = group
            job_id = job.get("job_id") or job.get("id") or "-"
            name = str(job.get("name") or job_id)
            styled_progress, _ = _progress(job, observed_at, use_color)
            lines.append(f"{job_id}  {name}")
            lines.append(
                f"  {job.get('cluster', '-')} / {job.get('partition') or '-'} · "
                f"{_resources(job)} · {styled_progress} · submitted {_submission_text(job)} · "
                f"launched {_lifecycle_text(job, 'launched')} · ended {_lifecycle_text(job, 'ended')}"
            )
        return "\n".join(lines) + "\n"

    prepared_rows: list[dict[str, str]] = []
    for job in jobs:
        styled_progress, plain_progress = _progress(job, observed_at, use_color)
        prepared_rows.append({
            "group": _state_group(job.get("state")),
            "job_id": str(job.get("job_id") or job.get("id") or "-"),
            "name": str(job.get("name") or job.get("job_id") or job.get("id") or "-"),
            "cluster": str(job.get("cluster") or "-"),
            "partition": str(job.get("partition") or "-"),
            "resources": _resources(job),
            "progress": plain_progress,
            "styled_progress": styled_progress,
            "submitted": _submission_text(job),
            "launched": _lifecycle_text(job, "launched"),
            "ended": _lifecycle_text(job, "ended"),
        })
    widths = _wide_column_widths(prepared_rows, terminal_width)
    headings = (
        _fit("JOB ID", widths[0]), _fit("JOB NAME", widths[1]),
        _fit("CLUSTER", widths[2]), _fit("PARTITION", widths[3]),
        _fit("RESOURCES", widths[4]), _fit("PROGRESS", widths[5]),
        _fit("SUBMITTED", widths[6]), _fit("LAUNCHED", widths[7]),
        _fit("ENDED", widths[8]),
    )
    lines.append("  ".join(headings).rstrip())
    lines.append("─" * min(terminal_width, len("  ".join(headings).rstrip())))
    previous_group = None
    for row in prepared_rows:
        if row["group"] != previous_group:
            lines.append(f"### {row['group']} ###")
            previous_group = row["group"]
        values = (
            _fit(row["job_id"], widths[0]),
            _fit(row["name"], widths[1]),
            _fit(row["cluster"], widths[2]),
            _fit(row["partition"], widths[3]),
            _fit(row["resources"], widths[4]),
            _fit_styled(row["styled_progress"], row["progress"], widths[5]),
            _fit(row["submitted"], widths[6]),
            _fit(row["launched"], widths[7]),
            _fit(row["ended"], widths[8]),
        )
        lines.append("  ".join(values).rstrip())
    return "\n".join(lines) + "\n"


def run_terminal_job_board(
    machines: list[Machine],
    timeout: int,
    refresh_seconds: int | None,
    *,
    output: TextIO = sys.stdout,
    input_stream: TextIO = sys.stdin,
    collector: Callable[[list[Machine], int], dict[str, object]] = collect_personal_jobs,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Print once or redraw the jobs board through the shared terminal UI."""
    return run_live_board(
        lambda: collector(machines, timeout),
        lambda payload, use_color, refresh: render_job_board(
            payload, use_color=use_color, refresh_seconds=refresh,
        ),
        refresh_seconds,
        output=output,
        input_stream=input_stream,
        sleep=sleep,
    )
