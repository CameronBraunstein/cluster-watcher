'use strict';

/** Compact, account-aware start estimates for standard GPU job shapes. */

const { escapeHtml, formatDuration } = require('./format');

const WAIT_GPU_COUNTS = [1, 2, 4, 8, 16, 32, 64];
const DEFAULT_WAIT_THRESHOLDS_MINUTES = [5, 30, 60, 120];
const WAIT_ERROR_LABELS = {
  denied: 'DENY', minimum: 'min', limit: 'limit', unavailable: 'n/a',
  timeout: 'ERR', error: 'ERR', budget: '?',
};

/** Classify an older service's untyped wait-probe error conservatively. */
function waitErrorKind(estimate) {
  if (estimate?.error_kind) return estimate.error_kind;
  return /permission denied|invalid account/i.test(estimate?.error || '') ? 'denied' : 'error';
}

/** Select the probe nearest one hour, preferring a shorter capped runtime. */
function waitEstimate(partition, count) {
  const rows = (partition.wait_estimates || []).filter((row) => Number(row.gpus) === count);
  if (rows.length < 2) return rows[0];
  return [...rows].sort((left, right) => {
    const leftSeconds = Number(left.walltime_seconds) || 3600;
    const rightSeconds = Number(right.walltime_seconds) || 3600;
    return Math.abs(leftSeconds - 3600) - Math.abs(rightSeconds - 3600)
      || leftSeconds - rightSeconds;
  })[0];
}

/** Return whether this GPU count can fit in the partition at all. */
function waitFits(partition, count) {
  return count <= (Number(partition.gpus?.total) || 0);
}

/** Return the concise text used in accessible strip summaries. */
function waitCell(partition, count, pending = false) {
  if (!waitFits(partition, count)) return '—';
  const estimate = waitEstimate(partition, count);
  if (!estimate) return pending ? '…' : '?';
  if (estimate.error) return WAIT_ERROR_LABELS[waitErrorKind(estimate)] || 'ERR';
  return formatDuration(estimate.estimated_wait_seconds);
}

/** Map a successful wait to one of five green-to-red configured buckets. */
function waitColorIndex(seconds, thresholds = DEFAULT_WAIT_THRESHOLDS_MINUTES) {
  const limits = Array.isArray(thresholds) && thresholds.length
    ? thresholds.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : DEFAULT_WAIT_THRESHOLDS_MINUTES;
  const minutes = Math.max(0, Number(seconds) || 0) / 60;
  const bucket = limits.findIndex((limit) => minutes < limit);
  const index = bucket < 0 ? limits.length : bucket;
  return Math.round(index * 4 / limits.length);
}

/** Describe the actual runtime used when a short development partition caps it. */
function runtimeLabel(estimate) {
  const seconds = Number(estimate?.walltime_seconds) || 3600;
  return seconds < 3600 ? `${Math.round(seconds / 60)}m job` : '1h job';
}

/** Build exact hover text for one standard job shape. */
function waitTitle(partition, count, pending = false) {
  const estimate = waitEstimate(partition, count);
  const label = `${count} GPU${count === 1 ? '' : 's'} · ${runtimeLabel(estimate)}`;
  if (!waitFits(partition, count)) return `${label}: exceeds the partition's ${Number(partition.gpus?.total) || 0} GPUs`;
  if (!estimate) return `${label}: ${pending ? 'still checking' : 'not probed'}`;
  if (estimate.error) return `${label}: ${estimate.error}`;
  const start = estimate.expected_start_at ? `; expected start ${estimate.expected_start_at}` : '';
  return `${label}: ${formatDuration(estimate.estimated_wait_seconds)} estimated wait${start}`;
}

/**
 * Render seven GPU-count blocks in a collapsed partition summary. Successful
 * probes use configured wait colors; policy failures, missing probes, and
 * unsupported shapes remain visually distinct and retain exact hover text.
 */
function launchabilityStrip(
  partition, pending = false, asOf = Date.now(),
  thresholds = DEFAULT_WAIT_THRESHOLDS_MINUTES,
) {
  if (!(Number(partition.gpus?.total) > 0)) return '';
  const blocks = WAIT_GPU_COUNTS.map((count) => {
    const estimate = waitEstimate(partition, count);
    let state = 'launch-missing';
    let content = '?';
    let dynamic = '';
    if (!waitFits(partition, count)) {
      state = 'launch-unsupported';
      content = '—';
    } else if (!estimate) {
      state = pending ? 'launch-pending' : 'launch-missing';
      content = pending ? '…' : '?';
    } else if (estimate.error) {
      const kind = waitErrorKind(estimate);
      state = ['denied', 'minimum', 'limit'].includes(kind) ? 'launch-blocked' : 'launch-missing';
      content = state === 'launch-blocked' ? '×' : WAIT_ERROR_LABELS[kind] === 'ERR' ? '!' : '?';
    } else {
      const seconds = Math.max(0, Number(estimate.estimated_wait_seconds) || 0);
      state = `launch-wait-${waitColorIndex(seconds, thresholds)}`;
      dynamic = ` data-launch-wait="${escapeHtml(JSON.stringify([seconds, asOf, `${count} GPU${count === 1 ? '' : 's'} · ${runtimeLabel(estimate)}`, thresholds, estimate.expected_start_at || '']))}"`;
      content = '';
    }
    const title = waitTitle(partition, count, pending);
    return `<span class="launch-shape"><span class="launch-count">${count}</span><span class="launch-block ${state}" role="img" aria-label="${escapeHtml(title)}" data-fast-tooltip="${escapeHtml(title)}"${dynamic}>${content}</span></span>`;
  }).join('');
  const summary = WAIT_GPU_COUNTS.map((count) => `${count}: ${waitCell(partition, count, pending)}`).join(', ');
  return `<span class="launchability" role="group" aria-label="Estimated launch wait by GPUs requested (${escapeHtml(summary)})">${blocks}</span>`;
}

module.exports = {
  DEFAULT_WAIT_THRESHOLDS_MINUTES, WAIT_GPU_COUNTS, launchabilityStrip,
  runtimeLabel, waitCell, waitColorIndex, waitEstimate, waitFits, waitTitle,
};
