'use strict';

/**
 * Launch a downloaded VS Code with this extension under development and run
 * the integration suite in its extension host. Usage: `npm run test:integration`
 * (on a headless Linux machine, wrap it in `xvfb-run -a`).
 */
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // When launched from VS Code's own terminal this variable makes the test
  // instance behave as plain Node and reject every VS Code argument.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      // An isolated profile without other extensions keeps the run reproducible.
      launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
    });
  } catch (error) {
    console.error('Integration tests failed:', error);
    process.exit(1);
  }
}

void main();
