"""Run several remote commands through one SSH call.

Opening an SSH session on a cluster costs roughly one to two seconds even over
a shared control master, because the remote side starts the user's login
shell and its startup files for every call; the Slurm queries themselves take
milliseconds. A refresh therefore sends all of its commands as one POSIX
``sh`` script and splits the combined output back into one :class:`Section`
per command. Each section keeps its own stdout, stderr, and exit status, so
one failing command does not hide the others' results.

Output framing uses lines that start with a random per-call token, which
remote command output cannot predict:

``<token><name``          section begins (stdout follows)
``<token>><name> <rc>``  stdout ends, with the command's exit status
``<token>!<name>``        stderr follows (only when stderr is non-empty)
``<token>.<name>``        stderr ends

With a time budget, commands that would start after the budget has passed
are not run; their section reports :data:`BUDGET_EXHAUSTED` as stderr.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
import secrets
import shlex
import subprocess

from .models import Machine
from .ssh import run_remote

_NAME_PATTERN = re.compile(r"[a-z][a-z0-9_]*")

BUDGET_EXHAUSTED = "batch time budget exhausted"
"""stderr of a section skipped because the batch's time budget had passed."""


@dataclass
class Section:
    """The result of one command in a batch."""

    stdout: str
    stderr: str
    returncode: int

    def output(self) -> str:
        """Return stdout, raising ``RuntimeError`` like ``run_remote`` on failure."""
        if self.returncode:
            raise RuntimeError(self.stderr.strip() or f"remote command exited with status {self.returncode}")
        return self.stdout


def batch_script(commands: dict[str, str], token: str, budget_seconds: float | None = None) -> str:
    """Return the ``sh`` script that runs ``commands`` in order with framing.

    ``budget_seconds`` skips every command that would start after that many
    seconds (measured with ``date +%s``) since the script began.
    """
    if any(not _NAME_PATTERN.fullmatch(name) for name in commands):
        raise ValueError("batch section names must be lowercase identifiers")
    budget = "" if budget_seconds is None else str(max(0, int(budget_seconds)))
    lines = [
        f"T={token}",
        f"B={budget}",
        "S=$(date +%s)",
        'E=$(mktemp) || exit 97',
        "trap 'rm -f \"$E\"' EXIT",
        # The blank line before each closing marker guarantees it starts a line;
        # the parser removes exactly that one added newline again.
        's() { if [ -n "$B" ] && [ $(( $(date +%s) - S )) -ge "$B" ]; then '
        f'printf \'%s<%s\\n\\n%s>%s 1\\n%s!%s\\n{BUDGET_EXHAUSTED}\\n%s.%s\\n\' "$T" "$1" "$T" "$1" "$T" "$1" "$T" "$1"; return; fi; '
        'printf \'%s<%s\\n\' "$T" "$1"; sh -c "$2" 2>"$E"; r=$?; '
        'printf \'\\n%s>%s %s\\n\' "$T" "$1" "$r"; '
        'if [ -s "$E" ]; then printf \'%s!%s\\n\' "$T" "$1"; cat "$E"; printf \'\\n%s.%s\\n\' "$T" "$1"; fi; }',
    ]
    lines.extend(f"s {name} {shlex.quote(command)}" for name, command in commands.items())
    lines.append("exit 0")
    return "\n".join(lines)


def parse_batch_output(output: str, token: str, names: list[str]) -> dict[str, Section]:
    """Split framed batch output into sections; missing sections count as failed."""
    sections: dict[str, Section] = {}
    stdout: dict[str, list[str]] = {}
    stderr: dict[str, list[str]] = {}
    codes: dict[str, int] = {}
    current: tuple[str, str] | None = None  # (name, "out" | "err")
    for line in output.splitlines(keepends=True):
        if line.startswith(token):
            marker = line[len(token):].rstrip("\n")
            kind, rest = marker[:1], marker[1:]
            if kind == "<":
                current = (rest, "out")
                stdout[rest] = []
            elif kind == ">":
                name, _, code = rest.partition(" ")
                codes[name] = int(code) if code.lstrip("-").isdigit() else 1
                current = None
            elif kind == "!":
                current = (rest, "err")
                stderr[rest] = []
            elif kind == ".":
                current = None
            continue
        if current is not None:
            (stdout if current[1] == "out" else stderr)[current[0]].append(line)

    def joined(parts: list[str]) -> str:
        text = "".join(parts)
        return text[:-1] if text.endswith("\n") else text

    for name in names:
        if name not in codes:
            sections[name] = Section("", "remote batch ended before this command finished", 1)
            continue
        sections[name] = Section(joined(stdout.get(name, [])), joined(stderr.get(name, [])), codes[name])
    return sections


def batch_process_timeout(timeout: int) -> float:
    """Return the deadline for a whole batch, which does several commands' work."""
    return timeout * 2 + 5


def run_batch(
    machine: Machine,
    timeout: int,
    commands: dict[str, str],
    *,
    budget_seconds: float | None = None,
    process_timeout: float | None = None,
) -> dict[str, Section]:
    """Run ``commands`` (name -> shell command) in one SSH call, in order.

    Raises ``RuntimeError``/``OSError`` only when the SSH call itself fails,
    with a short message for a timeout; individual command failures are
    reported per section. ``budget_seconds`` is passed to
    :func:`batch_script`; ``process_timeout`` replaces the default deadline
    of :func:`batch_process_timeout` for batches of slow commands.
    """
    if not commands:
        return {}
    token = f"@@CW{secrets.token_hex(8)}@@"
    script = batch_script(commands, token, budget_seconds)
    deadline = batch_process_timeout(timeout) if process_timeout is None else process_timeout
    try:
        output = run_remote(machine, timeout, f"sh -c {shlex.quote(script)}", deadline)
    except subprocess.TimeoutExpired as exc:
        # The default message repeats the whole script; keep errors readable.
        raise RuntimeError(f"no response from the cluster within {deadline:g} s") from exc
    return parse_batch_output(output, token, list(commands))
