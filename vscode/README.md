# Cluster Watcher for VS Code

This extension adds **My Jobs** and **Cluster Status** views to the Activity
Bar. It is a thin client for the loopback APIs provided by `cluster-watcher
serve`; the Python application remains responsible for configuration, SSH,
MFA, Slurm queries, and refresh scheduling.

## Requirements

- The **`cluster-watcher` command-line program** must be installed on the
  machine running the extension (the remote host under Remote SSH). The
  extension does not bundle it. Install the prebuilt Linux executable with

  ```bash
  curl -fsSL https://raw.githubusercontent.com/CameronBraunstein/cluster-watcher/master/install.sh | bash -s -- --add-to-path
  ```

  (or `pipx install git+https://github.com/CameronBraunstein/cluster-watcher`),
  then run `cluster-watcher setup` once to describe your clusters.
- SSH access to each Slurm cluster from that machine.
- If `cluster-watcher` is not on `PATH`, set `clusterWatcher.executable` to its
  absolute path.

**My Jobs** uses collapsible state groups instead of terminal-style banners.
Each job is another collapsible card whose compact form contains its name, ID,
progress color bar, and completion/start estimate. The ID badge has a fixed
width regardless of the title length; click it (or focus it and press Enter) to
copy the job ID to the clipboard without toggling the card. Expand a card to
see details and to:

- select **Archive** and move it into the collapsed **Archive** group at the
  bottom, or **Restore** it later;
- open the associated `.err` or `.out` stream as a read-only VS Code document;
- select **Open script** to view the Slurm batch script the job ran, as a
  read-only, shell-highlighted document. For queued and running jobs this is
  Slurm's exact copy of the submitted script. Slurm usually discards that copy
  when a job ends, so for finished jobs the extension opens the script file
  named on the recorded `sbatch` command line instead, and a warning says that
  it is the current file and may have changed since submission;
- for running and pending jobs, select **End Job** in the card's lower-right
  corner. A modal dialog asks for
  confirmation, then the service runs `scancel` for that job. The ID badge
  turns red and the button disappears until Slurm stops listing the job;
- for jobs with a Slurm dependency, read the **Depends on** row. Each job ID in
  it is a link that opens and scrolls to that job's card (opening its group if
  collapsed). A notification explains when the job is not in the list.

The archive is stored in VS Code extension global state and survives editor
restarts. Group, card, and cluster disclosure choices survive live data
refreshes: the webview reports each expand/collapse to the extension, which
renders the remembered state into every refreshed page (for the current VS Code
session). Cluster names are collapsible headings in **Cluster Status**. The
native **My Jobs** and **Cluster Status** view headings replace redundant titles
inside each webview. Refresh and service-start buttons appear once in the
Cluster Watcher container toolbar.

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

If a service is reachable but was started without `--jobs-api` (for example
by hand as `cluster-watcher serve`), **Cluster Status** still works, while
**My Jobs** explains the problem with **Copy restart command** and **Retry**
buttons, and the status bar shows **jobs API off** rather than offline.
**Start service** warns instead of attaching to such a service. Stop it and
start it again with `--jobs-api`. Buttons that an older service does not
support yet ask you to upgrade `cluster-watcher` and restart the service.

Two settings control background feedback:

- `clusterWatcher.notifications` (`all`, `failures`, or `off`; default `all`)
  shows a notification, with **Open .out**/**Open .err** buttons, when a job
  that was running or pending completes, fails, or is cancelled. The first
  refresh after VS Code starts only records the current state, so old
  completions are not replayed; jobs ended with **End Job** are not reported.
- `clusterWatcher.statusBar` (default `true`) shows `N running · M pending` in
  the status bar, or a warning-coloured **offline** item when the service is
  unreachable. Click it to reveal **My Jobs**.

Webview buttons do not use command links. Each one posts a message, and the
extension only runs commands from a fixed allowlist (archive, restore, open
log, end job, start service, setup, edit configuration, settings).

Use **Cluster Watcher: Start Service & SSH Sessions** from the Command Palette.
The service opens in an integrated terminal so password and OTP prompts remain
visible. If a compatible service is already listening at
`clusterWatcher.backendUrl`, the extension attaches without starting another
process.

The `cluster-watcher` executable must be installed on the machine running the
VS Code extension host. Set `clusterWatcher.executable` to an absolute path if
it is not on that host's `PATH`, and set `clusterWatcher.configPath` when the
normal configuration location should not be used.

The extension validates that setting with `<executable> --help` before opening
the service terminal. If validation fails, use the notification's **Open
Executable Setting** button and set `clusterWatcher.executable` in VS Code
`settings.json`. The extension's `package.json` only declares the setting; it
is not the user configuration file.

The extension is declared as a workspace extension. Under VS Code Remote SSH,
install it on the remote side so its process, the executable, and reusable SSH
control sockets all live on that remote development host.

The extension is licensed GPL-3.0-or-later (`LICENSE`). The original Activity
Bar icon and the Marketplace icon (`media/icon.png`, rendered from
`media/icon-source.svg`) show server boxes under a magnifying glass and are
dedicated under CC0-1.0; `media/LICENSE.txt` is included with the packaged
extension. Release notes are in `CHANGELOG.md`.

See the repository's main `README.md` for development, VSIX packaging,
publishing, security, and SSH-session sharing details.
