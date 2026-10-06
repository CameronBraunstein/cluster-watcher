# Changelog

All notable changes to the Cluster Watcher VS Code extension.

## Unreleased

- Job card titles sit next to the collapse arrow instead of below it, with the
  progress bar aligned under the title.
- **End Job** sits in the lower-right corner of the card, apart from the other
  actions.
- The Activity Bar icon hides the servers behind the magnifying glass, like
  the Marketplace icon.

## 0.1.1 — 2026-10-06

- When the service is running but was started without `--jobs-api`, My Jobs
  now explains this and offers **Copy restart command** and **Retry**, and the
  status bar shows "jobs API off" instead of wrongly reporting the service
  offline.
- **Start service** warns instead of silently attaching to such a service.
- Actions unsupported by an older service now suggest upgrading
  `cluster-watcher` instead of showing a bare HTTP 404.

## 0.1.0 — 2026-10-06

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
