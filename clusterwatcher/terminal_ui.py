"""Reusable rendering loop for live, scrollable terminal dashboards."""

from __future__ import annotations

from contextlib import contextmanager
import os
import re
import select
import shutil
import sys
import time
from typing import Callable, Iterator, TextIO, TypeVar

try:
    import termios
    import tty
except ImportError:  # pragma: no cover - the standalone target is Linux.
    termios = None  # type: ignore[assignment]
    tty = None  # type: ignore[assignment]


ANSI_HOME_AND_CLEAR = "\033[H\033[2J"
ANSI_ENTER_ALTERNATE_SCREEN = "\033[?1049h"
ANSI_LEAVE_ALTERNATE_SCREEN = "\033[?1049l"
ANSI_HIDE_CURSOR = "\033[?25l"
ANSI_SHOW_CURSOR = "\033[?25h"
_ANSI_SEQUENCE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
Payload = TypeVar("Payload")


def supports_color(output: TextIO) -> bool:
    """Enable ANSI colors only for an interactive terminal that permits them."""
    return (
        bool(getattr(output, "isatty", lambda: False)())
        and not os.environ.get("NO_COLOR")
        and os.environ.get("TERM") != "dumb"
    )


def supports_terminal_controls(output: TextIO) -> bool:
    """Return whether live frames should replace one another on this stream."""
    return bool(getattr(output, "isatty", lambda: False)())


@contextmanager
def terminal_input_mode(input_stream: TextIO) -> Iterator[int | None]:
    """Temporarily read navigation keys without echoing them to the terminal."""
    descriptor: int | None = None
    previous_attributes: list[object] | None = None
    try:
        if termios is not None and tty is not None and input_stream.isatty():
            descriptor = input_stream.fileno()
            previous_attributes = termios.tcgetattr(descriptor)
            tty.setcbreak(descriptor)
    except (AttributeError, OSError, ValueError):
        descriptor = None
        previous_attributes = None
    try:
        yield descriptor
    finally:
        if descriptor is not None and previous_attributes is not None and termios is not None:
            termios.tcsetattr(descriptor, termios.TCSADRAIN, previous_attributes)


def clip_terminal_line(line: str, width: int) -> str:
    """Clip one styled line to a terminal width without splitting ANSI codes."""
    plain = _ANSI_SEQUENCE.sub("", line)
    if len(plain) <= width:
        return line
    visible_limit = max(0, width - 1)
    result: list[str] = []
    visible_count = 0
    position = 0
    while position < len(line) and visible_count < visible_limit:
        sequence = _ANSI_SEQUENCE.match(line, position)
        if sequence:
            result.append(sequence.group())
            position = sequence.end()
            continue
        result.append(line[position])
        visible_count += 1
        position += 1
    result.append("…")
    if "\033[" in line:
        result.append("\033[0m")
    return "".join(result)


def draw_live_view(lines: list[str], offset: int, output: TextIO) -> tuple[int, int]:
    """Draw one terminal-sized viewport and return its clamped scroll bounds."""
    terminal_size = shutil.get_terminal_size((140, 24))
    body_height = max(1, terminal_size.lines - 1)
    maximum_offset = max(0, len(lines) - body_height)
    offset = min(max(0, offset), maximum_offset)
    visible = [
        clip_terminal_line(line, terminal_size.columns)
        for line in lines[offset:offset + body_height]
    ]
    if maximum_offset:
        first = offset + 1
        last = min(len(lines), offset + body_height)
        footer = f"↑/↓ scroll · PgUp/PgDn · Home/End · q quit · lines {first}-{last} of {len(lines)}"
    else:
        footer = f"q quit · {len(lines)} lines"
    output.write(ANSI_HOME_AND_CLEAR + "\n".join([*visible, footer[:terminal_size.columns]]))
    output.flush()
    return offset, maximum_offset


def navigation_result(data: bytes, offset: int, maximum: int, page: int) -> tuple[int, bool]:
    """Apply terminal navigation bytes and return the new offset and quit flag."""
    if b"q" in data.lower():
        return offset, True
    offset -= data.count(b"\033[A")
    offset += data.count(b"\033[B")
    offset -= page * data.count(b"\033[5~")
    offset += page * data.count(b"\033[6~")
    if b"\033[H" in data or b"\033[1~" in data:
        offset = 0
    if b"\033[F" in data or b"\033[4~" in data:
        offset = maximum
    return min(max(0, offset), maximum), False


def wait_for_refresh(
    seconds: int,
    input_descriptor: int | None,
    lines: list[str],
    offset: int,
    output: TextIO,
    sleep: Callable[[float], None],
) -> tuple[int, bool]:
    """Wait for refresh while processing navigation keys in live mode."""
    if input_descriptor is None:
        sleep(seconds)
        return offset, False
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return offset, False
        readable, _, _ = select.select([input_descriptor], [], [], remaining)
        if not readable:
            return offset, False
        data = os.read(input_descriptor, 64)
        if not data:
            return offset, False
        terminal_height = shutil.get_terminal_size((140, 24)).lines
        page = max(1, terminal_height - 2)
        maximum = max(0, len(lines) - max(1, terminal_height - 1))
        offset, should_quit = navigation_result(data, offset, maximum, page)
        if should_quit:
            return offset, True
        offset, _ = draw_live_view(lines, offset, output)


def run_live_board(
    collect: Callable[[], Payload],
    render: Callable[[Payload, bool, int | None], str],
    refresh_seconds: int | None,
    *,
    output: TextIO = sys.stdout,
    input_stream: TextIO = sys.stdin,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Print once or redraw collected data in an alternate terminal screen.

    Interactive refresh mode replaces stale frames and supports scrolling.
    Redirected output remains plain, sequential text. Terminal state is always
    restored after interruption, normal exit, or a collection error.
    """
    use_color = supports_color(output)
    live_screen = refresh_seconds is not None and supports_terminal_controls(output)
    screen_entered = False
    scroll_offset = 0
    with terminal_input_mode(input_stream) as input_descriptor:
        try:
            while True:
                frame = render(collect(), use_color, refresh_seconds)
                frame_lines = frame.rstrip("\n").splitlines()
                if live_screen:
                    if not screen_entered:
                        output.write(ANSI_ENTER_ALTERNATE_SCREEN + ANSI_HIDE_CURSOR)
                        screen_entered = True
                    scroll_offset, _ = draw_live_view(frame_lines, scroll_offset, output)
                else:
                    output.write(frame)
                    output.flush()
                if refresh_seconds is None:
                    return 0
                scroll_offset, should_quit = wait_for_refresh(
                    refresh_seconds,
                    input_descriptor if live_screen else None,
                    frame_lines,
                    scroll_offset,
                    output,
                    sleep,
                )
                if should_quit:
                    return 0
        except KeyboardInterrupt:
            return 0
        finally:
            if screen_entered:
                output.write(ANSI_SHOW_CURSOR + ANSI_LEAVE_ALTERNATE_SCREEN)
                output.flush()
