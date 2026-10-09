# Cluster Watcher for VS Code

This extension adds **My Jobs** and **Cluster Status** views to the Activity
Bar. It is a thin client for the loopback APIs provided by `cluster-watcher
serve`; the Python application remains responsible for configuration, SSH,
MFA, Slurm queries, and refresh scheduling.

## Requirements

- On first use, the extension looks for an existing **`cluster-watcher`**
  command on the machine running the extension (the remote host under Remote
  SSH). If it cannot run one, choose **Install and Add to PATH**, **Use Only in
  VS Code**, or **Choose Existing Executable**. The first two choices download
  the exact backend version paired with the extension and verify its embedded
  SHA-256 checksum before running it. You can change the choice at any time
  with **Cluster Watcher: Manage Backend Installation**.
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

**My Jobs** uses collapsible state groups instead of terminal-style banners.
Each job is another collapsible card whose compact form contains its name,
progress color bar, and completion/start estimate. Long names stay on one line
and end in an ellipsis; an immediate, white-outlined hover label shows the
cluster, job ID, and full job name. Card
summaries use tight internal padding and reduced spacing between neighboring
cards. The copyable job-ID badge has rectangular corners and an inset blue
hover/focus border whose four edges remain visible.
Dependency-blocked cards omit the empty progress bar and show
`dependency:<type> <job ID>`; the ID links to the relevant card and a popup
reports when it cannot be found. A clock marks a waiting ID, a green check a
satisfied condition, and a red x a failed one. Because Slurm normally removes
satisfied IDs from its remaining-dependencies field, checks appear only while
the ID remains available in the expression or a retained snapshot. Jobs whose
overall condition is impossible appear under **Failed Dependency** instead of
**Pending**. The expanded **Depends on** row also retains the complete
dependency. Open cards use a horizontal
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
Slurm's explicit `TIMEOUT` state. Expand a card to see the job ID before the
cluster, partition, and resource summary; click it (or focus it and press
Enter) to copy it. A running job's calculated limit and a terminal job's end
time appear with the expanded lifecycle details. Elapsed time is not repeated
there because it is already in the compact progress fraction. Running cards
omit **Ended**; pending cards omit both **Launched** and **Ended**. Expanded
resource metadata wraps across as many lines as needed. Lifecycle timestamps
stay on one line when space permits; on a narrow card, the date remains on the
first line and the time wraps onto a right-aligned second line. The compact
icon/short-label action row remains on one line. Long progress labels ellipsize,
while dependency expressions and expanded job names wrap inside the card.
Expand a card to see details and to:

- select the archive-box icon and move it into the collapsed **Archive** group
  at the bottom, or **Restore** it later;
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
  collapsed), with the same waiting/satisfied/failed icon as the compact row.
  A notification explains when the job is not in the list.

The archive is stored in VS Code extension global state and survives editor
restarts. Group, card, and cluster disclosure choices survive live data
refreshes: the webview reports each expand/collapse to the extension, which
renders the remembered state into every refreshed page (for the current VS Code
session). Cluster names are collapsible headings in **Cluster Status**. The
native **My Jobs** and **Cluster Status** view headings replace redundant titles
inside each webview. A compact `Last update: <date and time with seconds>` line
appears directly below each heading. Each heading has its own **Refresh**
action, which polls only that view's endpoint.
**Cluster Watcher: Refresh Sidebar** in the Command Palette
refreshes both views; service, dashboard, configuration, settings, and
backend-management actions also remain available there. A pressed heading
refresh button changes briefly to a spinning sync icon, including when the
response is unchanged. A notification distinguishes new data (`Refreshed at:`)
from an unchanged check (`Checked, but no updates at:`), with a local date and
time including seconds.

Log documents initially contain the newest 2,000 lines. If more output exists,
use the upward-arrow **Load 2,000 Older Lines** editor-title action; each click
prepends one more bounded page until the complete remote file is loaded.

When the service is not reachable, both views show a welcome screen with
buttons to **Start service & SSH sessions**, **Run setup wizard** (runs
`cluster-watcher setup` in a terminal), **Edit configuration** (opens the file
reported by `cluster-watcher config --path` in an editor tab), and **Settings**.
The same actions are in the Command Palette and the view's toolbar/overflow
menu. Saving the configuration from VS Code validates it immediately (via
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

In **Cluster Status**, a wait cell without an estimate says why: `DENY` (your
account may not use the partition), `min` (below its minimum GPU request),
`limit` (over a limit for your account), `n/a` (no node can run it now, e.g.
all drained), `ERR` (a real failure, such as Slurm not answering), `?` (not
probed), or `…` (the first probes are still running). Hover a cell for
Slurm's message. The columns begin **Partition**, **Available**, **GPU**,
**VRAM**, and **TFLOPS/s**, followed by the wait estimates and CPU total.
Catalog names are shortened to model labels such as `H100`; hover one for its
full GPU name. The availability bar and `idle/total` fraction stay together on
one line for a more compact table. Green available capacity appears on the left
and red unavailable capacity follows it. Hover the bar for a node-only state
breakdown that appears after about 100 ms; zero-count categories are omitted.

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
log, end job, start service, setup, edit configuration, settings, log in).

Use **Cluster Watcher: Start Service & SSH Sessions** from the Command Palette.
The service opens in an integrated terminal so password and OTP prompts remain
visible. If a compatible service is already listening at
`clusterWatcher.backendUrl`, the extension attaches without starting another
process.

If a cluster's SSH session closes later, its **Cluster Status** card says so
and shows **Log in again**. The button runs `cluster-watcher login <cluster>` in
a terminal, without restarting the service. Other closed clusters that share
the same password (`credential_group`) are logged in at the same time, so the
password is asked for once, followed by one one-time code per cluster. The
terminal closes after a successful login, and the card recovers on the next
refresh. **Cluster Watcher: Log In Again to Closed SSH Sessions** in the
Command Palette does the same for every closed cluster.

The `cluster-watcher` executable is resolved on the machine running the VS Code
extension host. Set `clusterWatcher.configPath` when the normal configuration
location should not be used.

The extension validates every managed or selected executable with
`<executable> --help` before opening the service terminal. If validation fails,
use the notification's **Manage Backend** button to repair the managed copy or
choose another executable.

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
