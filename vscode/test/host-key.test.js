'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const vscode = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {},
};
const originalLoad = Module._load;
let ServiceController;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ServiceController } = require('../extension'));
} finally {
  Module._load = originalLoad;
}

test('host confirmation shows the full fingerprint and requires the Trust Host action', async () => {
  const prompt = "The authenticity of host 'cluster.example (192.0.2.1)' can't be established.\n"
    + 'ED25519 key fingerprint is SHA256:example.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?';
  const controller = new ServiceController({}, () => {}, {}, { updateServer() {} });
  vscode.window.showInputBox = () => assert.fail('host keys must not use a password box');
  for (const choice of ['Trust Host', undefined, 'Cancel']) {
    vscode.window.showWarningMessage = async (message, options, ...actions) => {
      assert.equal(message, 'Trust this SSH host?');
      assert.equal(options.modal, true);
      assert.ok(options.detail.includes(prompt));
      assert.match(options.detail, /cluster administrator/);
      assert.deepEqual(actions, ['Trust Host']);
      return choice;
    };
    const answer = await controller.requestCredential({ kind: 'host_key', prompt });
    assert.equal(answer, choice === 'Trust Host' ? 'yes' : 'no');
    assert.match(controller.lifecycle.activity, choice === 'Trust Host' ? /Continuing/ : /cancelled/);
  }
});

test('password, OTP, and private key passphrase prompts remain masked', async () => {
  const controller = new ServiceController({}, () => {}, {}, { updateServer() {} });
  vscode.window.showWarningMessage = () => assert.fail('credentials must not use host trust dialogs');
  for (const kind of ['password', 'otp', 'passphrase']) {
    vscode.window.showInputBox = async (options) => {
      assert.equal(options.password, true);
      assert.equal(options.ignoreFocusOut, true);
      return 'secret';
    };
    assert.equal(await controller.requestCredential({ kind, prompt: 'Credential' }), 'secret');
  }
});
