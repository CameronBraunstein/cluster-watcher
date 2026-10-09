# Changelog

All notable changes to the Cluster Watcher VS Code extension.

## Unreleased

- Narrow job cards now keep progress, elapsed/total time, detail timestamps,
  and the complete action row on single lines. Running-job deadlines moved to
  expanded details, while archive/log/script/cancel actions use compact icons
  or labels with full tooltips.
- Collapsed cards now truncate long job names to one line and expose the full
  name on hover. Hover boxes now have a white outline and show the cluster, job
  ID, and full name in both interfaces. The copyable job ID moved beside
  expanded resource metadata, and elapsed/end text moved into expanded
  lifecycle details.
- Dependency waits and unavailable start estimates now omit their empty
  progress bars and show wrapped explanations. Open cards use a summary/detail
  divider instead of a disclosure icon, card borders flash immediately after
  layout changes and fade back more slowly, and full-name hover labels appear
  immediately.
- Completed and failed cards keep the progress bar's `time run / time allotted`
  comparison. Elapsed time is no longer duplicated in expanded details;
  running cards omit **Ended**, and pending cards omit **Launched** and
  **Ended**. The backend now includes Slurm's accounting time limit for
  terminal jobs so the denominator and proportional fill remain available
  after a job leaves the live queue.
- Job IDs now precede cluster and resource metadata. Failed jobs are split into
  **Failed (Early)** and **Failed (Timeout)** sections in both the sidebar and
  browser dashboard.
- Job-ID badges now use rectangular corners, while compact cards use less
  internal padding and tighter spacing between cards.
- Pending cards now omit `.err` and `.out`. Archived pending jobs continue to
  refresh and gain both log actions as soon as their Slurm state advances.
- **My Jobs** and **Cluster Status** now show compact `Last update:` text
  directly below their native headings, with second precision.
  Each heading has an independent **Refresh** action; the Command Palette's
  **Refresh Sidebar** action still refreshes both. Less-frequent actions remain
  in the Command Palette.
- The running/pending status-bar hover now pluralizes `job` for each count and
  shows the local date and time, including seconds, of the latest successful
  jobs refresh.
- Cluster Status now orders its leading columns as **Partition**, **Available**,
  **GPU**, **VRAM**, and **TFLOPS/s**. GPU names use compact model labels such
  as `H100`, with the full catalog name available on hover in both interfaces.
- Cluster Status keeps each availability bar and fraction on one line, puts
  green available capacity before red unavailable capacity, and shows a
  nonzero-only, node-only state breakdown after a 100 ms hover. Manual
  view refreshes briefly show a spinning sync icon so fast and unchanged
  checks still provide immediate feedback, followed by a notification that
  distinguishes refreshed data from a check with no updates.
- Narrow job cards use **estimated wait** when an estimate exists, ellipsize
  long progress/metadata text, and safely wrap explanations and dependency
  expressions so user- and cluster-provided values cannot escape the card.
  Zero-length job durations render as `<1m` rather than `now`.

## 0.1.3 — 2026-10-07

- First-use backend installation can now download the exact native release for
  the extension host, verify its embedded SHA-256 checksum, and either expose
  it only inside VS Code or add it to the user's PATH.
- New **Manage Backend Installation** command switches reversibly between the
  managed and an existing executable, manages PATH, repairs/updates the
  managed copy, and uninstalls only extension-owned files.
- Backend choices are local to each local, WSL, SSH, or container extension
  host, and Workspace Trust is required before native execution.
- Integrated CLI terminals now launch the executable and arguments directly,
  so service startup, setup, and login work without POSIX shell quoting on
  native Windows as well as Linux and macOS.
- Tagged releases now publish the CI-built VSIX to the VS Code Marketplace
  with short-lived Microsoft Entra credentials after the GitHub Release is
  available.

## 0.1.2 — 2026-10-07

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

## Unreleased

## 0.1.4 — 2026-10-07

- Releases now publish the CI-built VSIX automatically to the VS Code
  Marketplace using Microsoft Entra workload identity federation.
