"""Test infrastructure shared by the Cluster Watcher unit tests."""

from pathlib import Path
import signal
import threading
import unittest

from clusterwatcher.compute import configure_gpu_profiles

# The real configuration is personal; every compute test uses this fixture.
TEST_CONFIG = Path(__file__).with_name("clusters.test.toml")
configure_gpu_profiles(TEST_CONFIG)


class TimedTestCase(unittest.TestCase):
    """A ``TestCase`` that fails a test that runs longer than its deadline.

    ``unittest`` has no built-in per-test timeout. POSIX hosts use ``SIGALRM``
    to interrupt a stuck test in the main thread. Platforms without interval
    timers, notably Windows, run normally and rely on the CI job timeout. The
    signal handler is restored after each test so it cannot affect another
    test or the test runner.
    """

    TEST_TIMEOUT_SECONDS = 5

    def run(self, result: unittest.TestResult | None = None) -> unittest.TestResult | None:
        """Run one test with a deadline, preserving the prior alarm handler."""
        # CLI tests repoint profiles at temporary configs; start each test clean.
        configure_gpu_profiles(TEST_CONFIG)
        signal_deadline_supported = all(
            hasattr(signal, attribute)
            for attribute in ("SIGALRM", "ITIMER_REAL", "getitimer", "setitimer")
        )
        if threading.current_thread() is not threading.main_thread() or not signal_deadline_supported:
            return super().run(result)

        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)

        def on_timeout(signum: int, frame: object) -> None:
            raise TimeoutError(f"{self.id()} exceeded its {self.TEST_TIMEOUT_SECONDS}-second test timeout")

        signal.signal(signal.SIGALRM, on_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.TEST_TIMEOUT_SECONDS)
        try:
            return super().run(result)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)
