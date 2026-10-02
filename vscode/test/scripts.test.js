'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scriptRequestPath, scriptSourceMessage, virtualScriptPath } = require('../scripts');

test('script requests and virtual paths are safely encoded', () => {
  assert.equal(scriptRequestPath('my cluster', '12_3'), '/api/v1/jobs/my%20cluster/12_3/script');
  assert.equal(virtualScriptPath('a/b', '12_3'), '/a_b/12_3.sbatch.sh');
});

test('source message distinguishes exact copies from the current file', () => {
  assert.match(scriptSourceMessage({ job_id: '1', source: 'slurm' }), /exact script as submitted, from the Slurm controller/);
  assert.match(scriptSourceMessage({ job_id: '1', source: 'accounting' }), /Slurm accounting/);
  const file = scriptSourceMessage({ job_id: '1', source: 'file', path: '/w/run.sh', truncated: true });
  assert.match(file, /current file \/w\/run\.sh; it may have been edited/);
  assert.match(file, /cut off at 1 MiB/);
});
