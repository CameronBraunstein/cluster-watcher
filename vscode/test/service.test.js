'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { cliCommand, serviceCommand, shellQuote, validateExecutable } = require('../service');
const manifest = require('../package.json');

test('service command enables jobs API and preserves paths containing spaces', () => {
  const command = serviceCommand({
    executable: '/opt/Cluster Watcher/cluster-watcher',
    configPath: '/home/alice/My Clusters.toml',
    backendUrl: 'http://127.0.0.1:8123/',
    sshTimeoutSeconds: 20,
    refreshSeconds: 30,
  });

  assert.match(command, /^'\/opt\/Cluster Watcher\/cluster-watcher'/);
  assert.match(command, /'--config' '\/home\/alice\/My Clusters.toml'/);
  assert.match(command, /'--host' '127.0.0.1' '--port' '8123'/);
  assert.match(command, /'--jobs-api' '--no-browser'$/);
});

test('service command refuses a non-loopback or TLS endpoint', () => {
  const settings = {
    executable: 'cluster-watcher', configPath: '', sshTimeoutSeconds: 15, refreshSeconds: 15,
  };
  assert.throws(() => serviceCommand({ ...settings, backendUrl: 'http://dashboard.example:8080/' }), /loopback/);
  assert.throws(() => serviceCommand({ ...settings, backendUrl: 'https://127.0.0.1:8080/' }), /loopback/);
});

test('shell quoting cannot split a configured executable argument', () => {
  assert.equal(shellQuote("it's safe"), "'it'\\''s safe'");
});

test('extension runs beside the workspace so remote sessions remain reusable', () => {
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(
    manifest.contributes.configuration.properties['clusterWatcher.executable'].default,
    'cluster-watcher',
  );
  assert.ok(manifest.contributes.menus['viewContainer/title']);
  assert.equal(manifest.contributes.menus['view/title'], undefined);
  assert.match(manifest.contributes.menus['editor/title'][0].when, /cluster-watcher-log/);
  const commands = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
  assert.equal(commands.get('clusterWatcher.refresh').icon, '$(refresh)');
  assert.equal(commands.get('clusterWatcher.startService').icon, '$(play)');
});

test('executable validation accepts a program and explains a missing setting', async () => {
  await validateExecutable(process.execPath);
  await assert.rejects(
    validateExecutable('/definitely/missing/cluster-watcher'),
    (error) => error.name === 'ExecutableValidationError'
      && error.message.includes('clusterWatcher.executable')
      && error.message.includes('settings.json'),
  );
});

test('the original project icon carries its CC0 notice', () => {
  const notice = readFileSync(path.join(__dirname, '..', 'media', 'LICENSE.txt'), 'utf8');
  assert.match(notice, /SPDX-License-Identifier: CC0-1\.0/);
  assert.match(notice, /cluster-watcher\.svg/);
});

test('CLI helper commands reuse the configured executable and config path', () => {
  const settings = { executable: 'cluster-watcher', configPath: '/home/a b/clusters.toml' };
  assert.equal(cliCommand(settings, ['setup']), "'cluster-watcher' '--config' '/home/a b/clusters.toml' 'setup'");
  assert.equal(cliCommand({ ...settings, configPath: '' }, ['config', '--path']), "'cluster-watcher' 'config' '--path'");
});

test('manifest declares license, icon, new settings, and no redundant activation events', () => {
  assert.equal(manifest.license, 'GPL-3.0-or-later');
  assert.equal(manifest.icon, 'media/icon.png');
  assert.equal(manifest.activationEvents, undefined);
  const properties = manifest.contributes.configuration.properties;
  assert.deepEqual(properties['clusterWatcher.notifications'].enum, ['all', 'failures', 'off']);
  assert.equal(properties['clusterWatcher.statusBar'].default, true);
  const commands = manifest.contributes.commands.map((command) => command.command);
  for (const command of ['clusterWatcher.runSetup', 'clusterWatcher.editConfig', 'clusterWatcher.openSettings']) {
    assert.ok(commands.includes(command), command);
  }
});
