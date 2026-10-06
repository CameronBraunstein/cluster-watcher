'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { commandAttributes, escapeHtml, renderJobsApiDisabled, jobKey, jobRef, renderWelcome, openAttribute, parseDependency, lifecycle, renderJobs, renderStatus, stateGroup, waitCell } = require('../renderers');

test('jobs retain terminal state grouping and lifecycle visibility', () => {
  const jobs = [
    {
      job_id: '3', name: 'finished', cluster: 'cluster_1', partition: 'apu', state: 'COMPLETED',
      node_count: 1, gpus: 1, cpus: 48, elapsed_seconds: 60,
      submit_at: '2026-09-30T14:00:00Z', start_at: '2026-09-30T14:05:00Z', end_at: '2026-09-30T14:06:00Z',
    },
    {
      job_id: '1', name: 'active', cluster: 'cluster_0', partition: 'gpu-h100', state: 'RUNNING',
      node_count: 1, gpus: 1, cpus: 10, elapsed_seconds: 60, time_limit_seconds: 3600,
      submit_at: '2026-09-30T15:00:00Z', start_at: '2026-09-30T15:01:00Z', end_at: null,
    },
  ];

  const html = renderJobs({ generated_at: '2026-09-30T15:02:00Z', jobs, archived_jobs: [jobs[0]] });

  assert.ok(html.indexOf('Running (1)') < html.indexOf('Completed (1)'));
  assert.doesNotMatch(html, /### RUNNING ###/);
  assert.match(html, /<details class="job-group" data-disclosure-key="group:active:RUNNING" open><summary>Running \(1\)<\/summary>/);
  assert.match(html, /<details class="card" data-disclosure-key=/);
  assert.match(html, /class="card-summary-progress"/);
  assert.match(html, /limit /);
  assert.doesNotMatch(html, /<body><h2>My Jobs<\/h2>/);
  assert.match(html, /api\.postMessage\(\{ type: 'disclosure'/);
  assert.match(html, />Archive<\/a>/);
  assert.match(html, />Restore<\/a>/);
  assert.match(html, />Open \.err<\/a>/);
  assert.match(html, />Open \.out<\/a>/);
  assert.match(html, /Submitted/);
  assert.match(html, /Launched/);
  assert.match(html, /Ended/);
  assert.equal(lifecycle(jobs[1], 'ended'), '—');
  assert.notEqual(lifecycle(jobs[0], 'ended'), 'Unavailable');
  assert.equal(stateGroup('OUT_OF_MEMORY'), 'FAILED');
  assert.match(jobKey(jobs[0]), /cluster_1/);
});

test('status shows GPU specifications, availability, and wait matrix', () => {
  const partition = {
    name: 'gpu-h100', rank: 1, aggregate: false,
    cpus: { total: 128 },
    gpus: {
      total: 8, schedulable_idle: 2,
      models: [{ name: 'NVIDIA H100', vram_gb: 80, fp16_bf16_tensor_tflops: 989 }],
    },
    wait_estimates: [
      { gpus: 1, estimated_wait_seconds: 300, error: null },
      { gpus: 2, estimated_wait_seconds: null, error: 'Access/permission denied' },
    ],
  };

  const html = renderStatus({
    generated_at: '2026-09-30T15:02:00Z',
    clusters: [{ name: 'cluster_0', reachable: true, partitions: [partition] }],
  });

  assert.match(html, /NVIDIA H100/);
  assert.match(html, /80G/);
  assert.match(html, /2\/8/);
  assert.ok(html.indexOf('class="unavailable"') < html.indexOf('class="available"'));
  assert.match(html, /CPU threads/);
  assert.match(html, /<details class="cluster-group" data-disclosure-key="cluster:cluster_0" open><summary>cluster_0<\/summary>/);
  assert.doesNotMatch(html, /## cluster_0 ##/);
  assert.doesNotMatch(html, /<body><h2>Cluster Status<\/h2>/);
  assert.equal(waitCell(partition, 1), '5m');
  assert.equal(waitCell(partition, 2), 'DENY');
  assert.equal(waitCell(partition, 16), '—');
});

test('API text is escaped before entering a webview', () => {
  assert.equal(escapeHtml('<script>bad()</script>'), '&lt;script&gt;bad()&lt;/script&gt;');
  const html = renderJobs({ jobs: [{ job_id: '1', name: '<img src=x>', state: 'PENDING' }] });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('remembered disclosure choices override default open/closed state', () => {
  const job = { job_id: '7', name: 'kept', cluster: 'cluster_0', state: 'RUNNING', submit_at: '2026-09-30T15:00:00Z' };
  const cardKey = `card:active:${jobKey(job)}`;
  const html = renderJobs({ jobs: [job], archived_jobs: [] }, {
    'group:active:RUNNING': false,
    'group:archive': true,
    [cardKey]: true,
  });
  assert.match(html, /data-disclosure-key="group:active:RUNNING"><summary>/);
  assert.match(html, /data-disclosure-key="group:archive" open>/);
  assert.match(html, /<details class="card" data-disclosure-key="[^"]+" data-job-ref="cluster_0\/7" open>/);

  const status = renderStatus({ clusters: [{ name: 'cluster_0', reachable: false }] }, { 'cluster:cluster_0': false });
  assert.match(status, /data-disclosure-key="cluster:cluster_0"><summary>cluster_0/);
});

test('openAttribute falls back to the renderer default', () => {
  assert.equal(openAttribute({}, 'missing', true), ' open');
  assert.equal(openAttribute({}, 'missing', false), '');
  assert.equal(openAttribute({ key: false }, 'key', true), '');
});

test('job ID badge is fixed-width and copyable without toggling the card', () => {
  const html = renderJobs({ jobs: [{ job_id: '2000068_123', name: 'a very long job title indeed', cluster: 'cluster_0', state: 'RUNNING' }] });
  assert.match(html, /<span class="badge job-id" role="button" tabindex="0" data-copy="2000068_123"/);
  assert.match(html, /\.job-id\{flex:0 0 auto;box-sizing:content-box;width:12ch/);
  assert.match(html, /type: 'copy'/);
  assert.match(html, /event\.stopPropagation\(\)/);
});

test('End Job appears only for running and pending jobs and hides while ending', () => {
  const jobs = [
    { job_id: '1', cluster: 'cluster_0', state: 'RUNNING' },
    { job_id: '2', cluster: 'cluster_0', state: 'PENDING' },
    { job_id: '3', cluster: 'cluster_0', state: 'COMPLETED' },
  ];
  const html = renderJobs({ jobs });
  assert.equal(html.match(/>End Job<\/a>/g).length, 2);
  assert.match(html, /data-command="clusterWatcher\.cancelJob" data-args="\[&quot;cluster_0&quot;,&quot;1&quot;/);
  assert.doesNotMatch(html, /href="command:/);

  const ending = renderJobs({ jobs }, {}, new Set([jobRef(jobs[0])]));
  assert.equal(ending.match(/>End Job<\/a>/g).length, 1);
  assert.match(ending, /class="badge job-id ending"/);
});

test('dependencies are parsed and rendered as links to the referenced card', () => {
  assert.deepEqual(parseDependency('afterok:12(unfulfilled),afterany:13_4+5:14_*(failed)'), [
    { type: 'afterok', ids: ['12'], status: 'unfulfilled' },
    { type: 'afterany', ids: ['13_4', '14'], status: 'failed' },
  ]);
  assert.deepEqual(parseDependency('(null)'), []);
  assert.deepEqual(parseDependency('singleton'), [{ type: 'singleton', ids: [], status: '' }]);

  const html = renderJobs({ jobs: [
    { job_id: '12', cluster: 'cluster_0', state: 'RUNNING' },
    { job_id: '13', cluster: 'cluster_0', state: 'PENDING', dependency: 'afterok:12(unfulfilled)' },
  ] });
  assert.match(html, /<dt>Depends on<\/dt><dd>afterok <a class="dep-link" href="#" data-jump="cluster_0\/12"/);
  assert.match(html, /<details class="card" data-disclosure-key="[^"]+" data-job-ref="cluster_0\/12"/);
  assert.match(html, /type: 'missingJob'/);
  assert.equal((html.match(/<dt>Depends on/g) || []).length, 1);
});

test('webview buttons post allow-listed commands instead of using command URIs', () => {
  assert.equal(
    commandAttributes('clusterWatcher.openLog', ['cluster_0', '1', 'err']),
    'href="#" data-command="clusterWatcher.openLog" data-args="[&quot;cluster_0&quot;,&quot;1&quot;,&quot;err&quot;]"',
  );
  const html = renderJobs({ jobs: [{ job_id: '1', cluster: 'cluster_0', state: 'RUNNING' }] });
  assert.match(html, /type: 'command', command: button\.dataset\.command/);
});

test('welcome view offers start, setup, config, and settings with escaped detail', () => {
  const html = renderWelcome('My Jobs', 'connect ECONNREFUSED <127.0.0.1>');
  for (const command of ['startService', 'runSetup', 'editConfig', 'openSettings']) {
    assert.match(html, new RegExp(`data-command="clusterWatcher\\.${command}"`));
  }
  assert.match(html, /ECONNREFUSED &lt;127\.0\.0\.1&gt;/);
});

test('every card offers Open script for its job', () => {
  const html = renderJobs({ jobs: [{ job_id: '5', cluster: 'cluster_0', state: 'COMPLETED' }] });
  assert.match(html, /data-command="clusterWatcher\.openScript" data-args="\[&quot;cluster_0&quot;,&quot;5&quot;\]"[^>]*>Open script<\/a>/);
});

test('jobs-API-disabled view explains the fix and offers copy and retry', () => {
  const html = renderJobsApiDisabled('My Jobs', "'cluster-watcher' 'serve' '--jobs-api'");
  assert.match(html, /started without <code>--jobs-api<\/code>/);
  assert.match(html, /<pre class="command-line">&#39;cluster-watcher&#39; &#39;serve&#39; &#39;--jobs-api&#39;<\/pre>/);
  assert.match(html, /data-command="clusterWatcher\.copyServiceCommand"/);
  assert.match(html, /data-command="clusterWatcher\.refresh"/);
});
