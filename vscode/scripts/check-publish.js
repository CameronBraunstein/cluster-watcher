'use strict';

/**
 * Refuse to publish while package.json still carries development placeholders.
 * Run automatically by `npm run publish`; exits non-zero with a list of fixes.
 */
const manifest = require('../package.json');
const fs = require('node:fs');
const path = require('node:path');

/** Return human-readable problems that must be fixed before publishing. */
function publishProblems(pkg) {
  const problems = [];
  if (!pkg.publisher || pkg.publisher === 'cluster-watcher-project') {
    problems.push('set "publisher" to your Marketplace publisher ID');
  }
  for (const field of ['repository', 'bugs', 'homepage']) {
    const value = typeof pkg[field] === 'string' ? pkg[field] : pkg[field]?.url;
    if (!value || value.includes('REPLACE-ME')) problems.push(`set "${field}" to the real repository URL`);
  }
  return problems;
}

/** Validate that this VSIX will carry exact, complete native artifact hashes. */
function backendManifestProblems(pkg, filename = path.join(__dirname, '..', 'backend-manifest.json')) {
  let backend;
  try { backend = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (_error) { return ['generate backend-manifest.json from the six release artifacts']; }
  const problems = [];
  if (backend.schema_version !== 1) problems.push('backend-manifest.json has an unsupported schema');
  if (backend.version !== pkg.version) problems.push('backend-manifest.json version does not match package.json');
  if (!Array.isArray(backend.targets) || backend.targets.length !== 6) {
    problems.push('backend-manifest.json must contain all six release targets');
  } else if (backend.targets.some((target) => !/^[a-f0-9]{64}$/.test(target.sha256 || '') || !Number.isSafeInteger(target.size))) {
    problems.push('backend-manifest.json contains an invalid checksum or size');
  }
  return problems;
}

if (require.main === module) {
  const problems = [...publishProblems(manifest), ...backendManifestProblems(manifest)];
  if (problems.length) {
    console.error(`Cannot package or publish; fix these release inputs:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    process.exit(1);
  }
}

module.exports = { backendManifestProblems, publishProblems };
