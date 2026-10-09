'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_DATE_FORMAT, availabilityStateLabel, availabilityTitle, compactGpuName, localTime, setDateFormat, progressSpec, progressView, commandAttributes, escapeHtml, renderJobsApiDisabled, jobKey, jobRef, renderWelcome, openAttribute, parseDependency, lifecycle, renderJobs, renderStatus, stateGroup, viewFreshness, waitCell } = require('../renderers');

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
  assert.match(html, /<dt>Limit<\/dt><dd>/);
  assert.doesNotMatch(html, /<body><h2>My Jobs<\/h2>/);
  assert.match(html, /api\.postMessage\(\{ type: 'disclosure'/);
  assert.match(html, /title="Archive job" aria-label="Archive job"><svg class="action-icon"/);
  assert.match(html, />Restore<\/a>/);
  assert.match(html, />\.err<\/a>/);
  assert.match(html, />\.out<\/a>/);
  assert.match(html, /Submitted/);
  assert.match(html, /Launched/);
  assert.match(html, /Ended/);
  assert.equal(lifecycle(jobs[1], 'ended'), '—');
  assert.notEqual(lifecycle(jobs[0], 'ended'), 'Unavailable');
  assert.equal(stateGroup('OUT_OF_MEMORY'), 'FAILED_EARLY');
  assert.equal(stateGroup('TIMEOUT'), 'FAILED_TIMEOUT');
  assert.match(jobKey(jobs[0]), /cluster_1/);
});

test('status shows GPU specifications, availability, and wait matrix', () => {
  const partition = {
    name: 'gpu-h100', rank: 1, aggregate: false,
    cpus: { total: 128 },
    gpus: {
      total: 8, schedulable_idle: 2,
      models: [{ name: 'NVIDIA H100 NVL', vram_gb: 80, fp16_bf16_tensor_tflops: 989 }],
    },
    node_states: { IDLE: 2, MIXED: 0, ALLOCATED: 3, RESERVED: 1, DOWN: 1 },
    wait_estimates: [
      { gpus: 1, estimated_wait_seconds: 300, error: null },
      { gpus: 2, estimated_wait_seconds: null, error: 'Access/permission denied' },
    ],
  };

  const html = renderStatus({
    generated_at: '2026-09-30T15:02:00Z',
    clusters: [{ name: 'cluster_0', reachable: true, partitions: [partition] }],
  });

  assert.match(html, /<td title="NVIDIA H100 NVL">H100<\/td>/);
  assert.match(html, /80G/);
  assert.match(html, /2\/8/);
  assert.match(html, /<div class="availability-cell"><div class="availability"[^>]*>.*?<\/div><span>2\/8<\/span><\/div>/);
  assert.match(html, /\.availability-cell\{display:flex;align-items:center;gap:3px;white-space:nowrap\}/);
  assert.ok(html.indexOf('class="available"') < html.indexOf('class="unavailable"'));
  assert.match(html, /data-availability="Nodes: 2 idle, 3 full, 1 reserved, 1 down"/);
  assert.doesNotMatch(html, /data-availability="[^"]*GPUs:/);
  assert.match(html, /const AVAILABILITY_HOVER_DELAY_MS = 100/);
  assert.doesNotMatch(html, /0 mixed/);
  assert.match(html, /CPU threads/);
  assert.ok(html.indexOf('<th>Partition</th><th>Available</th><th>GPU</th><th>VRAM</th><th>TFLOPS\/s</th>') >= 0);
  assert.match(html, /<details class="cluster-group" data-disclosure-key="cluster:cluster_0" open><summary>cluster_0<\/summary>/);
  assert.doesNotMatch(html, /## cluster_0 ##/);
  assert.doesNotMatch(html, /<body><h2>Cluster Status<\/h2>/);
  assert.equal(waitCell(partition, 1), '5m');
  assert.equal(waitCell(partition, 2), 'DENY');
  assert.equal(waitCell(partition, 16), '—');
});

test('availability tooltips group restrictive Slurm states and omit zero counts', () => {
  const partition = {
    gpus: { total: 16, schedulable_idle: 4 },
    node_states: { IDLE: 2, 'IDLE+DRAIN': 1, 'MIXED+RESERVED': 2, ALLOCATED: 3, DOWN: 0 },
  };

  assert.equal(availabilityStateLabel('IDLE+DRAIN'), 'drained');
  assert.equal(availabilityStateLabel('MIXED+RESERVED'), 'reserved');
  assert.equal(
    availabilityTitle(partition),
    'Nodes: 2 idle, 3 full, 2 reserved, 1 drained',
  );
  assert.doesNotMatch(availabilityTitle(partition), /down/);
});

test('GPU catalog names are reduced to recognizable model labels', () => {
  assert.equal(compactGpuName('NVIDIA H100 NVL'), 'H100');
  assert.equal(compactGpuName('NVIDIA A100 80 GB'), 'A100');
  assert.equal(compactGpuName('AMD Instinct MI300A'), 'MI300A');
  assert.equal(compactGpuName('NVIDIA GeForce RTX 4090'), 'RTX 4090');
  assert.equal(compactGpuName('Intel Data Center GPU Max 1550'), 'Max 1550');
  assert.equal(compactGpuName('Custom Accelerator Name'), 'Custom Accelerator');
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

test('collapsed title truncates with a full-name tooltip and the job ID moves to expanded metadata', () => {
  const html = renderJobs({ jobs: [{ job_id: '2000068_123', name: 'a very long job title indeed', cluster: 'cluster_0', state: 'RUNNING' }] });
  const cardSummary = html.match(/<summary data-full-name="cluster_0 2000068_123 a very long job title indeed">.*?<\/summary>/s)[0];
  assert.match(cardSummary, /<span class="name">a very long job title indeed<\/span>/);
  assert.doesNotMatch(cardSummary, /class="badge job-id/);
  assert.match(html, /\.name\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap;/);
  assert.match(html, /\.card\[open\] \.name\{white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(html, /\.card:not\(\[open\]\)>summary\[data-full-name\]:hover::after\{visibility:visible;opacity:1\}/);
  assert.match(html, /\.card>summary\[data-full-name\]::after\{outline:1px solid #fff\}/);
  assert.doesNotMatch(cardSummary, /<summary[^>]* title=/);
  assert.match(html, /<span class="badge job-id" role="button" tabindex="0" data-copy="2000068_123"/);
  assert.match(html, /<div class="muted card-meta" title="cluster_0 \/ no partition · 0 node · 0 GPU · 0 CPU"><span class="badge job-id"[^>]*>2000068_123<\/span> cluster_0 \/ no partition · 0 node · 0 GPU · 0 CPU<\/div>/);
  assert.match(html, /\.card-meta>\.job-id\{display:inline-block;font-size:\.88em;margin-right:3px\}/);
  assert.match(html, /\.job-id\{[^}]*border-radius:0\}/);
  assert.doesNotMatch(html, /\.job-id\{[^}]*width:/);
  assert.match(html, /type: 'copy'/);
});

test('End appears only for running and pending jobs and hides while ending', () => {
  const jobs = [
    { job_id: '1', cluster: 'cluster_0', state: 'RUNNING' },
    { job_id: '2', cluster: 'cluster_0', state: 'PENDING' },
    { job_id: '3', cluster: 'cluster_0', state: 'COMPLETED' },
  ];
  const html = renderJobs({ jobs });
  assert.equal(html.match(/aria-label="End job">End<\/a>/g).length, 2);
  assert.match(html, /data-command="clusterWatcher\.cancelJob" data-args="\[&quot;cluster_0&quot;,&quot;1&quot;/);
  assert.doesNotMatch(html, /href="command:/);

  const ending = renderJobs({ jobs }, {}, new Set([jobRef(jobs[0])]));
  assert.equal(ending.match(/aria-label="End job">End<\/a>/g).length, 1);
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
  assert.match(html, /<dt>Depends on<\/dt><dd class="dependency-value">afterok <a class="dep-link" href="#" data-jump="cluster_0\/12"/);
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

test('every card offers a compact script action for its job', () => {
  const html = renderJobs({ jobs: [{ job_id: '5', cluster: 'cluster_0', state: 'COMPLETED' }] });
  assert.match(html, /data-command="clusterWatcher\.openScript" data-args="\[&quot;cluster_0&quot;,&quot;5&quot;\]"[^>]*>script<\/a>/);
});

test('pending jobs hide log actions until a refreshed archived snapshot leaves pending', () => {
  const pending = { job_id: '7', name: 'pending', cluster: 'cluster_0', state: 'PENDING', submit_at: '2026-10-01T10:00:00Z' };
  const completedArchive = { ...pending, name: 'archived-completed', state: 'COMPLETED', end_at: '2026-10-01T10:05:00Z' };
  const html = renderJobs({ jobs: [pending], archived_jobs: [completedArchive] });
  const card = name => html.match(new RegExp(`<summary data-full-name="cluster_0 7 ${name}">.*?</details>`, 's'))[0];

  assert.doesNotMatch(card('pending'), /clusterWatcher\.openLog/);
  assert.match(card('pending'), /clusterWatcher\.openScript/);
  assert.equal((card('archived-completed').match(/clusterWatcher\.openLog/g) || []).length, 2);
});

test('jobs-API-disabled view explains the fix and offers copy and retry', () => {
  const html = renderJobsApiDisabled('My Jobs', "'cluster-watcher' 'serve' '--jobs-api'");
  assert.match(html, /started without <code>--jobs-api<\/code>/);
  assert.match(html, /<pre class="command-line">&#39;cluster-watcher&#39; &#39;serve&#39; &#39;--jobs-api&#39;<\/pre>/);
  assert.match(html, /data-command="clusterWatcher\.copyServiceCommand"/);
  assert.match(html, /data-command="clusterWatcher\.refresh"/);
});

test('open card uses a divider and every layout toggle flashes its border', () => {
  const html = renderJobs({ jobs: [{ job_id: '1', cluster: 'cluster_0', state: 'RUNNING' }] });
  assert.match(html, /\.card\{[^}]*margin:3px 0;/);
  assert.match(html, /\.card>summary\{position:relative;padding:4px 5px;/);
  assert.match(html, /\.card\[open\]>summary\{border-bottom:1px solid var\(--vscode-panel-border\)\}/);
  assert.doesNotMatch(html, /\.card>summary::before/);
  assert.match(html, /@keyframes card-layout-flash/);
  assert.match(html, /@keyframes card-layout-flash\{0%\{border-color:var\(--vscode-focusBorder\);box-shadow:0 0 0 1px var\(--vscode-focusBorder\)\}100%\{/);
  assert.match(html, /\.card\.layout-flash\{animation:card-layout-flash \.9s ease-out both\}/);
  assert.match(html, /details\.classList\.add\('layout-flash'\)/);
  assert.match(html, /setTimeout\(\(\) => details\.classList\.remove\('layout-flash'\), 950\)/);
  assert.match(html, /\.actions>\.end-job\{margin-left:auto\}/);
  // End is the last action, so it lands at the right of the bottom row.
  assert.match(html, /<a class="button danger compact-action end-job"[^>]*aria-label="End job">End<\/a><\/div><\/div><\/details>/);
});

test('running progress keeps advancing from generated_at without new data', () => {
  const asOf = Date.parse('2026-10-06T10:00:00Z');
  const spec = progressSpec({ state: 'RUNNING', elapsed_seconds: 600, time_limit_seconds: 3600 }, asOf);
  const atRender = progressView(spec, asOf);
  const later = progressView(spec, asOf + 30 * 60 * 1000);
  assert.equal(atRender.label, '10m / 1h');
  assert.equal(later.label, '40m / 1h');
  assert.ok(later.percent > atRender.percent);
  assert.equal(progressView(progressSpec({ state: 'RUNNING', elapsed_seconds: 600 }, asOf), asOf).label, '10m');
  // Completed and failed cards compare recorded runtime with the allocation.
  const done = progressView(progressSpec({ state: 'COMPLETED', elapsed_seconds: 600, time_limit_seconds: 3600 }, asOf), asOf);
  const failed = progressView(progressSpec({ state: 'FAILED', elapsed_seconds: 1800, time_limit_seconds: 3600 }, asOf), asOf);
  const immediateFailure = progressView(progressSpec({ state: 'FAILED', elapsed_seconds: 0, time_limit_seconds: 10800 }, asOf), asOf);
  assert.equal(done.label, '10m / 1h');
  assert.equal(done.percent, 600 / 3600 * 100);
  assert.equal(failed.label, '30m / 1h');
  assert.equal(failed.percent, 50);
  assert.equal(immediateFailure.label, '<1m / 3h');
});

test('pending wait counts down and the webview re-runs the shared code', () => {
  const asOf = Date.parse('2026-10-06T10:00:00Z');
  const spec = progressSpec({ state: 'PENDING', submit_at: '2026-10-06T09:00:00Z', expected_start_at: '2026-10-06T11:00:00Z' }, asOf);
  assert.equal(progressView(spec, asOf).label, '1h estimated wait');
  assert.equal(progressView(spec, asOf + 30 * 60 * 1000).label, '30m estimated wait');
  assert.equal(progressView(spec, Date.parse('2026-10-06T11:00:00Z')).label, '<1m estimated wait');
  const dependency = progressSpec({ state: 'PENDING', reason: 'Dependency: afterok:12(unfulfilled)' }, asOf);
  assert.equal(progressView(dependency, asOf).label, 'dependency');
  assert.equal(progressView(progressSpec({ state: 'PENDING' }, asOf), asOf).label, 'no wait estimate');

  const html = renderJobs({ generated_at: '2026-10-06T10:00:00Z', jobs: [{ job_id: '1', cluster: 'c', state: 'RUNNING', elapsed_seconds: 1 }] });
  assert.match(html, /<span class="job-progress" data-progress="\{&quot;group&quot;:&quot;RUNNING&quot;/);
  assert.match(html, /function progressView\(spec, now\)/);
  assert.match(html, /setInterval\(tick, 5000\)/);
  assert.doesNotMatch(html, /<div class="meta"/);
  assert.match(html, /event\.data\?\.type !== 'checked'/);
});

test('pending jobs without an estimate explain why and omit the empty bar', () => {
  const dependencyHtml = renderJobs({ jobs: [{
    job_id: '1', cluster: 'c', state: 'PENDING', dependency: 'afterok:123(unfulfilled)',
  }] });
  const dependencySummary = dependencyHtml.match(/<summary data-full-name="c 1 1">.*?<\/summary>/s)[0];
  assert.match(dependencySummary, /Waiting for dependency: afterok:123\(unfulfilled\)\. No start estimate until it clears\./);
  assert.doesNotMatch(dependencySummary, /class="progress"/);

  const unavailableHtml = renderJobs({ jobs: [{ job_id: '2', cluster: 'c', state: 'PENDING' }] });
  const unavailableSummary = unavailableHtml.match(/<summary data-full-name="c 2 2">.*?<\/summary>/s)[0];
  assert.match(unavailableSummary, /Slurm cannot currently estimate when this job will start\./);
  assert.doesNotMatch(unavailableSummary, /class="progress"/);
  assert.match(unavailableHtml, /\.progress-message\{[^}]*overflow-wrap:anywhere/);
});

test('status wait cells carry their estimate and as-of time for counting down', () => {
  const partition = {
    name: 'gpu', gpus: { total: 8, schedulable_idle: 0, models: [] },
    wait_estimates: [{ gpus: 1, estimated_wait_seconds: 900, error: null }, { gpus: 2, estimated_wait_seconds: null, error: 'denied' }],
  };
  const html = renderStatus({ generated_at: '2026-10-06T10:00:00Z', clusters: [{ name: 'c', reachable: true, partitions: [partition] }] });
  assert.match(html, /<td title="Wait for 1 GPU" data-wait="\[900,1791280800000\]">15m<\/td>/);
  assert.match(html, /<td title="Wait for 2 GPUs: denied">ERR<\/td>/);
});

test('heading sizes: groups and cluster names match the 11px view headings, job titles are smaller', () => {
  const html = renderJobs({ jobs: [] });
  assert.match(html, /\.job-group>summary,\.cluster-group>summary\{[^}]*font-size:11px/);
  assert.doesNotMatch(html, /\.cluster-group>summary\{[^}]*font-size:1\.2rem/);
  assert.match(html, /\.name\{[^}]*font-size:10\.5px/);
});

test('progress label stays beside the bar at the narrowest expanded width', () => {
  const html = renderJobs({ generated_at: '2026-09-30T15:02:00Z', jobs: [{ job_id: '1', cluster: 'cluster_0', state: 'RUNNING', elapsed_seconds: 60, time_limit_seconds: 3600 }] });
  assert.match(html, /\.job-progress\{display:flex;flex-wrap:nowrap;/);
  assert.match(html, /\.job-progress>\.progress\{flex:1 1 auto;min-width:20px\}/);
  assert.match(html, /\.progress-label\{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:\.72em\}/);
  assert.match(html, /<span class="job-progress"[^>]*><span class="progress">.*?<\/span><\/span><span class="muted progress-label" title="[^"]*">/);
});

test('narrow cards contain long metadata and dependency text', () => {
  const html = renderJobs({ jobs: [{
    job_id: '12345678901234567890', name: 'long', cluster: 'cluster-with-a-very-long-name',
    partition: 'partition-with-a-very-long-name', state: 'PENDING', dependency: 'afterok:12345678901234567890(unfulfilled)',
  }] });

  assert.match(html, /\.card-meta\{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  assert.match(html, /\.times dd\.dependency-value\{white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(html, /<div class="muted card-meta" title="cluster-with-a-very-long-name \/ partition-with-a-very-long-name/);
  assert.match(html, /<dd class="dependency-value">/);
});

test('expanded card moves the running deadline down and keeps details and actions compact', () => {
  const html = renderJobs({
    generated_at: '2026-09-30T15:02:00Z',
    jobs: [{
      job_id: '1', cluster: 'cluster_0', state: 'RUNNING', elapsed_seconds: 60, time_limit_seconds: 3600,
      submit_at: '2026-09-30T15:00:00Z', start_at: '2026-09-30T15:01:00Z',
    }],
  });
  assert.ok(html.includes(`<dt>Limit</dt><dd>${localTime('2026-09-30T16:01:00Z')}</dd>`));
  assert.doesNotMatch(html, /<dt>Elapsed<\/dt>/);
  assert.doesNotMatch(html, /<dt>Ended<\/dt>/);
  assert.match(html, /<span class="muted progress-label" title="[^"]+ \/ 1h">[^<]+ \/ 1h<\/span>/);
  assert.match(html, /\.times dt,\.times dd\{white-space:nowrap\}/);
  assert.match(html, /\.actions\{display:flex;flex-wrap:nowrap;/);
  assert.match(html, /title="Archive job" aria-label="Archive job"><svg class="action-icon"/);
  assert.match(html, /title="Open \.err log" aria-label="Open \.err log">\.err<\/a>/);
  assert.match(html, /title="Open \.out log" aria-label="Open \.out log">\.out<\/a>/);
  assert.match(html, /title="Open the Slurm batch script this job ran" aria-label="Open batch script">script<\/a>/);
  assert.match(html, /title="End job" aria-label="End job">End<\/a>/);
  assert.doesNotMatch(html, />Open (?:\.err|\.out|script)<\/a>/);
});

test('terminal cards keep elapsed time in the compact fraction and end time in details', () => {
  const html = renderJobs({
    jobs: [{
      job_id: '3', name: 'finished', cluster: 'cluster_0', state: 'COMPLETED', elapsed_seconds: 600, time_limit_seconds: 3600,
      submit_at: '2026-09-30T15:00:00Z', start_at: '2026-09-30T15:01:00Z', end_at: '2026-09-30T15:11:00Z',
    }],
  });
  const cardSummary = html.match(/<summary data-full-name="cluster_0 3 finished">.*?<\/summary>/s)[0];
  assert.match(cardSummary, /<span class="muted progress-label" title="10m \/ 1h">10m \/ 1h<\/span>/);
  assert.doesNotMatch(cardSummary, />[^<]*(?:elapsed|ended)[^<]*</i);
  assert.doesNotMatch(html, /<dt>Elapsed<\/dt>/);
  assert.match(html, /<dt>Ended<\/dt><dd>[^<]+<\/dd>/);
  assert.match(html, /\.progress-label:empty\{display:none\}/);
});

test('expanded lifecycle rows are state-specific and failure groups distinguish timeouts', () => {
  const jobs = [
    { job_id: '1', name: 'running-job', cluster: 'c', state: 'RUNNING', submit_at: '2026-10-01T10:00:00Z', start_at: '2026-10-01T10:01:00Z' },
    { job_id: '2', name: 'pending-job', cluster: 'c', state: 'PENDING', submit_at: '2026-10-01T10:00:00Z' },
    { job_id: '3', name: 'early-job', cluster: 'c', state: 'OUT_OF_MEMORY', submit_at: '2026-10-01T10:00:00Z', start_at: '2026-10-01T10:01:00Z', end_at: '2026-10-01T10:02:00Z' },
    { job_id: '4', name: 'timeout-job', cluster: 'c', state: 'TIMEOUT', submit_at: '2026-10-01T10:00:00Z', start_at: '2026-10-01T10:01:00Z', end_at: '2026-10-01T11:01:00Z' },
  ];
  const html = renderJobs({ jobs });
  const identifiers = { 'running-job': '1', 'pending-job': '2', 'early-job': '3', 'timeout-job': '4' };
  const card = name => html.match(new RegExp(`<summary data-full-name="c ${identifiers[name]} ${name}">.*?</details>`, 's'))[0];

  assert.doesNotMatch(card('running-job'), /<dt>Ended<\/dt>/);
  assert.doesNotMatch(card('pending-job'), /<dt>(?:Launched|Ended)<\/dt>/);
  assert.doesNotMatch(html, /<dt>Elapsed<\/dt>/);
  assert.ok(html.indexOf('Failed (Early) (1)') < html.indexOf('Failed (Timeout) (1)'));
  assert.match(html, /data-disclosure-key="group:active:FAILED_EARLY" open><summary>Failed \(Early\) \(1\)<\/summary>/);
  assert.match(html, /data-disclosure-key="group:active:FAILED_TIMEOUT" open><summary>Failed \(Timeout\) \(1\)<\/summary>/);
});

test('dates use DD.MM.YYYY by default and follow the configured pattern', () => {
  const value = new Date(2026, 9, 6, 9, 5).toISOString();
  try {
    assert.equal(DEFAULT_DATE_FORMAT, 'DD.MM.YYYY');
    assert.equal(localTime(value), '06.10.2026 09:05');
    setDateFormat('YYYY-MM-DD');
    assert.equal(localTime(value), '2026-10-06 09:05');
    setDateFormat('MM/DD/YY');
    assert.equal(localTime(value), '10/06/26 09:05');
    assert.match(renderJobs({ jobs: [] }), /const dateFormat = "MM\/DD\/YY";/);
    setDateFormat('  ');
    assert.equal(localTime(value), '06.10.2026 09:05');
    setDateFormat('</script>DD');
    assert.doesNotMatch(renderJobs({ jobs: [] }), /"<\/script>/);
    assert.equal(localTime('not a date'), 'Unavailable');
  } finally {
    setDateFormat();
  }
});

test('view freshness shows only the last update with second precision', () => {
  const updated = new Date(2026, 9, 8, 14, 5, 23).toISOString();
  assert.equal(viewFreshness(updated), 'Last update: 08.10.2026 14:05:23');
  assert.equal(viewFreshness(undefined), '');

  const html = renderStatus(
    { clusters: [] }, {}, { updatedAt: updated },
  );
  assert.match(html, /<p class="view-freshness">Last update: 08\.10\.2026 14:05:23<\/p>/);
  assert.doesNotMatch(html, /Last checked|data-last-checked/);
  assert.match(html, /\.view-freshness\{margin:0 0 7px;/);
});

test('a closed SSH session offers a login button on the cluster card', () => {
  const html = renderStatus({ clusters: [
    { name: 'cluster_0', reachable: false, error: 'Permission denied (gssapi-with-mic,password).', login_required: true },
    { name: 'cluster_1', reachable: false, error: 'Connection timed out', login_required: false },
  ] });
  assert.match(html, /data-command="clusterWatcher\.login" data-args="\[&quot;cluster_0&quot;\]"[^>]*>Log in again<\/a>/);
  assert.equal((html.match(/Log in again<\/a>/g) || []).length, 1);
});

test('wait cells label policy refusals separately from real errors', () => {
  const rows = [
    { gpus: 1, error: 'QOSMinGRES', error_kind: 'minimum' },
    { gpus: 2, error: 'More than 4 gpus per node were requested', error_kind: 'limit' },
    { gpus: 4, error: 'Requested node configuration is not available', error_kind: 'unavailable' },
    { gpus: 8, error: 'Slurm probe timed out after 60 seconds', error_kind: 'timeout' },
    { gpus: 16, error: 'partition wait-probe budget exhausted after 240 seconds', error_kind: 'budget' },
    { gpus: 32, error: 'Invalid account or account/partition combination specified' },
  ];
  const partition = { name: 'gpu', gpus: { total: 64 }, wait_estimates: rows };
  assert.deepEqual([1, 2, 4, 8, 16, 32, 64].map((count) => waitCell(partition, count)), ['min', 'limit', 'n/a', 'ERR', '?', 'DENY', '?']);
  const html = renderStatus({ clusters: [{ name: 'cluster_0', reachable: true, wait_estimates_updated_at: '2026-10-06T16:00:00Z', partitions: [partition] }] });
  assert.match(html, /<td title="Wait for 2 GPUs: More than 4 gpus per node were requested"[^>]*>limit<\/td>/);
});

test('wait cells show … until the first probe round finishes', () => {
  const partition = { name: 'gpu', gpus: { total: 8 }, wait_estimates: [] };
  assert.equal(waitCell(partition, 4, true), '…');
  assert.equal(waitCell(partition, 16, true), '—');
  const html = renderStatus({ clusters: [{ name: 'cluster_0', reachable: true, partitions: [partition] }] });
  assert.match(html, /<td title="Wait for 1 GPU: still checking">…<\/td>/);
  const done = renderStatus({ clusters: [{ name: 'cluster_0', reachable: true, wait_estimates_updated_at: '2026-10-06T16:00:00Z', partitions: [partition] }] });
  assert.match(done, /<td title="Wait for 1 GPU">\?<\/td>/);
});
