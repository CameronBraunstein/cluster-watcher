"""Command-line parsing and orchestration."""

import argparse
import json
import os
import shlex
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Sequence, cast

from .commands import RemoteCommandService, SessionUnavailableError, UnknownMachineError
from .compute import configure_gpu_profiles, gpu_profiles, gpu_profiles_path
from .config import DEFAULT_CONFIG, load_config, load_wait_threshold_minutes
from .credentials import establish_interactive_sessions, login_targets
from .dashboard import serve
from .models import Machine
from .setup_wizard import edit_config, run_setup
from .slurm import SINFO_COMMAND, collect_status, print_status
from .ssh import ssh_command
from .terminal_jobs import run_terminal_job_board
from .terminal_status import run_terminal_status_board


def select_machines(machines: list[Machine], requested: Sequence[str]) -> list[Machine]:
    """Select configured machines in the requested order."""
    if not requested:
        return machines
    by_name = {machine.name: machine for machine in machines}
    unknown = [name for name in requested if name not in by_name]
    if unknown:
        raise ValueError(f"unknown machine(s): {', '.join(unknown)}")
    return [by_name[name] for name in requested]


def _status_targets(first: str | None, remaining: Sequence[str]) -> tuple[int | None, list[str]]:
    """Interpret ``status [SECONDS] [MACHINE ...]`` without breaking old selectors."""
    if first is None:
        return None, []
    if first.isdecimal():
        return int(first), list(remaining)
    return None, [first, *remaining]


def _format_duration(seconds: int) -> str:
    """Format a non-negative duration compactly for session inventory output."""
    hours, remainder = divmod(max(0, seconds), 3600)
    minutes, seconds = divmod(remainder, 60)
    parts = []
    if hours:
        parts.append(f"{hours}h")
    if minutes or hours:
        parts.append(f"{minutes}m")
    parts.append(f"{seconds}s")
    return " ".join(parts)


def _print_sessions(payload: dict[str, object]) -> None:
    """Print a concise human-readable SSH session inventory."""
    print("MACHINE\tSESSION\tREMAINING\tENDPOINT")
    sessions = cast(list[dict[str, object]], payload["machines"])
    for session in sessions:
        is_open = bool(session["session_open"])
        if not is_open:
            remaining = "-"
        elif session["control_persist_seconds"] is None:
            remaining = "unlimited"
        elif session["estimated_remaining_seconds"] is None:
            remaining = "unknown"
        else:
            remaining = _format_duration(int(session["estimated_remaining_seconds"]))
        endpoint = f"{session['username']}@{session['host']}"
        print(f"{session['name']}\t{'open' if is_open else 'closed'}\t{remaining}\t{endpoint}")
        if not is_open and session.get("error"):
            error = str(session["error"]).replace("\n", " ")
            print(f"  {error}", file=sys.stderr)


def _print_execution_result(result: dict[str, object]) -> int:
    """Relay captured remote streams and return a conventional process status."""
    sys.stdout.write(str(result["stdout"]))
    sys.stderr.write(str(result["stderr"]))
    if result["stdout_truncated"]:
        print("cluster-watcher: stdout was truncated at 1 MiB", file=sys.stderr)
    if result["stderr_truncated"]:
        print("cluster-watcher: stderr was truncated at 1 MiB", file=sys.stderr)
    if result["timed_out"]:
        print("cluster-watcher: remote command timed out", file=sys.stderr)
        return 124
    if result["connection_dropped"]:
        print("cluster-watcher: SSH session dropped during the command", file=sys.stderr)
        return 255
    return int(result["exit_code"])


def run_login(machines: list[Machine], requested: Sequence[str], timeout: int) -> int:
    """Re-open closed interactive sessions and report each target's result."""
    targets = login_targets(machines, list(requested))
    if not targets:
        print("No configured machine uses interactive login (interactive_auth = true).", file=sys.stderr)
        return 0
    errors = dict((machine.name, error) for machine, error in establish_interactive_sessions(targets, timeout))
    for machine in targets:
        if machine.name in errors:
            print(f"{machine.name}: login failed: {errors[machine.name]}", file=sys.stderr)
        else:
            print(f"{machine.name}: session open")
    return 1 if errors else 0


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI, or the private askpass client in a frozen subprocess."""
    from .askpass import ASKPASS_MODE_ENVIRONMENT_VARIABLE

    if os.environ.get(ASKPASS_MODE_ENVIRONMENT_VARIABLE) == "1":
        from .askpass import main as askpass_main

        return askpass_main()
    parser = argparse.ArgumentParser(
        prog=os.environ.get("CLUSTER_WATCHER_COMMAND_NAME") or None,
        description="Inspect Slurm clusters through SSH.",
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="TOML config path (default: clusters.toml)")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list", help="list configured machines")
    subparsers.add_parser(
        "setup", aliases=["set-up"],
        help="interactively create the configuration file",
        description="Walk through describing each cluster and write a validated clusters.toml (the --config path).",
    )
    config_parser = subparsers.add_parser(
        "config",
        help="open the configuration file in your editor",
        description="Open the --config file in $VISUAL/$EDITOR (or nano/vim/vi) and validate it after saving.",
    )
    config_parser.add_argument(
        "--path", action="store_true",
        help="print the absolute configuration path instead of opening an editor",
    )
    jobs_parser = subparsers.add_parser(
        "jobs",
        help="show your recent jobs in the terminal",
        description=(
            "Show jobs from the last 24 hours, ordered as running, pending, "
            "completed, failed, then cancelled. Running progress is blue and "
            "pending progress is red when output is a terminal. Live mode uses "
            "Up/Down, Page Up/Page Down, Home, and End to scroll; q exits."
        ),
    )
    jobs_parser.add_argument(
        "refresh_seconds", nargs="?", type=int, metavar="SECONDS",
        help="continuously refresh every SECONDS until Ctrl-C",
    )
    jobs_parser.add_argument("--timeout", type=int, default=15, help="SSH connect timeout in seconds (default: 15)")
    status_parser = subparsers.add_parser(
        "status",
        help="show GPU capacity and up-to-one-hour wait estimates",
        description=(
            "Show a table per cluster with GPU model/specifications, red/green "
            "availability, CPU threads, and up-to-one-hour wait estimates for 1, 2, "
            "4, 8, 16, 32, and 64 GPUs. Pass SECONDS first for live refresh; "
            "failed wait probes are marked ERR with their diagnostic below. "
            "live mode supports scrolling with Up/Down, Page Up/Page Down, "
            "Home, and End, and q exits."
        ),
    )
    status_parser.add_argument(
        "refresh_or_machine", nargs="?", metavar="[SECONDS|MACHINE]",
        help="refresh interval, or a configured machine name for legacy selection",
    )
    status_parser.add_argument("machines", nargs="*", metavar="MACHINE", help="additional configured machine names")
    status_parser.add_argument("--jobs", action="store_true", help="also summarize queued jobs by state")
    status_parser.add_argument("--timeout", type=int, default=15, help="SSH connect timeout in seconds (default: 15)")
    status_parser.add_argument("--json", action="store_true", help="emit JSON")
    status_parser.add_argument("--dry-run", action="store_true", help="print SSH commands without connecting")
    serve_parser = subparsers.add_parser("serve", help="start a live local web dashboard")
    serve_parser.add_argument("--host", default="127.0.0.1", help="address to bind (default: 127.0.0.1)")
    serve_parser.add_argument("--port", type=int, default=8080, help="HTTP port (default: 8080; use 0 for any free port)")
    serve_parser.add_argument("--timeout", type=int, default=15, help="SSH connect timeout in seconds (default: 15)")
    serve_parser.add_argument("--refresh", type=int, default=15, help="refresh interval in seconds (default: 15)")
    serve_parser.add_argument("--jobs", action="store_true", help="also summarize queued jobs by state")
    serve_parser.add_argument("--jobs-api", action="store_true", help="enable loopback-only personal job and log APIs")
    serve_parser.add_argument("--command-api", action="store_true", help="enable loopback-only SSH session and command APIs")
    serve_parser.add_argument("--no-browser", action="store_true", help="do not open the dashboard in a browser")
    login_parser = subparsers.add_parser(
        "login",
        help="log in again to machines whose SSH session has closed",
        description=(
            "Re-open the shared SSH session of interactive (password/OTP) machines "
            "whose session has closed; a running service picks it up on its next "
            "refresh. Machines that share a credential_group with a named machine "
            "are included, so one password covers all of them (each still asks "
            "for its own OTP). Machines with an open session are skipped."
        ),
    )
    login_parser.add_argument("machines", nargs="*", metavar="MACHINE", help="configured machine names (default: all)")
    login_parser.add_argument("--timeout", type=int, default=15, help="SSH connect timeout in seconds (default: 15)")
    sessions_parser = subparsers.add_parser("sessions", help="show reusable SSH session state")
    sessions_parser.add_argument("--timeout", type=int, default=5, help="session check timeout in seconds (default: 5)")
    sessions_parser.add_argument("--json", action="store_true", help="emit the versioned JSON session document")
    exec_parser = subparsers.add_parser("exec", help="run a command through an existing SSH session")
    exec_parser.add_argument(
        "--timeout", type=int, default=None,
        help="command timeout in seconds (default: unlimited; must be positive when set)",
    )
    exec_parser.add_argument("machine", metavar="MACHINE", help="configured machine name")
    exec_parser.add_argument("remote_command", nargs=argparse.REMAINDER, metavar="COMMAND", help="command and arguments, normally after --")
    shell_parser = subparsers.add_parser("shell", help="open a shell through an existing SSH session")
    shell_parser.add_argument("--timeout", type=int, default=15, help="session check timeout in seconds (default: 15)")
    shell_parser.add_argument("machine", metavar="MACHINE", help="configured machine name")
    args = parser.parse_args(argv)
    if args.command == "config" and args.path:
        print(args.config.expanduser().resolve())
        return 0
    if args.command in {"setup", "set-up", "config"}:
        try:
            return run_setup(args.config) if args.command != "config" else edit_config(args.config)
        except (EOFError, KeyboardInterrupt):
            print("\nCancelled; the configuration was not changed.", file=sys.stderr)
            return 130
    try:
        machines = load_config(args.config)
        configure_gpu_profiles(gpu_profiles_path(args.config))
        gpu_profiles()  # Report a malformed personal catalog now, not mid-refresh.
        if args.command == "list":
            for machine in machines:
                print(f"{machine.name}\t{machine.username}@{machine.host}\tport={machine.port}")
            return 0
        if args.command == "jobs":
            if args.timeout < 1:
                raise ValueError("--timeout must be at least 1")
            if args.refresh_seconds is not None and args.refresh_seconds < 1:
                raise ValueError("jobs refresh interval must be at least 1 second")
            for machine, error in establish_interactive_sessions(machines, args.timeout):
                print(f"Could not establish reusable SSH session for {machine.name}: {error}", file=sys.stderr)
            return run_terminal_job_board(machines, args.timeout, args.refresh_seconds)
        if args.command == "status":
            if args.timeout < 1:
                raise ValueError("--timeout must be at least 1")
            refresh_seconds, requested = _status_targets(args.refresh_or_machine, args.machines)
            if refresh_seconds is not None and refresh_seconds < 1:
                raise ValueError("status refresh interval must be at least 1 second")
            if refresh_seconds is not None and (args.json or args.dry_run):
                raise ValueError("live status refresh cannot be combined with --json or --dry-run")
            selected = select_machines(machines, requested)
            if not args.json and not args.dry_run:
                for machine, error in establish_interactive_sessions(selected, args.timeout):
                    print(f"Could not establish reusable SSH session for {machine.name}: {error}", file=sys.stderr)
                return run_terminal_status_board(
                    selected, args.timeout, refresh_seconds, include_jobs=args.jobs,
                )
        if args.command == "serve":
            if args.timeout < 1 or args.refresh < 1:
                raise ValueError("--timeout and --refresh must be at least 1")
            if not 0 <= args.port <= 65535:
                raise ValueError("--port must be between 0 and 65535")
            return serve(
                machines, args.host, args.port, args.timeout, args.jobs, args.refresh,
                not args.no_browser, load_wait_threshold_minutes(args.config), args.jobs_api,
                args.command_api,
            )
        if args.command == "login":
            if args.timeout < 1:
                raise ValueError("--timeout must be at least 1")
            return run_login(machines, args.machines, args.timeout)
        if args.command == "sessions":
            if args.timeout < 1:
                raise ValueError("--timeout must be at least 1")
            payload = RemoteCommandService(machines, args.timeout).sessions()
            if args.json:
                print(json.dumps(payload, indent=2))
            else:
                _print_sessions(payload)
            return 0
        if args.command == "exec":
            if args.timeout is not None and args.timeout < 1:
                raise ValueError("--timeout must be at least 1")
            tokens = args.remote_command[1:] if args.remote_command[:1] == ["--"] else args.remote_command
            if not tokens:
                raise ValueError("exec requires a command after MACHINE and --")
            try:
                result = RemoteCommandService(machines, 5).execute(
                    args.machine, shlex.join(tokens), args.timeout,
                )
            except (SessionUnavailableError, UnknownMachineError, OSError) as exc:
                print(f"cluster-watcher: {exc}", file=sys.stderr)
                return 1
            return _print_execution_result(result)
        if args.command == "shell":
            if args.timeout < 1:
                raise ValueError("--timeout must be at least 1")
            try:
                return RemoteCommandService(machines, args.timeout).shell(args.machine)
            except (SessionUnavailableError, UnknownMachineError, OSError) as exc:
                print(f"cluster-watcher: {exc}", file=sys.stderr)
                return 1
        if args.timeout < 1:
            raise ValueError("--timeout must be at least 1")
        _, requested = _status_targets(args.refresh_or_machine, args.machines)
        selected = select_machines(machines, requested)
        if args.dry_run:
            for machine in selected:
                print(" ".join(ssh_command(machine, args.timeout, SINFO_COMMAND)))
            return 0
        statuses = [collect_status(machine, args.timeout, args.jobs) for machine in selected]
    except ValueError as exc:
        parser.error(str(exc))
    if args.json:
        print(json.dumps([asdict(status) for status in statuses], indent=2))
    else:
        for status in statuses:
            print_status(status, args.jobs)
    return 1 if any(status.error for status in statuses) else 0
