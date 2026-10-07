# Changelog

All notable changes to the Cluster Watcher VS Code extension.

## Unreleased

- Job card titles sit next to the collapse arrow instead of below it, with the
  progress bar aligned under the title.
- The job ID badge fits its ID, and the progress label (elapsed time, limit or
  start estimate) sits to the right of the bar, which makes cards more compact.
- State groups (Running, Pending, …) and cluster names use the 11px size of
  the view headings; job titles are slightly smaller.
- New `clusterWatcher.dateFormat` setting (default `DD.MM.YYYY`); times are
  shown as 24-hour `HH:mm`.
- **Log in again** on a Cluster Status card whose SSH session has closed. It
  runs the new `cluster-watcher login` command, asks for a shared password
  once per credential group, and skips clusters that are still connected.
  Shared sessions now send keepalives, so they close less often.
- Wait estimates: 16-, 32- and 64-GPU requests are now probed (as multi-node
  jobs), refusals show why (`DENY`, `min`, `limit`, `n/a`; `ERR` is now only a
  real failure, with Slurm's message on hover), and cells show `…` until the
  first probes finish. Requires cluster-watcher 0.1.2, which also probes each
  partition in one SSH call and allows slow Slurm controllers 60 s per probe.
- **End Job** sits in the lower-right corner of the card, apart from the other
  actions.
- The sidebar's Refresh, Start Service, Edit Config, Setup and Settings
  buttons now appear in the **My Jobs** title bar. They used a proposed VS Code
  menu that published extensions cannot use, so they were missing before.
- The Activity Bar icon hides the servers behind the magnifying glass, like
  the Marketplace icon.
- Refreshes are conditional: unchanged data is answered with `304 Not
  Modified` and the views are not rebuilt, while progress bars, elapsed times,
  and wait estimates keep counting locally. Requires `cluster-watcher` 0.1.2.

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
