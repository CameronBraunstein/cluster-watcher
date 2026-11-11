'use strict';

const crypto = require('node:crypto');
const { escapeHtml, formatDuration } = require('./format');
const { sessionDialogEntries } = require('./sessions');
const {
  DEFAULT_WAIT_THRESHOLDS_MINUTES, launchabilityStrip, waitCell, waitColorIndex,
} = require('./launchability');

const FAILURE_STATES = new Set(['BOOT_FAIL', 'DEADLINE', 'FAILED', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'REVOKED', 'SPECIAL_EXIT', 'TIMEOUT']);
const PRIORITY_HELP = 'Lower rank numbers are considered sooner, but QOS, reservations, resource fit, and backfill can change the start order.';

const DEFAULT_DATE_FORMAT = 'DD.MM.YYYY';
/** The ``clusterWatcher.dateFormat`` pattern; the webview script receives its own copy. */
let dateFormat = DEFAULT_DATE_FORMAT;

/** Set the date pattern (``YYYY``, ``YY``, ``MM``, ``DD`` tokens); blank restores the default. */
function setDateFormat(pattern) {
  dateFormat = typeof pattern === 'string' && pattern.trim() ? pattern.trim() : DEFAULT_DATE_FORMAT;
}

/**
 * Show an ISO timestamp in local time as ``dateFormat`` plus ``HH:mm``.
 * Set ``withSeconds`` for freshness text that must identify the exact update.
 * Self-contained apart from ``dateFormat``, because the webview re-runs it.
 */
function localTime(value, withSeconds = false) {
  if (!value) return 'Unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unavailable';
  const pad = (number) => String(number).padStart(2, '0');
  const parts = { YYYY: String(parsed.getFullYear()), YY: pad(parsed.getFullYear() % 100), MM: pad(parsed.getMonth() + 1), DD: pad(parsed.getDate()) };
  const clock = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}${withSeconds ? `:${pad(parsed.getSeconds())}` : ''}`;
  return `${dateFormat.replace(/YYYY|YY|MM|DD/g, (token) => parts[token])} ${clock}`;
}

/** Put day and month before the local clock, respecting the configured order. */
function cardTime(value) {
  if (!value) return 'Unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unavailable';
  const pad = (number) => String(number).padStart(2, '0');
  const clock = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  const day = pad(parsed.getDate());
  const month = pad(parsed.getMonth() + 1);
  const separator = dateFormat.match(/[./-]/)?.[0] || ' ';
  const monthFirst = dateFormat.indexOf('MM') < dateFormat.indexOf('DD');
  return `${monthFirst ? `${month}${separator}${day}` : `${day}${separator}${month}`} ${clock}`;
}

/** Build compact freshness text for the last line of a sidebar view. */
function viewFreshness(updatedAt) {
  return updatedAt ? `Last update: ${localTime(updatedAt, true)}` : '';
}

/** Render the latest data-update time after the view content. */
function freshnessView(updatedAt) {
  const text = viewFreshness(updatedAt);
  return text ? `<p class="view-freshness">${escapeHtml(text)}</p>` : '';
}

/** Map detailed Slurm states onto the terminal board's groups. */
function stateGroup(value) {
  const state = String(value || 'UNKNOWN').toUpperCase();
  if (state === 'RUNNING') return 'RUNNING';
  if (['PENDING', 'CONFIGURING', 'REQUEUED', 'REQUEUE_FED', 'REQUEUE_HOLD', 'RESIZING', 'SIGNALING', 'STAGE_OUT', 'SUSPENDED'].includes(state)) return 'PENDING';
  if (state === 'COMPLETED') return 'COMPLETED';
  if (state === 'TIMEOUT') return 'FAILED_TIMEOUT';
  if (FAILURE_STATES.has(state)) return 'FAILED_EARLY';
  if (state === 'CANCELLED') return 'CANCELLED';
  return 'OTHER';
}

/** Return whether Slurm says a pending job's overall dependency is impossible. */
function hasFailedDependency(job) {
  if (stateGroup(job.state) !== 'PENDING') return false;
  if (/dependency\s*never\s*satisfied/i.test(String(job.reason || ''))) return true;
  const expression = String(job.dependency || '');
  const clauses = parseDependency(expression);
  if (!clauses.length) return false;
  const failed = (clause) => /^(?:failed|invalid|never satisfied)$/i.test(clause.status.trim());
  return expression.includes('?') ? clauses.every(failed) : clauses.some(failed);
}

/** Identify a queued job whose Slurm dependency is still present. */
function waitsForDependency(job) {
  if (stateGroup(job.state) !== 'PENDING') return false;
  const dependency = String(job.dependency || '').trim();
  return (dependency && !['(null)', 'NULL', 'None', 'N/A'].includes(dependency))
    || /^dependency(?:\s*:|$)/i.test(String(job.reason || '').trim());
}

/** Map a complete job record onto its visible card group. */
function jobGroup(job) {
  if (hasFailedDependency(job)) return 'FAILED_DEPENDENCY';
  return waitsForDependency(job) ? 'DEPENDING' : stateGroup(job.state);
}

/** Return whether the job has not launched and therefore lacks logs/timestamps. */
function isQueuedGroup(group) {
  return group === 'PENDING' || group === 'DEPENDING' || group === 'FAILED_DEPENDENCY';
}

/** Return a pending job's rank position among visible peers on its cluster. */
function relativeJobPriority(job, jobs = []) {
  if (job.priority == null || job.priority === '') return null;
  const priority = Number(job.priority);
  if (!Number.isFinite(priority)) return null;
  const peers = jobs.filter((candidate) => (
    candidate.cluster === job.cluster
    && jobGroup(candidate) === 'PENDING'
    && candidate.priority != null && candidate.priority !== ''
    && Number.isFinite(Number(candidate.priority))
  ));
  if (!peers.length) return null;
  const values = peers.map((candidate) => Number(candidate.priority));
  const lower = values.filter((value) => value < priority).length;
  const equal = values.filter((value) => value === priority).length;
  const higher = values.length - lower - equal;
  const tie = equal > 1 ? ` (tied with ${equal - 1})` : '';
  const globalRank = Number(job.global_priority_rank);
  const globalTotal = Number(job.global_priority_total);
  const hasGlobalRank = Number.isInteger(globalRank) && globalRank > 0 && Number.isInteger(globalTotal) && globalTotal >= globalRank;
  const hasGlobalPosition = hasGlobalRank && globalTotal > 1;
  if (!hasGlobalPosition && peers.length < 2) return null;
  const userPercent = peers.length > 1
    ? (lower + (equal - 1) / 2) / (values.length - 1) * 100
    : 100;
  const global = hasGlobalRank
    ? `Global priority ${globalRank} / ${globalTotal}` : 'Global priority unavailable';
  const percent = hasGlobalPosition
    ? (globalTotal - globalRank) / (globalTotal - 1) * 100
    : userPercent;
  return {
    percent,
    title: `${global}\nYour priority ${higher + 1} / ${values.length}${tie}`,
  };
}

/**
 * Render a compact, unlabeled, number-free low-to-high gauge. The exact
 * details live in its fast hover and accessible label.
 */
function priorityGauge(markers, title, prominent = false) {
  if (!markers.length) return '';
  const ticks = markers.map((percent) => `<i class="priority-marker" style="left:${Math.max(0, Math.min(100, percent))}%"></i>`).join('');
  return `<span class="priority-context${prominent ? ' priority-prominent' : ''}">${priorityHelp()}<span class="priority-gauge" role="img" aria-label="${escapeHtml(title)}" data-fast-tooltip="${escapeHtml(title)}"><span class="priority-track">${ticks}</span></span></span>`;
}

/** Render a pending card's relative priority without adding visible numbers. */
function jobPriorityGauge(job, jobs, prominent = false) {
  const relative = relativeJobPriority(job, jobs);
  return relative ? priorityGauge([relative.percent], relative.title, prominent) : '';
}

/** Render the scheduling explanation directly beside a pending job's gauge. */
function priorityHelp() {
  return `<span class="priority-help" aria-label="${escapeHtml(PRIORITY_HELP)}" data-fast-tooltip="${escapeHtml(PRIORITY_HELP)}">Priority</span>`;
}

/** Return whether a board group represents a failed job. */
function isFailureGroup(group) {
  return group === 'FAILED_EARLY' || group === 'FAILED_TIMEOUT';
}

/** Return a state-aware lifecycle timestamp. */
function lifecycle(job, event) {
  const group = stateGroup(job.state);
  const applicable = event === 'launched'
    ? group === 'RUNNING' || group === 'COMPLETED' || isFailureGroup(group)
    : group === 'COMPLETED' || isFailureGroup(group);
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

/** Build command attributes for a real button, avoiding hash navigation. */
function commandButtonAttributes(command, args = []) {
  return `type="button" data-command="${escapeHtml(command)}" data-args="${escapeHtml(JSON.stringify(args))}"`;
}

/** A separator belongs only between fields occupying the same visual row. */
function metadataSameLine(previous, current) {
  return current.top < previous.bottom - 1 && current.left > previous.left;
}

/** Render session details with one scroll container and a top-left close control. */
function sessionsDialog(inventory) {
  const entries = sessionDialogEntries(inventory);
  const content = (entries.length ? entries : ['No SSH sessions are available.'])
    .map((text) => `<pre class="sessions-dialog-text" tabindex="0">${escapeHtml(text)}</pre>`).join('');
  return `<dialog class="sessions-dialog" aria-labelledby="sessions-dialog-title"><div class="sessions-dialog-header"><button class="sessions-dialog-close" type="button" data-close-sessions aria-label="Close SSH Sessions">×</button><h2 id="sessions-dialog-title">SSH Sessions</h2></div>${content}</dialog>`;
}

/** Render the Cluster Status footer with service controls above configuration. */
function clusterFooter(service = {}, sessions) {
  return `<hr class="cluster-config-separator">${serviceSummary(service)}<button class="view-sessions" type="button" data-open-sessions>view sessions...</button><button class="configure-clusters" data-scroll-anchor="configure-clusters" ${commandButtonAttributes('clusterWatcher.editConfig')}>configure clusters...</button>${sessionsDialog(sessions)}`;
}

/**
 * Capture what a job's progress bar needs, relative to ``asOf`` (the
 * payload's ``generated_at`` in milliseconds). Elapsed time is reported at
 * ``asOf``, so the bar can keep advancing on the client's clock while the
 * service answers "not modified".
 */
function progressSpec(job, asOf) {
  const group = stateGroup(job.state);
  const time = (value) => {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    group,
    asOf: Number.isFinite(asOf) ? asOf : Date.now(),
    elapsed: Math.max(0, Number(job.elapsed_seconds) || 0),
    limit: Math.max(0, Number(job.time_limit_seconds) || 0),
    start: time(job.start_at || job.start_time),
    submit: time(job.submit_at || job.submit_time),
    expected: time(job.expected_start_at || job.start_at || job.start_time),
    reason: String(job.reason || ''),
  };
}

/**
 * Compute a progress bar's fill and label at time ``now`` from a
 * ``progressSpec``. Self-contained apart from ``formatDuration``, because the
 * webview re-runs it every few seconds.
 */
function progressView(spec, now) {
  const jobDuration = (value) => {
    const formatted = formatDuration(value);
    return formatted === 'now' ? '<1m' : formatted;
  };
  if (spec.group === 'RUNNING') {
    const elapsed = spec.elapsed + Math.max(0, (now - spec.asOf) / 1000);
    const percent = spec.limit ? Math.min(100, elapsed / spec.limit * 100) : 0;
    const label = spec.limit ? `${jobDuration(elapsed)} / ${jobDuration(spec.limit)}` : jobDuration(elapsed);
    return { fill: 'running', percent, label };
  }
  if (spec.group === 'PENDING') {
    const total = spec.expected != null && spec.submit != null ? spec.expected - spec.submit : NaN;
    const percent = Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, (now - spec.submit) / total * 100)) : 0;
    const remaining = spec.expected != null ? Math.max(0, (spec.expected - now) / 1000) : null;
    const label = remaining == null
      ? (/^dependency:/i.test(spec.reason) ? 'dependency' : 'no estimate available')
      : `${jobDuration(remaining)} estimated wait`;
    return { fill: 'pending', percent, label };
  }
  if (spec.group === 'COMPLETED' || isFailureGroup(spec.group)) {
    const percent = spec.limit ? Math.min(100, spec.elapsed / spec.limit * 100) : 100;
    const label = spec.limit ? `${jobDuration(spec.elapsed)} / ${jobDuration(spec.limit)}` : jobDuration(spec.elapsed);
    return { fill: isFailureGroup(spec.group) ? 'failed' : 'completed', percent, label };
  }
  return { fill: spec.group.toLowerCase(), percent: 100, label: '' };
}

/** Render a compact dependency link or no-estimate message without an empty bar. */
function pendingExplanation(job) {
  const rawDependency = String(job.dependency || '').trim();
  const dependency = ['(null)', 'NULL', 'None', 'N/A'].includes(rawDependency) ? '' : rawDependency;
  const reasonMatch = /^dependency(?::\s*(.*))?$/i.exec(String(job.reason || '').trim());
  const expression = dependency || reasonMatch?.[1] || '';
  if (expression || reasonMatch) {
    const clauses = parseDependency(expression);
    const rendered = clauses.map((clause) => {
      const links = clause.ids.map((id) => dependencyJobLink(job, id)).join(',');
      return `${escapeHtml(clause.type)}${links ? ` ${links}` : ''}`;
    }).join(', ');
    return `dependency:${rendered || escapeHtml(expression)}`;
  }
  return 'no estimate available';
}

/** Render state-appropriate elapsed/wait progress that the webview keeps current. */
function jobProgress(job, asOf, now = Date.now(), noEstimatePriority = '') {
  const spec = progressSpec(job, asOf);
  if (['DEPENDING', 'FAILED_DEPENDENCY'].includes(jobGroup(job)) || (spec.group === 'PENDING' && spec.expected == null)) {
    const explanation = pendingExplanation(job);
    if (explanation === 'no estimate available' && noEstimatePriority) return noEstimatePriority;
    return `<span class="muted progress-message">${explanation}</span>`;
  }
  const view = progressView(spec, now);
  return `<span class="job-progress" data-progress="${escapeHtml(JSON.stringify(spec))}"><span class="progress"><span class="progress-fill ${view.fill}" style="width:${view.percent}%"></span></span><span class="muted progress-label" title="${escapeHtml(view.label)}">${escapeHtml(view.label)}</span></span>`;
}

/** Render a running job's calculated deadline inside the expanded card. */
function runningLimitRow(job, asOf) {
  const spec = progressSpec(job, asOf);
  if (spec.group !== 'RUNNING' || !spec.limit) return '';
  const startedAt = spec.start ?? spec.asOf - spec.elapsed * 1000;
  return timeRow('Limit', new Date(startedAt + spec.limit * 1000).toISOString());
}

/** Render a lifecycle event on one line with its date before its clock. */
function timeRow(label, value) {
  return `<div class="time-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(cardTime(value))}</dd></div>`;
}

/** Render only lifecycle rows that are meaningful for the job's current state. */
function lifecycleRows(job, asOf) {
  const group = jobGroup(job);
  const rows = [timeRow('Submitted', job.submit_at || job.submit_time)];
  if (!isQueuedGroup(group)) rows.push(timeRow('Launched', job.start_at || job.start_time));
  if (group !== 'RUNNING' && !isQueuedGroup(group)) rows.push(timeRow('Ended', job.end_at));
  const limit = runningLimitRow(job, asOf);
  if (limit) rows.push(limit);
  return rows.join('');
}

/** Return the small archive-box icon used by compact job-card actions. */
function archiveIcon() {
  return '<svg class="action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 2.5h12v3H2zM3.5 5.5h9v8h-9zM6 8h4" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>';
}

/** Wrap sidebar content and optional freshness text in a self-contained document. */
function document(title, body, freshness = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{padding:0 10px 18px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}.view-freshness{margin:0 0 7px;color:var(--vscode-descriptionForeground);font-size:.72em;white-space:nowrap}.meta,.muted{color:var(--vscode-descriptionForeground);font-size:.82em}.meta{margin:5px 0 9px}.job-group{margin:9px 0}.cluster-group{margin:4px 0}.job-group>summary,.cluster-group>summary{cursor:pointer;font-weight:600;font-size:11px;text-transform:none}.cluster-group>summary{margin-bottom:3px;min-width:0}.cluster-summary{box-sizing:border-box;display:inline-flex;flex-direction:column;gap:2px;width:calc(100% - 16px);min-width:0;vertical-align:top}.cluster-summary-main{display:flex;align-items:center;gap:7px;min-width:0}.cluster-summary-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cluster-job-track{display:flex;flex:1 1 70px;max-width:140px;min-width:40px;height:6px;margin-left:auto;overflow:hidden;border-radius:4px;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent);cursor:help}.cluster-job-running,.cluster-job-pending{display:block;height:100%}.cluster-job-running{background:var(--vscode-progressBar-background)}.cluster-job-pending{background:var(--vscode-editorError-foreground)}.card{border:1px solid var(--vscode-panel-border);border-radius:0;margin:3px 0;background:var(--vscode-sideBar-background);min-width:0}.card>summary{position:relative;padding:4px 5px;cursor:pointer;list-style:none;min-width:0}.card>summary::-webkit-details-marker{display:none}.card[open]>summary{border-bottom:1px solid var(--vscode-panel-border)}.card-summary-title[data-full-name]::after{content:attr(data-full-name);position:absolute;z-index:10;left:0;top:calc(100% + 2px);max-width:calc(100% - 14px);padding:3px 5px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:2px;background:var(--vscode-editorHoverWidget-background,var(--vscode-sideBar-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));font-size:11px;font-weight:400;line-height:1.25;white-space:normal;overflow-wrap:anywhere;visibility:hidden;opacity:0;pointer-events:none}.card:not([open]) .card-summary-title[data-full-name]:hover::after{visibility:visible;opacity:1}.card-summary-title{position:relative;display:flex;min-width:0}.card-summary-progress{display:flex;align-items:center;gap:5px;min-width:0}.card-summary-progress>:not(.job-id){flex:1 1 auto;min-width:0}.card-summary-progress>.job-id{flex:0 0 auto;font-size:.72em}.card:not([open]) .card-summary-progress>.job-id{display:none}.job-progress{display:flex;flex-wrap:nowrap;align-items:center;column-gap:4px;min-width:0;max-width:100%}.job-progress>.progress{flex:1 1 auto;min-width:20px}.progress-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.72em}.progress-label:empty{display:none}.card-body{padding:0 8px 8px;min-width:0}.card[open]>.card-body{padding-top:7px}@keyframes card-layout-flash{0%{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder)}100%{border-color:var(--vscode-panel-border);box-shadow:none}}.card.layout-flash{animation:card-layout-flash .9s ease-out both}.row{display:flex;justify-content:space-between;gap:8px}.name{font-weight:600;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}.badge{font-size:.72em;padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.job-id{font-family:var(--vscode-editor-font-family);white-space:nowrap;cursor:copy;border-radius:0}.card-meta{min-width:0;white-space:normal;overflow-wrap:anywhere}.job-id:hover{outline:1px solid var(--vscode-focusBorder)}.job-id.copied{background:var(--vscode-testing-iconPassed)}.job-id.ending{background:var(--vscode-editorError-foreground)}.dep-link{color:var(--vscode-textLink-foreground);text-decoration:none;font-family:var(--vscode-editor-font-family)}.dep-link:hover{text-decoration:underline}.card.flash{outline:2px solid var(--vscode-focusBorder)}.button.danger{background:var(--vscode-inputValidation-errorBackground,var(--vscode-editorError-foreground));color:var(--vscode-button-foreground)}.progress,.availability{height:6px;border-radius:4px;overflow:hidden}.progress{display:block;margin:6px 0 3px;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}.progress-fill,.available,.unavailable{display:block;height:100%}.running{background:var(--vscode-progressBar-background)}.pending,.failed,.unavailable{background:var(--vscode-editorError-foreground)}.completed{background:var(--vscode-testing-iconPassed)}.cancelled,.other{background:var(--vscode-descriptionForeground)}.availability-cell{display:flex;align-items:center;gap:2px;white-space:nowrap}.availability-cell>.availability{display:flex;flex:0 0 34px;margin:0;cursor:help}.availability-count{font-variant-numeric:tabular-nums;white-space:nowrap}.available{background:var(--vscode-testing-iconPassed)}.fast-tooltip{position:fixed;z-index:100;display:none;box-sizing:border-box;width:max-content;max-width:min(220px,calc(100vw - 8px));overflow-wrap:anywhere;padding:3px 5px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));outline:1px solid #fff;border-radius:2px;background:var(--vscode-editorHoverWidget-background,var(--vscode-sideBar-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));font-size:11px;font-weight:400;line-height:1.25;white-space:pre-line;pointer-events:none}.times{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 4px;margin-top:6px;font-size:.72em;min-width:0}.times dt{color:var(--vscode-descriptionForeground);white-space:nowrap}.times dd{margin:0;min-width:0;white-space:normal;text-align:right}.times dd.dependency-value{overflow-wrap:anywhere}.actions{display:flex;flex-wrap:nowrap;align-items:center;gap:3px;margin-top:8px;min-width:0}.actions>.end-job{margin-left:auto}.actions>.compact-action{box-sizing:border-box;flex:0 0 auto;padding:2px 3px;font-size:.72em;line-height:1.4;white-space:nowrap}.action-icon{display:block;width:11px;height:11px}.button{display:inline-block;padding:4px 7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);text-decoration:none;border-radius:2px}.button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.aggregate{opacity:.78}.welcome p{margin:8px 0}.command-line{white-space:pre-wrap;overflow-wrap:anywhere;padding:6px;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:.85em}.welcome-detail{margin-top:12px}.welcome-detail>summary{cursor:pointer}
.card-summary-progress>.summary-archive-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;padding:2px 3px;line-height:1.4}
.cluster-job-running{background:#2563eb}.cluster-job-pending{background:#dc2626}.cluster-job-depending{display:block;height:100%;background:#6b1026}
.cluster-job-track>button{display:block;height:100%;min-width:0;margin:0;padding:0;border:0;cursor:pointer}.cluster-job-track>button:hover,.cluster-job-track>button:focus-visible{box-shadow:inset 0 0 0 1px #fff}
.job-partition-link,.job-cluster-link{border:0;padding:0;background:none;color:var(--vscode-textLink-foreground);font:inherit;cursor:pointer}.job-partition-link:hover,.job-cluster-link:hover{text-decoration:underline}.job-gpu-count{cursor:help}
.card-meta{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:10px;row-gap:1px}.meta-field{position:relative;flex:0 0 auto;max-width:100%}.meta-field.same-line::before{content:attr(data-separator);position:absolute;left:-8px}.meta-cluster,.meta-partition{overflow-wrap:anywhere}.meta-cluster button,.meta-partition button{max-width:100%;overflow-wrap:anywhere;text-align:left}.meta-nodes,.meta-accelerators,.meta-cpus,.job-gpu-count{white-space:nowrap}
.time-row{grid-column:1/-1;display:flex;justify-content:space-between;gap:4px;min-width:0;white-space:nowrap}.time-row dt{flex:0 0 auto}.time-row dd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.view-freshness{margin:8px 0 0}
.card-summary-title[data-full-name]::after{outline:1px solid #fff}
.card[open] .name{white-space:normal;overflow-wrap:anywhere}
.progress-message{display:block;max-width:100%;font-size:.72em;line-height:1.25;white-space:normal;overflow-wrap:anywhere}
.dependency-icon{display:inline-block;margin-left:2px;font-family:system-ui,sans-serif;font-weight:700;cursor:help}.dependency-icon.waiting{font-weight:400}.dependency-icon.satisfied{color:var(--vscode-testing-iconPassed)}.dependency-icon.failed{color:var(--vscode-errorForeground)}
.priority-context{display:flex;align-items:center;gap:5px;margin-top:6px;min-width:0}.priority-gauge{display:flex;align-items:center;flex:1 1 auto;min-width:54px;max-width:150px;cursor:help}.priority-track{position:relative;display:block;flex:1 1 auto;height:4px;border-radius:3px;background:linear-gradient(90deg,var(--vscode-editorError-foreground),var(--vscode-descriptionForeground) 50%,var(--vscode-testing-iconPassed))}.priority-marker{position:absolute;top:-3px;width:2px;height:10px;transform:translateX(-1px);background:var(--vscode-foreground);box-shadow:0 0 0 1px var(--vscode-sideBar-background)}.priority-prominent{margin-top:5px}.priority-prominent .priority-track{height:6px}.priority-prominent .priority-marker{top:-3px;height:12px}.card[open] .card-summary-progress>.priority-prominent{display:none}.priority-help{color:var(--vscode-descriptionForeground);font-size:.8em;cursor:help}
.partition-card{padding:5px;container-type:inline-size}.partition-title{align-items:center;flex-wrap:wrap;gap:4px 7px}.partition-title>.name{flex:0 1 auto;margin-right:auto}.partition-title>.launchability{flex:0 0 auto;margin-left:0}.partition-specs{display:block;margin-top:3px;font-size:.72em;white-space:normal;overflow-wrap:anywhere}.gpu-model,.vram-spec,.thread-spec{cursor:help}.partition-availability{display:flex;align-items:center;gap:0;margin-top:4px;font-size:.72em}.partition-availability-label{box-sizing:border-box;flex:0 0 36px;width:36px;padding-right:2px;color:var(--vscode-descriptionForeground);text-align:left;white-space:nowrap}.partition-availability>.availability-cell{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,max-content);column-gap:2px;flex:1 1 auto;min-width:0}.partition-availability .availability-cell>.availability{width:100%;min-width:0}.partition-availability .availability-count{width:max-content;min-width:min(var(--availability-count-width),45cqw);max-width:100%;overflow:hidden;text-overflow:ellipsis}.times dd>.availability-cell{justify-content:flex-end}
@keyframes partition-jump-highlight{0%,55%{box-shadow:0 0 0 2px #2563eb}100%{box-shadow:none}}.partition-card.jump-highlight{animation:partition-jump-highlight 1.5s ease-out both}
.launchability{display:flex;align-items:end;gap:2px;margin-left:auto;min-width:0}.launch-shape{display:grid;grid-template-rows:7px 9px;justify-items:center;gap:1px}.launch-count{color:var(--vscode-descriptionForeground);font-size:7px;line-height:7px}.launch-block{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:9px;height:9px;border:1px solid color-mix(in srgb,var(--vscode-foreground) 24%,transparent);border-radius:2px;color:#fff;font-size:7px;font-weight:700;line-height:1;cursor:help}.launch-wait-0{background:#15803d}.launch-wait-1{background:#22c55e}.launch-wait-2{background:#eab308;color:#111}.launch-wait-3{background:#f97316}.launch-wait-4{background:#dc2626}.launch-blocked{background:#111}.launch-missing,.launch-pending{background:#777}.launch-unsupported{color:var(--vscode-descriptionForeground);background:repeating-linear-gradient(135deg,transparent 0 2px,color-mix(in srgb,var(--vscode-descriptionForeground) 25%,transparent) 2px 4px)}
.job-id:hover,.job-id:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}
button.button{border:0;font:inherit;cursor:pointer}
.service-summary{display:flex;align-items:center;gap:4px;margin:3px 0 5px;min-width:0;white-space:nowrap;font-size:.78em}.service-summary>strong{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.service-url{box-sizing:border-box;display:block;flex:0 0 auto;max-width:calc(100% - 26px);min-width:0;margin:0;padding:0;overflow:hidden;border:0;background:none;color:var(--vscode-textLink-foreground);font:inherit;text-decoration:underline;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.service-toggle{position:relative;box-sizing:border-box;flex:0 0 22px;width:22px;height:12px;margin:0;padding:0;border:0;border-radius:999px;background:var(--vscode-descriptionForeground);cursor:pointer}.service-toggle::after{content:'';position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--vscode-sideBar-background);transition:left .12s ease}.service-toggle.on{background:var(--vscode-testing-iconPassed)}.service-toggle.on::after{left:12px}.service-toggle:disabled{cursor:wait;opacity:.65}.cluster-login-actions{display:flex;flex:0 1 auto;flex-wrap:wrap;justify-content:flex-end;gap:3px;margin-left:auto}.cluster-login-actions>.compact-action{box-sizing:border-box;max-width:100%;padding:2px 4px;font-size:.68em;line-height:1.3;white-space:normal;overflow-wrap:anywhere;text-align:left}
.service-setup-actions{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 8px}.service-setup-actions>.button{box-sizing:border-box;max-width:100%;padding:3px 5px;font-size:.78em;white-space:normal;text-align:left}
.cluster-config-separator{height:0;margin:9px 0 5px;border:0;border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 40%,transparent)}.view-sessions,.configure-clusters{display:block;margin:4px 0 0;padding:0;border:0;background:none;color:var(--vscode-textLink-foreground);font:inherit;font-size:.78em;text-align:left;text-decoration:none;cursor:pointer}.view-sessions:hover,.configure-clusters:hover{text-decoration:underline}
.partition-fair-share{display:flex;align-items:flex-start;gap:0;margin-top:5px;font-size:.72em}.fair-share-title{box-sizing:border-box;flex:0 0 56px;width:56px;padding-right:2px;color:var(--vscode-descriptionForeground);white-space:nowrap}.fair-share-bars{display:grid;flex:1 1 auto;min-width:0;gap:4px;padding-top:3px}.fair-share-row{min-width:0}.fair-share-track{box-sizing:border-box;position:relative;display:block;width:100%;height:6px;overflow:visible;border-radius:4px;background:linear-gradient(90deg,var(--vscode-editorError-foreground),var(--vscode-descriptionForeground) 50%,var(--vscode-testing-iconPassed))}.fair-share-marker{position:absolute;top:-3px;width:2px;height:12px;transform:translateX(-1px);background:var(--vscode-foreground);box-shadow:0 0 0 1px var(--vscode-sideBar-background);cursor:help}.fair-share-marker::before{content:'';position:absolute;inset:-2px -3px}.fair-share-marker:hover{outline:1px solid var(--vscode-focusBorder)}.fair-share-track.unavailable{background:color-mix(in srgb,var(--vscode-foreground) 10%,transparent)}
.cluster-group+.cluster-group{border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 35%,transparent);padding-top:4px}
.sessions-dialog{box-sizing:border-box;width:calc(100vw - 16px);max-width:none;inset:50% auto auto 50%;transform:translate(-50%,-50%);margin:0;height:fit-content;min-height:0;max-height:calc(100vh - 8px);overflow:auto;padding:4px 8px;border:1px solid var(--vscode-panel-border);border-left:6px solid #000;border-right:6px solid #000;border-radius:6px;background:var(--vscode-editorWidget-background,var(--vscode-sideBar-background));color:var(--vscode-descriptionForeground);font-size:.82em;box-shadow:0 8px 28px #0008}html:has(.sessions-dialog[open]){overflow:hidden}.sessions-dialog::backdrop{background:#0009}.sessions-dialog-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}.sessions-dialog h2{margin:0;font-size:1em}.sessions-dialog-close{padding:0 2px;border:0;background:none;color:inherit;font:inherit;font-size:1.6em;cursor:pointer}.sessions-dialog-text{margin:0;padding:6px 0;border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 35%,transparent);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;user-select:text;font:inherit;line-height:1.5}.sessions-dialog-text:last-of-type{padding-bottom:0}
</style></head><body>${body}${freshnessView(freshness.updatedAt)}<script nonce="${nonce}">
(() => {
  const api = acquireVsCodeApi();
  const savedViewport = api.getState() || {};
  const sessionsDialog = document.querySelector('.sessions-dialog');
  if (sessionsDialog) {
    const saveDialogState = (open) => {
      api.setState({ ...(api.getState() || {}), sessionsOpen: open });
      api.postMessage({ type: 'sessionsDialog', open });
    };
    document.querySelector('[data-open-sessions]')?.addEventListener('click', () => {
      sessionsDialog.showModal();
      saveDialogState(true);
    });
    document.querySelector('[data-close-sessions]')?.addEventListener('click', () => sessionsDialog.close());
    sessionsDialog.addEventListener('close', () => saveDialogState(false));
    if (savedViewport.sessionsOpen) {
      sessionsDialog.showModal();
      api.postMessage({ type: 'sessionsDialog', open: true });
    }
  }
  const savedScrollY = Number(savedViewport.scrollY) || 0;
  const statusAnchor = document.querySelector('[data-scroll-anchor="configure-clusters"]');
  let restoringScroll = true;
  const visibleJobCards = () => [...document.querySelectorAll('[data-job-ref]')]
    .filter((card) => card.getClientRects().length);
  const rememberScroll = (excludedCard) => {
    const jobAnchor = visibleJobCards()
      .filter((card) => card !== excludedCard)
      .map((card) => ({ card, top: card.getBoundingClientRect().top }))
      .sort((left, right) => Math.abs(left.top) - Math.abs(right.top))[0];
    api.setState({
      ...(api.getState() || {}), scrollY: window.scrollY,
      anchorRef: jobAnchor?.card.dataset.jobRef,
      anchorKey: statusAnchor?.dataset.scrollAnchor,
      anchorTop: jobAnchor?.top ?? statusAnchor?.getBoundingClientRect().top,
    });
  };
  const restoreScroll = () => {
    const anchor = statusAnchor?.dataset.scrollAnchor === savedViewport.anchorKey
      ? statusAnchor
      : visibleJobCards().find((card) => card.dataset.jobRef === savedViewport.anchorRef);
    const anchorTop = Number(savedViewport.anchorTop);
    if (anchor && Number.isFinite(anchorTop)) {
      window.scrollBy(0, anchor.getBoundingClientRect().top - anchorTop);
    } else {
      window.scrollTo(0, savedScrollY);
    }
  };
  // A replaced webview document may settle over more than one layout frame.
  requestAnimationFrame(() => {
    restoreScroll();
    requestAnimationFrame(() => { restoreScroll(); restoringScroll = false; });
  });
  window.addEventListener('load', () => {
    restoringScroll = true;
    restoreScroll();
    requestAnimationFrame(() => {
      restoreScroll();
      requestAnimationFrame(() => {
        restoreScroll();
        restoringScroll = false;
        api.postMessage({ type: 'ready' });
      });
    });
  }, { once: true });
  let scrollFrame;
  window.addEventListener('scroll', () => {
    if (restoringScroll || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => { scrollFrame = undefined; rememberScroll(); });
  }, { passive: true });
  const FAST_HOVER_DELAY_MS = 100;
  const fastTooltip = document.createElement('div');
  fastTooltip.className = 'fast-tooltip';
  fastTooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(fastTooltip);
  let fastHoverTimer;
  const hideFastTooltip = () => {
    clearTimeout(fastHoverTimer);
    fastTooltip.style.display = 'none';
  };
  document.querySelectorAll('[data-fast-tooltip]').forEach((target) => {
    target.addEventListener('mouseenter', () => {
      clearTimeout(fastHoverTimer);
      fastHoverTimer = setTimeout(() => {
        fastTooltip.textContent = target.dataset.fastTooltip;
        const viewportWidth = document.documentElement.clientWidth;
        fastTooltip.style.maxWidth = Math.max(0, Math.min(220, viewportWidth - 8)) + 'px';
        fastTooltip.style.display = 'block';
        const targetBounds = target.getBoundingClientRect();
        const tooltipBounds = fastTooltip.getBoundingClientRect();
        fastTooltip.style.left = Math.max(4, Math.min(targetBounds.left, viewportWidth - tooltipBounds.width - 4)) + 'px';
        const below = targetBounds.bottom + 4;
        fastTooltip.style.top = (below + tooltipBounds.height <= window.innerHeight ? below : Math.max(4, targetBounds.top - tooltipBounds.height - 4)) + 'px';
      }, FAST_HOVER_DELAY_MS);
    });
    target.addEventListener('mouseleave', hideFastTooltip);
  });
  window.addEventListener('scroll', hideFastTooltip, true);
  window.addEventListener('resize', hideFastTooltip);
  // Shared with the extension so the page keeps times current between refreshes.
  ${formatDuration.toString()}
  const DEFAULT_WAIT_THRESHOLDS_MINUTES = ${JSON.stringify(DEFAULT_WAIT_THRESHOLDS_MINUTES)};
  ${waitColorIndex.toString()}
  const dateFormat = ${JSON.stringify(dateFormat).replace(/</g, '\\u003c')};
  ${localTime.toString()}
  ${metadataSameLine.toString()}
  ${isFailureGroup.toString()}
  ${progressView.toString()}
  const tick = () => {
    const now = Date.now();
    document.querySelectorAll('[data-progress]').forEach((element) => {
      const view = progressView(JSON.parse(element.dataset.progress), now);
      element.querySelector('.progress-fill').style.width = view.percent + '%';
      const label = element.querySelector('.progress-label');
      label.textContent = view.label;
      label.title = view.label;
    });
    document.querySelectorAll('[data-wait]').forEach((target) => {
      const [seconds, asOf, label] = JSON.parse(target.dataset.wait);
      target.dataset.fastTooltip = label + ': ' + formatDuration(Math.max(0, seconds - (now - asOf) / 1000));
    });
    document.querySelectorAll('[data-launch-wait]').forEach((target) => {
      const [seconds, asOf, label, thresholds] = JSON.parse(target.dataset.launchWait);
      const remaining = Math.max(0, seconds - (now - asOf) / 1000);
      target.className = target.className.replace(/launch-wait-\d/g, 'launch-wait-' + waitColorIndex(remaining, thresholds));
      target.dataset.fastTooltip = label + ': ' + formatDuration(remaining) + ' estimated wait';
      target.setAttribute('aria-label', target.dataset.fastTooltip);
    });
  };
  setInterval(tick, 5000);
  const metadataRows = [...document.querySelectorAll('.card-meta')];
  const updateMetadataSeparators = (meta) => {
    const fields = [...meta.querySelectorAll('.meta-field')];
    fields.slice(1).forEach((field, index) => {
      field.classList.toggle('same-line', metadataSameLine(fields[index].getBoundingClientRect(), field.getBoundingClientRect()));
    });
  };
  metadataRows.forEach(updateMetadataSeparators);
  if (typeof ResizeObserver !== 'undefined') {
    const metadataObserver = new ResizeObserver((entries) => entries.forEach((entry) => updateMetadataSeparators(entry.target)));
    metadataRows.forEach((meta) => metadataObserver.observe(meta));
  }
  window.addEventListener('resize', () => metadataRows.forEach(updateMetadataSeparators));
  const partitionHighlightTimers = new WeakMap();
  // A not-modified check still prompts an immediate local progress update.
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'checked') tick();
    if (event.data?.type === 'jumpPartition') {
      const { cluster, partition } = event.data;
      const group = [...document.querySelectorAll('details.cluster-group[data-disclosure-key]')]
        .find((details) => details.dataset.disclosureKey === 'cluster:' + cluster);
      if (!group) { api.postMessage({ type: 'missingPartition', cluster, partition }); return; }
      if (!partition) { group.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (!group.open) { group.open = true; remember(group); }
      const card = group && [...group.querySelectorAll('.partition-card[data-partition]')]
        .find((item) => item.dataset.partition === partition);
      if (!card) { api.postMessage({ type: 'missingPartition', cluster, partition }); return; }
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      clearTimeout(partitionHighlightTimers.get(card));
      card.classList.remove('jump-highlight');
      void card.offsetWidth;
      card.classList.add('jump-highlight');
      partitionHighlightTimers.set(card, setTimeout(() => card.classList.remove('jump-highlight'), 1500));
      return;
    }
    if (event.data?.type !== 'jumpGroup') return;
    const { group, cluster } = event.data;
    const target = [...document.querySelectorAll('details.job-group[data-disclosure-key]')]
      .find((details) => details.dataset.disclosureKey === 'group:active:' + group);
    if (!target) { api.postMessage({ type: 'missingGroup', group, cluster }); return; }
    const clusterCard = [...target.querySelectorAll('details.card[data-job-ref]')]
      .find((card) => card.dataset.jobRef.startsWith(cluster + '/'));
    if (!clusterCard) { api.postMessage({ type: 'missingGroup', group, cluster }); return; }
    if (!target.open) { target.open = true; remember(target); }
    clusterCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    event.preventDefault();
    if (button.closest('summary')) event.stopPropagation();
    const movesJob = ['clusterWatcher.archiveJob', 'clusterWatcher.restoreJob'].includes(button.dataset.command);
    rememberScroll(movesJob ? button.closest('[data-job-ref]') : undefined);
    let args = [];
    try { args = JSON.parse(button.dataset.args || '[]'); } catch (_error) { args = []; }
    api.postMessage({ type: 'command', command: button.dataset.command, args });
  });
  const remember = (details) => api.postMessage({ type: 'disclosure', key: details.dataset.disclosureKey, open: details.open });
  document.querySelectorAll('details[data-disclosure-key]').forEach((details) => {
    details.addEventListener('toggle', () => {
      remember(details);
      if (!details.classList.contains('card')) return;
      const meta = details.querySelector('.card-meta');
      if (meta && details.open) requestAnimationFrame(() => updateMetadataSeparators(meta));
      details.classList.remove('layout-flash');
      void details.offsetWidth;
      details.classList.add('layout-flash');
      setTimeout(() => details.classList.remove('layout-flash'), 950);
    });
  });
  // Copy a job ID from the expanded card's summary without toggling the card.
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
      event.stopPropagation();
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
function renderMessage(title, message, action = '', freshness = {}) {
  return document(title, `<p class="error">${escapeHtml(message)}</p>${action}`, freshness);
}

/** Render the shared service toggle and dashboard URL in Cluster Status. */
function serviceSummary(service = {}) {
  const state = String(service.state || 'offline').toLowerCase();
  const labels = {
    starting: 'Starting', authenticating: 'Waiting for credentials', stopping: 'Stopping',
  };
  const serviceOn = ['running', 'attached', 'starting', 'authenticating', 'stopping'].includes(state);
  const serviceTransitioning = ['starting', 'authenticating', 'stopping'].includes(state);
  const toggleText = serviceOn ? 'Stop service' : 'Start service';
  const toggle = `<button class="service-toggle ${serviceOn ? 'on' : 'off'}" ${commandButtonAttributes(serviceOn ? 'clusterWatcher.stopService' : 'clusterWatcher.startService')} aria-pressed="${serviceOn}" aria-label="${toggleText}" data-fast-tooltip="${toggleText}"${serviceTransitioning ? ' disabled' : ''}></button>`;
  const serviceDetails = [
    `Process: ${service.pid ?? 'unavailable'}`,
    `Started: ${service.startedAt ? localTime(service.startedAt, true) : 'unavailable'}`,
  ].join('\n');
  const serviceDetailsAttribute = escapeHtml(serviceDetails).replace(/\n/g, '&#10;');
  const linkedUrl = service.url && ['running', 'attached'].includes(state)
    ? `<button class="service-url" ${commandButtonAttributes('clusterWatcher.openDashboard')} aria-label="${escapeHtml(`${service.url}. `)}${serviceDetailsAttribute}" data-fast-tooltip="${serviceDetailsAttribute}">${escapeHtml(service.url)}</button>`
    : '';
  const summaryLabel = serviceOn ? (labels[state] || '') : 'Start Server';
  const summaryText = `${summaryLabel ? `<strong>${escapeHtml(summaryLabel)}</strong>` : ''}${linkedUrl}`;
  return `<div class="service-summary">${toggle}${summaryText}</div>`;
}

/** Remove SSH user prefixes from Cluster Status diagnostics. */
function withoutSshUsernames(message) {
  return String(message || '').replace(/\b[A-Za-z0-9_.-]+@(?=[A-Za-z0-9_.-]+)/g, '');
}

/** Render current service/session errors without duplicating cluster cards. */
function serverNotices(server = {}) {
  const service = server.service || {};
  const activity = service.activity ? `<p class="muted">${escapeHtml(withoutSshUsernames(service.activity))}</p>` : '';
  const error = service.error ? `<p class="error">${escapeHtml(withoutSshUsernames(service.error))}</p>` : '';
  const sessionsError = server.sessionsError
    ? `<p class="error">Could not inspect SSH sessions: ${escapeHtml(withoutSshUsernames(server.sessionsError))}</p>` : '';
  return activity + error + sessionsError;
}

/** Render startup progress without suggesting that the service is offline. */
function renderLoading(title, freshness = {}, connecting = false, server = {}) {
  const subject = title === 'My Jobs' ? 'jobs' : 'cluster status';
  const message = connecting
    ? `Connecting to the local Cluster Watcher service to load ${subject}…`
    : `Cluster Watcher is running. Loading ${subject}…`;
  const controls = title === 'Cluster Status'
    ? serverNotices(server) : '';
  const footer = title === 'Cluster Status' ? clusterFooter(server.service, server.sessions) : '';
  return document(title, `${controls}<p class="muted" role="status">${message}</p>${footer}`, freshness);
}

/**
 * Render the view shown when the service is reachable but was started without
 * ``--jobs-api``: why My Jobs is empty, and the command that fixes it.
 */
function renderJobsApiDisabled(title, command, freshness = {}) {
  const body = `<div class="welcome"><p>The Cluster Watcher service is running, but it was started without <code>--jobs-api</code>, so your jobs cannot be shown. Cluster Status still works.</p>`
    + `<p>Stop that service (Ctrl-C in its terminal), then start it with:</p><pre class="command-line">${escapeHtml(command)}</pre>`
    + `<p class="actions"><a class="button" role="button" ${commandAttributes('clusterWatcher.copyServiceCommand')}>Copy restart command</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.refresh')}>Retry</a></p>`
    + `<p class="muted">Or close it and use the <b>Cluster Status</b> toggle, which starts the service with the jobs API enabled.</p></div>`;
  return document(title, body, freshness);
}

/**
 * Render a compact offline notice in My Jobs or Cluster Status. Service
 * startup lives in Cluster Status; ``detail`` remains available in a
 * collapsed diagnostic section.
 */
function renderWelcome(title, detail, freshness = {}, server = {}) {
  const controls = title === 'Cluster Status'
    ? serverNotices(server) : '';
  const guidance = title === 'Cluster Status' ? 'No service found.' : 'No service found. Use Cluster Status to start it.';
  const body = `${controls}<div class="welcome"><p class="muted" role="status">${guidance}</p>`
    + (detail ? `<details class="welcome-detail"><summary class="muted">Connection details</summary><p class="error">${escapeHtml(detail)}</p></details>` : '')
    + `</div>${title === 'Cluster Status' ? clusterFooter(server.service, server.sessions) : ''}`;
  return document(title, body, freshness);
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

/** Find the referenced card, including an array task represented by its parent ID. */
function referencedDependencyJob(owner, id, jobs) {
  const target = `${owner.cluster}/${id}`;
  return jobs.find((candidate) => jobRef(candidate) === target)
    || jobs.find((candidate) => jobRef(candidate).startsWith(target + '_'));
}

/** Infer one dependency ID's state from Slurm's annotation and known job card. */
function dependencyStatus(owner, clause, id, jobs = []) {
  const annotation = String(clause.status || '').trim().toLowerCase();
  if (['failed', 'invalid', 'never satisfied'].includes(annotation)) return 'failed';
  if (['satisfied', 'fulfilled', 'complete', 'completed', 'success'].includes(annotation)) return 'satisfied';
  if (annotation) return 'waiting';

  const referenced = referencedDependencyJob(owner, id, jobs);
  if (referenced) {
    const group = stateGroup(referenced.state);
    const terminal = ['COMPLETED', 'FAILED_EARLY', 'FAILED_TIMEOUT', 'CANCELLED'].includes(group);
    const type = String(clause.type || '').toLowerCase();
    if (type === 'afterany' && terminal) return 'satisfied';
    if (type === 'after' && (group === 'RUNNING' || terminal)) return 'satisfied';
    if (['afterok', 'aftercorr'].includes(type)) {
      if (group === 'COMPLETED') return 'satisfied';
      if (terminal) return 'failed';
    }
    if (type === 'afternotok') {
      if (group === 'COMPLETED') return 'failed';
      if (terminal) return 'satisfied';
    }
  }
  return hasFailedDependency(owner) ? 'failed' : 'waiting';
}

/** Render a dependency job ID link without expanded-card status decoration. */
function dependencyJobLink(owner, id) {
  return `<a class="dep-link" href="#" data-jump="${escapeHtml(`${owner.cluster}/${id}`)}" title="Show job ${escapeHtml(id)}">${escapeHtml(id)}</a>`;
}

/** Describe an expanded dependency icon for hover and assistive technology. */
function dependencyStatusDescription(status, clause, id) {
  const annotation = String(clause.status || '').trim();
  const annotatedStatus = annotation ? annotation[0].toUpperCase() + annotation.slice(1) : '';
  const type = String(clause.type || 'dependency');
  if (status === 'satisfied') return `${annotatedStatus || 'Satisfied'}: job ${id} satisfied ${type}`;
  if (status === 'failed') return `${annotatedStatus || 'Failed'}: job ${id} cannot satisfy ${type}`;
  return `${annotatedStatus || 'Waiting'}: waiting for job ${id} to satisfy ${type}`;
}

/** Render a linked dependency job ID followed by its accessible state icon. */
function dependencyLink(owner, clause, id, jobs = []) {
  const status = dependencyStatus(owner, clause, id, jobs);
  const icons = { waiting: '🕒', satisfied: '✓', failed: '✕' };
  const description = dependencyStatusDescription(status, clause, id);
  return `${dependencyJobLink(owner, id)} <span class="dependency-icon ${status}" role="img" aria-label="${escapeHtml(description)}" data-fast-tooltip="${escapeHtml(description)}">${icons[status]}</span>`;
}

/** Render dependency clauses with links that jump to the referenced cards. */
function dependencyLinks(job, jobs = []) {
  const clauses = parseDependency(job.dependency);
  if (!clauses.length) return '';
  const rendered = clauses.map((clause) => {
    const links = clause.ids.map((id) => dependencyLink(job, clause, id, jobs)).join(', ');
    return `${escapeHtml(clause.type)}${links ? ` ${links}` : ''}`;
  }).join('<br>');
  return `<dt>Depends on</dt><dd class="dependency-value">${rendered}</dd>`;
}

/** Return the ``cluster/job_id`` reference used for cancellation and dependency links. */
function jobRef(job) {
  return `${job.cluster}/${job.job_id || job.id || ''}`;
}

/**
 * Render one collapsible job card with archive, log, and (for active jobs)
 * cancellation actions. Finished jobs show Archive in the summary, while
 * Running and Pending jobs keep it in the expanded actions. ``cancelling``
 * holds refs whose cancellation was sent.
 * Hovering the collapsed title reveals the full cluster/ID/name; the copyable
 * job-ID badge sits right of the progress bar and shows only when expanded.
 */
function jobCard(job, archived, disclosures, cancelling = new Set(), asOf = Date.now(), jobs = [], priorityJobs = jobs) {
  const identifier = String(job.job_id || job.id || 'unknown');
  const name = String(job.name || identifier);
  const hoverText = [job.cluster, identifier, name].filter(Boolean).join(' ');
  const nodes = Number(job.node_count) || (job.nodes || []).length;
  const totalGpus = Number(job.gpu_total ?? (stateGroup(job.state) === 'RUNNING' || stateGroup(job.state) === 'PENDING'
    ? (Number(job.gpus) || 0) * Math.max(1, nodes) : job.gpus)) || 0;
  const modelEntries = Array.isArray(job.gpu_models) ? job.gpu_models : [];
  const device = job.accelerator_type === 'apu' ? 'APU' : job.accelerator_type === 'mixed' ? 'GPU/APU' : 'GPU';
  const modelsKnown = totalGpus > 0 && modelEntries.length && modelEntries.every((entry) => Number(entry.count) > 0)
    && modelEntries.reduce((sum, entry) => sum + Number(entry.count), 0) === totalGpus;
  const models = modelsKnown ? modelEntries.map((entry) => `${entry.name}${modelEntries.length > 1 ? `: ${entry.count}` : ''}`).join('\n')
    : totalGpus ? `${device} model unavailable` : `No ${device}s requested`;
  const gpuLabel = `<span class="job-gpu-count" data-fast-tooltip="${escapeHtml(models)}" aria-label="${escapeHtml(`${totalGpus} ${device}; ${models}`)}">${totalGpus} ${device}</span>`;
  const archiveCommand = archived ? 'clusterWatcher.restoreJob' : 'clusterWatcher.archiveJob';
  const key = jobKey(job);
  const quickArchive = !archived && !['RUNNING', 'PENDING', 'DEPENDING'].includes(jobGroup(job));
  const archiveAction = archived
    ? `<a class="button compact-action" role="button" ${commandAttributes(archiveCommand, [key])} title="Restore job">Restore</a>`
    : `<a class="button compact-action archive-action${quickArchive ? ' summary-archive-action' : ''}" role="button" ${commandAttributes(archiveCommand, [key])} title="Archive job" aria-label="Archive job">${archiveIcon()}</a>`;
  const actions = quickArchive ? [] : [archiveAction];
  if (stateGroup(job.state) !== 'PENDING') {
    actions.push(
      `<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.openLog', [job.cluster, identifier, 'err'])} title="Open .err log" aria-label="Open .err log">.err</button>`,
      `<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.openLog', [job.cluster, identifier, 'out'])} title="Open .out log" aria-label="Open .out log">.out</button>`,
    );
  }
  actions.push(`<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.openScript', [job.cluster, identifier])} title="Open the Slurm batch script this job ran" aria-label="Open batch script">script</button>`);
  const ending = cancelling.has(jobRef(job));
  if (['RUNNING', 'PENDING'].includes(stateGroup(job.state)) && !ending) {
    actions.push(`<a class="button danger compact-action end-job" role="button" ${commandAttributes('clusterWatcher.cancelJob', [job.cluster, identifier, job.name || identifier])} title="End job" aria-label="End job">End</a>`);
  }
  const disclosureKey = `card:${archived ? 'archive' : 'active'}:${key}`;
  const partition = String(job.partition || '');
  const partitionLabel = partition
    ? `<button class="job-partition-link" ${commandButtonAttributes('clusterWatcher.showPartition', [job.cluster, partition])} aria-label="Show ${escapeHtml(partition)} in Cluster Status">${escapeHtml(partition)}</button>`
    : 'no partition';
  const clusterLabel = `<button class="job-cluster-link" ${commandButtonAttributes('clusterWatcher.showCluster', [job.cluster])} aria-label="Show ${escapeHtml(job.cluster)} in Cluster Status">${escapeHtml(job.cluster)}</button>`;
  const metadata = [
    `<span class="meta-field meta-cluster">${clusterLabel}</span>`,
    `<span class="meta-field meta-partition" data-separator="/">${partitionLabel}</span>`,
    `<span class="meta-field meta-nodes" data-separator="·">${nodes} node</span>`,
    `<span class="meta-field meta-accelerators" data-separator="·">${gpuLabel}</span>`,
    `<span class="meta-field meta-cpus" data-separator="·">${Number(job.cpus) || 0} CPU</span>`,
  ].join('');
  const priority = !archived && jobGroup(job) === 'PENDING' ? jobPriorityGauge(job, priorityJobs) : '';
  const noEstimatePriority = priority && progressSpec(job, asOf).expected == null
    && pendingExplanation(job) === 'no estimate available'
    ? jobPriorityGauge(job, priorityJobs, true) : '';
  const expandedPriority = priority;
  const idBadge = `<span class="badge job-id${ending ? ' ending' : ''}" role="button" tabindex="0" data-copy="${escapeHtml(identifier)}" title="${escapeHtml(identifier)}${ending ? ' · ending' : ''} — click to copy">${escapeHtml(identifier)}</span>`;
  return `<details class="card" data-disclosure-key="${escapeHtml(disclosureKey)}" data-job-ref="${escapeHtml(jobRef(job))}"${openAttribute(disclosures, disclosureKey, false)}><summary><span class="card-summary-title" data-full-name="${escapeHtml(hoverText)}"><span class="name">${escapeHtml(name)}</span></span><span class="card-summary-progress">${quickArchive ? archiveAction : ''}${jobProgress(job, asOf, Date.now(), noEstimatePriority)}${idBadge}</span></summary><div class="card-body"><div class="muted card-meta">${metadata}</div>${expandedPriority}<dl class="times">${lifecycleRows(job, asOf)}${dependencyLinks(job, jobs)}</dl><div class="actions">${actions.join('')}</div></div></details>`;
}

/**
 * Render the jobs API using collapsible state and archive groups.
 * `disclosures` maps disclosure keys to remembered open/closed choices and
 * `cancelling` holds ``cluster/job_id`` refs whose End Job request was sent.
 */
function renderJobs(payload, disclosures = {}, cancelling = new Set(), freshness = {}) {
  const asOf = Date.parse(payload.generated_at || '') || Date.now();
  const byCluster = new Set(['RUNNING', 'PENDING', 'DEPENDING']);
  const ranks = new Map(['RUNNING', 'PENDING', 'DEPENDING', 'FAILED_DEPENDENCY', 'COMPLETED', 'FAILED_EARLY', 'FAILED_TIMEOUT', 'CANCELLED', 'OTHER'].map((name, index) => [name, index]));
  const jobs = [...(payload.jobs || [])].sort((left, right) => {
    const leftGroup = jobGroup(left);
    const groupDifference = ranks.get(leftGroup) - ranks.get(jobGroup(right));
    if (groupDifference) return groupDifference;
    if (byCluster.has(leftGroup)) {
      const clusterDifference = String(left.cluster || '').localeCompare(String(right.cluster || ''), undefined, { sensitivity: 'base', numeric: true });
      if (clusterDifference) return clusterDifference;
    }
    return String(right.submit_at || right.submit_time || '').localeCompare(String(left.submit_at || left.submit_time || ''))
      || jobKey(left).localeCompare(jobKey(right));
  });
  const labels = { RUNNING: 'Running', PENDING: 'Pending', DEPENDING: 'Depending', FAILED_DEPENDENCY: 'Failed Dependency', COMPLETED: 'Completed', FAILED_EARLY: 'Failed (Early)', FAILED_TIMEOUT: 'Failed (Timeout)', CANCELLED: 'Cancelled', OTHER: 'Other' };
  const archived = payload.archived_jobs || [];
  const knownJobs = [...jobs, ...archived];
  const rows = [];
  for (const group of ranks.keys()) {
    const grouped = jobs.filter((job) => jobGroup(job) === group);
    if (grouped.length) {
      const cards = grouped.map((job) => jobCard(job, false, disclosures, cancelling, asOf, knownJobs, jobs)).join('');
      rows.push(`<details class="job-group" data-disclosure-key="group:active:${group}"${openAttribute(disclosures, `group:active:${group}`, true)}><summary>${labels[group]} (${grouped.length})</summary>${cards}</details>`);
    }
  }
  rows.push(`<details class="job-group archive" data-disclosure-key="group:archive"${openAttribute(disclosures, 'group:archive', false)}><summary>Archive (${archived.length})</summary>${archived.length ? archived.map((job) => jobCard(job, true, disclosures, cancelling, asOf, knownJobs)).join('') : '<p class="muted">No archived jobs.</p>'}</details>`);
  if (!jobs.length && !archived.length) rows.unshift('<p>No jobs found in the last 24 hours.</p>');
  return document('My Jobs', rows.join(''), freshness);
}

/** Select the strongest per-GPU profile represented in a partition. */
function bestGpu(partition) {
  return [...(partition.gpus?.models || [])].sort((left, right) => (Number(right.vram_gb) - Number(left.vram_gb)) || (Number(right.fp16_bf16_tensor_tflops) - Number(left.fp16_bf16_tensor_tflops)))[0];
}

/**
 * Reduce a catalog GPU name to its recognizable model designation.
 *
 * Vendor and product-family wording remains available in the cell tooltip;
 * the compact label keeps the narrow status table readable.
 */
function compactGpuName(value) {
  const name = String(value || '').trim();
  if (!name) return '—';
  const patterns = [
    /\b((?:RTX|GTX)(?:\s+PRO)?\s+\d{3,4}(?:\s+Ti)?)\b/i,
    /\b((?:MI|GH|GB)\d{2,4}[A-Z]*|(?:H|A|B|L|T|V|P)\d{1,4}[A-Z]*)\b/i,
    /\b(Max\s+\d{3,4})\b/i,
    /\b(M\d(?:\s+(?:Pro|Max|Ultra))?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) return match[1].replace(/\s+/g, ' ');
  }
  const withoutBrand = name
    .replace(/^(?:NVIDIA|AMD|Advanced Micro Devices|Intel)\s+/i, '')
    .replace(/^(?:GeForce|Tesla|Quadro|Instinct|Data Center GPU)\s+/i, '');
  return withoutBrand.split(/\s+/).slice(0, 2).join(' ');
}

/**
 * Return the concise availability category for one Slurm node state.
 * Restrictive modifiers take precedence over the base state because an
 * ``IDLE+DRAIN`` node is physically idle but unavailable to new jobs.
 */
function availabilityStateLabel(state) {
  const value = String(state || 'unknown').toLowerCase();
  if (value.includes('reserved')) return 'reserved';
  if (value.includes('drain')) return 'drained';
  if (value.includes('maint')) return 'maintenance';
  if (value.includes('reboot')) return 'rebooting';
  if (value.includes('power')) return 'powered off';
  if (value.includes('down') || value.includes('fail') || value.includes('no_resp')) return 'down';
  if (value.startsWith('alloc')) return 'full';
  if (value.startsWith('idle')) return 'idle';
  if (value.startsWith('mix')) return 'mixed';
  return value.replace(/[+_]+/g, ' ');
}

/** Build a node-availability tooltip, omitting categories with no nodes. */
function availabilityTitle(partition) {
  const categories = new Map();
  let states = Object.entries(partition.node_states || {});
  if (!states.length && Array.isArray(partition.nodes)) {
    const counts = new Map();
    for (const node of partition.nodes) {
      const state = String(node.state || 'unknown');
      counts.set(state, (counts.get(state) || 0) + 1);
    }
    states = [...counts.entries()];
  }
  for (const [state, rawCount] of states) {
    const count = Number(rawCount) || 0;
    if (!count) continue;
    const label = availabilityStateLabel(state);
    categories.set(label, (categories.get(label) || 0) + count);
  }
  const order = ['idle', 'mixed', 'full', 'reserved', 'drained', 'down', 'maintenance', 'rebooting', 'powered off'];
  const entries = [...categories.entries()].sort(([left], [right]) => {
    const leftIndex = order.indexOf(left), rightIndex = order.indexOf(right);
    return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || left.localeCompare(right);
  });
  const nodes = entries.map(([label, count]) => `${count} ${label}`).join(', ');
  return nodes || 'Node state details unavailable';
}

/** Add a positive resource count to a compact tooltip category. */
function addAvailabilityCount(categories, label, rawCount) {
  const count = Math.max(0, Number(rawCount) || 0);
  if (count) categories.set(label, (categories.get(label) || 0) + count);
}

/**
 * Describe the red/green GPU bar in GPU units rather than node units.
 *
 * Schedulable idle GPUs remain ``idle``. Allocated GPUs are counted
 * independently, while idle GPUs made unavailable by a restrictive node
 * state retain that state (reserved, drained, down, and so on).
 */
function gpuAvailabilityTitle(partition) {
  const categories = new Map();
  const nodes = Array.isArray(partition.nodes) ? partition.nodes : [];
  if (nodes.length) {
    for (const node of nodes) {
      const gpu = node.gpus || node.gpu || {};
      const total = Math.max(0, Number(gpu.total) || 0);
      const allocated = Math.min(total, Math.max(0, Number(gpu.allocated) || 0));
      const idle = Math.min(total - allocated, Math.max(0, Number(gpu.schedulable_idle) || 0));
      addAvailabilityCount(categories, 'idle', idle);
      addAvailabilityCount(categories, 'allocated', allocated);
      const restricted = Math.max(0, total - allocated - idle);
      if (restricted) {
        const state = availabilityStateLabel(node.state);
        const label = ['idle', 'mixed', 'full'].includes(state) ? 'unavailable' : state;
        addAvailabilityCount(categories, label, restricted);
      }
    }
  } else {
    const gpu = partition.gpus || {};
    const total = Math.max(0, Number(gpu.total) || 0);
    const idle = Math.min(total, Math.max(0, Number(gpu.schedulable_idle) || 0));
    const allocated = Math.min(total - idle, Math.max(0, Number(gpu.allocated) || 0));
    addAvailabilityCount(categories, 'idle', idle);
    addAvailabilityCount(categories, 'allocated', allocated);
    const unavailableByState = Object.entries(gpu.unavailable_by_state || {});
    for (const [state, count] of unavailableByState) {
      const label = availabilityStateLabel(state);
      addAvailabilityCount(categories, ['idle', 'mixed', 'full'].includes(label) ? 'unavailable' : label, count);
    }
    const classified = unavailableByState.reduce((sum, [, count]) => sum + Math.max(0, Number(count) || 0), 0);
    addAvailabilityCount(categories, 'unavailable', Math.max(0, total - idle - allocated - classified));
  }
  const order = ['idle', 'allocated', 'reserved', 'drained', 'down', 'maintenance', 'rebooting', 'powered off', 'unavailable'];
  const entries = [...categories.entries()].sort(([left], [right]) => {
    const leftIndex = order.indexOf(left), rightIndex = order.indexOf(right);
    return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || left.localeCompare(right);
  });
  const details = entries.map(([label, count]) => `${count} ${label}`).join(', ');
  return details || 'GPU availability details unavailable';
}

/** Return the fully idle node count and total represented by a partition. */
function nodeAvailabilityCounts(partition) {
  let idle = 0, total = 0;
  const states = Object.entries(partition.node_states || {});
  if (states.length) {
    for (const [state, rawCount] of states) {
      const count = Math.max(0, Number(rawCount) || 0);
      total += count;
      if (partition.available !== false && availabilityStateLabel(state) === 'idle') idle += count;
    }
  } else if (Array.isArray(partition.nodes)) {
    total = partition.nodes.length;
    idle = partition.available === false ? 0 : partition.nodes.filter((node) => availabilityStateLabel(node.state) === 'idle').length;
  } else {
    total = Math.max(0, Number(partition.reported_nodes) || 0);
  }
  return { idle, total };
}

/** Render compact GPU and CPU specifications with exact accessible hover labels. */
function partitionSpecs(partition, profile) {
  const threads = Number(partition.cpus?.total) || 0;
  const threadLabel = `${threads.toLocaleString()} threads`;
  const thread = `<span class="thread-spec" data-fast-tooltip="CPU threads: ${escapeHtml(threadLabel)}" aria-label="CPU threads: ${escapeHtml(threadLabel)}">${escapeHtml(threadLabel)}</span>`;
  if (!profile) return `${Number(partition.gpus?.total) > 0 ? 'GPU details unavailable' : 'No GPUs'} · ${thread}`;
  const fullGpuName = profile.name || '—';
  const vramAmount = profile.vram_gb == null ? 'unavailable' : `${profile.vram_gb} GB`;
  const vram = `<span class="vram-spec" data-fast-tooltip="VRAM: ${escapeHtml(vramAmount)}" aria-label="VRAM: ${escapeHtml(vramAmount)}">${escapeHtml(vramAmount)}</span>`;
  const tflops = profile.fp16_bf16_tensor_tflops == null ? '—' : escapeHtml(profile.fp16_bf16_tensor_tflops);
  return `<span class="gpu-model" data-fast-tooltip="${escapeHtml(fullGpuName)}" aria-label="${escapeHtml(fullGpuName)}">${escapeHtml(compactGpuName(fullGpuName))}</span> · ${vram} · ${tflops} TFLOPS/s · ${thread}`;
}

/** Render one green/red availability bar with its ``free/total`` fraction. */
function availabilityBar(idle, total, title) {
  const availablePercent = total ? Math.max(0, Math.min(100, idle / total * 100)) : 0;
  const unavailablePercent = total ? 100 - availablePercent : 100;
  const availability = escapeHtml(title);
  return `<div class="availability-cell"><div class="availability" data-availability="${availability}" data-fast-tooltip="${availability}" aria-label="${availability}"><span class="available" style="width:${availablePercent}%"></span><span class="unavailable" style="width:${unavailablePercent}%"></span></div><span class="availability-count" aria-label="${idle} of ${total} free" title="${idle}/${total} Free">${idle}/${total} Free</span></div>`;
}

/**
 * Render one permanently expanded, compact partition card. Scheduling,
 * compute specifications, and physical availability remain visible together.
 */
function partitionCard(partition, pending, asOf, thresholds, shareError = null) {
  const profile = bestGpu(partition);
  const name = `${partition.name}${partition.aggregate ? ' (aggregate)' : ''}`;
  const launchability = launchabilityStrip(partition, pending, asOf, thresholds);
  const gpuTotal = Math.max(0, Number(partition.gpus?.total) || 0);
  const idleGpus = Math.min(gpuTotal, Math.max(0, Number(partition.gpus?.schedulable_idle) || 0));
  const nodeCounts = nodeAvailabilityCounts(partition);
  const countWidth = Math.max(`${idleGpus}/${gpuTotal} Free`.length, `${nodeCounts.idle}/${nodeCounts.total} Free`.length);
  return `<article class="card partition-card${partition.aggregate ? ' aggregate' : ''}" data-partition="${escapeHtml(partition.name)}" style="--availability-count-width:${countWidth}ch"><div class="card-summary-title partition-title"><span class="name">${escapeHtml(name)}</span>${launchability}</div><div class="muted partition-specs">${partitionSpecs(partition, profile)}</div>${partitionFairShare(partition.fair_share, shareError)}<div class="partition-availability"><span class="partition-availability-label">GPUs:</span>${availabilityBar(idleGpus, gpuTotal, gpuAvailabilityTitle(partition))}</div><div class="partition-availability"><span class="partition-availability-label">Nodes:</span>${availabilityBar(nodeCounts.idle, nodeCounts.total, availabilityTitle(partition))}</div></article>`;
}

/** Return whether a Slurm association has a displayable fair-share factor. */
function validFairShare(entry) {
  const factor = Number(entry.factor);
  const rank = Number(entry.rank), total = Number(entry.total);
  return entry.factor != null && Number.isFinite(factor) && factor >= 0 && factor <= 1
    && Number.isInteger(rank) && Number.isInteger(total) && rank >= 1 && total >= rank;
}

/** Describe only the account and its rank among visible associations. */
function fairShareDetails(entry) {
  return `${entry.account}: ${entry.rank}/${entry.total}`;
}

/** Draw a shared scale with a separate hover target for each account marker. */
function fairShareBar(entries) {
  if (!entries.length) return '';
  const role = entries.length === 1
    ? `role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${Number(entries[0].factor)}"`
    : 'role="img"';
  const markers = entries.map((entry) => {
    const tooltip = escapeHtml(fairShareDetails(entry)).replace(/\n/g, '&#10;');
    return `<i class="fair-share-marker" style="left:${(Number(entry.factor) * 100).toFixed(2)}%" role="img" aria-label="${tooltip}" data-fast-tooltip="${tooltip}"></i>`;
  }).join('');
  return `<div class="fair-share-row"><div class="fair-share-track" ${role} aria-label="Fair share for ${entries.length} account association${entries.length === 1 ? '' : 's'}">${markers}</div></div>`;
}

/** Put eligible account markers on a scale whose background has no tooltip. */
function partitionFairShare(entries, error = null) {
  const bars = fairShareBar((Array.isArray(entries) ? entries : []).filter(validFairShare));
  const explanation = escapeHtml(error || 'No confirmed association match for this partition.').replace(/\n/g, '&#10;');
  const unavailable = `<div class="fair-share-row"><div class="fair-share-track unavailable" aria-label="${explanation}"></div></div>`;
  return `<div class="partition-fair-share"><span class="fair-share-title">FairShare:</span><div class="fair-share-bars">${bars || unavailable}</div></div>`;
}

/** Render clickable running, pending, and dependency-held shares for a cluster. */
function clusterJobRatio(counts = {}, cluster = '', gpuHours = {}) {
  const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const running = count(counts.running);
  const pending = count(counts.pending);
  const depending = count(counts.depending);
  const total = running + pending + depending;
  const runningPercent = total ? running / total * 100 : 0;
  const pendingPercent = total ? pending / total * 100 : 0;
  const dependingPercent = total ? depending / total * 100 : 0;
  const label = `${running} running, ${pending} pending, ${depending} depending`;
  const segments = [
    ['RUNNING', running, runningPercent],
    ['PENDING', pending, pendingPercent],
    ['DEPENDING', depending, dependingPercent],
  ].filter(([, number]) => number > 0).map(([group, number, percent]) => {
    const hours = gpuHours[group.toLowerCase()];
    const estimate = hours == null || !Number.isFinite(Number(hours)) ? 'GPU-hours unavailable'
      : `${Number(hours).toLocaleString(undefined, { maximumFractionDigits: 1 })} GPU-hours ${group === 'RUNNING' ? 'remaining' : 'requested'}`;
    const tooltip = `${number} ${group.toLowerCase()} job${number === 1 ? '' : 's'}\n${estimate}`;
    return `<button class="cluster-job-${group.toLowerCase()}" style="width:${percent}%" ${commandButtonAttributes('clusterWatcher.showJobsGroup', [group, cluster])} aria-label="Show ${number} ${group.toLowerCase()} job${number === 1 ? '' : 's'} on ${escapeHtml(cluster)} in My Jobs" data-fast-tooltip="${escapeHtml(tooltip)}"></button>`;
  }).join('');
  return `<span class="cluster-job-track" role="group" aria-label="${escapeHtml(label)}">${segments}</span>`;
}

/** Return whether an interactive machine currently lacks its reusable SSH session. */
function clusterLoggedOut(cluster, session) {
  if (session) return Boolean(session.interactive_auth && !session.session_open);
  return Boolean(cluster.login_required);
}

/** Render scoped authentication actions for one logged-out cluster. */
function clusterLoginActions(cluster, session) {
  if (!clusterLoggedOut(cluster, session)) return '';
  const machine = String(session?.name || cluster.name);
  const buttons = [
    `<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.login', [machine, false])}>Log in</button>`,
  ];
  if (session?.credential_group) {
    buttons.push(`<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.login', [machine, true])}>Log into all machines on ${escapeHtml(session.credential_group)}</button>`);
  }
  return `<span class="cluster-login-actions">${buttons.join('')}</span>`;
}

/** Render one cluster heading with its job ratio or login actions. */
function clusterSummary(cluster, session) {
  const clusterName = escapeHtml(cluster.name);
  const loggedOut = clusterLoggedOut(cluster, session);
  const status = loggedOut ? clusterLoginActions(cluster, session) : clusterJobRatio(cluster.user_jobs, cluster.name, cluster.user_gpu_hours);
  return `<span class="cluster-summary"><span class="cluster-summary-main"><span class="cluster-summary-name">${clusterName}</span>${status}</span></span>`;
}

/**
 * Render the stable availability snapshot as one collapsible group per
 * cluster holding permanently expanded compact partition cards.
 * `disclosures` maps cluster disclosure keys to remembered choices. ``server``
 * supplies lifecycle diagnostics and the reusable-session inventory.
 */
function renderStatus(payload, disclosures = {}, freshness = {}, server = {}) {
  const asOf = Date.parse(payload.generated_at || '') || Date.now();
  const thresholds = payload.wait_threshold_minutes || DEFAULT_WAIT_THRESHOLDS_MINUTES;
  const sessions = new Map((server.sessions?.machines || [])
    .map((session) => [String(session.name), session]));
  const clusters = [];
  for (const cluster of payload.clusters || []) {
    const session = sessions.get(String(cluster.name));
    const summary = clusterSummary(cluster, session);
    const rawKey = `cluster:${cluster.name}`;
    const disclosureKey = escapeHtml(rawKey);
    const open = openAttribute(disclosures, rawKey, true);
    if (!cluster.reachable) {
      clusters.push(`<details class="cluster-group" data-disclosure-key="${disclosureKey}"${open}><summary>${summary}</summary><p class="error">${escapeHtml(withoutSshUsernames(cluster.error || 'Cluster is unreachable'))}</p></details>`);
      continue;
    }
    // No probe round has finished for this cluster yet (they start with the service).
    const pending = !cluster.wait_estimates_updated_at;
    const partitions = [...(cluster.partitions || [])].sort((left, right) => (Number(left.rank) || 9999) - (Number(right.rank) || 9999) || String(left.name).localeCompare(String(right.name)));
    const cards = partitions.map((partition) => partitionCard(partition, pending, asOf, thresholds, cluster.fair_share?.mapping_error || cluster.fair_share?.error)).join('');
    clusters.push(`<details class="cluster-group" data-disclosure-key="${disclosureKey}"${open}><summary>${summary}</summary>${cluster.resource_error ? `<p class="error">${escapeHtml(withoutSshUsernames(cluster.resource_error))}</p>` : ''}${cards}</details>`);
  }
  const content = clusters.join('') || '<p>No clusters returned.</p>';
  const body = serverNotices(server) + content + clusterFooter(server.service, server.sessions);
  return document('Cluster Status', body, freshness);
}

module.exports = { DEFAULT_DATE_FORMAT, availabilityStateLabel, availabilityTitle, compactGpuName, gpuAvailabilityTitle, localTime, setDateFormat, progressSpec, progressView, commandAttributes, commandButtonAttributes, dependencyStatus, escapeHtml, hasFailedDependency, isFailureGroup, jobGroup, jobRef, launchabilityStrip, metadataSameLine, openAttribute, parseDependency, relativeJobPriority, formatDuration, jobKey, lifecycle, renderJobs, renderJobsApiDisabled, renderLoading, renderMessage, renderStatus, renderWelcome, stateGroup, viewFreshness, waitCell };
