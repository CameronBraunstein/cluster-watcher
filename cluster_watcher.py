#!/usr/bin/env python3
"""Compatibility entry point for the Cluster Watcher command-line tool."""

from clusterwatcher.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
