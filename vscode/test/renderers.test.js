'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_DATE_FORMAT, availabilityStateLabel, availabilityTitle, compactGpuName, gpuAvailabilityTitle, localTime, setDateFormat, progressSpec, progressView, commandAttributes, commandButtonAttributes, dependencyStatus, escapeHtml, hasFailedDependency, renderJobsApiDisabled, renderLoading, jobGroup, jobKey, jobRef, renderWelcome, metadataSameLine, openAttribute, parseDependency, relativeJobPriority, lifecycle, renderJobs, renderStatus, stateGroup, viewFreshness, waitCell } = require('../renderers');

test('first-collection loading views place service controls in the Cluster Status footer', () => {
  const jobs = renderLoading('My Jobs');
  assert.match(jobs, /role="status">Cluster Watcher is running\. Loading jobs/);
  assert.doesNotMatch(jobs, /class="service-summary"|class="error"/);

  const status = renderLoading('Cluster Status', {}, false, { service: {
    state: 'attached', url: 'http://127.0.0.1:8080/', pid: 42,
    recentLines: [{ stream: 'stderr', text: 'startup diagnostic' }],
  } });
  assert.match(status, /role="status">Cluster Watcher is running\. Loading cluster status…<\/p><hr class="cluster-config-separator"><div class="service-summary">.*?http:\/\/127\.0\.0\.1:8080\/.*?<\/div><div class="cluster-footer-links"><button class="view-sessions" type="button" data-open-sessions>view sessions<\/button><span class="footer-divider" aria-hidden="true">\|<\/span><button class="configure-clusters"/s);
  assert.match(status, /data-command="clusterWatcher\.stopService"/);
  assert.doesNotMatch(status, /class="error"/);
  assert.doesNotMatch(status, /Recent backend output|startup diagnostic/);

  const connecting = renderLoading('Cluster Status', {}, true);
  assert.match(connecting, /Connecting to the local Cluster Watcher service/);
  assert.doesNotMatch(connecting, /is running/);
});
const { launchabilityStrip, waitColorIndex, waitEstimate } = require('../launchability');

test('sidebar green indicators match the screenshot palette', () => {
  const html = renderStatus({ clusters: [] });
  assert.match(html, /:root\{--cluster-watcher-green:#16a34a\}/);
  for (const selector of ['.available', '.completed', '.service-toggle.on', '.dependency-icon.satisfied']) {
    assert.ok(html.includes(`${selector}{background:var(--cluster-watcher-green)}`)
      || html.includes(`${selector}{color:var(--cluster-watcher-green)}`), selector);
  }
  assert.doesNotMatch(html, /var\(--vscode-testing-iconPassed\)/);
});

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
  assert.match(html, /<div class="time-row"><dt>Limit<\/dt><dd>/);
  assert.doesNotMatch(html, /<body><h2>My Jobs<\/h2>/);
  assert.match(html, /api\.postMessage\(\{ type: 'disclosure'/);
  assert.match(html, /title="Archive job" aria-label="Archive job"><svg class="action-icon"/);
  assert.match(html, />Restore<\/a>/);
  assert.match(html, />\.err<\/button>/);
  assert.match(html, />\.out<\/button>/);
  assert.match(html, /Submitted/);
  assert.match(html, /Launched/);
  assert.match(html, /Ended/);
  assert.equal(lifecycle(jobs[1], 'ended'), '—');
  assert.notEqual(lifecycle(jobs[0], 'ended'), 'Unavailable');
  assert.equal(stateGroup('OUT_OF_MEMORY'), 'FAILED_EARLY');
  assert.equal(stateGroup('TIMEOUT'), 'FAILED_TIMEOUT');
  assert.match(jobKey(jobs[0]), /cluster_1/);
});

test('dependency waits appear in Depending between Pending and failed dependencies', () => {
  const jobs = [
    { job_id: 'ready', cluster: 'c', state: 'PENDING', reason: 'Priority' },
    { job_id: 'held', cluster: 'c', state: 'PENDING', dependency: 'afterok:11(unfulfilled)', expected_start_at: '2026-10-01T11:00:00Z' },
    { job_id: 'failed', cluster: 'c', state: 'PENDING', reason: 'DependencyNeverSatisfied', dependency: 'afterok:12(failed)' },
  ];
  const html = renderJobs({ jobs });
  assert.equal(jobGroup(jobs[0]), 'PENDING');
  assert.equal(jobGroup(jobs[1]), 'DEPENDING');
  assert.equal(jobGroup(jobs[2]), 'FAILED_DEPENDENCY');
  assert.ok(html.indexOf('Pending (1)') < html.indexOf('Depending (1)'));
  assert.ok(html.indexOf('Depending (1)') < html.indexOf('Failed Dependency (1)'));
  assert.match(html, /group:active:DEPENDING" open/);
  const held = html.match(/data-job-ref="c\/held"[^>]*>.*?<\/details>/s)[0];
  assert.doesNotMatch(held, /<dt>Launched<\/dt>/);
  assert.doesNotMatch(held, /data-progress=/);
});

test('finished and failed cards expose one Archive icon before summary progress', () => {
  const cases = [
    ['running', 'RUNNING', {}, false],
    ['pending', 'PENDING', {}, false],
    ['dependency', 'PENDING', { reason: 'DependencyNeverSatisfied' }, true],
    ['completed', 'COMPLETED', {}, true],
    ['failed-early', 'FAILED', {}, true],
    ['failed-timeout', 'TIMEOUT', {}, true],
    ['cancelled', 'CANCELLED', {}, true],
    ['other', 'UNKNOWN', {}, true],
  ];
  const jobs = cases.map(([id, state, extra]) => ({ job_id: id, name: id, cluster: 'cluster_0', state, ...extra }));
  const archived = { job_id: 'archived', name: 'archived', cluster: 'cluster_0', state: 'COMPLETED' };
  const html = renderJobs({ jobs, archived_jobs: [archived] });
  const cardFor = (id) => html.match(new RegExp(`<details class="card"[^>]*data-job-ref="cluster_0/${id}"[^>]*>.*?</details>`, 's'))[0];

  for (const [id, , , quickArchive] of cases) {
    const card = cardFor(id);
    const summary = card.match(/<summary>.*?<\/summary>/s)[0];
    const actions = card.match(/<div class="actions">.*?<\/div>/s)[0];
    assert.equal((card.match(/data-command="clusterWatcher\.archiveJob"/g) || []).length, 1, id);
    if (quickArchive) {
      assert.match(summary, /<span class="card-summary-progress"><a class="button compact-action archive-action summary-archive-action"[^>]*data-command="clusterWatcher\.archiveJob"[^>]*>.*?<\/a><span class="(?:job-progress|muted progress-message)"/s, id);
      assert.doesNotMatch(actions, /clusterWatcher\.archiveJob/, id);
    } else {
      assert.doesNotMatch(summary, /clusterWatcher\.archiveJob/, id);
      assert.match(actions, /clusterWatcher\.archiveJob/, id);
    }
  }

  const archivedCard = cardFor('archived');
  assert.doesNotMatch(archivedCard.match(/<summary>.*?<\/summary>/s)[0], /clusterWatcher\.(?:archiveJob|restoreJob)/);
  assert.match(archivedCard.match(/<div class="actions">.*?<\/div>/s)[0], /clusterWatcher\.restoreJob/);
  assert.match(html, /\.card-summary-progress>\.summary-archive-action\{[^}]*flex:0 0 auto/);
  assert.match(html, /event\.preventDefault\(\);\s+if \(button\.closest\('summary'\)\) event\.stopPropagation\(\)/);
});

test('status shows every partition detail compactly without a card disclosure', () => {
  const partition = {
    name: 'gpu-h100', rank: 1, aggregate: false,
    cpus: { total: 128 },
    gpus: {
      total: 8, allocated: 4, idle: 4, schedulable_idle: 2, unavailable_idle: 2,
      models: [{ name: 'NVIDIA H100 NVL', vram_gb: 80, fp16_bf16_tensor_tflops: 989 }],
    },
    node_states: { IDLE: 2, MIXED: 0, ALLOCATED: 3, RESERVED: 1, DOWN: 1 },
    nodes: [
      { state: 'IDLE', gpus: { total: 1, allocated: 0, idle: 1, schedulable_idle: 1 } },
      { state: 'IDLE', gpus: { total: 1, allocated: 0, idle: 1, schedulable_idle: 1 } },
      { state: 'ALLOCATED', gpus: { total: 1, allocated: 1, idle: 0, schedulable_idle: 0 } },
      { state: 'ALLOCATED', gpus: { total: 1, allocated: 1, idle: 0, schedulable_idle: 0 } },
      { state: 'ALLOCATED', gpus: { total: 2, allocated: 2, idle: 0, schedulable_idle: 0 } },
      { state: 'RESERVED', gpus: { total: 1, allocated: 0, idle: 1, schedulable_idle: 0 } },
      { state: 'DOWN', gpus: { total: 1, allocated: 0, idle: 1, schedulable_idle: 0 } },
    ],
    wait_estimates: [
      { gpus: 1, estimated_wait_seconds: 300, error: null },
      { gpus: 2, estimated_wait_seconds: null, error: 'Access/permission denied' },
    ],
  };

  const html = renderStatus({
    generated_at: '2026-09-30T15:02:00Z',
    wait_threshold_minutes: [5, 30, 60, 120],
    clusters: [{ name: 'cluster_0', host: 'login-02.example', reachable: true, user_jobs: { running: 3, pending: 1 }, partitions: [partition] }],
  });

  const card = html.match(/<article class="card partition-card" data-partition="gpu-h100" style="--availability-count-width:8ch">.*?<\/article>/s)[0];
  assert.match(card, /<div class="card-summary-title partition-title"><span class="name">gpu-h100<\/span><span class="launchability"/);
  assert.match(card, /class="launch-block launch-wait-1"/);
  assert.match(card, /class="launch-block launch-blocked"[^>]*>×<\/span>/);
  assert.equal((card.match(/class="launch-shape"/g) || []).length, 7);
  assert.match(card, /<span class="gpu-model" data-fast-tooltip="NVIDIA H100 NVL" aria-label="NVIDIA H100 NVL">H100<\/span> · <span class="vram-spec" data-fast-tooltip="VRAM: 80 GB" aria-label="VRAM: 80 GB">80 GB<\/span> · 989 TFLOPS\/s · <span class="thread-spec" data-fast-tooltip="CPU threads: 128 threads" aria-label="CPU threads: 128 threads">128 threads<\/span>/);
  assert.match(card, /<span class="partition-availability-label">GPUs:<\/span>/);
  assert.match(card, /class="availability-count" aria-label="2 of 8 free"/);
  assert.match(card, /<span class="partition-availability-label">Nodes:<\/span>/);
  assert.match(card, /class="availability-count" aria-label="2 of 7 free"/);
  assert.doesNotMatch(card, /<details|<summary|data-disclosure-key|wait-chart|wait-figure|<svg/);
  assert.match(html, /\.partition-specs\{[^}]*white-space:normal;overflow-wrap:anywhere/);
  assert.match(html, /\.partition-title\{[^}]*flex-wrap:wrap/);
  assert.match(html, /\.partition-title>\.name\{[^}]*margin-right:auto/);
  assert.match(html, /\.partition-title>\.launchability\{[^}]*flex:0 0 auto;margin-left:0/);
  assert.match(html, /\.availability-cell\{display:flex;align-items:center;gap:2px;white-space:nowrap\}/);
  assert.match(html, /\.partition-availability\{[^}]*gap:0/);
  assert.match(html, /\.partition-availability-label\{[^}]*flex:0 0 36px;width:36px;padding-right:2px[^}]*text-align:left/);
  assert.match(html, /\.partition-availability>\.availability-cell\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,max-content\);column-gap:2px;flex:1 1 auto;min-width:0\}/);
  assert.match(html, /\.partition-availability \.availability-cell>\.availability\{width:100%;min-width:0\}/);
  assert.match(html, /\.partition-card\{padding:5px;container-type:inline-size\}/);
  assert.match(html, /\.partition-availability \.availability-count\{width:max-content;min-width:min\(var\(--availability-count-width\),45cqw\);max-width:100%;overflow:hidden;text-overflow:ellipsis\}/);
  assert.match(html, /\.availability-count\{font-variant-numeric:tabular-nums;white-space:nowrap\}/);
  assert.match(card, /aria-label="2 of 8 free" title="2\/8 Free">2\/8 Free<\/span>/);
  assert.match(card, /aria-label="2 of 7 free" title="2\/7 Free">2\/7 Free<\/span>/);
  assert.ok(html.indexOf('class="available"') < html.indexOf('class="unavailable"'));
  assert.match(html, /data-availability="2 idle, 4 allocated, 1 reserved, 1 down"/);
  assert.match(html, /data-fast-tooltip="2 idle, 4 allocated, 1 reserved, 1 down"/);
  assert.match(html, /data-availability="2 idle, 3 full, 1 reserved, 1 down"/);
  assert.match(html, /data-fast-tooltip="2 idle, 3 full, 1 reserved, 1 down"/);
  assert.match(html, /const FAST_HOVER_DELAY_MS = 100/);
  assert.match(html, /querySelectorAll\('\[data-fast-tooltip\]'\)/);
  assert.doesNotMatch(html, /0 mixed/);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<details class="cluster-group" data-disclosure-key="cluster:cluster_0" open><summary><span class="cluster-summary"><span class="cluster-summary-main"><span class="cluster-summary-name">cluster_0<\/span><span class="cluster-job-track" role="group" aria-label="3 running, 1 pending, 0 depending"/);
  assert.match(html, /class="cluster-job-running" style="width:75%"/);
  assert.match(html, /class="cluster-job-pending" style="width:25%"/);
  assert.match(html, /class="cluster-job-running"[^>]*data-command="clusterWatcher\.showJobsGroup" data-args="\[&quot;RUNNING&quot;,&quot;cluster_0&quot;\]"/);
  assert.match(html, /class="cluster-job-pending"[^>]*data-command="clusterWatcher\.showJobsGroup" data-args="\[&quot;PENDING&quot;,&quot;cluster_0&quot;\]"/);
  assert.doesNotMatch(html, /data-args="\[&quot;DEPENDING&quot;,&quot;cluster_0&quot;\]"/);
  assert.match(html, /data-fast-tooltip="3 running jobs\nGPU-hours unavailable"/);
  assert.match(html, /data-fast-tooltip="1 pending job\nGPU-hours unavailable"/);
  assert.doesNotMatch(html, /data-fast-tooltip="[^"]*(?:cluster_0|Click to view)/);
  assert.doesNotMatch(html, /class="cluster-job-track"[^>]*data-fast-tooltip=/);
  assert.doesNotMatch(html, /class="cluster-login-host"|login-02\.example/);
  assert.match(html, /\.cluster-job-running\{background:var\(--vscode-progressBar-background\)\}/);
  assert.match(html, /\.cluster-job-pending\{background:var\(--vscode-editorError-foreground\)\}/);
  assert.match(html, /\.cluster-job-depending\{display:block;height:100%;background:#6b1026\}/);
  assert.match(html, /\.cluster-job-running\{background:#2563eb\}\.cluster-job-pending\{background:#dc2626\}/);
  assert.match(html, /\.cluster-job-track\{[^}]*height:6px/);
  assert.match(html, /\.cluster-job-track>button:hover,\.cluster-job-track>button:focus-visible\{box-shadow:inset 0 0 0 1px #fff\}/);
  assert.doesNotMatch(html, /\.cluster-group(?:\[open\])?>summary::before/);
  assert.match(html, /\.cluster-summary\{[^}]*display:inline-flex;flex-direction:column/);
  assert.match(html, /<dialog class="sessions-dialog" aria-labelledby="sessions-dialog-title">/);
  assert.match(html, /class="sessions-dialog-text" tabindex="0">No SSH sessions are available\./);
  assert.match(html, /class="sessions-dialog-header"><button class="sessions-dialog-close" type="button" data-close-sessions aria-label="Close SSH Sessions">×<\/button><h2/);
  assert.doesNotMatch(html, /data-copy-sessions|sessions-dialog-actions|>Close<\/button>/);
  assert.match(html, /\.sessions-dialog-text\{[^}]*user-select:text/);
  assert.match(html, /sessionsDialog\.showModal\(\)/);
  assert.match(html, /sessionsOpen: open/);
  assert.doesNotMatch(html, /copySessions/);
  assert.ok(html.lastIndexOf('class="configure-clusters"') > html.lastIndexOf('class="cluster-group"'));
  assert.match(html, /<hr class="cluster-config-separator"><div class="service-summary">.*?<\/div><div class="cluster-footer-links"><button class="view-sessions" type="button" data-open-sessions>view sessions<\/button><span class="footer-divider" aria-hidden="true">\|<\/span><button class="configure-clusters"/s);
  assert.match(html, /\.cluster-group\+\.cluster-group\{border-top:1px solid color-mix\(in srgb,var\(--vscode-foreground\) 35%,transparent\);padding-top:4px\}/);
  assert.match(html, /\.cluster-config-separator\{[^}]*border-top:1px solid color-mix\(in srgb,var\(--vscode-foreground\) 40%,transparent\)/);
  assert.match(html, /<button class="configure-clusters" data-scroll-anchor="configure-clusters" type="button" data-command="clusterWatcher\.editConfig" data-args="\[\]">configure clusters<\/button><\/div>/);
  assert.match(html, /\.cluster-footer-links\{display:flex;align-items:center;gap:3px;margin:4px 0 0;white-space:nowrap/);
  assert.match(html, /const statusAnchor = document\.querySelector\('\[data-scroll-anchor="configure-clusters"\]'\)/);
  assert.doesNotMatch(html, /## cluster_0 ##/);
  assert.doesNotMatch(html, /<body><h2>Cluster Status<\/h2>/);
  assert.equal(waitCell(partition, 1), '5m');
  assert.equal(waitCell(partition, 2), 'DENY');
  assert.equal(waitCell(partition, 16), '—');
});

test('cluster job ratio remains empty when no jobs are running or pending', () => {
  const html = renderStatus({ clusters: [
    { name: 'idle', reachable: true, user_jobs: { running: 0, pending: 0 }, partitions: [] },
  ] });
  const track = html.match(/<span class="cluster-job-track"[^>]*>.*?<\/span>/s)[0];
  assert.match(track, /aria-label="0 running, 0 pending, 0 depending"/);
  assert.doesNotMatch(track, /cluster-job-(?:running|pending|depending)/);
});

test('early cluster overview keeps clickable job segments while details load', () => {
  const html = renderStatus({ overview_only: true, clusters: [{
    name: 'alpha', reachable: true, user_jobs: { running: 2, pending: 1, depending: 1 }, partitions: [],
  }] }, { 'cluster:alpha': false });

  assert.match(html, /<details class="cluster-group" data-disclosure-key="cluster:alpha"><summary>/);
  assert.match(html, /aria-label="2 running, 1 pending, 1 depending"/);
  for (const group of ['RUNNING', 'PENDING', 'DEPENDING']) {
    assert.match(html, new RegExp(`data-args="\\[&quot;${group}&quot;,&quot;alpha&quot;\\]"`));
  }
  assert.match(html, /Loading cluster details…/);
  assert.match(html, /\.cluster-group:not\(\[open\]\)\+\.cluster-config-separator\{margin-top:5px\}/);
  assert.doesNotMatch(html, /<article class="card partition-card"/);
});

test('cluster ratio includes three correctly sized status colors', () => {
  const html = renderStatus({ clusters: [
    { name: 'busy', reachable: true, user_jobs: { running: 2, pending: 1, depending: 1 }, partitions: [] },
  ] });
  assert.match(html, /aria-label="2 running, 1 pending, 1 depending"/);
  assert.match(html, /class="cluster-job-running" style="width:50%"/);
  assert.match(html, /class="cluster-job-pending" style="width:25%"/);
  assert.match(html, /class="cluster-job-depending" style="width:25%"/);
  assert.match(html, /class="cluster-job-depending"[^>]*data-command="clusterWatcher\.showJobsGroup" data-args="\[&quot;DEPENDING&quot;,&quot;busy&quot;\]"/);
  assert.match(html, /data-fast-tooltip="1 depending job\nGPU-hours unavailable"/);
  assert.match(html, /const target = \[\.\.\.document\.querySelectorAll\('details\.job-group\[data-disclosure-key\]'\)\]/);
  assert.match(html, /if \(!target\.open\) \{ target\.open = true; remember\(target\); \}/);
  assert.match(html, /clusterCard\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
});

test('cluster ratio hover estimates remaining and requested GPU hours', () => {
  const html = renderStatus({ clusters: [{
    name: 'c', reachable: true, partitions: [],
    user_jobs: { running: 2, pending: 1, depending: 1 },
    user_gpu_hours: { running: 7.5, pending: 8, depending: 2 },
  }] });
  assert.match(html, /data-fast-tooltip="2 running jobs\n7\.5 GPU-hours remaining"/);
  assert.match(html, /data-fast-tooltip="1 pending job\n8 GPU-hours requested"/);
  assert.match(html, /data-fast-tooltip="1 depending job\n2 GPU-hours requested"/);
});

test('expanded job shows total GPUs, model breakdown, and partition navigation', () => {
  const html = renderJobs({ jobs: [{
    job_id: '42', name: 'train', cluster: 'inf', partition: 'gpu-all', state: 'RUNNING',
    node_count: 2, gpus: 2, gpu_total: 4, cpus: 24,
    gpu_models: [{ name: 'A100', count: 2 }, { name: 'H100', count: 2 }],
  }] });
  const meta = html.match(/<div class="muted card-meta">.*?<\/div>/s)[0];
  assert.match(meta, /data-command="clusterWatcher\.showCluster" data-args="\[&quot;inf&quot;\]"/);
  assert.match(meta, /data-command="clusterWatcher\.showPartition" data-args="\[&quot;inf&quot;,&quot;gpu-all&quot;\]"/);
  assert.match(meta, /data-fast-tooltip="A100: 2\nH100: 2"[^>]*>4 GPU<\/span>/);
  assert.doesNotMatch(meta, /title=/);
  const one = renderJobs({ jobs: [{ job_id: '43', cluster: 'inf', partition: 'gpu-h100',
    state: 'RUNNING', node_count: 2, gpus: 1, gpu_total: 2,
    gpu_models: [{ name: 'H100', count: 2 }] }] });
  assert.match(one, /data-fast-tooltip="H100"[^>]*>2 GPU<\/span>/);
  assert.match(html, /event\.data\?\.type === 'jumpPartition'/);
  assert.match(html, /if \(!partition\) \{ group\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\); return; \}/);
  const status = renderStatus({ clusters: [{ name: 'inf', reachable: true,
    partitions: [{ name: 'gpu-all', gpus: { total: 4 } }] }] });
  assert.match(status, /data-partition="gpu-all"/);
});

test('APU jobs show APU counts and the configured model', () => {
  const html = renderJobs({ jobs: [{
    job_id: '42', cluster: 'viper', partition: 'apu', state: 'RUNNING',
    node_count: 2, gpus: 2, gpu_total: 4, accelerator_type: 'apu',
    gpu_models: [{ name: 'AMD Instinct MI300A', count: 4 }],
  }] });
  assert.match(html, /data-fast-tooltip="AMD Instinct MI300A"[^>]*>4 APU<\/span>/);
  const unknown = renderJobs({ jobs: [{ job_id: '43', cluster: 'viper', state: 'RUNNING',
    gpus: 1, accelerator_type: 'apu', gpu_models: [] }] });
  assert.match(unknown, /data-fast-tooltip="APU model unavailable"[^>]*>1 APU<\/span>/);
});

test('cluster-name navigation preserves the cluster disclosure state', () => {
  const html = renderJobs({ jobs: [{ job_id: '42', cluster: 'viper', state: 'RUNNING' }] });
  const clusterJump = html.indexOf("if (!partition) { group.scrollIntoView");
  const partitionOpens = html.indexOf('if (!group.open) { group.open = true; remember(group); }', clusterJump);
  assert.ok(clusterJump > -1 && partitionOpens > clusterJump);
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /if \(partition\) this\.disclosures\[`cluster:\$\{cluster\}`\] = true;/);
  assert.match(source, /if \(!partition && this\.showingData\) \{[\s\S]*?this\.view\.webview\.postMessage\(\{ type: 'jumpPartition', \.\.\.target \}\)/);
  assert.match(html, /data-command="clusterWatcher\.showCluster" data-args="\[&quot;viper&quot;\]"/);
  assert.match(renderStatus({ clusters: [{ name: 'viper', reachable: true, partitions: [] }] },
    { 'cluster:viper': false }), /data-disclosure-key="cluster:viper"><summary>/);
});

test('partition navigation briefly highlights only the destination card', () => {
  const html = renderStatus({ clusters: [{ name: 'inf', reachable: true,
    partitions: [{ name: 'gpu-h100', gpus: { total: 1 } }] }] });
  assert.match(html, /@keyframes partition-jump-highlight\{0%,55%\{box-shadow:0 0 0 2px #2563eb\}100%\{box-shadow:none\}\}/);
  assert.match(html, /\.partition-card\.jump-highlight\{animation:partition-jump-highlight 1\.5s ease-out both\}/);
  const clusterJump = html.indexOf("if (!partition) { group.scrollIntoView");
  const cardJump = html.indexOf("card.scrollIntoView({ behavior: 'smooth', block: 'start' });", clusterJump);
  const highlight = html.indexOf("card.classList.add('jump-highlight');", cardJump);
  assert.ok(clusterJump > -1 && cardJump > clusterJump && highlight > cardJump);
  assert.match(html, /clearTimeout\(partitionHighlightTimers\.get\(card\)\)/);
  assert.match(html, /setTimeout\(\(\) => card\.classList\.remove\('jump-highlight'\), 1500\)/);
});

test('expanded lifecycle rows keep label, date, and clock on one line', () => {
  const html = renderJobs({ jobs: [{
    job_id: '7', cluster: 'c', state: 'COMPLETED',
    submit_at: '2026-09-30T15:00:00Z', start_at: '2026-09-30T15:01:00Z',
    end_at: '2026-09-30T15:02:00Z',
  }] });
  const submitted = html.match(/<div class="time-row"><dt>Submitted<\/dt><dd>([^<]+)<\/dd><\/div>/);
  assert.ok(submitted);
  assert.match(submitted[1], /^\d\d\.\d\d \d\d:\d\d$/);
  assert.match(html, /<div class="time-row"><dt>Launched<\/dt><dd>[^<]+<\/dd><\/div>/);
  assert.match(html, /<div class="time-row"><dt>Ended<\/dt><dd>[^<]+<\/dd><\/div>/);
  assert.match(html, /\.time-row\{[^}]*justify-content:space-between;[^}]*white-space:nowrap\}/);
  assert.match(html, /\.time-row dd\{[^}]*text-align:right\}/);
  assert.match(html, /\.times dd\.dependency-value\{overflow-wrap:anywhere\}/);
});

test('expanded timestamps honor month-first date settings without showing a year', () => {
  try {
    setDateFormat('MM/DD/YY');
    const html = renderJobs({ jobs: [{ job_id: '7', cluster: 'c', state: 'PENDING',
      submit_at: '2026-09-30T15:00:00Z' }] });
    assert.match(html, /<div class="time-row"><dt>Submitted<\/dt><dd>09\/30 \d\d:\d\d<\/dd><\/div>/);
    assert.doesNotMatch(html.match(/<div class="time-row">.*?<\/div>/s)[0], /2026|<dt>Submitted:/);
  } finally {
    setDateFormat();
  }
});

test('running, pending, and depending jobs group by cluster then newest submission', () => {
  const jobs = [
    { job_id: 'b-new', cluster: 'beta', state: 'RUNNING', submit_at: '2026-10-01T12:00:00Z' },
    { job_id: 'a-old', cluster: 'alpha', state: 'RUNNING', submit_at: '2026-10-01T10:00:00Z' },
    { job_id: 'a-new', cluster: 'alpha', state: 'RUNNING', submit_at: '2026-10-01T11:00:00Z' },
    { job_id: 'p-beta', cluster: 'beta', state: 'PENDING', submit_at: '2026-10-01T12:00:00Z' },
    { job_id: 'p-alpha', cluster: 'alpha', state: 'PENDING', submit_at: '2026-10-01T10:00:00Z' },
    { job_id: 'd-beta', cluster: 'beta', state: 'PENDING', dependency: 'afterok:1', submit_at: '2026-10-01T12:00:00Z' },
    { job_id: 'd-alpha', cluster: 'alpha', state: 'PENDING', dependency: 'afterok:1', submit_at: '2026-10-01T10:00:00Z' },
  ];
  const html = renderJobs({ jobs });
  assert.ok(html.indexOf('data-job-ref="alpha/a-new"') < html.indexOf('data-job-ref="alpha/a-old"'));
  assert.ok(html.indexOf('data-job-ref="alpha/a-old"') < html.indexOf('data-job-ref="beta/b-new"'));
  assert.ok(html.indexOf('data-job-ref="alpha/p-alpha"') < html.indexOf('data-job-ref="beta/p-beta"'));
  assert.ok(html.indexOf('data-job-ref="alpha/d-alpha"') < html.indexOf('data-job-ref="beta/d-beta"'));
  assert.doesNotMatch(html, /job-cluster-heading|data-job-cluster/);
  assert.match(html, /card\.dataset\.jobRef\.startsWith\(cluster \+ '\/'\)/);
});

test('matched fair-share factors have bars above GPU and node availability', () => {
  const html = renderStatus({ clusters: [
    { name: 'cluster_a', reachable: true, fair_share: {
      associations: [
        { account: 'gpu_a100_bs_default', partition: 'gpu_a100', factor: 0.725, rank: 1302, total: 4728 },
        { account: 'unscoped', partition: null, factor: 0.5, rank: 9, total: 20 },
      ],
    }, partitions: [
      { name: 'gpu_a100', gpus: { total: 0 }, fair_share: [{ account: 'gpu_a100_bs_default', partition: 'gpu_a100', factor: 0.725, rank: 1302, total: 4728 }] },
      { name: 'apu', gpus: { total: 0 }, fair_share: [] },
    ] },
    { name: 'cluster_b', reachable: true, fair_share: {
      associations: [], error: 'sshare unavailable',
    }, partitions: [{ name: 'gpu', gpus: { total: 0 } }] },
  ] });

  const cards = [...html.matchAll(/<article class="card partition-card"[^>]*>.*?<\/article>/gs)].map((match) => match[0]);
  const gpuCard = cards.find((card) => card.includes('>gpu_a100</span>'));
  const apuCard = cards.find((card) => card.includes('>apu</span>'));
  assert.match(gpuCard, /role="progressbar"[^>]*aria-valuenow="0\.725"/);
  assert.match(gpuCard, /class="fair-share-marker" style="left:72\.50%"/);
  assert.match(gpuCard, /<span class="fair-share-title">FairShare:<\/span><div class="fair-share-bars"><div class="fair-share-row"><div class="fair-share-track"/);
  assert.doesNotMatch(gpuCard, /fair-share-label|0\.725000/);
  assert.match(gpuCard, /gpu_a100_bs_default: 1302\/4728/);
  assert.match(html, /\.fair-share-track\{[^}]*height:6px/);
  assert.match(html, /\.partition-fair-share\{display:flex;align-items:flex-start/);
  assert.match(html, /\.fair-share-bars\{[^}]*padding-top:3px/);
  assert.match(html, /\.fair-share-track\{[^}]*linear-gradient\(90deg,var\(--vscode-editorError-foreground\),var\(--vscode-descriptionForeground\) 50%,var\(--cluster-watcher-green\)\)/);
  assert.ok(gpuCard.indexOf('FairShare:') < gpuCard.indexOf('GPUs:'));
  assert.ok(gpuCard.indexOf('GPUs:') < gpuCard.indexOf('Nodes:'));
  assert.doesNotMatch(apuCard, /gpu_a100_bs_default|unscoped/);
  assert.match(apuCard, /class="fair-share-track unavailable"/);
  assert.match(apuCard, /No confirmed association match for this partition/);
  assert.match(html, /sshare unavailable/);
  assert.doesNotMatch(html, /Other fair-share associations|fair-share-card/);
});

test('two fair-share associations share one track with separate markers and hover details', () => {
  const entry = { account: 'lab', partition: 'gpu', factor: 0.8, rank: 4, total: 100 };
  const second = { account: 'other', partition: 'gpu', factor: 0.25, rank: 50, total: 100 };
  const html = renderStatus({ clusters: [{ name: 'cluster_d', reachable: true,
    fair_share: { associations: [entry, second] },
    partitions: [{ name: 'gpu', gpus: { total: 0 }, fair_share: [entry, second] }],
  }] });

  assert.equal((html.match(/class="fair-share-track" role="img"/g) || []).length, 1);
  assert.equal((html.match(/class="fair-share-marker"/g) || []).length, 2);
  assert.match(html, /class="fair-share-marker" style="left:80\.00%"/);
  assert.match(html, /class="fair-share-marker" style="left:25\.00%"/);
  assert.doesNotMatch(html, /fair-share-label|0\.800000|0\.250000/);
  assert.match(html, /lab: 4\/100/);
  assert.match(html, /other: 50\/100/);
  assert.doesNotMatch(html, /Other fair-share associations/);
});

test('unscoped accounts matched through access rules appear on the partition card', () => {
  const entry = {
    account: 'gpu_v100_bs_default', partition: null, factor: 0.998557,
    rank: 3, total: 4728, matched_partitions: ['gpu-v100'], mapping_source: 'account_qos',
  };
  const html = renderStatus({ clusters: [{
    name: 'cluster_d', reachable: true,
    fair_share: { associations: [entry] },
    partitions: [{ name: 'gpu-v100', gpus: { total: 6 }, fair_share: [entry] }],
  }] });

  assert.match(html, /aria-valuenow="0\.998557"/);
  assert.doesNotMatch(html, /fair-share-label/);
  assert.match(html, /gpu_v100_bs_default: 3\/4728/);
  assert.doesNotMatch(html, /Other fair-share associations|No partition specified/);
});

test('long availability fractions keep their complete value available on hover', () => {
  const partition = {
    name: 'large', gpus: { total: 12345, schedulable_idle: 1234 },
    node_states: { IDLE: 2, ALLOCATED: 5 },
  };
  const html = renderStatus({ clusters: [{ name: 'large-cluster', reachable: true, partitions: [partition] }] });

  assert.match(html, /<article class="card partition-card" data-partition="large" style="--availability-count-width:15ch">/);
  assert.match(html, /aria-label="1234 of 12345 free" title="1234\/12345 Free">1234\/12345 Free<\/span>/);
  assert.match(html, /aria-label="2 of 7 free" title="2\/7 Free">2\/7 Free<\/span>/);
});

test('Cluster Status puts the service toggle and dashboard URL below the divider', () => {
  const html = renderStatus({ clusters: [
    { name: 'cluster_0', reachable: true, partitions: [] },
  ] }, {}, {}, { service: {
    state: 'attached', pid: 1234, startedAt: '2026-10-13T10:00:00Z', url: 'http://127.0.0.1:8080/',
  } });

  assert.match(html, /class="service-toggle on"[^>]*data-command="clusterWatcher\.stopService"[^>]*aria-label="Stop service"/);
  assert.match(html, /<div class="service-summary"><button class="service-toggle on"[^>]*><\/button><button class="service-url"[^>]*data-command="clusterWatcher\.openDashboard"[^>]*>http:\/\/127\.0\.0\.1:8080\/<\/button><\/div>/);
  assert.match(html, /data-fast-tooltip="Process: 1234&#10;Started: [^"]+"/);
  assert.ok(html.indexOf('class="cluster-group"') < html.indexOf('class="cluster-config-separator"'));
  assert.ok(html.indexOf('class="cluster-config-separator"') < html.indexOf('class="service-summary"'));
  assert.ok(html.indexOf('class="service-summary"') < html.indexOf('class="configure-clusters"'));
  assert.doesNotMatch(html, /class="service-url"[^>]*href="#"/);

  const stopped = renderStatus({ clusters: [] }, {}, {}, { service: { state: 'offline' } });
  assert.match(stopped, /class="service-toggle off"[^>]*data-command="clusterWatcher\.startService"[^>]*data-fast-tooltip="Start service"/);
  assert.match(stopped, /<div class="service-summary"><button class="service-toggle off"[^>]*><\/button><strong>Start Server<\/strong><\/div>/);
  assert.match(stopped, /\.service-summary\{[^}]*white-space:nowrap/);
  assert.match(stopped, /\.service-url\{[^}]*max-width:calc\(100% - 26px\)/);
  assert.match(stopped, /\.service-toggle\{[^}]*width:22px;height:12px;margin:0/);

  const starting = renderStatus({ clusters: [] }, {}, {}, { service: { state: 'starting' } });
  assert.match(starting, /class="service-toggle on"[^>]*data-command="clusterWatcher\.stopService"[^>]* disabled/);
  assert.match(starting, /<strong>Starting<\/strong>/);
});

test('Cluster Status replaces logged-out session details with scoped login actions', () => {
  const html = renderStatus({ clusters: [
    { name: 'open', host: 'old.example', reachable: true, user_jobs: { running: 2, pending: 1 }, partitions: [] },
    { name: 'closed', host: 'b.example', reachable: false, login_required: true, error: 'alice@b.example: Permission denied', user_jobs: { running: 9, pending: 4 }, partitions: [] },
  ] }, {}, {}, {
    service: {
      state: 'attached', url: 'http://127.0.0.1:8080/', activity: 'Refreshing sessions…',
      recentLines: [{ stream: 'stderr', text: 'diagnostic <line>' }],
    },
    sessionsError: 'alice@b.example: temporary inspection error',
    sessions: { machines: [
      { name: 'open', username: 'alice', host: 'a.example', session_open: true, interactive_auth: true, control_persist_seconds: 3600, estimated_remaining_seconds: 28740 },
      { name: 'closed', username: 'alice', host: 'b.example', session_open: false, interactive_auth: true, credential_group: 'shared-site', error: 'No master' },
    ] },
  });
  const summaryFor = (name) => html.match(new RegExp(`data-disclosure-key="cluster:${name}"[^>]*><summary>.*?</summary>`, 's'))[0];
  const open = summaryFor('open');
  const closed = summaryFor('closed');

  assert.match(open, /class="cluster-job-track"[^>]*aria-label="2 running, 1 pending, 0 depending"/);
  assert.doesNotMatch(open, /cluster-login-host|a\.example|alice/);
  assert.match(html, /open: alice@a\.example\n🕒 07:59 left/);
  assert.doesNotMatch(open, /alice@/);
  assert.doesNotMatch(open, /clusterWatcher\.login/);
  assert.match(closed, /data-command="clusterWatcher\.login" data-args="\[&quot;closed&quot;,false\]">Log in<\/button>/);
  assert.match(closed, /data-command="clusterWatcher\.login" data-args="\[&quot;closed&quot;,true\]">Log into all machines on shared-site<\/button>/);
  assert.doesNotMatch(closed, /cluster-job-track|cluster-login-host|alice@b\.example/);
  assert.match(html, /b\.example: Permission denied/);
  assert.equal((html.match(/>Log in<\/button>/g) || []).length, 1);
  assert.match(html, /Refreshing sessions…/);
  assert.match(html, /Could not inspect SSH sessions: b\.example: temporary inspection error/);
  assert.doesNotMatch(html, /Recent backend output|cluster-diagnostics|service-output|diagnostic &lt;line&gt;/);
  assert.match(html, /\.cluster-login-actions\{display:flex;[^}]*flex-wrap:wrap/);
  assert.doesNotMatch(html, /<title>Server Status<\/title>|class="session-row"/);

  const fallback = renderStatus({ clusters: [
    { name: 'fallback', host: 'login.example', reachable: false, login_required: true },
  ] });
  assert.match(fallback, /data-command="clusterWatcher\.login" data-args="\[&quot;fallback&quot;,false\]">Log in<\/button>/);
  assert.equal((fallback.match(/clusterWatcher\.login/g) || []).length, 1);
});

test('session dialog escapes SSH account text before placing it in the webview', () => {
  const html = renderStatus({ clusters: [] }, {}, {}, { sessions: { machines: [
    { name: 'test', username: '<img src=x>', host: 'login.example', session_open: true },
  ] } });
  assert.match(html, /test: &lt;img src=x&gt;@login\.example/);
  assert.doesNotMatch(html, /test: <img src=x>/);
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
    '2 idle, 3 full, 2 reserved, 1 drained',
  );
  assert.doesNotMatch(availabilityTitle(partition), /down/);
  assert.equal(
    availabilityTitle({ nodes: [{ state: 'IDLE' }, { state: 'MIXED' }, { state: 'MIXED' }] }),
    '1 idle, 2 mixed',
  );
});

test('GPU availability tooltips count resources separately from node states', () => {
  const partition = {
    gpus: { total: 8, allocated: 2, idle: 6, schedulable_idle: 3, unavailable_idle: 3 },
    nodes: [
      { state: 'MIXED', gpus: { total: 4, allocated: 1, idle: 3, schedulable_idle: 3 } },
      { state: 'ALLOCATED', gpus: { total: 1, allocated: 1, idle: 0, schedulable_idle: 0 } },
      { state: 'IDLE+DRAIN', gpus: { total: 2, allocated: 0, idle: 2, schedulable_idle: 0 } },
      { state: 'RESERVED', gpus: { total: 1, allocated: 0, idle: 1, schedulable_idle: 0 } },
    ],
  };

  assert.equal(gpuAvailabilityTitle(partition), '3 idle, 2 allocated, 1 reserved, 2 drained');
  assert.equal(gpuAvailabilityTitle({
    gpus: {
      total: 8, allocated: 2, schedulable_idle: 3,
      unavailable_by_state: { 'IDLE+DRAIN': 2, RESERVED: 1 },
    },
  }), '3 idle, 2 allocated, 1 reserved, 2 drained');
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

  const status = renderStatus({ clusters: [{ name: 'cluster_0', host: 'login.example', reachable: false }] }, { 'cluster:cluster_0': false });
  assert.match(status, /data-disclosure-key="cluster:cluster_0"><summary><span class="cluster-summary"><span class="cluster-summary-main"><span class="cluster-summary-name">cluster_0<\/span>/);
  assert.doesNotMatch(status, /class="cluster-login-host"|login\.example/);
});

test('openAttribute falls back to the renderer default', () => {
  assert.equal(openAttribute({}, 'missing', true), ' open');
  assert.equal(openAttribute({}, 'missing', false), '');
  assert.equal(openAttribute({ key: false }, 'key', true), '');
});

test('collapsed title hover shows the full name and the job ID sits beside the progress when expanded', () => {
  const html = renderJobs({ jobs: [{ job_id: '2000068_123', name: 'a very long job title indeed', cluster: 'cluster_0', state: 'RUNNING' }] });
  const cardSummary = html.match(/<summary><span class="card-summary-title".*?<\/summary>/s)[0];
  assert.match(cardSummary, /^<summary><span class="card-summary-title" data-full-name="cluster_0 2000068_123 a very long job title indeed"><span class="name">a very long job title indeed<\/span><\/span>/);
  assert.match(cardSummary, /<span class="card-summary-progress"><span class="job-progress"[^>]*>.*?<\/span><\/span><span class="badge job-id" role="button" tabindex="0" data-copy="2000068_123"[^>]*>2000068_123<\/span><\/span><\/summary>$/s);
  assert.match(html, /\.name\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap;/);
  assert.match(html, /\.card\[open\] \.name\{white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(html, /\.card:not\(\[open\]\) \.card-summary-title\[data-full-name\]:hover::after\{visibility:visible;opacity:1\}/);
  assert.doesNotMatch(html, /summary\[data-full-name\]/);
  assert.match(html, /\.card-summary-title\[data-full-name\]::after\{outline:1px solid #fff\}/);
  assert.match(html, /\.card:not\(\[open\]\) \.card-summary-progress>\.job-id\{display:none\}/);
  assert.doesNotMatch(cardSummary, /<summary[^>]* title=/);
  assert.match(html, /<div class="muted card-meta"><span class="meta-field meta-cluster"><button class="job-cluster-link"[^>]*>cluster_0<\/button><\/span><span class="meta-field meta-partition" data-separator="\/">no partition<\/span><span class="meta-field meta-nodes" data-separator="·">0 node<\/span><span class="meta-field meta-accelerators" data-separator="·"><span class="job-gpu-count"[^>]*>0 GPU<\/span><\/span><span class="meta-field meta-cpus" data-separator="·">0 CPU<\/span><\/div>/);
  assert.equal((html.match(/data-copy=/g) || []).length, 1);
  assert.match(html, /\.job-id\{[^}]*border-radius:0\}/);
  assert.match(html, /\.job-id:hover,\.job-id:focus-visible\{outline:none;box-shadow:inset 0 0 0 1px var\(--vscode-focusBorder\)\}/);
  assert.doesNotMatch(html, /\.job-id\{[^}]*width:/);
  assert.match(html, /type: 'copy'/);
});

test('the job ID also follows a no-estimate priority gauge in the summary', () => {
  const low = { job_id: '1', cluster: 'c', state: 'PENDING', priority: 1 };
  const high = { job_id: '2', cluster: 'c', state: 'PENDING', priority: 2 };
  const summary = renderJobs({ jobs: [low, high] }).match(/<summary><span class="card-summary-title" data-full-name="c 1 1">.*?<\/summary>/s)[0];
  assert.match(summary, /priority-prominent.*<span class="badge job-id"[^>]*>1<\/span><\/span><\/summary>/s);
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
  assert.match(html, /<dt>Depends on<\/dt><dd class="dependency-value">afterok <a class="dep-link" href="#" data-jump="cluster_0\/12"[^>]*>12<\/a> <span class="dependency-icon waiting"[^>]*data-fast-tooltip="Unfulfilled: waiting for job 12 to satisfy afterok"[^>]*>🕒<\/span>/);
  const summary = html.match(/<summary><span class="card-summary-title" data-full-name="cluster_0 13 13">.*?<\/summary>/s)[0];
  assert.match(summary, /dependency:afterok <a class="dep-link" href="#" data-jump="cluster_0\/12"[^>]*>12<\/a>/);
  assert.doesNotMatch(summary, /dependency-icon/);
  assert.doesNotMatch(html, /<span class="muted">\(unfulfilled\)<\/span>/);
  assert.match(html, /<details class="card" data-disclosure-key="[^"]+" data-job-ref="cluster_0\/12"/);
  assert.match(html, /type: 'missingJob'/);
  assert.equal((html.match(/<dt>Depends on/g) || []).length, 1);
});

test('dependency icons reflect referenced outcomes and impossible jobs get their own group', () => {
  const completed = { job_id: '10', cluster: 'c', state: 'COMPLETED' };
  const failed = { job_id: '11', cluster: 'c', state: 'FAILED' };
  const waiting = { job_id: '12', cluster: 'c', state: 'RUNNING' };
  const clauses = parseDependency('afterany:10,afterok:11,afterok:12');
  const owner = { job_id: '20', cluster: 'c', state: 'PENDING' };
  assert.equal(dependencyStatus(owner, clauses[0], '10', [completed, failed, waiting]), 'satisfied');
  assert.equal(dependencyStatus(owner, clauses[1], '11', [completed, failed, waiting]), 'failed');
  assert.equal(dependencyStatus(owner, clauses[2], '12', [completed, failed, waiting]), 'waiting');

  const recoverableOr = { ...owner, dependency: 'afterok:10(failed)?afterok:12(unfulfilled)' };
  const failedOr = { ...owner, dependency: 'afterok:10(failed)?afterok:11(failed)' };
  const impossible = { ...owner, job_id: '21', dependency: 'afterok:11(failed)', reason: 'DependencyNeverSatisfied' };
  assert.equal(hasFailedDependency(recoverableOr), false);
  assert.equal(hasFailedDependency(failedOr), true);
  assert.equal(jobGroup(impossible), 'FAILED_DEPENDENCY');

  const html = renderJobs({ jobs: [
    completed, failed, waiting, impossible,
    { ...owner, dependency: 'afterany:10' },
    { ...owner, job_id: '22', dependency: 'afterok:12' },
  ] });
  assert.match(html, /Failed Dependency \(1\)/);
  assert.match(html, /class="dependency-icon satisfied"[^>]*>✓<\/span>/);
  assert.match(html, /class="dependency-icon failed"[^>]*>✕<\/span>/);
  assert.match(html, /class="dependency-icon waiting"[^>]*>🕒<\/span>/);
  assert.match(html, /data-fast-tooltip="Satisfied: job 10 satisfied afterany"/);
  assert.match(html, /data-fast-tooltip="Failed: job 11 cannot satisfy afterok"/);
  assert.match(html, /data-fast-tooltip="Waiting: waiting for job 12 to satisfy afterok"/);
  assert.match(html, /\.dependency-icon\.satisfied\{color:var\(--cluster-watcher-green\)\}/);
  assert.match(html, /\.dependency-icon\.failed\{color:var\(--vscode-errorForeground\)\}/);
});

test('pending cards show a labeled relative-priority gauge only in expanded content', () => {
  const low = { job_id: '1', cluster: 'c', state: 'PENDING', priority: 100, global_priority_rank: 50, global_priority_total: 100, submit_at: '2026-01-01T00:00:00Z', expected_start_at: '2026-01-01T01:00:00Z' };
  const high = { job_id: '2', cluster: 'c', state: 'PENDING', priority: 900, global_priority_rank: 10, global_priority_total: 100, submit_at: '2026-01-01T00:00:00Z', expected_start_at: '2026-01-01T01:00:00Z' };
  assert.ok(Math.abs(relativeJobPriority(low, [low, high]).percent - (50 / 99 * 100)) < 1e-9);
  assert.ok(Math.abs(relativeJobPriority(high, [low, high]).percent - (90 / 99 * 100)) < 1e-9);
  assert.ok(Math.abs(relativeJobPriority(low, [low]).percent - (50 / 99 * 100)) < 1e-9);
  assert.equal(relativeJobPriority({ ...low, priority: null }, [low, high]), null);
  const localOnlyLow = { ...low, global_priority_rank: null, global_priority_total: null };
  const localOnlyHigh = { ...high, global_priority_rank: null, global_priority_total: null };
  assert.equal(
    relativeJobPriority(localOnlyLow, [localOnlyLow, localOnlyHigh]).title,
    'Global priority unavailable\nYour priority 2 / 2',
  );
  assert.equal(relativeJobPriority(localOnlyLow, [localOnlyLow, localOnlyHigh]).percent, 0);
  assert.equal(relativeJobPriority(localOnlyLow, [localOnlyLow]), null);

  const html = renderJobs({ jobs: [low, high] });
  const lowCard = html.match(/<details class="card"[^>]*data-job-ref="c\/1".*?<\/details>/s)[0];
  const lowSummary = lowCard.match(/<summary.*?<\/summary>/s)[0];
  assert.doesNotMatch(lowSummary, /priority-gauge/);
  assert.match(lowCard, /class="priority-marker" style="left:50\.5050/);
  assert.match(lowCard, /data-fast-tooltip="Global priority 50 \/ 100\nYour priority 2 \/ 2"/);
  assert.doesNotMatch(lowCard, /Priority 100|position 2 of 2/);
  assert.doesNotMatch(lowCard, /←|→/);
  assert.equal((html.match(/class="priority-gauge"/g) || []).length, 2);
  assert.doesNotMatch(html, /Pending \(2\)<span class="priority-help"/);
  assert.equal((html.match(/class="priority-help"/g) || []).length, 2);
  assert.match(lowCard, /<span class="priority-help"[^>]*>Priority<\/span><span class="priority-gauge".*?<\/span><\/span><\/span>/s);
  assert.match(html, /data-fast-tooltip="Lower rank numbers are considered sooner,[^"]*resource fit, and backfill can change the start order/);
  assert.doesNotMatch(html, /Global priority ranks|user priority ranks|>ⓘ</);
  assert.match(html, /\.fast-tooltip\{[^}]*white-space:pre-line/);

  const noEstimateHtml = renderJobs({ jobs: [
    { ...low, expected_start_at: null },
    { ...high, expected_start_at: null },
  ] });
  const noEstimateCard = noEstimateHtml.match(/<details class="card"[^>]*data-job-ref="c\/1".*?<\/details>/s)[0];
  const noEstimateSummary = noEstimateCard.match(/<summary.*?<\/summary>/s)[0];
  assert.match(noEstimateSummary, /priority-context priority-prominent/);
  assert.doesNotMatch(noEstimateCard, /no estimate available/);
  assert.equal((noEstimateCard.match(/class="priority-gauge"/g) || []).length, 2);
  assert.match(noEstimateCard, /<\/summary><div class="card-body">.*?<span class="priority-context"><span class="priority-help"/s);
  assert.match(noEstimateHtml, /\.priority-prominent \.priority-track\{height:6px\}/);
  assert.match(noEstimateHtml, /\.card\[open\] \.card-summary-progress>\.priority-prominent\{display:none\}/);
  const expanded = renderJobs({ jobs: [
    { ...low, expected_start_at: null },
    { ...high, expected_start_at: null },
  ] }, { [`card:active:${jobKey(low)}`]: true });
  assert.match(expanded, /data-job-ref="c\/1" open><summary>/);
  assert.match(expanded, /data-job-ref="c\/1" open>.*?<\/summary><div class="card-body">.*?class="priority-context"/s);
});

test('partition launchability uses absolute configurable wait buckets, not priority factors', () => {
  const partition = {
    name: 'gpu', priority_job_factor: 9999, gpus: { total: 64 },
    wait_estimates: [
      { gpus: 1, walltime_seconds: 3600, estimated_wait_seconds: 60 },
      { gpus: 2, walltime_seconds: 3600, estimated_wait_seconds: 600 },
      { gpus: 4, walltime_seconds: 3600, estimated_wait_seconds: 2700 },
      { gpus: 8, walltime_seconds: 3600, estimated_wait_seconds: 5400 },
      { gpus: 16, walltime_seconds: 3600, estimated_wait_seconds: 10800 },
    ],
  };
  const strip = launchabilityStrip(partition, false, 0, [5, 30, 60, 120]);
  for (const index of [0, 1, 2, 3, 4]) assert.match(strip, new RegExp(`launch-wait-${index}`));
  assert.doesNotMatch(strip, /priority|9999/i);
  assert.equal(waitColorIndex(299, [5, 30, 60, 120]), 0);
  assert.equal(waitColorIndex(300, [5, 30, 60, 120]), 1);
  assert.equal(waitColorIndex(7200, [5, 30, 60, 120]), 4);

  const html = renderStatus({ wait_threshold_minutes: [5, 30, 60, 120], clusters: [{ name: 'c', reachable: true, partitions: [partition] }] });
  assert.match(html, /class="launchability"/);
  assert.doesNotMatch(html, /class="priority-context"|partition job factor/);
});

test('webview buttons post allow-listed commands instead of using command URIs', () => {
  assert.equal(
    commandAttributes('clusterWatcher.openLog', ['cluster_0', '1', 'err']),
    'href="#" data-command="clusterWatcher.openLog" data-args="[&quot;cluster_0&quot;,&quot;1&quot;,&quot;err&quot;]"',
  );
  assert.equal(
    commandButtonAttributes('clusterWatcher.openLog', ['cluster_0', '1', 'out']),
    'type="button" data-command="clusterWatcher.openLog" data-args="[&quot;cluster_0&quot;,&quot;1&quot;,&quot;out&quot;]"',
  );
  const html = renderJobs({ jobs: [{ job_id: '1', cluster: 'cluster_0', state: 'RUNNING' }] });
  assert.match(html, /type: 'command', command: button\.dataset\.command/);
  assert.match(html, /const savedViewport = api\.getState\(\) \|\| \{\}/);
  assert.match(html, /visibleJobCards\(\)\.find\(\(card\) => card\.dataset\.jobRef === savedViewport\.anchorRef\)/);
  assert.match(html, /requestAnimationFrame\(\(\) => \{\s+restoreScroll\(\);\s+requestAnimationFrame\(\(\) => \{ restoreScroll\(\); restoringScroll = false; \}\);\s+\}\)/);
  assert.match(html, /const movesJob = \['clusterWatcher\.archiveJob', 'clusterWatcher\.restoreJob'\]\.includes\(button\.dataset\.command\)/);
  assert.match(html, /rememberScroll\(movesJob \? button\.closest\('\[data-job-ref\]'\) : undefined\);\s+let args/);
});

test('offline Cluster Status owns the service control while My Jobs points to it', () => {
  const html = renderWelcome('My Jobs', 'connect ECONNREFUSED <127.0.0.1>');
  assert.match(html, /No service found\. Use Cluster Status to start it\./);
  assert.doesNotMatch(html, /data-command="clusterWatcher\.(?:startService|runSetup|editConfig|openSettings)"/);
  assert.match(html, /ECONNREFUSED &lt;127\.0\.0\.1&gt;/);
  const status = renderWelcome('Cluster Status', '', {}, { service: {
    state: 'offline', recentLines: [{ stream: 'stderr', text: 'offline diagnostic' }],
  } });
  assert.doesNotMatch(status, /Connection details/);
  assert.match(status, /class="service-toggle off"[^>]*data-command="clusterWatcher\.startService"/);
  assert.ok(status.indexOf('class="welcome"') < status.indexOf('class="cluster-config-separator"'));
  assert.ok(status.indexOf('class="cluster-config-separator"') < status.indexOf('class="service-summary"'));
  assert.equal((status.match(/data-command="clusterWatcher\.startService"/g) || []).length, 1);
  assert.match(status, /<hr class="cluster-config-separator"><div class="service-summary">.*?<\/div><div class="cluster-footer-links"><button class="view-sessions" type="button" data-open-sessions>view sessions<\/button><span class="footer-divider" aria-hidden="true">\|<\/span><button class="configure-clusters"/s);
  assert.match(status, /class="configure-clusters"[^>]*data-command="clusterWatcher\.editConfig"/);
  assert.doesNotMatch(status, /Recent backend output|offline diagnostic/);
});

test('every card offers a compact script action for its job', () => {
  const html = renderJobs({ jobs: [{ job_id: '5', cluster: 'cluster_0', state: 'COMPLETED' }] });
  assert.match(html, /<button class="button secondary compact-action" type="button" data-command="clusterWatcher\.openScript" data-args="\[&quot;cluster_0&quot;,&quot;5&quot;\]"[^>]*>script<\/button>/);
});

test('pending jobs hide log actions until a refreshed archived snapshot leaves pending', () => {
  const pending = { job_id: '7', name: 'pending', cluster: 'cluster_0', state: 'PENDING', submit_at: '2026-10-01T10:00:00Z' };
  const completedArchive = { ...pending, name: 'archived-completed', state: 'COMPLETED', end_at: '2026-10-01T10:05:00Z' };
  const html = renderJobs({ jobs: [pending], archived_jobs: [completedArchive] });
  const card = name => html.match(new RegExp(`<summary><span class="card-summary-title" data-full-name="cluster_0 7 ${name}">.*?</details>`, 's'))[0];

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
  assert.equal(progressView(progressSpec({ state: 'PENDING' }, asOf), asOf).label, 'no estimate available');

  const html = renderJobs({ generated_at: '2026-10-06T10:00:00Z', jobs: [{ job_id: '1', cluster: 'c', state: 'RUNNING', elapsed_seconds: 1 }] });
  assert.match(html, /<span class="job-progress" data-progress="\{&quot;group&quot;:&quot;RUNNING&quot;/);
  assert.match(html, /function progressView\(spec, now\)/);
  assert.match(html, /setInterval\(tick, 5000\)/);
  assert.doesNotMatch(html, /<div class="meta"/);
  assert.match(html, /event\.data\?\.type === 'checked'/);
});

test('pending jobs without an estimate explain why and omit the empty bar', () => {
  const dependencyHtml = renderJobs({ jobs: [{
    job_id: '1', cluster: 'c', state: 'PENDING', dependency: 'afterok:123(unfulfilled)',
  }] });
  const dependencySummary = dependencyHtml.match(/<summary><span class="card-summary-title" data-full-name="c 1 1">.*?<\/summary>/s)[0];
  assert.match(dependencySummary, /dependency:afterok <a class="dep-link" href="#" data-jump="c\/123"[^>]*>123<\/a>/);
  assert.doesNotMatch(dependencySummary, /dependency-icon/);
  assert.match(dependencyHtml, /event\.preventDefault\(\);\s+event\.stopPropagation\(\);\s+const target = link\.dataset\.jump/);
  assert.doesNotMatch(dependencySummary, /class="progress"/);

  const unavailableHtml = renderJobs({ jobs: [{ job_id: '2', cluster: 'c', state: 'PENDING' }] });
  const unavailableSummary = unavailableHtml.match(/<summary><span class="card-summary-title" data-full-name="c 2 2">.*?<\/summary>/s)[0];
  assert.match(unavailableSummary, /no estimate available/);
  assert.doesNotMatch(unavailableSummary, /class="progress"/);
  assert.match(unavailableHtml, /\.progress-message\{[^}]*overflow-wrap:anywhere/);
});

test('launchability blocks carry exact hover estimates and count down locally', () => {
  const partition = {
    name: 'gpu', gpus: { total: 8, schedulable_idle: 0, models: [] },
    wait_estimates: [
      { gpus: 1, walltime_seconds: 3600, estimated_wait_seconds: 900, expected_start_at: '2026-10-06T10:15:00Z', error: null },
      { gpus: 2, walltime_seconds: 3600, estimated_wait_seconds: null, error: 'Access denied', error_kind: 'denied' },
    ],
  };
  const html = renderStatus({ generated_at: '2026-10-06T10:00:00Z', wait_threshold_minutes: [5, 30, 60, 120], clusters: [{ name: 'c', reachable: true, partitions: [partition] }] });
  assert.match(html, /data-fast-tooltip="1 GPU · 1h job: 15m estimated wait" data-launch-wait="\[900,1791280800000,&quot;1 GPU · 1h job&quot;,\[5,30,60,120\]\]"/);
  assert.match(html, /class="launch-block launch-blocked"[^>]*data-fast-tooltip="2 GPUs · 1h job: Access denied"[^>]*>×<\/span>/);
  assert.match(html, /querySelectorAll\('\[data-launch-wait\]'\)/);
  assert.match(html, /waitColorIndex\(remaining, thresholds\)/);
  assert.match(html, /target\.dataset\.fastTooltip = label \+ ': ' \+ formatDuration\(remaining\) \+ ' estimated wait'/);
  assert.doesNotMatch(html, /expected start 2026-10-06T10:15:00Z/);
});

test('launchability selects the one-hour probe and preserves capped runtimes', () => {
  const normal = { gpus: { total: 2 }, wait_estimates: [
    { gpus: 1, walltime_seconds: 43200, estimated_wait_seconds: 100 },
    { gpus: 1, walltime_seconds: 3600, estimated_wait_seconds: 200 },
  ] };
  assert.equal(waitEstimate(normal, 1).estimated_wait_seconds, 200);
  const development = { gpus: { total: 1 }, wait_estimates: [
    { gpus: 1, walltime_seconds: 900, estimated_wait_seconds: 60 },
  ] };
  assert.match(launchabilityStrip(development), /1 GPU · 15m job/);
  assert.equal(launchabilityStrip({ gpus: { total: 0 } }), '');
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

  assert.match(html, /\.card-meta\{min-width:0;white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(html, /\.times dd\.dependency-value\{overflow-wrap:anywhere\}/);
  assert.match(html, /<div class="muted card-meta"><span class="meta-field meta-cluster"><button class="job-cluster-link"[^>]*>cluster-with-a-very-long-name<\/button><\/span><span class="meta-field meta-partition" data-separator="\/">(?:<button class="job-partition-link"[^>]*>partition-with-a-very-long-name<\/button>)/);
  assert.match(html, /<dd class="dependency-value">/);
});

test('resource labels stay intact and separators follow visual line breaks', () => {
  const sameRow = { top: 10, bottom: 22, left: 40 };
  assert.equal(metadataSameLine(sameRow, { top: 10, left: 95 }), true);
  assert.equal(metadataSameLine(sameRow, { top: 24, left: 10 }), false);
  assert.equal(metadataSameLine(sameRow, { top: 10, left: 40 }), false);

  const html = renderJobs({ jobs: [{
    job_id: '9', cluster: 'viper', partition: 'apu', state: 'RUNNING',
    gpus: 4, accelerator_type: 'apu', cpus: 48,
  }] });
  const meta = html.match(/<div class="muted card-meta">.*?<\/div>/s)[0];
  assert.match(meta, /class="meta-field meta-accelerators" data-separator="·"><span class="job-gpu-count"[^>]*>4 APU<\/span><\/span>/);
  assert.match(meta, /class="meta-field meta-cpus" data-separator="·">48 CPU<\/span>/);
  assert.match(html, /\.meta-nodes,\.meta-accelerators,\.meta-cpus,\.job-gpu-count\{white-space:nowrap\}/);
  assert.match(html, /\.meta-field\.same-line::before\{content:attr\(data-separator\);position:absolute;left:-8px\}/);
  assert.match(html, /new ResizeObserver\(\(entries\) => entries\.forEach\(\(entry\) => updateMetadataSeparators\(entry\.target\)\)\)/);
  assert.match(html, /if \(meta && details\.open\) requestAnimationFrame\(\(\) => updateMetadataSeparators\(meta\)\)/);
});

test('expanded card moves the running deadline down and keeps details and actions compact', () => {
  const html = renderJobs({
    generated_at: '2026-09-30T15:02:00Z',
    jobs: [{
      job_id: '1', cluster: 'cluster_0', state: 'RUNNING', elapsed_seconds: 60, time_limit_seconds: 3600,
      submit_at: '2026-09-30T15:00:00Z', start_at: '2026-09-30T15:01:00Z',
    }],
  });
  assert.match(html, /<div class="time-row"><dt>Limit<\/dt><dd>[^<]+<\/dd><\/div>/);
  assert.doesNotMatch(html, /<dt>Elapsed<\/dt>/);
  assert.doesNotMatch(html, /<dt>Ended<\/dt>/);
  assert.match(html, /<span class="muted progress-label" title="[^"]+ \/ 1h">[^<]+ \/ 1h<\/span>/);
  assert.match(html, /\.times dt\{color:var\(--vscode-descriptionForeground\);white-space:nowrap\}/);
  assert.match(html, /\.times dd\{margin:0;min-width:0;white-space:normal;text-align:right\}/);
  assert.match(html, /\.actions\{display:flex;flex-wrap:nowrap;/);
  assert.match(html, /title="Archive job" aria-label="Archive job"><svg class="action-icon"/);
  assert.match(html, /title="Open \.err log" aria-label="Open \.err log">\.err<\/button>/);
  assert.match(html, /title="Open \.out log" aria-label="Open \.out log">\.out<\/button>/);
  assert.match(html, /title="Open the Slurm batch script this job ran" aria-label="Open batch script">script<\/button>/);
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
  const cardSummary = html.match(/<summary><span class="card-summary-title" data-full-name="cluster_0 3 finished">.*?<\/summary>/s)[0];
  assert.match(cardSummary, /<span class="muted progress-label" title="10m \/ 1h">10m \/ 1h<\/span>/);
  assert.doesNotMatch(cardSummary, />[^<]*(?:elapsed|ended)[^<]*</i);
  assert.doesNotMatch(html, /<dt>Elapsed<\/dt>/);
  assert.match(html, /<div class="time-row"><dt>Ended<\/dt><dd>[^<]+<\/dd><\/div>/);
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
  const card = name => html.match(new RegExp(`<summary><span class="card-summary-title" data-full-name="c ${identifiers[name]} ${name}">.*?</details>`, 's'))[0];

  assert.doesNotMatch(card('running-job'), /<dt>Ended<\/dt>/);
  assert.doesNotMatch(card('pending-job'), /<dt>(?:Launched|Ended):<\/dt>/);
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

test('Cluster Status freshness precedes its links while My Jobs freshness stays last', () => {
  const updated = new Date(2026, 9, 8, 14, 5, 23).toISOString();
  assert.equal(viewFreshness(updated), 'Last update: 08.10.2026 14:05:23');
  assert.equal(viewFreshness(undefined), '');

  const html = renderStatus(
    { clusters: [] }, {}, { updatedAt: updated },
  );
  assert.match(html, /<p class="view-freshness">Last update: 08\.10\.2026 14:05:23<\/p>/);
  assert.ok(html.indexOf('<p class="view-freshness">') < html.indexOf('view sessions</button>'));
  assert.ok(html.indexOf('view sessions</button>') < html.indexOf('configure clusters</button>'));
  assert.equal((html.match(/Last update:/g) || []).length, 1);
  const loading = renderLoading('Cluster Status', { updatedAt: updated });
  const offline = renderWelcome('Cluster Status', '', { updatedAt: updated });
  for (const view of [loading, offline]) {
    assert.ok(view.indexOf('<p class="view-freshness">') < view.indexOf('view sessions</button>'));
    assert.equal((view.match(/Last update:/g) || []).length, 1);
  }
  const jobsHtml = renderJobs({ jobs: [] }, {}, new Set(), { updatedAt: updated });
  assert.ok(jobsHtml.indexOf('Archive (0)') < jobsHtml.indexOf('<p class="view-freshness">'));
  assert.match(jobsHtml, /<\/details><p class="view-freshness">Last update: 08\.10\.2026 14:05:23<\/p><script/);
  assert.doesNotMatch(html, /Last checked|data-last-checked/);
  assert.match(html, /\.view-freshness\{margin:8px 0 0\}/);
});

test('a closed SSH session offers its login button in the cluster summary', () => {
  const html = renderStatus({ clusters: [
    { name: 'cluster_0', reachable: false, error: 'Permission denied (gssapi-with-mic,password).', login_required: true },
    { name: 'cluster_1', reachable: false, error: 'Connection timed out', login_required: false },
  ] });
  assert.match(html, /data-command="clusterWatcher\.login" data-args="\[&quot;cluster_0&quot;,false\]">Log in<\/button>/);
  assert.equal((html.match(/>Log in<\/button>/g) || []).length, 1);
  assert.doesNotMatch(html, /Log in again|The SSH session has closed/);
});

test('a timed-out cluster keeps its job bar and partition cards with a warning hover', () => {
  const updated = new Date(2026, 9, 8, 14, 5, 23).toISOString();
  const html = renderStatus({ clusters: [{
    name: 'inf', reachable: false, error: 'alice@login.example: SSH timed out after 35 seconds',
    last_success_at: updated,
    user_jobs: { running: 2, pending: 1 },
    partitions: [{ name: 'gpu-h100', gpus: { total: 4 } }],
  }] });
  assert.match(html, /class="cluster-job-running"/);
  assert.match(html, /class="cluster-job-pending"/);
  assert.match(html, /class="cluster-warning fast-hover"[^>]*data-fast-tooltip="Cluster refresh timed out\.\nLatest update: 14:05:23 08\.10\.2026"/);
  assert.doesNotMatch(html, /35 seconds/);
  assert.match(html, /class="card partition-card/);
  assert.doesNotMatch(html, /<p class="error">/);
  assert.doesNotMatch(html, /alice@login\.example/);
});

test('an unfinished cluster shows a loading placeholder beside completed clusters', () => {
  const html = renderStatus({ clusters: [
    { name: 'fast', reachable: true, partitions: [{ name: 'gpu', gpus: { total: 1 } }] },
    { name: 'slow', reachable: true, collecting: true, partitions: [] },
  ] });
  assert.match(html, /gpu/);
  assert.match(html, /cluster-collecting">Loading…<\/span>/);
  assert.match(html, /Collecting cluster data…/);
});

test('a first-refresh failure does not present invented zero job counts', () => {
  const html = renderStatus({ clusters: [{
    name: 'slow', reachable: false, error: 'SSH timed out', partitions: [],
    user_jobs: { running: 0, pending: 0 },
  }] });
  assert.match(html, /cluster-collecting">Unavailable<\/span>/);
  assert.match(html, /Latest update: Unavailable/);
  assert.doesNotMatch(html, /<span class="cluster-job-track"/);
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
  assert.match(html, /data-fast-tooltip="2 GPUs · 1h job: More than 4 gpus per node were requested"/);
  assert.match(html, /class="launch-block launch-blocked"[^>]*>×<\/span>/);
});

test('wait cells show … until the first probe round finishes', () => {
  const partition = { name: 'gpu', gpus: { total: 8 }, wait_estimates: [] };
  assert.equal(waitCell(partition, 4, true), '…');
  assert.equal(waitCell(partition, 16, true), '—');
  const html = renderStatus({ clusters: [{ name: 'cluster_0', reachable: true, partitions: [partition] }] });
  assert.match(html, /data-fast-tooltip="1 GPU · 1h job: still checking"/);
  assert.match(html, /class="launch-block launch-pending"[^>]*>…<\/span>/);
  const done = renderStatus({ clusters: [{ name: 'cluster_0', reachable: true, wait_estimates_updated_at: '2026-10-06T16:00:00Z', partitions: [partition] }] });
  assert.match(done, /data-fast-tooltip="1 GPU · 1h job: not probed"/);
  assert.match(done, /data-fast-tooltip="16 GPUs · 1h job: exceeds the partition&#39;s 8 GPUs"/);
});

test('session dialog scrolls only its outer container', () => {
  const html = renderStatus({ clusters: [] });
  assert.match(html, /\.sessions-dialog\{[^}]*max-height:calc\(100vh - 8px\);overflow:auto/);
  const textStyles = html.match(/\.sessions-dialog-text\{([^}]*)\}/)[1];
  assert.doesNotMatch(textStyles, /(?:^|;)overflow:|max-height:/);
  assert.match(textStyles, /white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.match(html, /querySelector\('\[data-close-sessions\]'\).*sessionsDialog\.close\(\)/);
});

test('cluster spacing is compact and the sessions popup stays wide and fits its content', () => {
  const html = renderStatus({ clusters: [] });
  assert.match(html, /\.cluster-group\{margin:4px 0\}/);
  assert.match(html, /\.cluster-group>summary\{margin-bottom:3px/);
  assert.match(html, /\.sessions-dialog\{[^}]*width:calc\(100vw - 16px\);max-width:none;inset:50% auto auto 50%;transform:translate\(-50%,-50%\);margin:0;height:fit-content/);
  assert.match(html, /\.sessions-dialog\{[^}]*padding:4px 8px/);
  assert.match(html, /\.sessions-dialog-close\{padding:0 2px/);
});

test('session popup keeps update text color and hides background scrolling only while open', () => {
  const html = renderStatus({ clusters: [] });
  const freshness = html.match(/\.view-freshness\{([^}]*)\}/)[1];
  const dialog = html.match(/\.sessions-dialog\{([^}]*)\}/)[1];
  for (const property of ['color']) {
    const value = new RegExp(`(?:^|;)${property}:([^;}]*)`);
    assert.equal(dialog.match(value)[1], freshness.match(value)[1]);
  }
  assert.match(dialog, /border-left:6px solid #000;border-right:6px solid #000/);
  assert.match(html, /html:has\(\.sessions-dialog\[open\]\)\{overflow:hidden\}/);
  assert.match(html, /\.sessions-dialog-text\{[^}]*font:inherit;line-height/);
});

test('sidebar content cards have square corners and session text and close control are larger', () => {
  const html = renderStatus({ clusters: [] });
  assert.match(html, /\.card\{[^}]*border-radius:0;/);
  const dialog = html.match(/\.sessions-dialog\{([^}]*)\}/)[1];
  const freshness = html.match(/\.view-freshness\{([^}]*)\}/)[1];
  assert.equal(dialog.match(/font-size:([^;}]*)/)[1], '.82em');
  assert.ok(parseFloat(dialog.match(/font-size:([^;}]*)/)[1])
    > parseFloat(freshness.match(/font-size:([^;}]*)/)[1]));
  assert.match(html, /\.sessions-dialog-close\{[^}]*font-size:1\.6em;/);
});

test('long session addresses fill the heading line before wrapping within the account', () => {
  const html = renderStatus({ clusters: [] }, {}, {}, { sessions: { machines: [{
    name: 'cluster_a', username: 'alice', host: 'login12.research.example.org',
    session_open: true, control_persist_seconds: 7200, estimated_remaining_seconds: 3900,
  }] } });
  assert.match(html, /cluster_a: alice@login12\.research\.example\.org\n🕒 01:05 left/);
  assert.match(html, /\.sessions-dialog-text\{[^}]*word-break:break-all;/);
});

test('session popup separates each entry and fits its content with minimal bottom spacing', () => {
  const html = renderStatus({ clusters: [] }, {}, {}, { sessions: { machines: [
    { name: 'cluster_a', username: 'alice', host: 'login1.example.org' },
    { name: 'cluster_b', username: 'bob', host: 'login2.example.org' },
  ] } });
  const popup = html.match(/<dialog class="sessions-dialog"[^>]*>(.*?)<\/dialog>/s)[1];
  assert.equal((popup.match(/class="sessions-dialog-text"/g) || []).length, 2);
  assert.match(popup, /<\/h2><\/div><pre class="sessions-dialog-text"/);
  assert.match(popup, /cluster_a: alice@login1\.example\.org\nclosed<\/pre><pre[^>]*>cluster_b: bob@login2\.example\.org/);
  assert.match(html, /\.sessions-dialog-text\{[^}]*border-top:1px solid color-mix/);
  assert.match(html, /\.sessions-dialog-text:last-of-type\{padding-bottom:0\}/);
  assert.match(html, /\.sessions-dialog\{[^}]*height:fit-content;min-height:0;max-height:calc\(100vh - 8px\)/);
});

test('each fair-share marker has only its own account and rank tooltip', () => {
  const html = renderStatus({ clusters: [{ name: 'cluster_a', reachable: true, partitions: [{
    name: 'gpu', gpus: { total: 0 }, fair_share: [
      { account: 'account_a', factor: 0.8, rank: 2, total: 10 },
      { account: 'account_b', factor: 0.3, rank: 7, total: 10 },
    ],
  }] }] });
  const tooltips = [...html.matchAll(/class="fair-share-marker"[^>]*data-fast-tooltip="([^"]*)"/g)]
    .map((match) => match[1]);
  assert.ok(tooltips.every((text) => !/Account:|Visible rank:|&#10;/.test(text)));
  assert.deepEqual(tooltips, ['account_a: 2/10',
    'account_b: 7/10']);
  for (const track of html.matchAll(/<div class="fair-share-track[^>]*>/g)) {
    assert.doesNotMatch(track[0], /data-fast-tooltip=|title=/);
  }
  assert.match(html, /\.fair-share-marker:hover\{outline:1px solid var\(--vscode-focusBorder\)\}/);
  assert.doesNotMatch(html, /Startup dry run|Matched by:/);
});

test('fair-share marker tooltips escape account names and cover single and missing associations', () => {
  const html = renderStatus({ clusters: [{ name: 'cluster_a', reachable: true, partitions: [{
    name: 'gpu', gpus: { total: 0 }, fair_share: [
      { account: '<project>"', factor: 0.5, rank: 1, total: 2 },
    ],
  }, { name: 'cpu', gpus: { total: 0 }, fair_share: [] }] }] });
  assert.match(html, /data-fast-tooltip="&lt;project&gt;&quot;: 1\/2"/);
  assert.equal((html.match(/class="fair-share-marker"/g) || []).length, 1);
  for (const track of html.matchAll(/<div class="fair-share-track[^>]*>/g)) {
    assert.doesNotMatch(track[0], /data-fast-tooltip=|title=/);
  }
});

test('account hover boxes fit their text and constrain long names to the visible sidebar', () => {
  const html = renderStatus({ clusters: [] });
  const styles = html.match(/\.fast-tooltip\{([^}]*)\}/)[1];
  assert.match(styles, /box-sizing:border-box;width:max-content/);
  assert.match(styles, /max-width:min\(220px,calc\(100vw - 8px\)\)/);
  assert.match(styles, /overflow-wrap:anywhere/);
  assert.match(html, /const viewportWidth = document\.documentElement\.clientWidth/);
  assert.match(html, /fastTooltip\.style\.maxWidth = Math\.max\(0, Math\.min\(220, viewportWidth - 8\)\)/);
  assert.match(html, /viewportWidth - tooltipBounds\.width - 4/);
  assert.match(html, /addEventListener\('resize', hideFastTooltip\)/);
});

test('SSH Sessions popup title capitalizes Sessions', () => {
  const html = renderStatus({ clusters: [] });
  assert.match(html, /<h2 id="sessions-dialog-title">SSH Sessions<\/h2>/);
});
