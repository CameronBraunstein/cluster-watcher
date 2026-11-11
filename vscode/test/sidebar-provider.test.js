'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

/** Load the view provider with a minimal VS Code stub for standalone tests. */
function sidebarProviderClass() {
  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return {};
      return originalLoad.call(this, request, parent, isMain);
    };
    return require('../extension').SidebarProvider;
  } finally {
    Module._load = originalLoad;
  }
}

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
