'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SIDEBAR_MENU_ITEMS, showSidebarMenu } = require('../menu');

test('the consolidated sidebar menu exposes service and configuration actions', () => {
  const commands = SIDEBAR_MENU_ITEMS.map((item) => item.command);
  for (const command of [
    'clusterWatcher.refresh', 'clusterWatcher.startService', 'clusterWatcher.stopService',
    'clusterWatcher.openDashboard', 'clusterWatcher.showServiceTerminal',
    'clusterWatcher.editConfig', 'clusterWatcher.runSetup',
    'clusterWatcher.openSettings', 'clusterWatcher.manageBackend',
  ]) assert.ok(commands.includes(command), command);
});

test('the consolidated sidebar menu executes only the selected action', async () => {
  const executed = [];
  const choice = SIDEBAR_MENU_ITEMS.find((item) => item.command === 'clusterWatcher.refresh');
  const vscode = {
    window: { showQuickPick: async (_items, options) => (assert.equal(options.title, 'Cluster Watcher'), choice) },
    commands: { executeCommand: async (command) => executed.push(command) },
  };

  await showSidebarMenu(vscode);
  assert.deepEqual(executed, ['clusterWatcher.refresh']);
  vscode.window.showQuickPick = async () => undefined;
  await showSidebarMenu(vscode);
  assert.deepEqual(executed, ['clusterWatcher.refresh']);
});
