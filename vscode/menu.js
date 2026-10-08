'use strict';

/** Actions exposed by the single Cluster Watcher sidebar menu. */
const SIDEBAR_MENU_ITEMS = Object.freeze([
  { label: '$(refresh) Refresh', command: 'clusterWatcher.refresh' },
  { label: '$(play) Start Service & SSH Sessions', command: 'clusterWatcher.startService' },
  { label: '$(debug-stop) Stop Extension-started Service', command: 'clusterWatcher.stopService' },
  { label: '$(globe) Open Web Dashboard', command: 'clusterWatcher.openDashboard' },
  { label: '$(terminal) Show Service Terminal', command: 'clusterWatcher.showServiceTerminal' },
  { label: '$(edit) Edit Configuration', command: 'clusterWatcher.editConfig' },
  { label: '$(tools) Run Configuration Setup Wizard', command: 'clusterWatcher.runSetup' },
  { label: '$(settings-gear) Open Extension Settings', command: 'clusterWatcher.openSettings' },
  { label: '$(package) Manage Backend Installation', command: 'clusterWatcher.manageBackend' },
]);

/** Show the shared sidebar action picker and run the selected command. */
async function showSidebarMenu(vscode) {
  const selection = await vscode.window.showQuickPick(SIDEBAR_MENU_ITEMS, {
    title: 'Cluster Watcher',
    placeHolder: 'Choose an action',
  });
  if (selection) await vscode.commands.executeCommand(selection.command);
}

module.exports = { SIDEBAR_MENU_ITEMS, showSidebarMenu };
