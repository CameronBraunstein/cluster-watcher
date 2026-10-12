'use strict';

/**
 * Hypothetical GPU-job wait estimates for Cluster Status: per-shape cell
 * labels and the log-log line chart drawn inside an expanded partition card.
 */

const { escapeHtml, formatDuration } = require('./format');

/** GPU counts probed per partition; powers of two, so they are evenly spaced on a log axis. */
const WAIT_GPU_COUNTS = [1, 2, 4, 8, 16, 32, 64];

/**
 * Short labels for why a wait probe failed (the service's ``error_kind``).
 * Policy refusals get their own words, so ERR only marks real failures.
 */
const WAIT_ERROR_LABELS = { denied: 'DENY', minimum: 'min', limit: 'limit', unavailable: 'n/a', timeout: 'ERR', error: 'ERR', budget: '?' };

/** Candidate wait-axis gridlines, in seconds, with their labels. */
const WAIT_AXIS_TICKS = [[60, '1m'], [600, '10m'], [3600, '1h'], [21600, '6h'], [86400, '1d'], [604800, '1w'], [2592000, '30d'], [31536000, '1y']];

/** Chart geometry in SVG user units; the SVG scales to the card width. */
const CHART = { width: 240, height: 108, left: 30, right: 8, top: 6, bottom: 20 };

/** Classify a probe error from a service too old to send ``error_kind``. */
function waitErrorKind(estimate) {
  if (estimate.error_kind) return estimate.error_kind;
  return /permission denied|invalid account/i.test(estimate.error) ? 'denied' : 'error';
}

/** Return the probe row for ``count`` GPUs, if any. */
function waitEstimate(partition, count) {
  return (partition.wait_estimates || []).find((row) => Number(row.gpus) === count);
}

/** Return whether a request for ``count`` GPUs can fit in the partition at all. */
function waitFits(partition, count) {
  return count <= (Number(partition.gpus?.total) || 0);
}

/**
 * Format a terminal-compatible wait label: a duration, a failure label,
 * ``…`` while the cluster's first probes are still running (``pending``),
 * ``?`` when the shape was not probed, or ``—`` when it cannot fit.
 */
function waitCell(partition, count, pending = false) {
  if (!waitFits(partition, count)) return '—';
  const estimate = waitEstimate(partition, count);
  if (!estimate) return pending ? '…' : '?';
  if (estimate.error) return WAIT_ERROR_LABELS[waitErrorKind(estimate)] || 'ERR';
  return formatDuration(estimate.estimated_wait_seconds);
}

/** Return the hover text of a wait shape, including Slurm's message on failure. */
function waitTitle(partition, count, pending) {
  const estimate = waitEstimate(partition, count);
  const label = `Wait for ${count} GPU${count === 1 ? '' : 's'}`;
  if (estimate?.error) return `${label}: ${estimate.error}`;
  if (!waitFits(partition, count)) return `${label}: exceeds the partition's ${Number(partition.gpus?.total) || 0} GPUs`;
  if (!estimate) return `${label}: ${pending ? 'still checking' : 'not probed'}`;
  return `${label}: ${formatDuration(estimate.estimated_wait_seconds)}`;
}

/** Return a successful estimate's wait in seconds, or ``null`` when there is none to plot. */
function waitSeconds(partition, count) {
  if (!waitFits(partition, count)) return null;
  const estimate = waitEstimate(partition, count);
  const seconds = Number(estimate?.estimated_wait_seconds);
  if (!estimate || estimate.error || estimate.estimated_wait_seconds == null || !Number.isFinite(seconds)) return null;
  return Math.max(0, seconds);
}

/**
 * Choose the log wait axis: it starts at one minute (shorter waits, including
 * "now", sit on that floor) and ends at the first gridline covering both one
 * hour and the longest plotted wait. Long ranges drop intermediate gridlines.
 */
function waitAxis(maxSeconds) {
  const floor = WAIT_AXIS_TICKS[0][0];
  const target = Math.max(3600, maxSeconds);
  const ceiling = WAIT_AXIS_TICKS.find(([seconds]) => seconds >= target)?.[0] ?? target;
  let ticks = WAIT_AXIS_TICKS.filter(([seconds]) => seconds <= ceiling);
  if (ticks.length > 5) ticks = ticks.filter(([seconds]) => seconds !== 600 && seconds !== 21600);
  return { floor, ceiling, ticks };
}

/**
 * Render wait time over requested GPU count as an inline SVG line chart with
 * logarithmic axes. Successful estimates are points joined by a line (broken
 * across shapes without an estimate); other shapes show their short label.
 * Each GPU column has a fast-hover target whose ``data-wait`` lets the webview
 * count the estimate down between refreshes. Returns ``''`` without GPUs.
 */
function waitChart(partition, pending = false, asOf = Date.now()) {
  if (!(Number(partition.gpus?.total) > 0)) return '';
  const waits = WAIT_GPU_COUNTS.map((count) => waitSeconds(partition, count));
  const axis = waitAxis(Math.max(0, ...waits.filter((seconds) => seconds != null)));
  const plotRight = CHART.width - CHART.right;
  const plotBottom = CHART.height - CHART.bottom;
  const step = (plotRight - CHART.left) / (WAIT_GPU_COUNTS.length - 1);
  const x = (index) => CHART.left + index * step;
  const logRange = Math.log(axis.ceiling) - Math.log(axis.floor);
  const y = (seconds) => plotBottom - (Math.log(Math.max(seconds, axis.floor)) - Math.log(axis.floor)) / logRange * (plotBottom - CHART.top);
  const round = (value) => Math.round(value * 10) / 10;

  const grid = axis.ticks.map(([seconds, label]) => `<line class="wait-grid" x1="${CHART.left}" x2="${plotRight}" y1="${round(y(seconds))}" y2="${round(y(seconds))}"/><text class="wait-axis" x="${CHART.left - 4}" y="${round(y(seconds) + 3)}" text-anchor="end">${label}</text>`).join('');
  const columns = WAIT_GPU_COUNTS.map((count, index) => `<text class="wait-axis" x="${round(x(index))}" y="${plotBottom + 11}" text-anchor="middle">${count}</text>`).join('');
  let path = '';
  waits.forEach((seconds, index) => {
    if (seconds == null) return;
    path += `${waits[index - 1] == null ? 'M' : 'L'}${round(x(index))} ${round(y(seconds))}`;
  });
  const line = path ? `<path class="wait-line" d="${path}"/>` : '';
  const marks = waits.map((seconds, index) => (seconds == null
    ? `<text class="wait-status" x="${round(x(index))}" y="${plotBottom - 3}" text-anchor="middle">${escapeHtml(waitCell(partition, WAIT_GPU_COUNTS[index], pending))}</text>`
    : `<circle class="wait-point" cx="${round(x(index))}" cy="${round(y(seconds))}" r="3"/>`)).join('');
  const targets = WAIT_GPU_COUNTS.map((count, index) => {
    const title = waitTitle(partition, count, pending);
    const seconds = waits[index];
    const wait = seconds == null ? '' : ` data-wait="${escapeHtml(JSON.stringify([seconds, asOf, title.replace(/:.*$/, '')]))}"`;
    return `<rect class="wait-hit" x="${round(x(index) - step / 2)}" y="0" width="${round(step)}" height="${plotBottom}" pointer-events="all" data-fast-tooltip="${escapeHtml(title)}"${wait}/>`;
  }).join('');
  const summary = WAIT_GPU_COUNTS.map((count) => `${count}: ${waitCell(partition, count, pending)}`).join(', ');
  const description = `Estimated wait by GPUs requested (${summary})`;
  return `<figure class="wait-figure"><svg class="wait-chart" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${escapeHtml(description)}">${grid}<line class="wait-baseline" x1="${CHART.left}" x2="${plotRight}" y1="${plotBottom}" y2="${plotBottom}"/>${columns}${line}${marks}${targets}</svg><figcaption class="muted wait-caption">Estimated wait vs. GPUs requested (log scales)</figcaption></figure>`;
}

module.exports = { WAIT_GPU_COUNTS, waitAxis, waitCell, waitChart, waitSeconds, waitTitle };
