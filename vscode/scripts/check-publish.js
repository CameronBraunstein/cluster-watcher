'use strict';

/**
 * Refuse to publish while package.json still carries development placeholders.
 * Run automatically by `npm run publish`; exits non-zero with a list of fixes.
 */
const manifest = require('../package.json');

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

if (require.main === module) {
  const problems = publishProblems(manifest);
  if (problems.length) {
    console.error(`Not publishing; fix package.json first:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    process.exit(1);
  }
}

module.exports = { publishProblems };
