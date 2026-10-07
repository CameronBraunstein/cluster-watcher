"""Tests for the terminal personal-jobs board."""

from datetime import datetime, timedelta, timezone
from io import StringIO
import os
from unittest.mock import patch

from clusterwatcher.models import Machine
from clusterwatcher.terminal_jobs import (
    _draw_live_view,
    _lifecycle_text,
    _navigation_result,
    _submission_text,
    render_job_board,
    run_terminal_job_board,
)
from helpers import TimedTestCase


NOW = datetime(2026, 9, 25, 10, 30, tzinfo=timezone.utc)


def job(state: str, job_id: str) -> dict[str, object]:
    """Return a complete terminal-job fixture for one state."""
    return {
        "job_id": job_id,
        "name": f"job-{state.lower()}",
        "cluster": "CLUSTER_0",
        "partition": "gpu-h100",
        "state": state,
        "node_count": 1,
        "nodes": ["node01"],
        "gpus": 2,
        "cpus": 16,
        "elapsed_seconds": 600,
        "time_limit_seconds": 3600,
        "submit_at": "2026-09-25T10:00:00+00:00",
        "start_at": "2026-09-25T10:05:00+00:00" if state in {"RUNNING", "COMPLETED", "FAILED"} else None,
        "end_at": "2026-09-25T10:20:00+00:00" if state in {"COMPLETED", "FAILED"} else None,
        "expected_start_at": "2026-09-25T11:00:00+00:00" if state == "PENDING" else None,
        "reason": None,
    }


class InteractiveOutput(StringIO):
    """A memory stream that behaves like an ANSI-capable terminal."""

    def isatty(self) -> bool:
        """Report terminal support to the jobs-board runner."""
        return True


class TerminalJobsTests(TimedTestCase):
    """Exercise state order, progress colors, and live refresh behavior."""

    def test_board_orders_states_and_displays_every_requested_field(self):
        payload = {
            "jobs": [
                job("CANCELLED", "5"), job("FAILED", "4"), job("COMPLETED", "3"),
                job("PENDING", "2"), job("RUNNING", "1"),
            ],
            "clusters": [],
        }

        output = render_job_board(payload, now=NOW, use_color=True, width=180)

        positions = [output.index(state) for state in ("RUNNING", "PENDING", "COMPLETED", "FAILED", "CANCELLED")]
        self.assertEqual(positions, sorted(positions))
        for state in ("RUNNING", "PENDING", "COMPLETED", "FAILED", "CANCELLED"):
            self.assertEqual(output.count(f"### {state} ###"), 1)
        self.assertNotIn("STATE", output.splitlines()[1])
        self.assertIn("\033[34m", output)
        self.assertIn("\033[31m", output)
        self.assertIn("job-running", output)
        self.assertIn("CLUSTER_0", output)
        self.assertIn("gpu-h100", output)
        self.assertIn("1 node · 2 GPU · 16 CPU", output)
        local_submission = datetime(2026, 9, 25, 10, tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
        local_launch = datetime(2026, 9, 25, 10, 5, tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
        local_end = datetime(2026, 9, 25, 10, 20, tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
        self.assertIn(local_submission, output)
        self.assertIn(local_launch, output)
        self.assertIn(local_end, output)
        self.assertIn("LAUNCHED", output.splitlines()[1])
        self.assertIn("ENDED", output.splitlines()[1])
        self.assertIn("10m / 1h0m", output)
        self.assertIn("30m waited · 30m left", output)

    def test_utc_accounting_submission_is_rendered_in_local_timezone(self):
        """Convert explicit accounting UTC rather than printing it as local."""
        completed = job("COMPLETED", "1000414")
        completed["submit_at"] = "2026-09-30T14:26:05Z"

        rendered = _submission_text(completed, timezone(timedelta(hours=2)))

        self.assertEqual(rendered, "2026-09-30 16:26")

    def test_lifecycle_times_are_shown_only_for_relevant_states(self):
        """Suppress launch/end fields where the requested lifecycle excludes them."""
        local = timezone(timedelta(hours=2))

        self.assertEqual(_lifecycle_text(job("RUNNING", "1"), "launched", local), "2026-09-25 12:05")
        self.assertEqual(_lifecycle_text(job("RUNNING", "1"), "ended", local), "—")
        self.assertEqual(_lifecycle_text(job("COMPLETED", "2"), "ended", local), "2026-09-25 12:20")
        self.assertEqual(_lifecycle_text(job("FAILED", "3"), "ended", local), "2026-09-25 12:20")
        self.assertEqual(_lifecycle_text(job("PENDING", "4"), "launched", local), "—")

    def test_board_skips_empty_groups_and_does_not_stretch_progress_column(self):
        """Render only populated separators and keep a wide terminal compact."""
        payload = {"jobs": [job("RUNNING", "1000150")], "clusters": []}

        output = render_job_board(payload, now=NOW, use_color=False, width=240)

        self.assertIn("### RUNNING ###", output)
        self.assertNotIn("### PENDING ###", output)
        heading = next(line for line in output.splitlines() if line.startswith("JOB ID"))
        self.assertLess(heading.index("SUBMITTED") - heading.index("PROGRESS"), 40)
        job_line = next(line for line in output.splitlines() if line.startswith("1000150"))
        self.assertLess(len(job_line), 185)

    def test_narrow_board_uses_group_separators_without_repeating_state(self):
        """Keep the grouped presentation when rows use the two-line layout."""
        output = render_job_board(
            {"jobs": [job("RUNNING", "1"), job("RUNNING", "2")], "clusters": []},
            now=NOW,
            width=100,
        )

        self.assertEqual(output.count("### RUNNING ###"), 1)
        self.assertNotIn("RUNNING    1", output)

    def test_noninteractive_output_omits_ansi_colors(self):
        output = render_job_board(
            {"jobs": [job("RUNNING", "1"), job("PENDING", "2")], "clusters": []},
            now=NOW,
            use_color=False,
            width=100,
        )

        self.assertNotIn("\033[", output)
        self.assertIn("RUNNING", output)
        self.assertIn("PENDING", output)
        self.assertIn("█", output)

    def test_refresh_mode_replaces_the_terminal_until_interrupted(self):
        output = InteractiveOutput()
        collections = 0
        sleeps = 0

        def collect(_machines: list[Machine], _timeout: int) -> dict[str, object]:
            nonlocal collections
            collections += 1
            return {"jobs": [job("RUNNING", str(collections))], "clusters": []}

        def sleep(_seconds: float) -> None:
            nonlocal sleeps
            sleeps += 1
            if sleeps == 2:
                raise KeyboardInterrupt

        # Integrated terminals sometimes report TERM=dumb. Live output should
        # still replace the prior frame instead of growing without bound.
        with patch.dict("clusterwatcher.terminal_ui.os.environ", {"TERM": "dumb"}, clear=True):
            result = run_terminal_job_board(
                [Machine("CLUSTER_0", "host", "alice")], 15, 7,
                output=output, input_stream=StringIO(), collector=collect,
                sleep=sleep,
            )

        self.assertEqual(result, 0)
        self.assertEqual(collections, 2)
        self.assertEqual(sleeps, 2)
        self.assertIn("refreshing every 7s", output.getvalue())
        self.assertTrue(output.getvalue().startswith("\033[?1049h\033[?25l\033[H\033[2J"))
        self.assertEqual(output.getvalue().count("\033[H\033[2J"), 2)
        self.assertTrue(output.getvalue().endswith("\033[?25h\033[?1049l"))

    @patch("clusterwatcher.terminal_jobs.shutil.get_terminal_size", return_value=os.terminal_size((100, 5)))
    def test_live_view_starts_at_top_and_never_overflows_terminal_height(self, _terminal_size):
        """Keep headers visible and expose excess rows through a bounded viewport."""
        output = InteractiveOutput()
        lines = ["header", "columns-" * 20, "running", "job-1", "job-2", "job-3"]

        offset, maximum = _draw_live_view(lines, 0, output)

        visible = output.getvalue().removeprefix("\033[H\033[2J").splitlines()
        self.assertEqual(offset, 0)
        self.assertEqual(maximum, 2)
        self.assertEqual(visible[0], "header")
        self.assertTrue(visible[1].endswith("…"))
        self.assertEqual(len(visible[1]), 100)
        self.assertEqual(visible[2:4], lines[2:4])
        self.assertNotIn("job-3", visible)
        self.assertEqual(len(visible), 5)
        self.assertIn("lines 1-4 of 6", visible[-1])

    def test_navigation_keys_scroll_clamp_and_quit(self):
        """Interpret navigation sequences instead of echoing them into the board."""
        self.assertEqual(_navigation_result(b"\033[B", 0, 8, 4), (1, False))
        self.assertEqual(_navigation_result(b"\033[6~", 1, 8, 4), (5, False))
        self.assertEqual(_navigation_result(b"\033[F", 5, 8, 4), (8, False))
        self.assertEqual(_navigation_result(b"\033[A\033[A", 1, 8, 4), (0, False))
        self.assertEqual(_navigation_result(b"q", 3, 8, 4), (3, True))

    def test_redirected_refresh_output_does_not_emit_terminal_controls(self):
        """Keep redirected snapshots readable instead of inserting ANSI clears."""
        output = StringIO()
        collections = 0

        def collect(_machines: list[Machine], _timeout: int) -> dict[str, object]:
            nonlocal collections
            collections += 1
            return {"jobs": [job("RUNNING", str(collections))], "clusters": []}

        def sleep(_seconds: float) -> None:
            if collections == 2:
                raise KeyboardInterrupt

        result = run_terminal_job_board(
            [Machine("CLUSTER_0", "host", "alice")], 15, 7,
            output=output, collector=collect, sleep=sleep,
        )

        self.assertEqual(result, 0)
        self.assertEqual(collections, 2)
        self.assertNotIn("\033[H\033[2J", output.getvalue())
        self.assertNotIn("\033[?1049h", output.getvalue())
        self.assertEqual(output.getvalue().count("My jobs · updated"), 2)

    def test_live_screen_is_restored_when_collection_fails(self):
        """Never strand the user's terminal in alternate-screen mode."""
        output = InteractiveOutput()
        collections = 0

        def collect(_machines: list[Machine], _timeout: int) -> dict[str, object]:
            nonlocal collections
            collections += 1
            if collections == 2:
                raise RuntimeError("collector failed")
            return {"jobs": [job("RUNNING", "1")], "clusters": []}

        with self.assertRaisesRegex(RuntimeError, "collector failed"):
            run_terminal_job_board(
                [Machine("CLUSTER_0", "host", "alice")], 15, 1,
                output=output, input_stream=StringIO(), collector=collect,
                sleep=lambda _seconds: None,
            )

        self.assertTrue(output.getvalue().endswith("\033[?25h\033[?1049l"))
