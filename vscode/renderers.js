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

/** Build compact freshness text displayed directly below a sidebar view title. */
function viewFreshness(updatedAt) {
  return updatedAt ? `Last update: ${localTime(updatedAt, true)}` : '';
}

/** Render the latest data-update time beneath a view's native heading. */
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

/** Map a complete job record onto its visible card group. */
function jobGroup(job) {
  return hasFailedDependency(job) ? 'FAILED_DEPENDENCY' : stateGroup(job.state);
}

/** Return whether the job has not launched and therefore lacks logs/timestamps. */
function isQueuedGroup(group) {
  return group === 'PENDING' || group === 'FAILED_DEPENDENCY';
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
function jobProgress(job, asOf, now = Date.now()) {
  const spec = progressSpec(job, asOf);
  if (jobGroup(job) === 'FAILED_DEPENDENCY' || (spec.group === 'PENDING' && spec.expected == null)) {
    const explanation = pendingExplanation(job);
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
  return `<dt>Limit</dt><dd>${escapeHtml(localTime(new Date(startedAt + spec.limit * 1000).toISOString()))}</dd>`;
}

/** Render only lifecycle rows that are meaningful for the job's current state. */
function lifecycleRows(job, asOf) {
  const group = jobGroup(job);
  const rows = [`<dt>Submitted</dt><dd>${escapeHtml(localTime(job.submit_at || job.submit_time))}</dd>`];
  if (!isQueuedGroup(group)) rows.push(`<dt>Launched</dt><dd>${escapeHtml(lifecycle(job, 'launched'))}</dd>`);
  if (group !== 'RUNNING' && !isQueuedGroup(group)) rows.push(`<dt>Ended</dt><dd>${escapeHtml(lifecycle(job, 'ended'))}</dd>`);
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
body{padding:0 10px 18px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}.view-freshness{margin:0 0 7px;color:var(--vscode-descriptionForeground);font-size:.72em;white-space:nowrap}.meta,.muted{color:var(--vscode-descriptionForeground);font-size:.82em}.meta{margin:5px 0 9px}.job-group,.cluster-group{margin:9px 0}.job-group>summary,.cluster-group>summary{cursor:pointer;font-weight:600;font-size:11px;text-transform:none}.cluster-group>summary{margin-bottom:7px}.card{border:1px solid var(--vscode-panel-border);border-radius:5px;margin:3px 0;background:var(--vscode-sideBar-background);min-width:0}.card>summary{position:relative;padding:4px 5px;cursor:pointer;list-style:none;min-width:0}.card>summary::-webkit-details-marker{display:none}.card[open]>summary{border-bottom:1px solid var(--vscode-panel-border)}.card>summary[data-full-name]::after{content:attr(data-full-name);position:absolute;z-index:10;left:4px;top:calc(100% + 2px);max-width:calc(100% - 18px);padding:3px 5px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:2px;background:var(--vscode-editorHoverWidget-background,var(--vscode-sideBar-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));font-size:11px;font-weight:400;line-height:1.25;white-space:normal;overflow-wrap:anywhere;visibility:hidden;opacity:0;pointer-events:none}.card:not([open])>summary[data-full-name]:hover::after{visibility:visible;opacity:1}.card-summary-title{display:flex;min-width:0}.card-summary-progress{display:block;min-width:0}.job-progress{display:flex;flex-wrap:nowrap;align-items:center;column-gap:4px;min-width:0;max-width:100%}.job-progress>.progress{flex:1 1 auto;min-width:20px}.progress-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.72em}.progress-label:empty{display:none}.card-body{padding:0 8px 8px;min-width:0}.card[open]>.card-body{padding-top:7px}@keyframes card-layout-flash{0%{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder)}100%{border-color:var(--vscode-panel-border);box-shadow:none}}.card.layout-flash{animation:card-layout-flash .9s ease-out both}.row{display:flex;justify-content:space-between;gap:8px}.name{font-weight:600;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}.badge{font-size:.72em;padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.job-id{font-family:var(--vscode-editor-font-family);white-space:nowrap;cursor:copy;border-radius:0}.card-meta{min-width:0;white-space:normal;overflow-wrap:anywhere}.card-meta>.job-id{display:inline-block;font-size:.88em;margin-right:3px}.job-id:hover{outline:1px solid var(--vscode-focusBorder)}.job-id.copied{background:var(--vscode-testing-iconPassed)}.job-id.ending{background:var(--vscode-editorError-foreground)}.dep-link{color:var(--vscode-textLink-foreground);text-decoration:none;font-family:var(--vscode-editor-font-family)}.dep-link:hover{text-decoration:underline}.card.flash{outline:2px solid var(--vscode-focusBorder)}.button.danger{background:var(--vscode-inputValidation-errorBackground,var(--vscode-editorError-foreground));color:var(--vscode-button-foreground)}.progress,.availability{height:6px;border-radius:4px;overflow:hidden}.progress{display:block;margin:6px 0 3px;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}.progress-fill,.available,.unavailable{display:block;height:100%}.running{background:var(--vscode-progressBar-background)}.pending,.failed,.unavailable{background:var(--vscode-editorError-foreground)}.completed{background:var(--vscode-testing-iconPassed)}.cancelled,.other{background:var(--vscode-descriptionForeground)}.availability-cell{display:flex;align-items:center;gap:3px;white-space:nowrap}.availability-cell>.availability{display:flex;flex:0 0 34px;margin:0;cursor:help}.available{background:var(--vscode-testing-iconPassed)}.fast-tooltip{position:fixed;z-index:100;display:none;max-width:220px;padding:3px 5px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));outline:1px solid #fff;border-radius:2px;background:var(--vscode-editorHoverWidget-background,var(--vscode-sideBar-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));font-size:11px;font-weight:400;line-height:1.25;white-space:normal;pointer-events:none}.times{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 4px;margin-top:6px;font-size:.72em;min-width:0}.times dt{color:var(--vscode-descriptionForeground);white-space:nowrap}.times dd{margin:0;min-width:0;white-space:normal;text-align:right}.times dd.dependency-value{overflow-wrap:anywhere}.actions{display:flex;flex-wrap:nowrap;align-items:center;gap:3px;margin-top:8px;min-width:0}.actions>.end-job{margin-left:auto}.actions>.compact-action{box-sizing:border-box;flex:0 0 auto;padding:2px 3px;font-size:.72em;line-height:1.4;white-space:nowrap}.action-icon{display:block;width:11px;height:11px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.78em}th,td{text-align:left;padding:3px 5px;border-bottom:1px solid var(--vscode-panel-border);white-space:nowrap}th{color:var(--vscode-descriptionForeground)}thead th:first-child,tbody td:first-child{padding-left:0}.partition-name-row th{padding:6px 0 1px;border-bottom:0;color:var(--vscode-foreground);font-weight:600}.gpu-model{cursor:help}.button{display:inline-block;padding:4px 7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);text-decoration:none;border-radius:2px}.button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.aggregate{opacity:.78}.welcome p{margin:8px 0}.command-line{white-space:pre-wrap;overflow-wrap:anywhere;padding:6px;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:.85em}.welcome-detail{margin-top:12px}.welcome-detail>summary{cursor:pointer}
.card>summary[data-full-name]::after{outline:1px solid #fff}
.card[open] .name{white-space:normal;overflow-wrap:anywhere}
.progress-message{display:block;max-width:100%;font-size:.72em;line-height:1.25;white-space:normal;overflow-wrap:anywhere}
.dependency-icon{display:inline-block;margin-left:2px;font-family:system-ui,sans-serif;font-weight:700;cursor:help}.dependency-icon.waiting{font-weight:400}.dependency-icon.satisfied{color:var(--vscode-testing-iconPassed)}.dependency-icon.failed{color:var(--vscode-errorForeground)}
.job-id:hover,.job-id:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}
button.button{border:0;font:inherit;cursor:pointer}
</style></head><body>${freshnessView(freshness.updatedAt)}${body}<script nonce="${nonce}">
(() => {
  const api = acquireVsCodeApi();
  const savedScrollY = Number(api.getState()?.scrollY) || 0;
  const rememberScroll = () => api.setState({ ...(api.getState() || {}), scrollY: window.scrollY });
  requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  let scrollFrame;
  window.addEventListener('scroll', () => {
    if (scrollFrame) return;
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
        fastTooltip.style.display = 'block';
        const targetBounds = target.getBoundingClientRect();
        const tooltipBounds = fastTooltip.getBoundingClientRect();
        fastTooltip.style.left = Math.max(4, Math.min(targetBounds.left, window.innerWidth - tooltipBounds.width - 4)) + 'px';
        const below = targetBounds.bottom + 4;
        fastTooltip.style.top = (below + tooltipBounds.height <= window.innerHeight ? below : Math.max(4, targetBounds.top - tooltipBounds.height - 4)) + 'px';
      }, FAST_HOVER_DELAY_MS);
    });
    target.addEventListener('mouseleave', hideFastTooltip);
  });
  window.addEventListener('scroll', hideFastTooltip, true);
  // Shared with the extension so the page keeps times current between refreshes.
  ${formatDuration.toString()}
  const dateFormat = ${JSON.stringify(dateFormat).replace(/</g, '\\u003c')};
  ${localTime.toString()}
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
    document.querySelectorAll('[data-wait]').forEach((cell) => {
      const [seconds, asOf] = JSON.parse(cell.dataset.wait);
      cell.textContent = formatDuration(Math.max(0, seconds - (now - asOf) / 1000));
    });
  };
  setInterval(tick, 5000);
  // A not-modified check still prompts an immediate local progress update.
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'checked') return;
    tick();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    event.preventDefault();
    rememberScroll();
    let args = [];
    try { args = JSON.parse(button.dataset.args || '[]'); } catch (_error) { args = []; }
    api.postMessage({ type: 'command', command: button.dataset.command, args });
  });
  const remember = (details) => api.postMessage({ type: 'disclosure', key: details.dataset.disclosureKey, open: details.open });
  document.querySelectorAll('details[data-disclosure-key]').forEach((details) => {
    details.addEventListener('toggle', () => {
      remember(details);
      if (!details.classList.contains('card')) return;
      details.classList.remove('layout-flash');
      void details.offsetWidth;
      details.classList.add('layout-flash');
      setTimeout(() => details.classList.remove('layout-flash'), 950);
    });
  });
  // Copy a job ID from the expanded detail row.
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

/**
 * Render the view shown when the service is reachable but was started without
 * ``--jobs-api``: why My Jobs is empty, and the command that fixes it.
 */
function renderJobsApiDisabled(title, command, freshness = {}) {
  const body = `<div class="welcome"><p>The Cluster Watcher service is running, but it was started without <code>--jobs-api</code>, so your jobs cannot be shown. Cluster Status still works.</p>`
    + `<p>Stop that service (Ctrl-C in its terminal), then start it with:</p><pre class="command-line">${escapeHtml(command)}</pre>`
    + `<p class="actions"><a class="button" role="button" ${commandAttributes('clusterWatcher.copyServiceCommand')}>Copy restart command</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.refresh')}>Retry</a></p>`
    + `<p class="muted">Or close it and use <b>Start service &amp; SSH sessions</b>, which always enables the jobs API.</p></div>`;
  return document(title, body, freshness);
}

/**
 * Render the first-run/offline view shown when the service cannot be reached:
 * guidance plus buttons to start the service, create or edit the
 * configuration, and open the extension settings. ``detail`` is the
 * connection error, kept in a collapsed section.
 */
function renderWelcome(title, detail, freshness = {}) {
  const body = `<div class="welcome"><p>The Cluster Watcher service is not reachable. Start it to see your jobs and cluster capacity; password and OTP prompts appear in its terminal.</p>`
    + `<p class="actions"><a class="button" role="button" ${commandAttributes('clusterWatcher.startService')}>Start service &amp; SSH sessions</a></p>`
    + `<p class="muted">First time? Describe your clusters with the setup wizard, or edit an existing configuration.</p>`
    + `<p class="actions"><a class="button secondary" role="button" ${commandAttributes('clusterWatcher.runSetup')}>Run setup wizard</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.editConfig')}>Edit configuration</a>`
    + `<a class="button secondary" role="button" ${commandAttributes('clusterWatcher.openSettings')}>Settings</a></p>`
    + `<details class="welcome-detail"><summary class="muted">Connection details</summary><p class="error">${escapeHtml(detail)}</p></details></div>`;
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
 * cancellation actions. ``cancelling`` holds refs whose cancellation was sent.
 */
function jobCard(job, archived, disclosures, cancelling = new Set(), asOf = Date.now(), jobs = []) {
  const identifier = String(job.job_id || job.id || 'unknown');
  const name = String(job.name || identifier);
  const hoverText = [job.cluster, identifier, name].filter(Boolean).join(' ');
  const nodes = Number(job.node_count) || (job.nodes || []).length;
  const resources = `${nodes} node · ${Number(job.gpus) || 0} GPU · ${Number(job.cpus) || 0} CPU`;
  const archiveCommand = archived ? 'clusterWatcher.restoreJob' : 'clusterWatcher.archiveJob';
  const key = jobKey(job);
  const actions = [
    archived
      ? `<a class="button compact-action" role="button" ${commandAttributes(archiveCommand, [key])} title="Restore job">Restore</a>`
      : `<a class="button compact-action archive-action" role="button" ${commandAttributes(archiveCommand, [key])} title="Archive job" aria-label="Archive job">${archiveIcon()}</a>`,
    `<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.openScript', [job.cluster, identifier])} title="Open the Slurm batch script this job ran" aria-label="Open batch script">script</button>`,
  ];
  if (stateGroup(job.state) !== 'PENDING') {
    actions.splice(1, 0,
      `<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.openLog', [job.cluster, identifier, 'err'])} title="Open .err log" aria-label="Open .err log">.err</button>`,
      `<button class="button secondary compact-action" ${commandButtonAttributes('clusterWatcher.openLog', [job.cluster, identifier, 'out'])} title="Open .out log" aria-label="Open .out log">.out</button>`,
    );
  }
  const ending = cancelling.has(jobRef(job));
  if (['RUNNING', 'PENDING'].includes(stateGroup(job.state)) && !ending) {
    actions.push(`<a class="button danger compact-action end-job" role="button" ${commandAttributes('clusterWatcher.cancelJob', [job.cluster, identifier, job.name || identifier])} title="End job" aria-label="End job">End</a>`);
  }
  const disclosureKey = `card:${archived ? 'archive' : 'active'}:${key}`;
  const metadata = `${job.cluster} / ${job.partition || 'no partition'} · ${resources}`;
  return `<details class="card" data-disclosure-key="${escapeHtml(disclosureKey)}" data-job-ref="${escapeHtml(jobRef(job))}"${openAttribute(disclosures, disclosureKey, false)}><summary data-full-name="${escapeHtml(hoverText)}"><span class="card-summary-title"><span class="name">${escapeHtml(name)}</span></span><span class="card-summary-progress">${jobProgress(job, asOf)}</span></summary><div class="card-body"><div class="muted card-meta" title="${escapeHtml(metadata)}"><span class="badge job-id${ending ? ' ending' : ''}" role="button" tabindex="0" data-copy="${escapeHtml(identifier)}" title="${escapeHtml(identifier)}${ending ? ' · ending' : ''} — click to copy">${escapeHtml(identifier)}</span> ${escapeHtml(metadata)}</div><dl class="times">${lifecycleRows(job, asOf)}${dependencyLinks(job, jobs)}</dl><div class="actions">${actions.join('')}</div></div></details>`;
}

/**
 * Render the jobs API using collapsible state and archive groups.
 * `disclosures` maps disclosure keys to remembered open/closed choices and
 * `cancelling` holds ``cluster/job_id`` refs whose End Job request was sent.
 */
function renderJobs(payload, disclosures = {}, cancelling = new Set(), freshness = {}) {
  const asOf = Date.parse(payload.generated_at || '') || Date.now();
  const ranks = new Map(['RUNNING', 'PENDING', 'FAILED_DEPENDENCY', 'COMPLETED', 'FAILED_EARLY', 'FAILED_TIMEOUT', 'CANCELLED', 'OTHER'].map((name, index) => [name, index]));
  const jobs = [...(payload.jobs || [])].sort((left, right) => {
    const groupDifference = ranks.get(jobGroup(left)) - ranks.get(jobGroup(right));
    if (groupDifference) return groupDifference;
    return String(right.submit_at || right.submit_time || '').localeCompare(String(left.submit_at || left.submit_time || ''));
  });
  const labels = { RUNNING: 'Running', PENDING: 'Pending', FAILED_DEPENDENCY: 'Failed Dependency', COMPLETED: 'Completed', FAILED_EARLY: 'Failed (Early)', FAILED_TIMEOUT: 'Failed (Timeout)', CANCELLED: 'Cancelled', OTHER: 'Other' };
  const archived = payload.archived_jobs || [];
  const knownJobs = [...jobs, ...archived];
  const rows = [];
  for (const group of ranks.keys()) {
    const grouped = jobs.filter((job) => jobGroup(job) === group);
    if (grouped.length) rows.push(`<details class="job-group" data-disclosure-key="group:active:${group}"${openAttribute(disclosures, `group:active:${group}`, true)}><summary>${labels[group]} (${grouped.length})</summary>${grouped.map((job) => jobCard(job, false, disclosures, cancelling, asOf, knownJobs)).join('')}</details>`);
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
 * Short labels for why a wait probe failed (the service's ``error_kind``).
 * Policy refusals get their own words, so ERR only marks real failures.
 */
const WAIT_ERROR_LABELS = { denied: 'DENY', minimum: 'min', limit: 'limit', unavailable: 'n/a', timeout: 'ERR', error: 'ERR', budget: '?' };

/** Classify a probe error from a service too old to send ``error_kind``. */
function waitErrorKind(estimate) {
  if (estimate.error_kind) return estimate.error_kind;
  return /permission denied|invalid account/i.test(estimate.error) ? 'denied' : 'error';
}

/**
 * Format a terminal-compatible wait cell: a duration, a failure label,
 * ``…`` while the cluster's first probes are still running (``pending``),
 * ``?`` when the shape was not probed, or ``—`` when it cannot fit.
 */
function waitCell(partition, count, pending = false) {
  const total = Number(partition.gpus?.total) || 0;
  if (count > total) return '—';
  const estimate = (partition.wait_estimates || []).find((row) => Number(row.gpus) === count);
  if (!estimate) return pending ? '…' : '?';
  if (estimate.error) return WAIT_ERROR_LABELS[waitErrorKind(estimate)] || 'ERR';
  return formatDuration(estimate.estimated_wait_seconds);
}

/** Return the hover text of a wait cell, including Slurm's message on failure. */
function waitTitle(partition, count, pending) {
  const estimate = (partition.wait_estimates || []).find((row) => Number(row.gpus) === count);
  const label = `Wait for ${count} GPU${count === 1 ? '' : 's'}`;
  if (estimate?.error) return `${label}: ${estimate.error}`;
  if (!estimate && pending && count <= (Number(partition.gpus?.total) || 0)) return `${label}: still checking`;
  return label;
}

/** Return a ``data-wait`` attribute so the webview can count a wait estimate down. */
function waitData(partition, count, asOf) {
  if (count > (Number(partition.gpus?.total) || 0)) return '';
  const estimate = (partition.wait_estimates || []).find((row) => Number(row.gpus) === count);
  const seconds = Number(estimate?.estimated_wait_seconds);
  if (!estimate || estimate.error || estimate.estimated_wait_seconds == null || !Number.isFinite(seconds)) return '';
  return ` data-wait="${escapeHtml(JSON.stringify([seconds, asOf]))}"`;
}

/**
 * Offer to re-open a cluster's closed SSH session. The login also covers
 * other closed clusters that share its password (credential group).
 */
function loginPrompt(cluster) {
  if (!cluster.login_required) return '';
  return `<p class="muted">The SSH session has closed.</p><div class="actions"><a class="button" ${commandAttributes('clusterWatcher.login', [String(cluster.name)])} title="Runs cluster-watcher login in a terminal. Closed clusters that share this password are included, so it is asked for once; each cluster asks for its own one-time code.">Log in again</a></div>`;
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

/** Build an availability tooltip, omitting node-state categories with no nodes. */
function availabilityTitle(partition) {
  const categories = new Map();
  for (const [state, rawCount] of Object.entries(partition.node_states || {})) {
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
  return nodes ? `Nodes: ${nodes}` : 'Node state details unavailable';
}

/**
 * Render the stable availability snapshot in cluster-separated tables.
 * `disclosures` maps disclosure keys to remembered open/closed choices.
 */
function renderStatus(payload, disclosures = {}, freshness = {}) {
  const asOf = Date.parse(payload.generated_at || '') || Date.now();
  const clusters = [];
  for (const cluster of payload.clusters || []) {
    const clusterName = escapeHtml(cluster.name);
    const rawKey = `cluster:${cluster.name}`;
    const disclosureKey = escapeHtml(rawKey);
    const open = openAttribute(disclosures, rawKey, true);
    if (!cluster.reachable) {
      clusters.push(`<details class="cluster-group" data-disclosure-key="${disclosureKey}"${open}><summary>${clusterName}</summary><p class="error">${escapeHtml(cluster.error || 'Cluster is unreachable')}</p>${loginPrompt(cluster)}</details>`);
      continue;
    }
    // No probe round has finished for this cluster yet (they start with the service).
    const pending = !cluster.wait_estimates_updated_at;
    const partitions = [...(cluster.partitions || [])].sort((left, right) => (Number(left.rank) || 9999) - (Number(right.rank) || 9999) || String(left.name).localeCompare(String(right.name)));
    const statusColumnCount = 5 + WAIT_GPU_COUNTS.length;
    const rows = partitions.map((partition) => {
      const profile = bestGpu(partition);
      const total = Number(partition.gpus?.total) || 0;
      const idle = Number(partition.gpus?.schedulable_idle) || 0;
      const availablePercent = total ? Math.max(0, Math.min(100, idle / total * 100)) : 0;
      const unavailablePercent = total ? 100 - availablePercent : 100;
      const availability = escapeHtml(availabilityTitle(partition));
      const waits = WAIT_GPU_COUNTS.map((count) => `<td title="${escapeHtml(waitTitle(partition, count, pending))}"${waitData(partition, count, asOf)}>${escapeHtml(waitCell(partition, count, pending))}</td>`).join('');
      const fullGpuName = profile?.name || '—';
      const aggregate = partition.aggregate ? ' aggregate' : '';
      return `<tbody class="partition-rows${aggregate}"><tr class="partition-name-row"><th colspan="${statusColumnCount}" scope="rowgroup">${escapeHtml(partition.name)}${partition.aggregate ? ' (aggregate)' : ''}</th></tr><tr><td><div class="availability-cell"><div class="availability" data-availability="${availability}" data-fast-tooltip="${availability}" aria-label="${availability}"><span class="available" style="width:${availablePercent}%"></span><span class="unavailable" style="width:${unavailablePercent}%"></span></div><span>${idle}/${total}</span></div></td><td class="gpu-model" data-fast-tooltip="${escapeHtml(fullGpuName)}" aria-label="${escapeHtml(fullGpuName)}">${escapeHtml(compactGpuName(fullGpuName))}</td><td>${profile?.vram_gb == null ? '—' : `${escapeHtml(profile.vram_gb)}G`}</td><td>${profile?.fp16_bf16_tensor_tflops == null ? '—' : escapeHtml(profile.fp16_bf16_tensor_tflops)}</td>${waits}<td>${escapeHtml(partition.cpus?.total ?? 0)}</td></tr></tbody>`;
    }).join('');
    clusters.push(`<details class="cluster-group" data-disclosure-key="${disclosureKey}"${open}><summary>${clusterName}</summary>${cluster.resource_error ? `<p class="error">${escapeHtml(cluster.resource_error)}</p>` : ''}<div class="table-wrap"><table><thead><tr><th>Available</th><th>GPU</th><th>VRAM</th><th>TFLOPS/s</th>${WAIT_GPU_COUNTS.map((count) => `<th>${count}</th>`).join('')}<th>CPU threads</th></tr></thead>${rows}</table></div></details>`);
  }
  return document('Cluster Status', clusters.join('') || '<p>No clusters returned.</p>', freshness);
}

module.exports = { DEFAULT_DATE_FORMAT, availabilityStateLabel, availabilityTitle, compactGpuName, localTime, setDateFormat, progressSpec, progressView, commandAttributes, commandButtonAttributes, dependencyStatus, escapeHtml, hasFailedDependency, isFailureGroup, jobGroup, jobRef, openAttribute, parseDependency, formatDuration, jobKey, lifecycle, renderJobs, renderJobsApiDisabled, renderMessage, renderStatus, renderWelcome, stateGroup, viewFreshness, waitCell };
