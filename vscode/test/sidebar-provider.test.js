'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

/** Load the view provider with a minimal VS Code stub for standalone tests. */
function extensionClasses() {
  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
      return originalLoad.call(this, request, parent, isMain);
    };
    return require('../extension');
  } finally {
    Module._load = originalLoad;
  }
}

function sidebarProviderClass() { return extensionClasses().SidebarProvider; }

test('a later service-reachable event keeps an overview received while the view was hidden', () => {
  const SidebarProvider = sidebarProviderClass();
  const provider = new SidebarProvider('status');
  provider.updateOverview({ overview_only: true, clusters: [{
    name: 'alpha', reachable: true, user_jobs: { running: 2, pending: 1, depending: 1 }, partitions: [],
  }] });

  assert.equal(provider.hasSuccessfulData, true);
  assert.equal(provider.showingData, false);
  provider.loading();
  assert.equal(provider.loadingState, false);

  const view = {
    webview: { html: '', onDidReceiveMessage() {} },
    onDidDispose() {},
  };
  provider.resolveWebviewView(view);
  assert.match(view.webview.html, /data-disclosure-key="cluster:alpha"><summary>/);
  assert.match(view.webview.html, /aria-label="2 running, 1 pending, 1 depending"/);
  assert.doesNotMatch(view.webview.html, /Cluster Watcher is running\. Loading cluster status/);
});

test('a prior offline error still changes to Loading when the service returns', () => {
  const SidebarProvider = sidebarProviderClass();
  const provider = new SidebarProvider('status');
  provider.updateOverview({ overview_only: true, clusters: [{ name: 'alpha', user_jobs: {} }] });
  provider.error(new Error('Connection refused'));

  provider.loading();

  assert.equal(provider.loadingState, true);
  assert.equal(provider.errorState, undefined);
});

test('a slow status response keeps the prior cluster card and clears its notice on recovery', () => {
  const SidebarProvider = sidebarProviderClass();
  const provider = new SidebarProvider('status');
  provider.update({ generated_at: '2026-11-15T10:00:00Z', clusters: [{
    name: 'alpha', reachable: true, partitions: [], user_jobs: {},
  }] });
  const view = { webview: { html: '', onDidReceiveMessage() {} }, onDidDispose() {} };
  provider.resolveWebviewView(view);

  provider.refreshError(new Error('Cluster Watcher service request timed out'));
  assert.match(view.webview.html, /data-disclosure-key="cluster:alpha"/);
  assert.match(view.webview.html, /Status check timed out; showing the last update/);
  assert.doesNotMatch(view.webview.html, /No service found/);

  provider.checked(Date.now());
  assert.doesNotMatch(view.webview.html, /Status check timed out/);
  assert.match(view.webview.html, /data-disclosure-key="cluster:alpha"/);
});

test('one service timeout keeps the sidebar available, then repeated timeouts mark it offline', async () => {
  const { ServiceController } = extensionClasses();
  const availability = [];
  const client = {
    serviceInfo: async () => { throw new Error('Cluster Watcher service request timed out (/api/v1/service)'); },
    sessionInfo: async () => { throw new Error('Cluster Watcher service request timed out (/api/v1/sessions)'); },
  };
  const controller = new ServiceController(client, () => {}, {}, { updateServer() {} },
    () => {}, (available) => availability.push(available));
  controller.lifecycle.state = 'attached';

  await controller.refreshStatus();
  assert.equal(controller.lifecycle.state, 'attached');
  assert.match(controller.lifecycle.activity, /retrying/);
  assert.equal(availability.at(-1), true);

  await controller.refreshStatus();
  assert.equal(controller.lifecycle.state, 'attached');
  await controller.refreshStatus();
  assert.equal(controller.lifecycle.state, 'offline');
  assert.equal(availability.at(-1), false);
});
