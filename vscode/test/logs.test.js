'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { LOG_TAIL_LINES, logDocumentContent, logRequestPath, prependLogPage, virtualLogPath } = require('../logs');

test('stdout and stderr requests are bounded and URL encoded', () => {
  assert.equal(
    logRequestPath('cluster one', '12_3', 'out'),
    `/api/v1/jobs/cluster%20one/12_3/log?stream=out&tail=${LOG_TAIL_LINES}&before=0`,
  );
  assert.match(logRequestPath('cluster_0', '42', 'err'), /stream=err/);
  assert.match(logRequestPath('cluster_0', '42', 'err', 2000), /before=2000$/);
  assert.throws(() => logRequestPath('cluster_0', '42', 'input'), /err or out/);
  assert.throws(() => logRequestPath('cluster_0', '42', 'out', -1), /non-negative/);
});

test('virtual logs have safe names and identify truncated content', () => {
  assert.equal(virtualLogPath('cluster/one', '../42', 'err'), '/cluster_one/.._42.err');
  assert.equal(logDocumentContent({ content: 'complete\n', truncated: false }), 'complete\n');
  assert.match(
    logDocumentContent({ content: 'tail\n', moreBefore: true, loadedLines: 4000, path: '/logs/job.out', stream: 'out' }),
    /newest 4000 lines of \/logs\/job\.out.*Load 2,000 Older Lines/,
  );
  assert.match(logDocumentContent({ content: 'all\n', moreBefore: false, loadedLines: 4000, path: '/logs/job.out' }), /showing all 4000 lines/);
});

test('an older page is prepended without duplicating newer content', () => {
  const updated = prependLogPage(
    { content: 'newest\n', loadedLines: 2000, moreBefore: true, path: '/old/path' },
    { content: 'older\n', lines: 2000, more_before: false, path: '/logs/job.out' },
  );

  assert.equal(updated.content, 'older\nnewest\n');
  assert.equal(updated.loadedLines, 4000);
  assert.equal(updated.moreBefore, false);
  assert.equal(updated.path, '/logs/job.out');
});
