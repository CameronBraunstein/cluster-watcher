'use strict';

const crypto = require('node:crypto');

const WAIT_GPU_COUNTS = [1, 2, 4, 8, 16, 32, 64];
const FAILURE_STATES = new Set(['BOOT_FAIL', 'DEADLINE', 'FAILED', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'REVOKED', 'SPECIAL_EXIT', 'TIMEOUT']);

/** Escape untrusted API text before inserting it into a webview document. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

/** Format a non-negative duration compactly. */
function formatDuration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '?';
  let seconds = Math.max(0, Math.floor(Number(value)));
  if (seconds === 0) return 'now';
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return `${days}d${hours ? ` ${hours}h` : ''}`;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  if (minutes) return `${minutes}m`;
  return '<1m';
}

/** Convert an ISO timestamp to the VS Code host's local display timezone. */
function localTime(value) {
  if (!value) return 'Unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unavailable' : parsed.toLocaleString();
}

/** Map detailed Slurm states onto the terminal board's groups. */
function stateGroup(value) {
  const state = String(value || 'UNKNOWN').toUpperCase();
  if (state === 'RUNNING') return 'RUNNING';
  if (['PENDING', 'CONFIGURING', 'REQUEUED', 'REQUEUE_FED', 'REQUEUE_HOLD', 'RESIZING', 'SIGNALING', 'STAGE_OUT', 'SUSPENDED'].includes(state)) return 'PENDING';
  if (state === 'COMPLETED') return 'COMPLETED';
  if (FAILURE_STATES.has(state)) return 'FAILED';
  if (state === 'CANCELLED') return 'CANCELLED';
  return 'OTHER';
}

/** Return a state-aware lifecycle timestamp. */
function lifecycle(job, event) {
  const group = stateGroup(job.state);
  const applicable = event === 'launched' ? ['RUNNING', 'COMPLETED', 'FAILED'].includes(group) : ['COMPLETED', 'FAILED'].includes(group);
  if (!applicable) return '—';
  return localTime(event === 'launched' ? job.start_at || job.start_time : job.end_at);
}

/** Return the persistent identity shared by archive and command actions. */
function jobKey(job) {
  const submitted = job.submit_at || job.submit_time || '';
  const parsed = new Date(submitted);
  const canonicalTime = submitted && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : String(submitted);
  return JSON.stringify([String(job.cluster || ''), String(job.job_id || job.id || ''), canonicalTime]);
}

/**
 * Build the attributes of a webview button that asks the extension to run
 * ``command``. The webview has no command-URI access: its script posts the
 * request and the extension runs only allow-listed commands.
 */
function commandAttributes(command, args = []) {
  return `href="#" data-command="${escapeHtml(command)}" data-args="${escapeHtml(JSON.stringify(args))}"`;
}

/** Render state-appropriate elapsed/wait progress. */
function jobProgress(job) {
  const group = stateGroup(job.state);
  const elapsed = Math.max(0, Number(job.elapsed_seconds) || 0);
  if (group === 'RUNNING') {
    const limit = Math.max(0, Number(job.time_limit_seconds) || 0);
    const percent = limit ? Math.min(100, elapsed / limit * 100) : 0;
    const started = new Date(job.start_at || job.start_time).getTime();
    const limitAt = limit && Number.isFinite(started) ? localTime(new Date(started + limit * 1000).toISOString()) : null;
    const label = limit ? `${formatDuration(elapsed)} / ${formatDuration(limit)}${limitAt ? ` · limit ${limitAt}` : ''}` : `${formatDuration(elapsed)} elapsed`;
    return `<span class="progress"><span class="progress-fill running" style="width:${percent}%"></span></span><span class="muted">${escapeHtml(label)}</span>`;
  }
  if (group === 'PENDING') {
    const submitted = new Date(job.submit_at || job.submit_time).getTime();
    const expected = new Date(job.expected_start_at || job.start_at || job.start_time).getTime();
    const now = Date.now();
    const total = expected - submitted;
    const percent = Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, (now - submitted) / total * 100)) : 0;
    const remaining = Number.isFinite(expected) ? Math.max(0, (expected - now) / 1000) : null;
    const reason = String(job.reason || '');
    const label = remaining == null
      ? (/^dependency:/i.test(reason) ? `waiting for ${reason}` : 'wait estimate unavailable')
      : `${formatDuration(remaining)} until estimated start`;
    return `<span class="progress"><span class="progress-fill pending" style="width:${percent}%"></span></span><span class="muted">${escapeHtml(label)}</span>`;
  }
  const ended = lifecycle(job, 'ended');
  const label = ended !== '—' && ended !== 'Unavailable' ? `${formatDuration(elapsed)} elapsed · ended ${ended}` : `${formatDuration(elapsed)} elapsed`;
  return `<span class="progress"><span class="progress-fill ${group.toLowerCase()}" style="width:100%"></span></span><span class="muted">${escapeHtml(label)}</span>`;
}

/** Wrap sidebar content in a self-contained webview document. */
function document(title, body, updatedAt) {
  const updated = updatedAt ? `Updated ${localTime(updatedAt)}` : '';
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{padding:0 10px 18px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}.meta,.muted{color:var(--vscode-descriptionForeground);font-size:.82em}.meta{margin:5px 0 9px}.job-group,.cluster-group{margin:9px 0}.job-group>summary,.cluster-group>summary{cursor:pointer;font-weight:600;font-size:1em;text-transform:none}.cluster-group>summary{font-size:1.2rem;margin-bottom:7px}.card{border:1px solid var(--vscode-panel-border);border-radius:5px;margin:6px 0;background:var(--vscode-sideBar-background)}.card>summary{padding:8px;cursor:pointer}.card-summary-title{display:flex;justify-content:space-between;gap:8px}.card-summary-progress{display:block}.card-body{padding:0 8px 8px}.row{display:flex;justify-content:space-between;gap:8px}.name{font-weight:600;overflow-wrap:anywhere;flex:1 1 auto;min-width:0}.badge{font-size:.72em;padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.job-id{flex:0 0 auto;box-sizing:content-box;width:12ch;align-self:flex-start;text-align:center;font-family:var(--vscode-editor-font-family);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:copy}.job-id:hover{outline:1px solid var(--vscode-focusBorder)}.job-id.copied{background:var(--vscode-testing-iconPassed)}.job-id.ending{background:var(--vscode-editorError-foreground)}.dep-link{color:var(--vscode-textLink-foreground);text-decoration:none;font-family:var(--vscode-editor-font-family)}.dep-link:hover{text-decoration:underline}.card.flash{outline:2px solid var(--vscode-focusBorder)}.button.danger{background:var(--vscode-inputValidation-errorBackground,var(--vscode-editorError-foreground));color:var(--vscode-button-foreground)}.progress,.availability{height:6px;border-radius:4px;overflow:hidden;margin:6px 0 3px}.progress{display:block;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}.progress-fill,.available,.unavailable{display:block;height:100%}.running{background:var(--vscode-progressBar-background)}.pending,.failed,.unavailable{background:var(--vscode-editorError-foreground)}.completed{background:var(--vscode-testing-iconPassed)}.cancelled,.other{background:var(--vscode-descriptionForeground)}.availability{display:flex}.available{background:var(--vscode-testing-iconPassed)}.times{display:grid;grid-template-columns:auto 1fr;gap:2px 6px;margin-top:6px;font-size:.8em}.times dt{color:var(--vscode-descriptionForeground)}.times dd{margin:0;text-align:right}.actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.78em}th,td{text-align:left;padding:3px 5px;border-bottom:1px solid var(--vscode-panel-border);white-space:nowrap}th{color:var(--vscode-descriptionForeground)}.button{display:inline-block;padding:4px 7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);text-decoration:none;border-radius:2px}.button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.aggregate{opacity:.78}.welcome p{margin:8px 0}.command-line{white-space:pre-wrap;overflow-wrap:anywhere;padding:6px;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:.85em}.welcome-detail{margin-top:12px}.welcome-detail>summary{cursor:pointer}
</style></head><body><div class="meta">${escapeHtml(updated)}</div>${body}<script nonce="${nonce}">
(() => {
  const api = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    event.preventDefault();
    let args = [];
    try { args = JSON.parse(button.dataset.args || '[]'); } catch (_error) { args = []; }
    api.postMessage({ type: 'command', command: button.dataset.command, args });
  });
  const remember = (details) => api.postMessage({ type: 'disclosure', key: details.dataset.disclosureKey, open: details.open });
  document.querySelectorAll('details[data-disclosure-key]').forEach((details) => {
    details.addEventListener('toggle', () => remember(details));
  });
  // Copy a job ID without toggling the card that contains its badge.
  const copy = (event, badge) => {
    event.preventDefault();
    event.stopPropagation();
    api.postMessage({ type: 'copy', text: badge.dataset.copy });
    badge.classList.add('copied');
    setTimeout(() => badge.classList.remove('copied'), 900);
  };
  document.querySelectorAll('[data-copy]').forEach((badge) => {
    badge.addEventListener('click', (event) => copy(event, badge));
    badge.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') copy(event, badge); });
  });
  // Reveal the card a dependency link points at, opening every enclosing group.
  document.querySelectorAll('[data-jump]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = link.dataset.jump;
      const cards = [...document.querySelectorAll('details.card[data-job-ref]')];
      const card = cards.find((candidate) => candidate.dataset.jobRef === target)
        || cards.find((candidate) => candidate.dataset.jobRef.startsWith(target + '_'));
      if (!card) {
        api.postMessage({ type: 'missingJob', ref: target });
        return;
      }
      for (let node = card; node; node = node.parentElement?.closest('details')) {
        if (!node.open) { node.open = true; remember(node); }
      }
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1500);
    });
  });
})();
</script></body></html>`;
}

/**
 * Return the `open` attribute for a disclosure, preferring the user's remembered
 * choice (keyed by `data-disclosure-key`) over the renderer's default.
 */
function openAttribute(disclosures, key, defaultOpen) {
  const remembered = disclosures && Object.prototype.hasOwnProperty.call(disclosures, key) ? disclosures[key] : defaultOpen;
  return remembered ? ' open' : '';
}

/** Render an informational or connection-error view. */
function renderMessage(title, message, action = '') {
  return document(title, `<p class="error">${escapeHtml(message)}</p>${action}`, null);
}

/**
 * Render the view shown when the service is reachable but was started without
 * ``--jobs-api``: why My Jobs is empty, and the command that fixes it.
 */
function renderJobsApiDisabled(title, command) {
  const body = `<div class="welcome"><p>The Cluster Watcher service is running, but it was started without <code>--jobs-api</code>, so your jobs cannot be shown. Cluster Status still works.</p>`
    + `<p>Stop that service (Ctrl-C in its terminal), then start it with:</p><pre class="command-line">${escapeHtml(command)}</pre>`
    + `<p class="actions"><a class="button" role="button" ${commandAttributes('clusterWatcher.copyServiceCommand')}>Copy restart command</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.refresh')}>Retry</a></p>`
    + `<p class="muted">Or close it and use <b>Start service &amp; SSH sessions</b>, which always enables the jobs API.</p></div>`;
  return document(title, body, null);
}

/**
 * Render the first-run/offline view shown when the service cannot be reached:
 * guidance plus buttons to start the service, create or edit the
 * configuration, and open the extension settings. ``detail`` is the
 * connection error, kept in a collapsed section.
 */
function renderWelcome(title, detail) {
  const body = `<div class="welcome"><p>The Cluster Watcher service is not reachable. Start it to see your jobs and cluster capacity; password and OTP prompts appear in its terminal.</p>`
    + `<p class="actions"><a class="button" role="button" ${commandAttributes('clusterWatcher.startService')}>Start service &amp; SSH sessions</a></p>`
    + `<p class="muted">First time? Describe your clusters with the setup wizard, or edit an existing configuration.</p>`
    + `<p class="actions"><a class="button secondary" role="button" ${commandAttributes('clusterWatcher.runSetup')}>Run setup wizard</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.editConfig')}>Edit configuration</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.openSettings')}>Settings</a></p>`
    + `<details class="welcome-detail"><summary class="muted">Connection details</summary><p class="error">${escapeHtml(detail)}</p></details></div>`;
  return document(title, body, null);
}

/**
 * Parse Slurm's dependency expression (``squeue %E``), for example
 * ``afterok:12(unfulfilled),afterany:13_4+5(failed)``, into clauses of
 * ``{ type, ids, status }``. Clauses without job IDs (``singleton``) keep
 * an empty ``ids`` list; unparseable text yields an empty array.
 */
function parseDependency(value) {
  const text = String(value ?? '').trim();
  if (!text || ['(null)', 'NULL', 'None', 'N/A'].includes(text)) return [];
  return text.split(/[,?]/).map((clause) => clause.trim()).filter(Boolean).map((clause) => {
    const match = /^([A-Za-z_]+)(?::([^()]*))?(?:\(([^)]*)\))?$/.exec(clause);
    if (!match) return null;
    const ids = (match[2] || '').split(':')
      .map((part) => part.replace(/\+\d+$/, ''))
      .filter((part) => /^\d+(?:_(?:\d+|\*))?$/.test(part))
      .map((part) => part.replace(/_\*$/, ''));
    return { type: match[1], ids, status: match[3] || '' };
  }).filter(Boolean);
}

/** Render dependency clauses with links that jump to the referenced cards. */
function dependencyLinks(job) {
  const clauses = parseDependency(job.dependency);
  if (!clauses.length) return '';
  const rendered = clauses.map((clause) => {
    const links = clause.ids.map((id) => `<a class="dep-link" href="#" data-jump="${escapeHtml(`${job.cluster}/${id}`)}" title="Show job ${escapeHtml(id)}">${escapeHtml(id)}</a>`).join(', ');
    return `${escapeHtml(clause.type)}${links ? ` ${links}` : ''}${clause.status ? ` <span class="muted">(${escapeHtml(clause.status)})</span>` : ''}`;
  }).join('<br>');
  return `<dt>Depends on</dt><dd>${rendered}</dd>`;
}

/** Return the ``cluster/job_id`` reference used for cancellation and dependency links. */
function jobRef(job) {
  return `${job.cluster}/${job.job_id || job.id || ''}`;
}

/**
 * Render one collapsible job card with archive, log, and (for active jobs)
 * End Job actions. ``cancelling`` holds job refs whose cancellation was sent.
 */
function jobCard(job, archived, disclosures, cancelling = new Set()) {
  const identifier = String(job.job_id || job.id || 'unknown');
  const nodes = Number(job.node_count) || (job.nodes || []).length;
  const resources = `${nodes} node · ${Number(job.gpus) || 0} GPU · ${Number(job.cpus) || 0} CPU`;
  const archiveCommand = archived ? 'clusterWatcher.restoreJob' : 'clusterWatcher.archiveJob';
  const archiveLabel = archived ? 'Restore' : 'Archive';
  const key = jobKey(job);
  const actions = [
    `<a class="button" role="button" ${commandAttributes(archiveCommand, [key])}>${archiveLabel}</a>`,
    `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.openLog', [job.cluster, identifier, 'err'])}>Open .err</a>`,
    `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.openLog', [job.cluster, identifier, 'out'])}>Open .out</a>`,
    `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.openScript', [job.cluster, identifier])} title="Open the Slurm batch script this job ran">Open script</a>`,
  ];
  const ending = cancelling.has(jobRef(job));
  if (['RUNNING', 'PENDING'].includes(stateGroup(job.state)) && !ending) {
    actions.push(`<a class="button danger" role="button" ${commandAttributes('clusterWatcher.cancelJob', [job.cluster, identifier, job.name || identifier])}>End Job</a>`);
  }
  const disclosureKey = `card:${archived ? 'archive' : 'active'}:${key}`;
  return `<details class="card" data-disclosure-key="${escapeHtml(disclosureKey)}" data-job-ref="${escapeHtml(jobRef(job))}"${openAttribute(disclosures, disclosureKey, false)}><summary><span class="card-summary-title"><span class="name">${escapeHtml(job.name || identifier)}</span><span class="badge job-id${ending ? ' ending' : ''}" role="button" tabindex="0" data-copy="${escapeHtml(identifier)}" title="${escapeHtml(identifier)}${ending ? ' · ending' : ''} — click to copy">${escapeHtml(identifier)}</span></span><span class="card-summary-progress">${jobProgress(job)}</span></summary><div class="card-body"><div class="muted">${escapeHtml(job.cluster)} / ${escapeHtml(job.partition || 'no partition')} · ${escapeHtml(resources)}</div><dl class="times"><dt>Submitted</dt><dd>${escapeHtml(localTime(job.submit_at || job.submit_time))}</dd><dt>Launched</dt><dd>${escapeHtml(lifecycle(job, 'launched'))}</dd><dt>Ended</dt><dd>${escapeHtml(lifecycle(job, 'ended'))}</dd>${dependencyLinks(job)}</dl><div class="actions">${actions.join('')}</div></div></details>`;
}

/**
 * Render the jobs API using collapsible state and archive groups.
 * `disclosures` maps disclosure keys to remembered open/closed choices and
 * `cancelling` holds ``cluster/job_id`` refs whose End Job request was sent.
 */
function renderJobs(payload, disclosures = {}, cancelling = new Set()) {
  const ranks = new Map(['RUNNING', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'OTHER'].map((name, index) => [name, index]));
  const jobs = [...(payload.jobs || [])].sort((left, right) => {
    const groupDifference = ranks.get(stateGroup(left.state)) - ranks.get(stateGroup(right.state));
    if (groupDifference) return groupDifference;
    return String(right.submit_at || right.submit_time || '').localeCompare(String(left.submit_at || left.submit_time || ''));
  });
  const labels = { RUNNING: 'Running', PENDING: 'Pending', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled', OTHER: 'Other' };
  const rows = [];
  for (const group of ranks.keys()) {
    const grouped = jobs.filter((job) => stateGroup(job.state) === group);
    if (grouped.length) rows.push(`<details class="job-group" data-disclosure-key="group:active:${group}"${openAttribute(disclosures, `group:active:${group}`, true)}><summary>${labels[group]} (${grouped.length})</summary>${grouped.map((job) => jobCard(job, false, disclosures, cancelling)).join('')}</details>`);
  }
  const archived = payload.archived_jobs || [];
  rows.push(`<details class="job-group archive" data-disclosure-key="group:archive"${openAttribute(disclosures, 'group:archive', false)}><summary>Archive (${archived.length})</summary>${archived.length ? archived.map((job) => jobCard(job, true, disclosures, cancelling)).join('') : '<p class="muted">No archived jobs.</p>'}</details>`);
  if (!jobs.length && !archived.length) rows.unshift('<p>No jobs found in the last 24 hours.</p>');
  return document('My Jobs', rows.join(''), payload.generated_at);
}

/** Select the strongest per-GPU profile represented in a partition. */
function bestGpu(partition) {
  return [...(partition.gpus?.models || [])].sort((left, right) => (Number(right.vram_gb) - Number(left.vram_gb)) || (Number(right.fp16_bf16_tensor_tflops) - Number(left.fp16_bf16_tensor_tflops)))[0];
}

/** Format a terminal-compatible wait cell. */
function waitCell(partition, count) {
  const total = Number(partition.gpus?.total) || 0;
  if (count > total) return '—';
  const estimate = (partition.wait_estimates || []).find((row) => Number(row.gpus) === count);
  if (!estimate) return '?';
  if (estimate.error) return /permission denied|access\/permission denied|invalid account/i.test(estimate.error) ? 'DENY' : 'ERR';
  return formatDuration(estimate.estimated_wait_seconds);
}

/**
 * Render the stable availability snapshot in cluster-separated tables.
 * `disclosures` maps disclosure keys to remembered open/closed choices.
 */
function renderStatus(payload, disclosures = {}) {
  const clusters = [];
  for (const cluster of payload.clusters || []) {
    const clusterName = escapeHtml(cluster.name);
    const rawKey = `cluster:${cluster.name}`;
    const disclosureKey = escapeHtml(rawKey);
    const open = openAttribute(disclosures, rawKey, true);
    if (!cluster.reachable) {
      clusters.push(`<details class="cluster-group" data-disclosure-key="${disclosureKey}"${open}><summary>${clusterName}</summary><p class="error">${escapeHtml(cluster.error || 'Cluster is unreachable')}</p></details>`);
      continue;
    }
    const partitions = [...(cluster.partitions || [])].sort((left, right) => (Number(left.rank) || 9999) - (Number(right.rank) || 9999) || String(left.name).localeCompare(String(right.name)));
    const rows = partitions.map((partition) => {
      const profile = bestGpu(partition);
      const total = Number(partition.gpus?.total) || 0;
      const idle = Number(partition.gpus?.schedulable_idle) || 0;
      const availablePercent = total ? Math.max(0, Math.min(100, idle / total * 100)) : 0;
      const unavailablePercent = total ? 100 - availablePercent : 100;
      const waits = WAIT_GPU_COUNTS.map((count) => `<td title="Wait for ${count} GPU">${escapeHtml(waitCell(partition, count))}</td>`).join('');
      return `<tr class="${partition.aggregate ? 'aggregate' : ''}"><td>${escapeHtml(partition.name)}${partition.aggregate ? ' (aggregate)' : ''}</td><td>${escapeHtml(profile?.name || '—')}</td><td>${profile?.vram_gb == null ? '—' : `${escapeHtml(profile.vram_gb)}G`}</td><td>${profile?.fp16_bf16_tensor_tflops == null ? '—' : escapeHtml(profile.fp16_bf16_tensor_tflops)}</td><td><div class="availability" title="${idle}/${total} GPUs schedulable and idle"><span class="unavailable" style="width:${unavailablePercent}%"></span><span class="available" style="width:${availablePercent}%"></span></div>${idle}/${total}</td>${waits}<td>${escapeHtml(partition.cpus?.total ?? 0)}</td></tr>`;
    }).join('');
    clusters.push(`<details class="cluster-group" data-disclosure-key="${disclosureKey}"${open}><summary>${clusterName}</summary>${cluster.resource_error ? `<p class="error">${escapeHtml(cluster.resource_error)}</p>` : ''}<div class="table-wrap"><table><thead><tr><th>Partition</th><th>GPU</th><th>VRAM</th><th>TFLOPS/s</th><th>Available</th>${WAIT_GPU_COUNTS.map((count) => `<th>${count}</th>`).join('')}<th>CPU threads</th></tr></thead><tbody>${rows}</tbody></table></div></details>`);
  }
  return document('Cluster Status', clusters.join('') || '<p>No clusters returned.</p>', payload.generated_at);
}

module.exports = { commandAttributes, escapeHtml, jobRef, openAttribute, parseDependency, formatDuration, jobKey, lifecycle, renderJobs, renderJobsApiDisabled, renderMessage, renderStatus, renderWelcome, stateGroup, waitCell };
