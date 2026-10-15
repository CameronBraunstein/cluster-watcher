# Cluster Watcher for VS Code

This extension adds **My Jobs**, **Cluster Status**, and **Server Status** views
to the Activity Bar. It is a thin client for the loopback APIs provided by
`cluster-watcher serve`; the Python application remains responsible for
configuration, SSH, MFA, Slurm queries, and refresh scheduling.

When no backend service is found, **My Jobs** and **Cluster Status** become
collapsed offline placeholders. Their expanded content contains only a short
notice. The off switch in **Server Status** is labeled **Start Server**.
**Run setup wizard** appears beneath it only if the selected `clusters.toml`
is missing, but remains in the Server Status title menu at all times. The
**configure clusters...** link beneath the cluster cards opens the
configuration file; configuration and settings commands remain in the Command
Palette. Successful backend responses restore the live views. You can still
expand an offline placeholder manually.

## Requirements

- On first use, the extension looks for an existing **`cluster-watcher`**
  command on the machine running the extension (the remote host under Remote
  SSH). If it cannot run one, choose **Install and Add to PATH**, **Use Only in
  VS Code**, or **Choose Existing Executable**. The first two choices download
  the exact backend version paired with the extension and verify its embedded
  SHA-256 checksum before running it. You can change the choice at any time
  with **Cluster Watcher: Manage Backend Installation**.
  In an unpackaged Linux or macOS development checkout with no
  `backend-manifest.json`, the first choices are **Download Latest Release
  and Add to PATH** and **Download Latest Release (No PATH Change)**. They
  run the checkout's `install.sh`, verify the release against `SHA256SUMS`,
  and select the installed command automatically. **Build from Source** is
  available in the same menu if the release binary cannot run; it requires
  Python 3.11+ and build dependencies. A development download may be older
  than the extension checkout. No-PATH choices leave shell profiles unchanged;
  add-to-PATH choices use the installer's safety checks. Development-checkout
  installs are standalone external commands, so remove one with the checkout's
  `uninstall.sh`, not **Uninstall Managed Backend**.
- A manual installation remains supported. On Linux or macOS, install the
  prebuilt executable with

  ```bash
  curl -fsSL https://raw.githubusercontent.com/CameronBraunstein/cluster-watcher/master/install.sh | bash -s -- --add-to-path
  ```

  (or `pipx install git+https://github.com/CameronBraunstein/cluster-watcher`),
  then run `cluster-watcher setup` once to describe your clusters.
  On native Windows, install it with the repository's `install.ps1`; SSH
  key/agent clusters are supported there. Password/OTP clusters require the
  complete Unix OpenSSH multiplexing path, so run both the executable and this
  workspace extension inside WSL for those clusters.
- SSH access to each Slurm cluster from that machine.
- If an existing executable is not on `PATH`, select it through **Manage
  Backend Installation**. `clusterWatcher.executable` remains a fallback for
  settings created before the managed installer was introduced.
  On Linux, the prebuilt installer verifies glibc through Node's runtime
  report or `getconf GNU_LIBC_VERSION`. If the prebuilt backend is incompatible
  or its glibc version cannot be verified, run
  `./install.sh --from-source --add-to-path` in a matching source checkout,
  then choose the resulting command with **Choose Existing Executable**. Use
  its absolute path if the extension host has not picked up the new `PATH`.

**My Jobs** uses collapsible state groups instead of terminal-style banners.
On first startup, the service can be running before its first Slurm collection
finishes. During that interval, offline **My Jobs**, **Cluster Status**, and
status-bar views show **Loading** rather than start-service controls. The extension
retries the backend's temporary first-collection response every second; each
view replaces Loading as soon as its own data arrives.
Each job is another collapsible card whose compact form contains its name,
progress color bar, and completion/start estimate. Long names stay on one line
and end in an ellipsis; hovering the title (not the rest of the card) shows an
immediate, white-outlined label with the cluster, job ID, and full job name. Card
summaries use tight internal padding and reduced spacing between neighboring
cards. The copyable job-ID badge has rectangular corners and an inset blue
hover/focus border whose four edges remain visible.
Dependency-blocked cards omit the empty progress bar and show
`dependency:<type> <job ID>`; the ID links to the relevant card and a popup
reports when it cannot be found. In the expanded **Depends on** row, a clock
after an ID marks it as waiting, a green check marks it as satisfied, and a red
x marks it as failed. Hovering an icon shows the Slurm status and a fuller
description instead of displaying a status parenthetical, using the same fast
hover timing as the availability breakdown. Because Slurm normally removes
satisfied IDs from its remaining-dependencies field, checks appear only while
the ID remains available in the expression or a retained snapshot. Jobs whose
overall condition is impossible appear under **Failed Dependency** instead of
**Pending**. Open cards use a horizontal
divider between the always-visible summary and their details instead of a
disclosure icon. Opening or closing highlights the card border immediately,
then fades that highlight more slowly.
Pending cards with usable estimates use `<duration> estimated wait`; missing
estimates show **no estimate available** without an empty bar. The bar and run/allotted
time stay on one line at the sidebar's narrowest
expanded width, including on completed and failed cards; their denominator
comes from the time limit retained in Slurm accounting. Zero-length recorded
durations appear as `<1m` rather than `now`. Jobs are separated into
**Failed (Early)** and **Failed (Timeout)** groups; the latter is reserved for
Slurm's explicit `TIMEOUT` state. Expanding a card reveals the job-ID badge to
the right of its progress bar (or priority gauge); click it (or focus it and
press Enter) to copy it without collapsing the card. The cluster, partition,
and resource summary follow in the details. A running job's calculated limit and a terminal job's end
time appear with the expanded lifecycle details. Elapsed time is not repeated
there because it is already in the compact progress fraction. Running cards
omit **Ended**; pending cards omit both **Launched** and **Ended**. Expanded
resource metadata wraps across as many lines as needed. Lifecycle timestamps
stay on one line when space permits; on a narrow card, the date remains on the
first line and the time wraps onto a right-aligned second line. The compact
icon/short-label action row remains on one line. Long progress labels ellipsize,
while dependency expressions and expanded job names wrap inside the card.
When a cluster exposes a global queue rank—or numeric Slurm priorities for at
least two of the user's visible pending jobs—expanded Pending cards add a
number-free low-to-high priority gauge. Hover it for `Global priority <rank> / <all pending>` and `Your
priority <rank> / <your pending>` on separate lines, or hover the **Priority**
label to the left of the bar for a reminder that lower rank numbers are better
and a short scheduling caveat. The marker visualizes the global rank and falls
back to the user rank only when global data is unavailable. If no wait estimate exists, the
gauge moves into the always-visible
summary and becomes as thick as a normal progress bar. It has no directional
arrows and is omitted when no useful comparison is possible.
Finished, failed, cancelled, and other non-running/non-pending cards show the
archive-box icon on the compact card, just left of progress. Running and
Pending cards keep Archive in their expanded actions; Archive cards keep
Restore there. Expand a card to see details and to:

- archive a running or pending job, or **Restore** a job from the collapsed
  **Archive** group at the bottom;
- once a job has left the pending group, select **.err** or **.out** to open
  that stream as a read-only VS Code document. Pending cards omit both actions;
  an archived pending card receives refreshed state and gains them when it
  starts or finishes;
- select **script** to view the Slurm batch script the job ran, as a
  read-only, shell-highlighted document. For queued and running jobs this is
  Slurm's exact copy of the submitted script. Slurm usually discards that copy
  when a job ends, so for finished jobs the extension opens the script file
  named on the recorded `sbatch` command line instead, and a warning says that
  it is the current file and may have changed since submission. The **.err**,
  **.out**, and **script** controls preserve the sidebar's current scroll
  position when their document opens;
- for running and pending jobs, select **End** in the card's lower-right
  corner. A modal dialog asks for
  confirmation, then the service runs `scancel` for that job. The ID badge
  turns red and the button disappears until Slurm stops listing the job;
- for jobs with a Slurm dependency, read the **Depends on** row. Each job ID in
  it is a link that opens and scrolls to that job's card (opening its group if
  collapsed). The status icon follows the ID only in this expanded row and
  provides its description on hover. A notification explains when the job is
  not in the list.

The archive is stored in VS Code extension global state and survives editor
restarts. Group, job-card, and cluster disclosure choices survive live data
refreshes: the webview reports each expand/collapse to the extension, which
renders the remembered state into every refreshed page (for the current VS Code
session). Archive and restore actions also retain the current viewport by
anchoring it to a nearby unchanged card across the rerender. Cluster names are
collapsible headings in **Cluster Status**. The
native **My Jobs** and **Cluster Status** view headings replace redundant titles
inside each webview. A compact `Last update: <date and time with seconds>` line
appears directly below each heading. Each heading has its own **Refresh**
action, which polls only that view's endpoint.
**Cluster Watcher: Refresh Sidebar** in the Command Palette
refreshes all three views; service, dashboard, configuration, settings, and
backend-management actions also remain available there. A pressed heading
refresh button changes briefly to a spinning sync icon, including when the
response is unchanged. A notification distinguishes new data (`Refreshed at:`)
from an unchanged check (`Checked, but no updates at:`), with a local date and
time including seconds.

Log documents initially contain the newest 2,000 lines. If more output exists,
use the upward-arrow **Load 2,000 Older Lines** editor-title action; each click
prepends one more bounded page until the complete remote file is loaded.

When the service is not reachable, the collapsed jobs and cluster placeholders
contain no startup buttons. **Run setup wizard** runs `cluster-watcher setup`
in a terminal, and the Server Status title menu keeps that action available
even when a TOML already exists. **Edit configuration** opens the file reported
by `cluster-watcher config --path` in an editor tab; if missing, it offers the
wizard. Saving the configuration from VS Code validates it immediately (via
`cluster-watcher list`) and reports any error; restart the service to apply it.

The extension-managed backend is installed per user on the extension host:

- Linux: `~/.local/share/cluster-watcher/vscode-backend/bin`
- macOS: `~/Library/Application Support/Cluster Watcher/vscode-backend/bin`
- Windows: `%LOCALAPPDATA%\Programs\ClusterWatcher\vscode-backend\bin`

**Use Only in VS Code** exposes that directory to new integrated terminals
through VS Code's terminal environment API without changing the system PATH.
**Install and Add to PATH** additionally writes one marked block to the
current Unix shell profile, or one entry to the Windows user PATH. Open a new
terminal after changing PATH. The ownership manifest records the exact change;
**Manage Backend Installation** can add or remove it later without touching a
pre-existing PATH entry.

The same management command can switch between the managed and an existing
executable, repair/update the managed copy, or uninstall it. Switching to an
external executable keeps the managed copy available for a later switch.
Uninstalling the managed backend removes only extension-owned files and PATH
changes and preserves Cluster Watcher configuration. Removing the VS Code
extension itself intentionally leaves a standalone managed backend in place;
use the management command first if it should also be removed.

If a service is reachable but was started without `--jobs-api` (for example
by hand as `cluster-watcher serve`), **Cluster Status** still works, while
**My Jobs** explains the problem with **Copy restart command** and **Retry**
buttons, and the status bar shows **jobs API off** rather than offline.
**Start service** warns instead of attaching to such a service. Stop it and
start it again with `--jobs-api`. Buttons that an older service does not
support yet ask you to upgrade `cluster-watcher` and restart the service.

Refreshes are conditional: the extension sends the previous response's ETag
and the service answers `304 Not Modified` when your jobs and the cluster
status are unchanged, so the views are not rebuilt (no flicker, and scroll and
hover are kept). Progress bars, elapsed times, and wait estimates still count
on their own every few seconds. The compact freshness line below each heading
shows only when data last changed, with exact second precision.

Pending-job priority bars show both a cluster-wide rank among all visible
pending jobs and a user rank among your pending jobs on that cluster; 1 is the
highest Slurm score and tied scores share a rank. The marker visualizes the
user rank, while hover text reports both ranks. The ⓘ beside each bar begins
**Higher scores …** and explains that neither value guarantees launch order or
start time. A better rank usually means earlier consideration than lower-ranked
jobs when their resource requirements and scheduling tier are comparable, but
QOS, reservations, resource fit, and backfill still control actual launch
order. If the cluster denies the queue-wide query, global priority is shown as
unavailable while the user rank remains available.
The former large value was Slurm's raw, cluster-specific weighted priority
score. Its absolute magnitude is not a queue position and is not comparable
between clusters, which is why the interface now presents relative global and
user ranks.

**Cluster Status** shows each partition as a permanently expanded compact card.
It shows the partition name, seven account-aware launchability blocks for 1,
2, 4, 8, 16, 32, and 64 GPUs, and the best GPU's compact model label (such as
`H100`), VRAM, TFLOPS/s, CPU-thread total, and GPU availability. Each block uses the configured
wait thresholds from dark green through green, yellow, orange, and red. Black
means the request was rejected by account/QOS policy, gray means unavailable
or unprobed, and a striped block exceeds the partition's capacity. Hover a
block for its exact one-hour-job estimate, expected start, or Slurm error, and
hover the GPU model for its full name. VRAM and thread hover text explicitly
labels those amounts. When the partition name and complete launchability strip
do not fit together, the strip wraps intact and flush left onto a second line.

**Free GPUs** precedes a green/red bar with its `idle/total` fraction;
hover the bar for a node-only state breakdown (zero-count categories are
omitted).

The card does not repeat the same wait information as a graph. The colored
blocks keep counting down locally between service updates. A
development partition capped below one hour shows the actual shorter probe
runtime in its hover text.
The main README explains the scheduling semantics; unavailable data is simply
omitted.

**Server Status** sits below Cluster Status. It reports the managed process as
starting, waiting for credentials, running, stopping, or stopped. Both a
compatible service started elsewhere and an extension-owned service show only
the clickable dashboard URL, with no status prefix. The URL is a button styled
as a link, so its process/start tooltip is not accompanied by a dummy `#`
target. A smaller toggle appears to the left of smaller text, preserving the
standard local URL at minimum sidebar width; it is green when on and gray when
off, and its hover says
**Stop service** or **Start service**. When off, **Start Server** appears next
to the toggle; there is no duplicate start button. A running extension-owned service shows
the URL without the redundant “Running in the background” label. Hover the URL
for the backend process ID and start time. The view also shows bounded recent
diagnostic output and an
Open/Closed card for every reusable SSH session with its approximate remaining
idle lifetime. These cards use tighter spacing and a smaller, truncatable SSH
login address at minimum width. Open cards display only **Open**; hovering it
shows the approximate remaining session lifetime. Every closed interactive
machine has **Log in**. A machine with
`credential_group = "site"` also has **Log into all machines on site**; the
first action targets only that machine, while the second reuses the shared
password for all closed group members. Stopping an attached local service asks
for confirmation, warns that other connected clients will be disconnected,
and then requests a graceful shutdown from the backend.
**configure clusters...** appears below the machine cards and opens the
selected `clusters.toml` (or offers setup if it does not exist).
An extension-owned process stops when the extension host shuts down or reloads;
the OpenSSH masters may remain available for their configured persistence
period. Start the service separately when it must outlive VS Code.

Two settings control background feedback:

- `clusterWatcher.notifications` (`all`, `failures`, or `off`; default `all`)
  shows a notification, with **Open .out**/**Open .err** buttons, when a job
  that was running or pending completes, fails, or is cancelled. The first
  refresh after VS Code starts only records the current state, so old
  completions are not replayed; jobs ended with **End Job** are not reported.
- `clusterWatcher.statusBar` (default `true`) shows `N running · M pending` in
  the status bar, or a warning-coloured **offline** item when the service is
  unreachable. Its hover uses the correct singular/plural job labels and shows
  the date and time of the latest successful jobs refresh, including seconds.
  Click it to reveal **My Jobs**.

`clusterWatcher.dateFormat` (default `DD.MM.YYYY`) sets how sidebar dates are
shown, using the tokens `YYYY`, `YY`, `MM` and `DD` (for example `YYYY-MM-DD`).
Times follow as 24-hour `HH:mm` in local time, and a change redraws the
sidebar immediately.

Webview buttons do not use command links. Each one posts a message, and the
extension only runs commands from a fixed allowlist (archive, restore, open
logs/scripts/dashboard, end job, start/stop/refresh the service, setup, edit
configuration, settings, backend management, and login).

Use **Cluster Watcher: Start Service & SSH Sessions** from the Command Palette
or Server Status. The service runs directly as a managed background child
process. Password and OTP requests use masked, focus-retaining VS Code input
boxes; responses pass over the child's private stdin and never appear in its
arguments, environment, configuration, or retained diagnostic output. If a
compatible service is already listening at
`clusterWatcher.backendUrl`, the extension attaches without starting another
process.

If a cluster's SSH session closes later, its **Cluster Status** card says so
and shows **Log in again**. The button runs `cluster-watcher login <cluster>`
as a background process, without restarting the service. Other closed clusters
that share the same password (`credential_group`) are logged in at the same
time, so the password is asked for once, followed by one one-time code per
cluster. No terminal opens, and the card recovers on the next
refresh. **Cluster Watcher: Log In Again to Closed SSH Sessions** in the
Command Palette does the same for every closed cluster.

The `cluster-watcher` executable is resolved on the machine running the VS Code
extension host. Set `clusterWatcher.configPath` when the normal configuration
location should not be used.

The extension validates every managed or selected executable with
`<executable> --help` and `<executable> capabilities` before starting the
background service. The capability check prevents an older executable from
being started with unsupported terminal-free credential arguments. If it
fails, use the notification's **Manage Backend** button to repair the managed
copy, or run `./install.sh --from-source --add-to-path` from the matching source
checkout and reload the extension host.

The extension is declared as a workspace extension. Under VS Code Remote SSH,
install it on the remote side so its process, the executable, and reusable SSH
control sockets all live on that remote development host. Backend selection is
independent for local, WSL, Remote SSH, and container extension hosts.
Workspace Trust is required because the extension downloads/runs a native
executable and opens SSH sessions.

The extension is licensed GPL-3.0-or-later (`LICENSE`). The original Activity
Bar icon and the Marketplace icon (`media/icon.png`, rendered from
`media/icon-source.svg`) show server boxes under a magnifying glass and are
dedicated under CC0-1.0; `media/LICENSE.txt` is included with the packaged
extension. Release notes are in `CHANGELOG.md`.

See the repository's main `README.md` for development, VSIX packaging,
publishing, security, and SSH-session sharing details.
