'use strict';

/**
 * Integration checks executed inside a real VS Code extension host: the
 * extension activates, registers its commands, and its webview views open
 * without a running Cluster Watcher service.
 */
const assert = require('node:assert/strict');
const vscode = require('vscode');
const manifest = require('../../package.json');

const EXPECTED_COMMANDS = [
  'clusterWatcher.startService', 'clusterWatcher.stopService', 'clusterWatcher.refresh',
  'clusterWatcher.openDashboard', 'clusterWatcher.showServiceTerminal', 'clusterWatcher.loadMoreLog',
  'clusterWatcher.runSetup', 'clusterWatcher.editConfig', 'clusterWatcher.openSettings',
  'clusterWatcher.archiveJob', 'clusterWatcher.restoreJob', 'clusterWatcher.openLog', 'clusterWatcher.openScript', 'clusterWatcher.cancelJob',
];

/** Entry point called by @vscode/test-electron. */
async function run() {
  // Point at a closed loopback port so the views take their offline path.
  await vscode.workspace.getConfiguration('clusterWatcher')
    .update('backendUrl', 'http://127.0.0.1:9/', vscode.ConfigurationTarget.Global);

  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'extension is installed in the development host');
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of EXPECTED_COMMANDS) assert.ok(commands.has(command), `${command} is registered`);

  // Opening the views resolves both webview providers; this must not throw offline.
  await vscode.commands.executeCommand('workbench.view.extension.clusterWatcher');
  await vscode.commands.executeCommand('clusterWatcher.refresh');
  console.log(`Cluster Watcher integration suite passed (${EXPECTED_COMMANDS.length} commands).`);
}

module.exports = { run };
