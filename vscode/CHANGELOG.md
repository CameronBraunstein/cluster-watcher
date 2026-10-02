# Changelog

All notable changes to the Cluster Watcher VS Code extension.

## 0.1.0 — Unreleased

First public release.

- **My Jobs** sidebar: running, pending, completed, failed, and cancelled
  groups with collapsible job cards, progress bars, and start estimates.
- Fixed-width job ID badges; click one to copy the ID.
- **End Job** button for running and pending jobs, with a confirmation dialog.
- **Depends on** row for dependent jobs; each job ID jumps to its card.
- Archive and restore jobs; the archive persists across restarts.
- **Open script** shows the Slurm batch script a job ran.
- Open a job's `.out` or `.err` log as a read-only document and load older
  pages on demand.
- **Cluster Status** sidebar: per-cluster partition tables with GPU model,
  VRAM, throughput, availability, and wait estimates for 1–64 GPUs.
- Expanded/collapsed sections survive refreshes.
- Notifications when jobs complete, fail, or are cancelled
  (`clusterWatcher.notifications`).
- Status bar summary of running and pending jobs (`clusterWatcher.statusBar`).
- Welcome screen with buttons to start the service, run the setup wizard, or
  edit the configuration; the configuration is validated on save.
