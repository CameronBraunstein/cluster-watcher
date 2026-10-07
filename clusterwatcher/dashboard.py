"""Local HTTP dashboard and periodic status cache."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import sys
import threading
import time
import webbrowser
from dataclasses import asdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import re
import socket
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit

from .commands import (
    MAX_COMMAND_TIMEOUT_SECONDS,
    RemoteCommandService,
    SessionUnavailableError,
    UnknownMachineError,
)
from .config import DEFAULT_WAIT_THRESHOLD_MINUTES
from .credentials import establish_interactive_sessions
from .job_scripts import JobScriptNotFound
from .jobs import JobLogNotFound, JobService, parse_since
from .models import ClusterStatus, Machine
from .slurm import collect_status
from .ssh import session_status
from .snapshot import build_snapshot
from .wait_probes import WAIT_PROBE_REFRESH_SECONDS, collect_wait_estimates


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cluster Watcher</title><style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
header { margin-bottom:1rem; } .title-row { display:flex; align-items:center; gap:1rem; } .title-row h1 { margin:.45rem 0; } #updated { color:#777; font-size:.9rem; }
.refresh-countdown { display:inline-flex; align-items:center; gap:.5rem; font-size:.8rem; color:#666; }
.refresh-clock { width:1.8rem; height:1.8rem; flex:none; }
.refresh-clock-face { fill:none; stroke:currentColor; stroke-width:1.5; }
.refresh-clock-tick { stroke:currentColor; stroke-width:1.25; stroke-linecap:round; opacity:.6; }
.refresh-clock-hand { stroke:#2563eb; stroke-width:2; stroke-linecap:round; transform-origin:12px 12px; transition:transform .25s linear; }
.refresh-clock-center { fill:#2563eb; }
.cluster { border:1px solid #8885; border-radius:.5rem; margin:1rem 0; padding:1rem; }
.key { border:1px solid #8885; border-radius:.5rem; margin:1rem 0; padding:1rem; }
.key h2 { margin-top:0; } .key-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:.5rem 1.5rem; }
.key-grid p { margin:.35rem 0; }
.my-jobs { border:1px solid #2563eb66; background:#2563eb0c; border-radius:.5rem; margin:1rem 0; padding:1rem; }
.my-jobs h2 { margin:0 0 .75rem; } .job-group { margin:.7rem 0; } .job-group > summary { cursor:pointer; font-weight:700; }
.job-card-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:.65rem; margin:.65rem 0; }
.job-card { border:1px solid #8885; border-radius:.4rem; background:Canvas; } .job-card > summary { display:grid; gap:.25rem; padding:.7rem; cursor:pointer; }
.job-card-summary-title { display:flex; justify-content:space-between; gap:.5rem; align-items:baseline; }
.job-card-body { padding:0 .7rem .7rem; } .job-card-actions, .job-sort-controls { display:flex; flex-wrap:wrap; gap:.4rem; margin:.55rem 0; }
.job-card-actions button, .job-sort-controls button { cursor:pointer; }
.job-times { display:grid; grid-template-columns:auto 1fr; gap:.2rem .7rem; margin:.55rem 0; font-size:.8rem; } .job-times dt { color:#666; } .job-times dd { margin:0; text-align:right; }
.job-name { font-weight:700; overflow-wrap:anywhere; } .job-location, .job-resources, .job-id { color:#666; font-size:.78rem; } .job-state { font-size:.74rem; text-transform:uppercase; letter-spacing:.04em; }
.job-progress { display:block; margin-top:.5rem; } .job-progress-track { display:block; height:.62rem; overflow:hidden; border-radius:999px; background:#8883; }
.job-progress-fill { display:block; height:100%; background:#2563eb; transition:width 1s linear; } .job-progress-text { display:block; margin-top:.22rem; font-size:.76rem; color:#666; }
.job-progress.pending .job-progress-fill { background:#7c3aed; } .job-message { margin-top:.5rem; font-size:.78rem; color:#666; }
.job-progress.completed .job-progress-fill { background:#16a34a; } .job-progress.failed .job-progress-fill { background:#dc2626; } .job-progress.cancelled .job-progress-fill, .job-progress.other .job-progress-fill { background:#6b7280; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0, 0, 0, 0); white-space:nowrap; border:0; }
.archived-jobs { margin-top:1rem; border-top:1px solid #8884; padding-top:.75rem; } .archived-jobs > summary { cursor:pointer; font-weight:700; }
.job-card .job-progress { margin-top:.5rem; } .log-tail { max-width:720px; max-height:20rem; overflow:auto; white-space:pre-wrap; font-size:.75rem; background:#111; color:#eee; padding:.5rem; border-radius:.3rem; }
.log-button { white-space:nowrap; cursor:pointer; }
.partition-section { margin:1.25rem 0; } .partition-heading { display:flex; align-items:center; gap:.65rem; margin:0 0 .55rem; } .partition-heading h3 { margin:0; }
.partition-status { display:flex; flex-wrap:wrap; gap:2px; } .node-state-block { width:.75rem; height:.75rem; border-radius:2px; }
.partition-compute { color:#666; font-size:.8rem; margin:-.2rem 0 .55rem; }
.wait-chart { margin:.8rem 0 1.2rem; max-width:720px; } .wait-chart figcaption { font-size:.8rem; margin-bottom:.45rem; }
.wait-chart-layout { display:grid; grid-template-columns:2.8rem minmax(260px, 1fr); gap:.4rem; }
.wait-y-axis { height:190px; position:relative; font-size:.68rem; color:#666; }
.wait-y-axis span { position:absolute; right:0; transform:translateY(50%); }
.wait-groups { height:190px; display:flex; align-items:stretch; border-left:1px solid #8888; border-bottom:1px solid #8888; background:repeating-linear-gradient(to top, transparent 0, transparent calc(25% - 1px), #8883 25%); }
.wait-group { position:relative; flex:1; min-width:54px; display:flex; align-items:flex-end; justify-content:center; gap:4px; padding:0 .25rem; }
.wait-bar { width:min(18px, 24%); min-height:2px; position:relative; border-radius:3px 3px 0 0; cursor:help; }
.wait-bar.wait-series-0 { background:#2563eb; } .wait-bar.wait-series-1 { background:#7c3aed; } .wait-bar.wait-series-2 { background:#ea580c; }
.wait-bar.unavailable { height:10px !important; background:repeating-linear-gradient(135deg, #777 0 3px, transparent 3px 6px); border:1px solid #777; }
.wait-bar.capped::after { content:'+'; position:absolute; top:-1rem; width:100%; text-align:center; font-size:.7rem; font-weight:700; }
.wait-group-label { position:absolute; top:calc(100% + .28rem); font-size:.7rem; white-space:nowrap; }
.wait-chart-key { display:flex; flex-wrap:wrap; gap:.35rem .8rem; margin:.8rem 0 0 3.2rem; font-size:.72rem; color:#666; }
.wait-key-item { display:inline-flex; align-items:center; gap:.3rem; } .wait-key-swatch { width:.75rem; height:.75rem; border-radius:2px; }
.partition-section > summary { cursor:pointer; } .partition-section > summary .partition-heading { display:inline-flex; margin:0; }
.node-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:.65rem; }
.node { border:1px solid #8884; border-radius:.4rem; padding:.75rem; }
.node.mine { outline:2px solid #2563eb; outline-offset:2px; } .cell.mine { outline:2px solid #2563eb; outline-offset:1px; }
.cell-row { display:flex; flex-wrap:wrap; gap:2px; margin:.25rem 0 .4rem; } .cell { border-radius:2px; }
.gpu-cell { width:1.1rem; height:1.1rem; } .cpu-cell { width:.42rem; height:.42rem; }
.powered-off { background:#000; } .drained { background:#8b4513; } .allocated { background:#dc2626; } .mixed-powered-off { background:#f97316; } .mixed { background:#eab308; } .idle { background:#16a34a; } .unknown { background:#6b7280; } .other { background:#eab308; }
.legend { display:flex; flex-wrap:wrap; gap:.35rem .75rem; font-size:.85rem; }
.legend-item { display:inline-flex; gap:.3rem; align-items:center; } .swatch { width:.7rem; height:.7rem; border-radius:50%; }
.error { color:#c33; white-space:pre-wrap; }
.job-badges { display:flex; flex-wrap:wrap; gap:.35rem; } .job-badge { border:1px solid #8885; border-radius:.55rem; font-size:.82rem; padding:.2rem .5rem; white-space:nowrap; }
.job-badge .job-progress { display:inline-grid; grid-template-columns:70px auto; align-items:center; gap:.35rem; margin:0 0 0 .35rem; } .job-badge .job-progress-track { width:70px; height:.4rem; } .job-badge .job-progress-text { margin:0; }
@media (max-width:600px) { .title-row { flex-wrap:wrap; gap:.25rem .75rem; } .wait-chart-key { margin-left:0; } .job-badge .job-progress { display:none; } }
</style></head><body><header><div class="title-row"><h1>Cluster Watcher</h1><span id="updated">Loading…</span><div class="refresh-countdown"><svg class="refresh-clock" viewBox="0 0 24 24" role="img" aria-labelledby="refresh-label"><circle class="refresh-clock-face" cx="12" cy="12" r="9.5"></circle><path class="refresh-clock-tick" d="M12 3.8v1.4M20.2 12h-1.4M12 20.2v-1.4M3.8 12h1.4"></path><line id="refresh-clock-hand" class="refresh-clock-hand" x1="12" y1="12" x2="12" y2="5"></line><circle class="refresh-clock-center" cx="12" cy="12" r="1.25"></circle></svg><span id="refresh-label">Waiting for first refresh…</span></div></div></header>
<section class="my-jobs"><h2>My jobs</h2><div id="my-jobs-content">Waiting for job data…</div></section>
<section class="key"><h2>How to read this dashboard</h2><div class="key-grid"><div><p><i class="swatch powered-off"></i> <b>Drained (powered off)</b> — unavailable and powered off.</p><p><i class="swatch drained"></i> <b>Drained</b> — removed from scheduling by an administrator.</p><p><i class="swatch allocated"></i> <b>Allocated</b> — fully assigned to jobs, including GPU-saturated nodes.</p></div><div><p><i class="swatch mixed-powered-off"></i> <b>Mixed~</b> — partly allocated and powered off/transitioning.</p><p><i class="swatch mixed"></i> <b>Mixed</b> — some resources are assigned to jobs and some remain free.</p><p><i class="swatch idle"></i> <b>Idle</b> — available for eligible new jobs.</p><p><b>Blue outlines</b> mark nodes and resource cells allocated to your running jobs. Pending-job times are Slurm scheduler estimates; node release times are only the earliest visible running-job end, not a promise.</p></div></div></section>
<main id="clusters"></main><script>
const escapeHtml = value => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const asNumber = value => /^\\d+$/.test(value) ? Number(value) : 0;
function cells(kind, count, cellClass, label, mineCount = 0) {
  return Array.from({ length: asNumber(count) }, (_, index) => `<i class="cell ${cellClass} ${kind}${index < mineCount ? ' mine' : ''}" title="${escapeHtml(label)}"></i>`).join('');
}

function resourceCells(label, resource, cellClass, mineCount) {
  if (!resource || !resource.total) return '';
  const allocated = asNumber(resource.allocated), idle = asNumber(resource.idle), total = asNumber(resource.total);
  const unavailable = Math.max(0, total - allocated - idle);
  const accessibleLabel = `${label}: ${allocated} allocated, ${idle} idle, ${unavailable} unavailable, ${total} total`;
  return `<div class="cell-row" role="img" aria-label="${escapeHtml(accessibleLabel)}">${cells('idle', idle, cellClass, `${label}: idle`)}${cells('other', unavailable, cellClass, `${label}: unavailable`)}${cells('allocated', allocated, cellClass, `${label}: allocated`, Math.min(mineCount, allocated))}</div>`;
}

function stateClass(state) {
  const value = String(state).toLowerCase();
  if (value.startsWith('mixed') && value.includes('~')) return 'mixed-powered-off';
  if (value.startsWith('drained') && value.includes('~')) return 'powered-off';
  if (value.startsWith('drained')) return 'drained';
  if (value.startsWith('allocated')) return 'allocated';
  if (value.startsWith('mixed')) return 'mixed';
  if (value.startsWith('idle')) return 'idle';
  return 'unknown';
}

function nodeCard(node) {
  const mine = node.my_usage || {}, hasMine = asNumber(mine.gpus) || asNumber(mine.cpus);
  const gpu = node.gpu || {}, cpu = node.cpu || {};
  const hasFreeResource = asNumber(gpu.total) ? asNumber(gpu.idle) : asNumber(cpu.idle);
  const wait = hasFreeResource ? 'Resources available now' : node.next_release ? `Earliest visible resource release: ${node.next_release}` : 'No node release estimate available';
  return `<article class="node${hasMine ? ' mine' : ''}" title="${escapeHtml(node.name)} · ${escapeHtml(node.state)} · ${escapeHtml(wait)}">${resourceCells('GPUs', gpu, 'gpu-cell', asNumber(mine.gpus))}${resourceCells('CPUs', node.cpu, 'cpu-cell', asNumber(mine.cpus))}</article>`;
}

function statePriority(node) {
  return { idle: 0, mixed: 1, 'mixed-powered-off': 2, allocated: 3, drained: 4, 'powered-off': 5, unknown: 6 }[summaryStateClass(node)];
}

function summaryStateClass(node) {
  const gpu = node.gpu || {};
  return asNumber(gpu.total) && !asNumber(gpu.idle) ? 'allocated' : stateClass(node.state);
}

function nodesByAvailableGpu(nodes) {
  return [...nodes].sort((left, right) => asNumber(right.gpu?.idle) - asNumber(left.gpu?.idle) || asNumber(right.cpu?.idle) - asNumber(left.cpu?.idle) || String(left.name).localeCompare(String(right.name)));
}

function partitionGroups(nodes, compute) {
  const groups = new Map();
  for (const node of nodes) {
    const names = String(node.partitions || '').split(',').filter(name => name && name !== '(null)');
    for (const name of names.length ? names : ['unassigned']) {
      const group = groups.get(name) || [];
      group.push(node); groups.set(name, group);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => (compute.get(left)?.rank || Infinity) - (compute.get(right)?.rank || Infinity) || left.localeCompare(right));
}

function durationLabel(minutes) {
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
  return `${minutes} minutes`;
}

function waitLabel(startTime, thresholds) {
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return 'estimate unavailable';
  const minutes = Math.max(0, (start.getTime() - Date.now()) / 60000);
  for (const threshold of thresholds) if (minutes < threshold) return `< ${durationLabel(threshold)}`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return `~${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function formatSeconds(value, withSeconds = false) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), minutes = Math.floor((seconds % 3600) / 60), remainder = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  if (withSeconds && !days) parts.push(`${remainder}s`);
  return parts.join(' ') || (withSeconds ? '0s' : '< 1m');
}

function allottedRuntime(job) {
  const total = Number(job.time_limit_seconds);
  if (job.time_limit_seconds != null && Number.isFinite(total) && total > 0) return `${formatSeconds(total)} allotted`;
  if (job.time_limit && !['N/A', 'NOT_SET'].includes(job.time_limit)) return `${job.time_limit} allotted`;
  return 'allotted runtime unavailable';
}

function runningJobProgress(job, compact = false) {
  const total = Number(job.time_limit_seconds), reportedElapsed = Number(job.elapsed_seconds), reportedRemaining = Number(job.time_left_seconds);
  const elapsed = job.elapsed_seconds != null ? reportedElapsed : job.time_left_seconds != null ? Math.max(0, total - reportedRemaining) : NaN;
  if (job.time_limit_seconds == null || !Number.isFinite(total) || total <= 0 || !Number.isFinite(elapsed)) {
    return `<span class="job-progress-text">${escapeHtml(allottedRuntime(job))}</span>`;
  }
  return `<span class="job-progress" data-running-progress data-total-seconds="${total}" data-elapsed-seconds="${Math.max(0, elapsed)}" data-sampled-at="${Date.now()}" data-compact="${compact}" role="progressbar" aria-valuemin="0" aria-valuemax="${total}"><span class="job-progress-track"><span class="job-progress-fill"></span></span><span class="job-progress-text"></span></span>`;
}

function pendingJobProgress(job) {
  const dependency = String(job.dependency || '').trim(), runtime = allottedRuntime(job);
  if (dependency && !['(null)', 'NULL', 'None', 'N/A'].includes(dependency)) {
    return `<span class="job-progress pending" role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><span class="job-progress-track"><span class="job-progress-fill" style="width:0%"></span></span><span class="job-progress-text">Waiting for dependency: ${escapeHtml(dependency)}. No start estimate is available until it clears · ${escapeHtml(runtime)}.</span></span>`;
  }
  const submittedAt = new Date(job.submit_time).getTime(), startAt = new Date(job.start_time).getTime();
  if (!Number.isFinite(submittedAt) || !Number.isFinite(startAt) || startAt <= submittedAt) {
    return `<span class="job-progress pending" role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><span class="job-progress-track"><span class="job-progress-fill" style="width:0%"></span></span><span class="job-progress-text">Slurm cannot currently estimate when this job will start · ${escapeHtml(runtime)}.</span></span>`;
  }
  const waitSeconds = Math.max(1, Math.round((startAt - submittedAt) / 1000));
  return `<span class="job-progress pending" data-pending-progress data-submitted-at="${submittedAt}" data-start-at="${startAt}" data-wait-seconds="${waitSeconds}" data-runtime-label="${escapeHtml(runtime)}" role="progressbar" aria-valuemin="0" aria-valuemax="${waitSeconds}"><span class="job-progress-track"><span class="job-progress-fill"></span></span><span class="job-progress-text"></span></span>`;
}

function pendingJobStatus(job, thresholds) {
  const dependency = String(job.dependency || '').trim();
  const waitingForDependency = dependency && !['(null)', 'NULL', 'None', 'N/A'].includes(dependency);
  return waitingForDependency ? 'waiting for dependency' : waitLabel(job.start_time, thresholds);
}

function jobBadges(jobs, partition, thresholds) {
  return (jobs || []).filter(job => job.partition === partition).map(job => {
    const name = job.name || job.id, dependency = String(job.dependency || '').trim();
    const title = dependency && !['(null)', 'NULL', 'None', 'N/A'].includes(dependency) ? `Job ${job.id} · remaining dependency: ${dependency}` : `Job ${job.id}`;
    if (job.state === 'RUNNING') return `<span class="job-badge" title="${escapeHtml(title)}">▶ ${escapeHtml(name)}${runningJobProgress(job, true)}</span>`;
    return `<span class="job-badge" title="${escapeHtml(title)}">⌛ ${escapeHtml(name)}: ${escapeHtml(pendingJobStatus(job, thresholds))}</span>`;
  }).join('');
}

function requestedRuntime(minutes) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

// Why a probe failed (see wait_probes.classify_wait_error).
const waitErrorLabels = { denied: 'access denied', minimum: 'below the minimum request', limit: 'over a limit', unavailable: 'no node can run it now', timeout: 'Slurm did not answer in time', budget: 'not checked', error: 'error' };
function waitChart(estimates, partition, updatedAt) {
  const rows = estimates?.[partition];
  if (!rows?.length) return updatedAt ? '' : '<p>Checking queue waits…</p>';
  const byGpus = new Map();
  const durationMinutes = row => row.walltime_minutes ?? Math.round(row.walltime_hours * 60);
  for (const row of rows) { const values = byGpus.get(row.gpus) || new Map(); values.set(durationMinutes(row), row); byGpus.set(row.gpus, values); }
  const durations = [...new Set(rows.map(durationMinutes))].sort((left, right) => left - right);
  const groups = [...byGpus.entries()].sort(([left], [right]) => left - right).map(([gpus, values]) => {
    const memoryMb = [...values.values()][0]?.memory_mb;
    const bars = durations.map((duration, index) => {
      const row = values.get(duration), start = row?.start_time ? new Date(row.start_time) : null;
      const waitHours = start && !Number.isNaN(start.getTime()) ? Math.max(0, (start.getTime() - Date.now()) / 3600000) : null;
      const unavailable = waitHours === null, capped = waitHours !== null && waitHours > 24;
      const height = unavailable ? 0 : Math.max(.8, Math.min(100, waitHours / 24 * 100));
      const waitText = unavailable ? `unavailable${row?.error_kind ? ` (${waitErrorLabels[row.error_kind] || row.error_kind})` : ''}${row?.error ? `: ${row.error}` : ''}` : `${waitHours.toFixed(1)} hours${capped ? ' (chart capped at 24)' : ''}`;
      const title = `${gpus} GPU${gpus === 1 ? '' : 's'}, ${requestedRuntime(duration)} runtime: ${waitText}`;
      return `<span class="wait-bar wait-series-${index % 3}${unavailable ? ' unavailable' : ''}${capped ? ' capped' : ''}" style="height:${height}%" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
    }).join('');
    const request = `${gpus} GPU${gpus === 1 ? '' : 's'}${memoryMb ? ` · ${memoryMb} MiB` : ''}`;
    return `<div class="wait-group" title="${escapeHtml(request)}">${bars}<span class="wait-group-label">${gpus} GPU${gpus === 1 ? '' : 's'}</span></div>`;
  }).join('');
  const key = durations.map((duration, index) => `<span class="wait-key-item"><i class="wait-key-swatch wait-bar wait-series-${index % 3}"></i>${requestedRuntime(duration)} requested runtime</span>`).join('');
  const refreshed = updatedAt ? ` Probed ${new Date(updatedAt).toLocaleTimeString()}.` : '';
  return `<figure class="wait-chart"><figcaption>Estimated queue wait in hours (0–24; + means over 24h).${escapeHtml(refreshed)}</figcaption><div class="wait-chart-layout"><div class="wait-y-axis"><span style="bottom:100%">24h</span><span style="bottom:75%">18h</span><span style="bottom:50%">12h</span><span style="bottom:25%">6h</span><span style="bottom:0">0h</span></div><div class="wait-groups" role="img" aria-label="Estimated queue wait by GPU count and requested runtime">${groups}</div></div><div class="wait-chart-key">${key}<span class="wait-key-item"><i class="wait-key-swatch wait-bar unavailable"></i>Unavailable</span></div></figure>`;
}

const JOB_ARCHIVE_STORAGE_KEY = 'cluster-watcher.archived-jobs.v1';
const jobSorts = {
  active: { key: 'state', direction: 'asc' },
  archived: { key: 'submitted', direction: 'desc' },
};
let currentJobs = [], jobWarnings = '', jobsApiEnabled = false;
const jobDisclosure = new Map();

function jobId(job) { return String(job.job_id || job.id || 'unknown'); }
function jobSubmittedAt(job) { return job.submit_at || job.submit_time || null; }
function jobSubmissionDate(job) {
  const value = jobSubmittedAt(job);
  if (!value) return null;
  const normalized = job.submit_at && !/[zZ]|[+-]\\d\\d:\\d\\d$/.test(value) ? `${value}Z` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
const FAILED_JOB_STATES = new Set(['BOOT_FAIL', 'DEADLINE', 'FAILED', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'REVOKED', 'SPECIAL_EXIT', 'TIMEOUT']);
function jobLifecycleDate(job, event) {
  const state = String(job.state || '').toUpperCase();
  const visible = event === 'launched' ? state === 'RUNNING' || state === 'COMPLETED' || FAILED_JOB_STATES.has(state) : state === 'COMPLETED' || FAILED_JOB_STATES.has(state);
  if (!visible) return { applicable: false, value: null, raw: null };
  const raw = event === 'launched' ? job.start_at || job.start_time : job.end_at;
  if (!raw) return { applicable: true, value: null, raw: null };
  const parsed = new Date(raw);
  return { applicable: true, value: Number.isNaN(parsed.getTime()) ? null : parsed, raw };
}
function jobLifecycleCell(job, event) {
  const timestamp = jobLifecycleDate(job, event);
  if (!timestamp.applicable) return '<span aria-label="Not applicable">—</span>';
  if (!timestamp.value) return 'Unavailable';
  return `<time datetime="${escapeHtml(timestamp.raw)}">${escapeHtml(timestamp.value.toLocaleString())}</time>`;
}
function jobArchiveKey(job) {
  const submitted = jobSubmissionDate(job);
  return JSON.stringify([String(job.cluster || ''), jobId(job), submitted ? submitted.toISOString() : '']);
}

function loadJobStorage() {
  try {
    const document = JSON.parse(localStorage.getItem(JOB_ARCHIVE_STORAGE_KEY) || '{}');
    if (document.version !== 1 || !Array.isArray(document.jobs)) return { archived: new Map(), restored: new Map() };
    const toMap = jobs => new Map((jobs || []).filter(job => job && typeof job === 'object').map(job => [jobArchiveKey(job), job]));
    return { archived: toMap(document.jobs), restored: toMap(document.restored_jobs) };
  } catch (error) {
    console.warn('Could not read the local job archive:', error);
    return { archived: new Map(), restored: new Map() };
  }
}

const storedJobs = loadJobStorage(), archivedJobs = storedJobs.archived, restoredJobs = storedJobs.restored;

function persistArchivedJobs() {
  try {
    localStorage.setItem(JOB_ARCHIVE_STORAGE_KEY, JSON.stringify({ version: 1, jobs: [...archivedJobs.values()], restored_jobs: [...restoredJobs.values()] }));
  } catch (error) {
    console.warn('Could not persist the local job archive:', error);
  }
}

function compareText(left, right) { return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base', numeric: true }); }
function nodeCount(job) { return Number(job.node_count) || (job.nodes || []).length; }

function compareResources(left, right) {
  for (const value of [[Number(left.gpus) || 0, Number(right.gpus) || 0], [Number(left.cpus) || 0, Number(right.cpus) || 0], [nodeCount(left), nodeCount(right)]]) {
    if (value[0] !== value[1]) return value[0] - value[1];
  }
  return 0;
}

function compareJobs(left, right, key) {
  if (key === 'name') return compareText(left.name || jobId(left), right.name || jobId(right));
  if (key === 'location') return compareText(left.cluster, right.cluster) || compareText(left.partition, right.partition);
  if (key === 'state') return compareText(left.state, right.state);
  if (key === 'progress') return (Number(left.elapsed_seconds) || 0) - (Number(right.elapsed_seconds) || 0);
  if (key === 'resources') return compareResources(left, right);
  if (key === 'submitted') return (jobSubmissionDate(left)?.getTime() || 0) - (jobSubmissionDate(right)?.getTime() || 0);
  if (key === 'launched' || key === 'ended') return (jobLifecycleDate(left, key).value?.getTime() || 0) - (jobLifecycleDate(right, key).value?.getTime() || 0);
  return 0;
}

function sortedJobs(jobs, listName) {
  const sort = jobSorts[listName];
  return [...jobs].sort((left, right) => {
    const compared = compareJobs(left, right, sort.key) * (sort.direction === 'asc' ? 1 : -1);
    return compared || compareText(jobArchiveKey(left), jobArchiveKey(right));
  });
}

const JOB_GROUP_ORDER = ['RUNNING', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'OTHER'];
const JOB_GROUP_LABELS = { RUNNING:'Running', PENDING:'Pending', COMPLETED:'Completed', FAILED:'Failed', CANCELLED:'Cancelled', OTHER:'Other' };
const ACTIVE_JOB_STATES = new Set(['CONFIGURING', 'PENDING', 'REQUEUED', 'REQUEUE_FED', 'REQUEUE_HOLD', 'RESIZING', 'SIGNALING', 'STAGE_OUT', 'SUSPENDED']);
function jobGroup(job) {
  const state = String(job.state || 'UNKNOWN').toUpperCase();
  if (state === 'RUNNING' || state === 'COMPLETED' || state === 'CANCELLED') return state;
  if (ACTIVE_JOB_STATES.has(state)) return 'PENDING';
  if (FAILED_JOB_STATES.has(state)) return 'FAILED';
  return 'OTHER';
}

function sortControls(listName) {
  const labels = { name:'Name', location:'Cluster / partition', state:'State', progress:'Progress', resources:'Resources', submitted:'Submitted', launched:'Launched', ended:'Ended' };
  const sort = jobSorts[listName];
  return `<div class="job-sort-controls" aria-label="Sort jobs">Sort: ${Object.entries(labels).map(([key, label]) => {
    const indicator = sort.key === key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
    return `<button data-job-sort="${key}" data-job-list="${listName}">${escapeHtml(label + indicator)}</button>`;
  }).join('')}</div>`;
}

function jobDisclosureAttribute(key, defaultOpen = false) {
  const open = jobDisclosure.has(key) ? jobDisclosure.get(key) : defaultOpen;
  return open ? ' open' : '';
}

function jobCard(job, listName) {
  const identifier = jobId(job), name = job.name || identifier;
  const nodes = nodeCount(job), gpus = Number(job.gpus) || 0, cpus = Number(job.cpus) || 0;
  const resources = job.id || gpus || cpus ? `${nodes} node${nodes === 1 ? '' : 's'} · ${gpus} GPU${gpus === 1 ? '' : 's'} · ${cpus} CPU${cpus === 1 ? '' : 's'}` : `${nodes} node${nodes === 1 ? '' : 's'}`;
  const group = jobGroup(job);
  let timing;
  if (group === 'RUNNING') timing = runningJobProgress(job);
  else if (group === 'PENDING') timing = pendingJobProgress(job);
  else {
    const ended = jobLifecycleDate(job, 'ended');
    const label = `${formatSeconds(job.elapsed_seconds)} elapsed${ended.value ? ` · ended ${ended.value.toLocaleString()}` : ''}`;
    timing = `<span class="job-progress ${group.toLowerCase()}" role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="1"><span class="job-progress-track"><span class="job-progress-fill" style="width:100%"></span></span><span class="job-progress-text">${escapeHtml(label)}</span></span>`;
  }
  const reason = job.reason ? `<div class="job-message">${escapeHtml(job.reason)}</div>` : '';
  const submittedAt = jobSubmittedAt(job), submitted = jobSubmissionDate(job);
  const submittedText = submitted ? submitted.toLocaleString() : 'Unavailable';
  const action = listName === 'archived' ? 'restore' : 'archive';
  const actionLabel = listName === 'archived' ? 'Restore' : 'Archive';
  const actionButton = `<button data-job-action="${action}" data-job-key="${escapeHtml(jobArchiveKey(job))}">${actionLabel}</button>`;
  const logButtons = jobsApiEnabled ? `<button class="log-button" data-log-stream="err" data-cluster="${escapeHtml(job.cluster)}" data-job-id="${escapeHtml(identifier)}">Open .err</button><button class="log-button" data-log-stream="out" data-cluster="${escapeHtml(job.cluster)}" data-job-id="${escapeHtml(identifier)}">Open .out</button>` : '';
  const disclosureKey = `card:${listName}:${jobArchiveKey(job)}`;
  return `<details class="job-card" data-job-disclosure-key="${escapeHtml(disclosureKey)}"${jobDisclosureAttribute(disclosureKey)}><summary><span class="job-card-summary-title"><span class="job-name">${escapeHtml(name)}</span><span class="job-id">${escapeHtml(identifier)}</span></span>${timing}</summary><div class="job-card-body"><div class="job-location">${escapeHtml(job.cluster)} / ${escapeHtml(job.partition || 'no partition')}</div><div><span class="job-state">${escapeHtml(job.state)}</span> · <span class="job-resources">${escapeHtml(resources)}</span></div>${reason}<dl class="job-times"><dt>Submitted</dt><dd><time datetime="${escapeHtml(submittedAt || '')}">${escapeHtml(submittedText)}</time></dd><dt>Launched</dt><dd>${jobLifecycleCell(job, 'launched')}</dd><dt>Ended</dt><dd>${jobLifecycleCell(job, 'ended')}</dd></dl><div class="job-card-actions">${actionButton}${logButtons}</div><pre class="log-tail" hidden></pre></div></details>`;
}

function jobGroups(jobs, listName) {
  const sorted = sortedJobs(jobs, listName);
  return JOB_GROUP_ORDER.map(group => {
    const grouped = sorted.filter(job => jobGroup(job) === group);
    if (!grouped.length) return '';
    const disclosureKey = `group:${listName}:${group}`;
    return `<details class="job-group" data-job-disclosure-key="${disclosureKey}"${jobDisclosureAttribute(disclosureKey, true)}><summary>${JOB_GROUP_LABELS[group]} (${grouped.length})</summary><div class="job-card-grid">${grouped.map(job => jobCard(job, listName)).join('')}</div></details>`;
  }).join('');
}

function renderJobs() {
  const activeByKey = new Map(restoredJobs);
  for (const job of currentJobs) activeByKey.set(jobArchiveKey(job), job);
  const active = [...activeByKey.values()].filter(job => !archivedJobs.has(jobArchiveKey(job)));
  const archived = [...archivedJobs.values()];
  const activeContent = active.length ? `${sortControls('active')}${jobGroups(active, 'active')}` : '<p>No jobs to show.</p>';
  const archiveKey = 'group:archive';
  const archive = `<details class="archived-jobs" data-job-disclosure-key="${archiveKey}"${jobDisclosureAttribute(archiveKey)}><summary>Archive (${archived.length})</summary>${archived.length ? `${sortControls('archived')}${jobGroups(archived, 'archived')}` : '<p>No archived jobs.</p>'}</details>`;
  return `${jobWarnings}${activeContent}${archive}`;
}

function renderJobsIntoPage() {
  document.querySelectorAll('[data-job-disclosure-key]').forEach(details => jobDisclosure.set(details.dataset.jobDisclosureKey, details.open));
  document.querySelector('#my-jobs-content').innerHTML = renderJobs();
  updateDynamicDisplays();
}

function setCurrentJobs(jobs, warnings, apiEnabled) {
  currentJobs = jobs;
  jobWarnings = warnings;
  jobsApiEnabled = apiEnabled;
  let archiveChanged = false;
  for (const job of jobs) {
    const key = jobArchiveKey(job);
    if (archivedJobs.has(key)) {
      archivedJobs.set(key, { ...archivedJobs.get(key), ...job });
      archiveChanged = true;
    }
    if (restoredJobs.has(key)) {
      restoredJobs.set(key, { ...restoredJobs.get(key), ...job });
      archiveChanged = true;
    }
  }
  if (archiveChanged) persistArchivedJobs();
  renderJobsIntoPage();
}

function jobsView(clusters, warning = '') {
  const jobs = clusters.flatMap(cluster => (cluster.user_jobs || []).map(job => ({ ...job, cluster: cluster.name })));
  setCurrentJobs(jobs, warning, false);
}

function recentJobsView(payload, clusters) {
  const active = new Map(clusters.flatMap(cluster => (cluster.user_jobs || []).map(job => [`${cluster.name}|${job.id}`, { ...job, cluster: cluster.name }])));
  const jobs = (payload.jobs || []).map(job => ({ ...job, ...(active.get(`${job.cluster}|${job.job_id}`) || {}) }));
  const warnings = (payload.clusters || []).filter(cluster => cluster.error).map(cluster => `<p class="error">${escapeHtml(cluster.name)}: ${escapeHtml(cluster.error)}</p>`).join('');
  setCurrentJobs(jobs, warnings, true);
}

// Conditional GET: unchanged data comes back as 304 and is served from this cache.
const responseCache = new Map();
async function fetchUnlessUnchanged(url) {
  const cached = responseCache.get(url);
  const response = await fetch(url, { headers: cached ? { 'If-None-Match': cached.etag } : {} });
  if (response.status === 304 && cached) return { response, payload: cached.payload, notModified: true };
  const payload = await response.json();
  const etag = response.headers.get('ETag');
  if (response.ok && etag) responseCache.set(url, { etag, payload }); else responseCache.delete(url);
  return { response, payload, notModified: false };
}

async function refreshJobs(result) {
  if (!result.jobs_api_enabled) { jobsView(result.clusters); return; }
  try {
    const { response, payload } = await fetchUnlessUnchanged('/api/v1/jobs');
    if (!response.ok && response.status !== 304) throw new Error(payload.error || `HTTP ${response.status}`);
    recentJobsView(payload, result.clusters);
  } catch (error) {
    jobsView(result.clusters, `<p class="error">Could not load recent jobs: ${escapeHtml(error.message)}</p>`);
  }
}

const partitionDisclosure = new Map();

function rememberPartitionDisclosure() {
  document.querySelectorAll('details[data-partition-key]').forEach(details => partitionDisclosure.set(details.dataset.partitionKey, details.open));
}

function partitionView(clusterName, [name, nodes], compute, jobs, thresholds, estimates, estimatesUpdatedAt) {
  const status = [...nodes].sort((left, right) => statePriority(left) - statePriority(right) || String(left.name).localeCompare(String(right.name))).map(node => `<i class="node-state-block ${summaryStateClass(node)}" title="${escapeHtml(node.name)}: ${escapeHtml(node.state)}"></i>`).join('');
  const summary = compute.get(name);
  const best = summary && summary.best_gpu;
  const details = best ? `${summary.rank ? `#${summary.rank} · ` : ''}${best.name} · ${best.vram_gb} GB VRAM/GPU · ${best.tensor_tflops.toLocaleString()} FP16/BF16 Tensor TFLOPS/GPU · ${summary.cpu_threads.toLocaleString()} CPU threads` : 'GPU model not catalogued';
  const badges = jobBadges(jobs, name, thresholds);
  const heading = `<div class="partition-heading"><h3>${escapeHtml(name)}</h3><div class="partition-status" aria-label="Node states for ${escapeHtml(name)}">${status}</div>${badges ? `<div class="job-badges">${badges}</div>` : ''}</div>`;
  const body = `<div class="partition-compute">${escapeHtml(details)}</div>${waitChart(estimates, name, estimatesUpdatedAt)}<div class="node-grid">${nodesByAvailableGpu(nodes).map(nodeCard).join('')}</div>`;
  const disclosureKey = JSON.stringify([clusterName, name]);
  return `<details class="partition-section${summary?.aggregate ? ' aggregate-partition' : ''}" data-partition-key="${escapeHtml(disclosureKey)}"${partitionDisclosure.get(disclosureKey) ? ' open' : ''}><summary>${heading}</summary>${body}</details>`;
}

function clusterView(cluster, waitThresholds) {
  let content;
  if (cluster.error) content = `<p class="error">${escapeHtml(cluster.error)}</p>` + (cluster.login_required ? `<p>The SSH session has closed. Log in again with <code>cluster-watcher login ${escapeHtml(cluster.name)}</code>.</p>` : '');
  else if (!cluster.nodes || !cluster.nodes.length) content = '<p>No individual node information was returned by scontrol.</p>';
  else { const compute = new Map((cluster.partition_compute || []).map(summary => [summary.name, summary])); content = partitionGroups(cluster.nodes, compute).map(group => partitionView(cluster.name, group, compute, cluster.user_jobs, waitThresholds || [5, 30, 60, 120], cluster.wait_estimates, cluster.wait_estimates_updated_at)).join(''); }
  if (cluster.jobs) content += `<p><b>Jobs:</b> ${Object.entries(cluster.jobs).map(([state, count]) => `${escapeHtml(state)}=${count}`).join(', ') || 'none'}</p>`;
  return `<section class="cluster"><h2>${escapeHtml(cluster.name)} <small>${escapeHtml(cluster.username)}@${escapeHtml(cluster.host)}</small></h2>${content}</section>`;
}

let refreshTimer, refreshDeadline = 0, refreshPeriodMs = 1;
function scheduleRefresh(seconds, fullPeriodSeconds = seconds) {
  clearTimeout(refreshTimer); refreshPeriodMs = fullPeriodSeconds * 1000; refreshDeadline = Date.now() + seconds * 1000;
  refreshTimer = setTimeout(refresh, seconds * 1000); updateDynamicDisplays();
}

function updateDynamicDisplays() {
  if (refreshDeadline) {
    const remainingMs = Math.max(0, refreshDeadline - Date.now());
    document.querySelector('#refresh-label').textContent = `Next refresh in ${Math.ceil(remainingMs / 1000)}s`;
    document.querySelector('#refresh-clock-hand').style.transform = `rotate(${remainingMs / refreshPeriodMs * 360}deg)`;
  }
  document.querySelectorAll('[data-running-progress]').forEach(progress => {
    const total = Number(progress.dataset.totalSeconds), initialElapsed = Number(progress.dataset.elapsedSeconds), sampledAt = Number(progress.dataset.sampledAt);
    const elapsed = Math.min(total, initialElapsed + Math.max(0, Math.floor((Date.now() - sampledAt) / 1000)));
    const remaining = Math.max(0, total - elapsed), completed = Math.max(0, Math.min(100, elapsed / total * 100));
    progress.querySelector('.job-progress-fill').style.width = `${completed}%`;
    progress.querySelector('.job-progress-text').textContent = progress.dataset.compact === 'true' ? `${formatSeconds(remaining, true)} left / ${formatSeconds(total)}` : `${formatSeconds(elapsed, true)} elapsed · ${formatSeconds(remaining, true)} remaining · ${formatSeconds(total)} allotted`;
    progress.setAttribute('aria-valuenow', String(elapsed));
  });
  document.querySelectorAll('[data-pending-progress]').forEach(progress => {
    const submittedAt = Number(progress.dataset.submittedAt), startAt = Number(progress.dataset.startAt), waitSeconds = Number(progress.dataset.waitSeconds);
    const elapsed = Math.max(0, Math.min(waitSeconds, (Date.now() - submittedAt) / 1000));
    const remaining = Math.max(0, (startAt - Date.now()) / 1000), completed = Math.max(0, Math.min(100, elapsed / waitSeconds * 100));
    progress.querySelector('.job-progress-fill').style.width = `${completed}%`;
    const estimatedStart = new Date(startAt).toLocaleString(), submitted = new Date(submittedAt).toLocaleString(), runtime = progress.dataset.runtimeLabel;
    progress.querySelector('.job-progress-text').textContent = remaining > 0 ? `${formatSeconds(remaining, true)} until estimated start (${estimatedStart}) · submitted ${submitted} · ${runtime}` : `Estimated start ${estimatedStart} has passed; waiting for Slurm to update · submitted ${submitted} · ${runtime}`;
    progress.setAttribute('aria-valuenow', String(Math.floor(elapsed)));
  });
}

async function refresh() {
  document.querySelector('#refresh-label').textContent = 'Refreshing…'; document.querySelector('#refresh-clock-hand').style.transform = 'rotate(0deg)';
  try { const { response, payload: result, notModified } = await fetchUnlessUnchanged('/api/status');
    if (response.status === 503) {
      const retryAfter = Math.max(1, Number(response.headers.get('Retry-After')) || 1);
      document.querySelector('#updated').textContent = 'Waiting for first result…';
      scheduleRefresh(retryAfter); return;
    }
    if (!response.ok && !notModified) throw new Error(result.error || `HTTP ${response.status}`);
    const thresholds = result.wait_threshold_minutes || [5, 30, 60, 120];
    if (!result.updated_at) { document.querySelector('#updated').textContent = 'Waiting for first result…'; scheduleRefresh(1); return; }
    rememberPartitionDisclosure();
    document.querySelector('#clusters').innerHTML = result.clusters.map(cluster => clusterView(cluster, thresholds)).join('');
    await refreshJobs(result);
    const checked = notModified ? ` · checked ${new Date().toLocaleTimeString()}` : '';
    document.querySelector('#updated').textContent = `Updated ${new Date(result.updated_at).toLocaleTimeString()}${checked}`;
    // An unchanged (304) answer carries the old updated_at, which must not look overdue.
    const collectedAt = notModified ? Date.now() : new Date(result.updated_at).getTime();
    const ageSeconds = Number.isFinite(collectedAt) ? Math.max(0, (Date.now() - collectedAt) / 1000) : 0;
    updateDynamicDisplays(); scheduleRefresh(Math.max(1, result.refresh_seconds - ageSeconds), result.refresh_seconds);
  } catch (error) { document.querySelector('#updated').textContent = `Dashboard error: ${error.message}`; scheduleRefresh(15); }
}
document.addEventListener('click', async event => {
  const sortButton = event.target.closest('[data-job-sort]');
  if (sortButton) {
    const sort = jobSorts[sortButton.dataset.jobList];
    if (sort.key === sortButton.dataset.jobSort) sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
    else { sort.key = sortButton.dataset.jobSort; sort.direction = 'asc'; }
    renderJobsIntoPage();
    return;
  }
  const archiveButton = event.target.closest('[data-job-action]');
  if (archiveButton) {
    const key = archiveButton.dataset.jobKey;
    if (archiveButton.dataset.jobAction === 'restore') {
      const job = archivedJobs.get(key);
      if (job) { const { archived_at, ...restored } = job; restoredJobs.set(key, restored); }
      archivedJobs.delete(key);
    }
    else {
      const job = currentJobs.find(candidate => jobArchiveKey(candidate) === key) || restoredJobs.get(key);
      if (job) archivedJobs.set(key, { ...job, archived_at: new Date().toISOString() });
      restoredJobs.delete(key);
    }
    persistArchivedJobs();
    renderJobsIntoPage();
    return;
  }
  const button = event.target.closest('.log-button');
  if (!button) return;
  const output = button.closest('.job-card').querySelector('.log-tail');
  const stream = button.dataset.logStream;
  button.disabled = true; output.hidden = false; output.textContent = `Loading .${stream} tail…`;
  try {
    const url = `/api/v1/jobs/${encodeURIComponent(button.dataset.cluster)}/${encodeURIComponent(button.dataset.jobId)}/log?stream=${encodeURIComponent(stream)}&tail=100`;
    const response = await fetch(url), payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const notice = payload.truncated ? `Showing the last ${payload.lines} lines of ${payload.path}.\n\n` : `${payload.path}\n\n`;
    output.textContent = notice + (payload.content || '(log file is empty)');
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});
setInterval(updateDynamicDisplays, 1000); refresh();
</script></body></html>"""


class StatusStore:
    """Thread-safe cache periodically populated using the Slurm collector."""

    def __init__(self, machines: list[Machine], timeout: int, include_jobs: bool, refresh_seconds: int, wait_threshold_minutes: tuple[int, ...] = DEFAULT_WAIT_THRESHOLD_MINUTES, jobs_api_enabled: bool = False, command_api_enabled: bool = False):
        self.machines, self.timeout = machines, timeout
        self.include_jobs, self.refresh_seconds = include_jobs, refresh_seconds
        self.wait_threshold_minutes = wait_threshold_minutes
        self.jobs_api_enabled = jobs_api_enabled
        self.command_api_enabled = command_api_enabled
        self._lock = threading.Lock()
        self._statuses: list[ClusterStatus] = []
        self._wait_estimates: dict[str, dict[str, list[dict[str, object]]]] = {}
        self._wait_estimates_updated_at: dict[str, str] = {}
        self._updated_at: str | None = None
        self._capacity_collected: dict[str, float] = {}
        self.job_service = JobService(machines, timeout, refresh_seconds, self.statuses) if jobs_api_enabled else None
        self.command_service = RemoteCommandService(machines, timeout) if command_api_enabled else None

    def refresh(self) -> None:
        """Collect every cluster with one SSH call each (see ``collect_status``).

        Capacity data refreshes every :data:`CAPACITY_REFRESH_SECONDS`; the
        user's jobs (and, with the jobs API, fingerprint-gated accounting)
        refresh every time. Clusters are collected in parallel: each still
        receives exactly one SSH call per refresh against its own Slurm
        controller, so a refresh takes as long as the slowest cluster instead
        of the sum of all of them.
        """
        with self._lock:
            previous = {status.name: status for status in self._statuses}
        now = time.monotonic()
        due = {
            machine.name: now - self._capacity_collected.get(machine.name, float("-inf")) >= CAPACITY_REFRESH_SECONDS
            for machine in self.machines
        }

        def collect(machine: Machine) -> ClusterStatus:
            status = collect_status(
                machine, self.timeout, self.include_jobs,
                previous=previous.get(machine.name), refresh_capacity=due[machine.name],
                include_accounting=self.jobs_api_enabled,
            )
            if status.error and machine.interactive_auth:
                # A local ``ssh -O check``: did the failure come from a closed session?
                status.login_required = not session_status(machine, self.timeout)["session_open"]
            return status

        with ThreadPoolExecutor(max_workers=max(1, len(self.machines)), thread_name_prefix="collect") as pool:
            statuses = list(pool.map(collect, self.machines))  # Keeps configuration order.
        for status in statuses:
            if due[status.name] and status.error is None:
                self._capacity_collected[status.name] = now
        with self._lock:
            for status in statuses:
                status.wait_estimates = self._wait_estimates.get(status.name)
                status.wait_estimates_updated_at = self._wait_estimates_updated_at.get(status.name)
            self._statuses = statuses
            self._updated_at = datetime.now(timezone.utc).isoformat()

    def refresh_wait_estimates(self) -> bool:
        """Refresh slow hypothetical-job probes independently of status polling.

        Clusters are probed concurrently (each partition is one SSH call; see
        ``collect_wait_estimates``), so the first estimates appear after the
        slowest cluster rather than after all of them in turn.
        """
        with self._lock:
            statuses = list(self._statuses)
        if not statuses:
            return False
        probed = [status for status in statuses if not status.error and status.nodes]
        if probed:
            with ThreadPoolExecutor(max_workers=len(probed), thread_name_prefix="wait-probe") as pool:
                list(pool.map(self._probe_cluster, probed))
        return True

    def _probe_cluster(self, status: ClusterStatus) -> None:
        """Probe one cluster's wait estimates and publish them."""
        machine = next(machine for machine in self.machines if machine.name == status.name)
        estimates = collect_wait_estimates(machine, status.nodes, self.timeout)
        updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._wait_estimates[status.name] = estimates
            self._wait_estimates_updated_at[status.name] = updated_at
            for current in self._statuses:
                if current.name == status.name:
                    current.wait_estimates = estimates
                    current.wait_estimates_updated_at = updated_at

    def payload(self) -> dict[str, object]:
        """Return the dashboard's internal status representation."""
        with self._lock:
            clusters = [asdict(status) for status in self._statuses]
            for cluster in clusters:
                cluster.pop("accounting", None)  # Server-internal sacct cache.
            return {"clusters": clusters, "updated_at": self._updated_at, "refresh_seconds": self.refresh_seconds, "wait_threshold_minutes": self.wait_threshold_minutes, "jobs_api_enabled": self.jobs_api_enabled, "command_api_enabled": self.command_api_enabled}

    def statuses(self) -> list[ClusterStatus]:
        """Return the latest per-cluster objects for the personal-job service."""
        with self._lock:
            return list(self._statuses)

    def snapshot_payload(self) -> dict[str, object]:
        """Return the stable, versioned snapshot intended for API consumers."""
        with self._lock:
            return build_snapshot(self._statuses, self._updated_at, self.refresh_seconds)

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.refresh()
            stop.wait(self.refresh_seconds)

    def run_wait_probes_forever(self, stop: threading.Event) -> None:
        """Run controller-intensive test-only queries no more than every ten minutes."""
        while not stop.is_set():
            try:
                refreshed = self.refresh_wait_estimates()
            except Exception as exc:  # Keep this daemon alive after an unexpected collector defect.
                print(f"Wait-probe refresh failed: {exc}", file=sys.stderr)
                stop.wait(60)
                continue
            if refreshed:
                stop.wait(WAIT_PROBE_REFRESH_SECONDS)
            else:
                # Let the normal collector produce its first node snapshot.
                stop.wait(1)


# Partition/node capacity is collected at most this often; the user's own jobs
# are collected on every refresh. Capacity changes slowly but its node detail
# can be over a megabyte per refresh on large clusters.
CAPACITY_REFRESH_SECONDS = 60

# Fields that change on every refresh without anything having happened. They
# are excluded from ETags so clients can skip unchanged responses; clients
# extrapolate them from the response's generated_at instead.
VOLATILE_FIELDS = frozenset({
    # ``since`` is the moving start of the jobs API's default 24-hour window.
    "generated_at", "updated_at", "since", "capacity_updated_at", "elapsed", "elapsed_seconds",
    "time_left", "time_left_seconds", "estimated_wait_seconds",
})


def stable_etag(payload: object) -> str:
    """Return a strong ETag for ``payload`` that ignores :data:`VOLATILE_FIELDS`."""
    def strip(value: object) -> object:
        if isinstance(value, dict):
            return {key: strip(item) for key, item in value.items() if key not in VOLATILE_FIELDS}
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value
    digest = hashlib.sha256(json.dumps(strip(payload), sort_keys=True, default=str).encode()).hexdigest()
    return f'"{digest[:32]}"'


def make_handler(store: StatusStore):
    """Create an HTTP handler bound to a particular status cache."""

    class DashboardHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed_url = urlsplit(self.path)
            path = parsed_url.path
            query = parse_qs(parsed_url.query, keep_blank_values=True)
            extra_headers: dict[str, str] = {}
            if path == "/":
                body, content_type, code = PAGE.encode(), "text/html; charset=utf-8", 200
            elif path == "/api/status":
                payload = store.payload()
                code = 200 if payload["updated_at"] else 503
                if code == 503:
                    payload["error"] = "The first cluster status collection has not completed"
                    extra_headers["Retry-After"] = "1"
                body, content_type = json.dumps(payload).encode(), "application/json; charset=utf-8"
                extra_headers["Cache-Control"] = "no-store"
            elif path == "/api/v1/snapshot":
                snapshot = store.snapshot_payload()
                code = 200 if snapshot["generated_at"] else 503
                if code == 503:
                    snapshot["error"] = "The first cluster status collection has not completed"
                    extra_headers["Retry-After"] = "1"
                body, content_type = json.dumps(snapshot).encode(), "application/json; charset=utf-8"
                extra_headers["Cache-Control"] = "no-store"
            elif path == "/api/v1/jobs":
                body, content_type, code, headers = self._jobs_response(query)
                extra_headers.update(headers)
            elif path == "/api/v1/sessions":
                body, content_type, code, headers = self._sessions_response()
                extra_headers.update(headers)
            elif match := re.fullmatch(r"/api/v1/jobs/([^/]+)/([^/]+)/script", path):
                body, content_type, code, headers = self._job_script_response(
                    unquote(match.group(1)), unquote(match.group(2))
                )
                extra_headers.update(headers)
            elif match := re.fullmatch(r"/api/v1/jobs/([^/]+)/([^/]+)/log", path):
                body, content_type, code, headers = self._job_log_response(
                    unquote(match.group(1)), unquote(match.group(2)), query
                )
                extra_headers.update(headers)
            else:
                body, content_type, code = b"Not found\n", "text/plain; charset=utf-8", 404
            if code == 200 and path in {"/api/status", "/api/v1/snapshot", "/api/v1/jobs"}:
                # Let polling clients skip unchanged data with If-None-Match.
                etag = stable_etag(json.loads(body))
                extra_headers["ETag"] = etag
                requested = {value.strip() for value in self.headers.get("If-None-Match", "").split(",")}
                if etag in requested:
                    body, code = b"", 304
            self._write_response(body, content_type, code, extra_headers)

        def do_POST(self) -> None:  # noqa: N802
            """Handle the explicitly enabled command and job-cancel endpoints."""
            path = urlsplit(self.path).path
            headers = {"Cache-Control": "no-store"}
            if match := re.fullmatch(r"/api/v1/jobs/([^/]+)/([^/]+)/cancel", path):
                body, content_type, code, response_headers = self._cancel_response(
                    unquote(match.group(1)), unquote(match.group(2))
                )
            elif path == "/api/v1/commands":
                body, content_type, code, response_headers = self._command_response()
            else:
                self._write_response(b"Not found\n", "text/plain; charset=utf-8", 404, headers)
                return
            headers.update(response_headers)
            self._write_response(body, content_type, code, headers)

        def _write_response(self, body: bytes, content_type: str, code: int, headers: dict[str, str]) -> None:
            """Write one response, tolerating clients that disconnect early.

            Browsers routinely abandon in-flight refresh requests when a page
            reloads, closes, or supersedes a fetch. In that case the response
            is no longer useful, and logging a thread traceback obscures real
            collector and SSH failures.
            """
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Content-Type-Options", "nosniff")
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)
            except ConnectionError:
                # The peer has gone away; there is no response left to send.
                return

        def _sessions_response(self) -> tuple[bytes, str, int, dict[str, str]]:
            """Serve current control-master state without opening connections."""
            headers = {"Cache-Control": "no-store"}
            if store.command_service is None:
                return self._json_error("The command API is disabled; restart with --command-api", 404, headers)
            try:
                payload = store.command_service.sessions()
            except ValueError as exc:
                return self._json_error(str(exc), 500, headers)
            return json.dumps(payload).encode(), "application/json; charset=utf-8", 200, headers

        def _command_response(self) -> tuple[bytes, str, int, dict[str, str]]:
            """Validate and execute one bounded command request."""
            headers = {"Cache-Control": "no-store"}
            if store.command_service is None:
                return self._json_error("The command API is disabled; restart with --command-api", 404, headers)
            if self.headers.get_content_type() != "application/json":
                return self._json_error("Content-Type must be application/json", 415, headers)
            try:
                content_length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._json_error("Content-Length must be supplied", 411, headers)
            if not 1 <= content_length <= 131072:
                return self._json_error("request body must be between 1 and 131072 bytes", 413, headers)
            try:
                request = json.loads(self.rfile.read(content_length))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self._json_error("request body must be valid JSON", 400, headers)
            if not isinstance(request, dict):
                return self._json_error("request body must be a JSON object", 400, headers)
            unknown = set(request) - {"machine", "command", "timeout_seconds"}
            if unknown:
                return self._json_error(f"unknown request field(s): {', '.join(sorted(unknown))}", 400, headers)
            if not isinstance(request.get("machine"), str):
                return self._json_error("machine must be a string", 400, headers)
            command_timeout = request.get("timeout_seconds", 30)
            if (
                isinstance(command_timeout, bool)
                or not isinstance(command_timeout, int)
                or not 1 <= command_timeout <= MAX_COMMAND_TIMEOUT_SECONDS
            ):
                return self._json_error(
                    f"timeout_seconds must be between 1 and {MAX_COMMAND_TIMEOUT_SECONDS}",
                    400,
                    headers,
                )
            try:
                payload = store.command_service.execute(
                    request["machine"], request.get("command"),
                    command_timeout,
                )
            except UnknownMachineError as exc:
                return self._json_error(str(exc), 404, headers)
            except SessionUnavailableError as exc:
                return self._json_error(str(exc), 409, headers)
            except ValueError as exc:
                return self._json_error(str(exc), 400, headers)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                return self._json_error(f"Remote execution failed: {exc}", 502, headers)
            code = 504 if payload["timed_out"] else 502 if payload["connection_dropped"] else 200
            return json.dumps(payload).encode(), "application/json; charset=utf-8", code, headers

        def _cancel_response(self, cluster: str, job_id: str) -> tuple[bytes, str, int, dict[str, str]]:
            """Cancel one personal job through the jobs API.

            A JSON content type is required even though the body is unused:
            browsers cannot send it cross-origin without a CORS preflight,
            which this server never approves, so web pages cannot cancel jobs.
            """
            headers = {"Cache-Control": "no-store"}
            if store.job_service is None:
                return self._json_error("The personal jobs API is disabled; restart with --jobs-api", 404, headers)
            if self.headers.get_content_type() != "application/json":
                return self._json_error("Content-Type must be application/json", 415, headers)
            try:
                payload = store.job_service.cancel(cluster, job_id)
            except ValueError as exc:
                return self._json_error(str(exc), 400, headers)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                return self._json_error(f"Could not cancel job {job_id} on {cluster}: {exc}", 502, headers)
            return json.dumps(payload).encode(), "application/json; charset=utf-8", 200, headers

        def _jobs_response(self, query: dict[str, list[str]]) -> tuple[bytes, str, int, dict[str, str]]:
            """Validate query parameters and serve the versioned jobs document."""
            headers = {"Cache-Control": "no-store"}
            if store.job_service is None:
                return self._json_error("The personal jobs API is disabled; restart with --jobs-api", 404, headers)
            if not store.payload()["updated_at"]:
                headers["Retry-After"] = "1"
                return self._json_error("The first cluster status collection has not completed", 503, headers)
            try:
                state_values = query.get("state", ["both"])
                since_values = query.get("since", [])
                if len(state_values) != 1 or len(since_values) > 1:
                    raise ValueError("state and since may each be supplied at most once")
                payload = store.job_service.query(
                    tuple(query.get("cluster", [])),
                    tuple(query.get("job_id", [])),
                    state_values[0],
                    parse_since(since_values[0]) if since_values else None,
                )
            except ValueError as exc:
                return self._json_error(str(exc), 400, headers)
            return json.dumps(payload).encode(), "application/json; charset=utf-8", 200, headers

        def _job_script_response(self, cluster: str, job_id: str) -> tuple[bytes, str, int, dict[str, str]]:
            """Serve the batch script of one personal job."""
            headers = {"Cache-Control": "no-store"}
            if store.job_service is None:
                return self._json_error("The personal jobs API is disabled; restart with --jobs-api", 404, headers)
            try:
                payload = store.job_service.batch_script(cluster, job_id)
            except ValueError as exc:
                return self._json_error(str(exc), 400, headers)
            except JobScriptNotFound as exc:
                return self._json_error(str(exc), 404, headers)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                return self._json_error(f"Could not query {cluster}: {exc}", 502, headers)
            return json.dumps(payload).encode(), "application/json; charset=utf-8", 200, headers

        def _job_log_response(
            self,
            cluster: str,
            job_id: str,
            query: dict[str, list[str]],
        ) -> tuple[bytes, str, int, dict[str, str]]:
            """Validate and serve one explicitly requested bounded log tail."""
            headers = {"Cache-Control": "no-store"}
            if store.job_service is None:
                return self._json_error("The personal jobs API is disabled; restart with --jobs-api", 404, headers)
            try:
                stream_values = query.get("stream", ["err"])
                tail_values = query.get("tail", ["100"])
                before_values = query.get("before", ["0"])
                path_values = query.get("path", [])
                if len(stream_values) != 1 or len(tail_values) != 1 or len(before_values) != 1 or len(path_values) > 1:
                    raise ValueError("stream, tail, before, and path may each be supplied at most once")
                try:
                    tail = int(tail_values[0])
                    before = int(before_values[0])
                except ValueError as exc:
                    raise ValueError("tail and before must be integers") from exc
                payload = store.job_service.log_tail(
                    cluster, job_id, stream_values[0], tail,
                    path_values[0] if path_values else None,
                    before,
                )
            except ValueError as exc:
                return self._json_error(str(exc), 400, headers)
            except JobLogNotFound as exc:
                return self._json_error(str(exc), 404, headers)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                return self._json_error(f"Could not query {cluster}: {exc}", 502, headers)
            return json.dumps(payload).encode(), "application/json; charset=utf-8", 200, headers

        @staticmethod
        def _json_error(message: str, code: int, headers: dict[str, str]) -> tuple[bytes, str, int, dict[str, str]]:
            """Build a consistent JSON error response tuple."""
            return json.dumps({"error": message}).encode(), "application/json; charset=utf-8", code, headers

        def log_message(self, format: str, *args: object) -> None:
            return

    return DashboardHandler


def is_loopback_host(host: str) -> bool:
    """Return whether an HTTP bind host is explicitly loopback-only."""
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def serve(machines: list[Machine], host: str, port: int, timeout: int, include_jobs: bool, refresh_seconds: int, open_browser: bool, wait_threshold_minutes: tuple[int, ...] = DEFAULT_WAIT_THRESHOLD_MINUTES, jobs_api_enabled: bool = False, command_api_enabled: bool = False) -> int:
    """Start the dashboard and its background collectors."""
    if (jobs_api_enabled or command_api_enabled) and not is_loopback_host(host):
        raise ValueError("--jobs-api and --command-api require a loopback --host (127.0.0.1, ::1, or localhost)")
    for machine, error in establish_interactive_sessions(machines, timeout):
        print(f"Could not establish reusable SSH session for {machine.name}: {error}", file=sys.stderr)
    store = StatusStore(machines, timeout, include_jobs, refresh_seconds, wait_threshold_minutes, jobs_api_enabled, command_api_enabled)
    stop = threading.Event()
    threading.Thread(target=store.run_forever, args=(stop,), name="cluster-refresh", daemon=True).start()
    threading.Thread(target=store.run_wait_probes_forever, args=(stop,), name="wait-probes", daemon=True).start()
    try:
        server_type = ThreadingHTTPServer
        try:
            if isinstance(ipaddress.ip_address(host.strip("[]")), ipaddress.IPv6Address):
                class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
                    address_family = socket.AF_INET6

                server_type = IPv6ThreadingHTTPServer
        except ValueError:
            pass
        server = server_type((host.strip("[]"), port), make_handler(store))
    except OSError as exc:
        stop.set()
        print(f"Could not start dashboard: {exc}", file=sys.stderr)
        return 1
    address, actual_port = server.server_address[:2]
    url_host = f"[{address}]" if ":" in address else address
    url = f"http://{url_host}:{actual_port}/"
    print(
        f"Cluster Watcher dashboard: {url}\n"
        f"Availability API: {url}api/v1/snapshot\n"
        f"Personal jobs API: {url + 'api/v1/jobs' if jobs_api_enabled else 'disabled (use --jobs-api)'}\n"
        f"Remote command API: {url + 'api/v1/commands' if command_api_enabled else 'disabled (use --command-api)'}\n"
        f"Refreshing every {refresh_seconds} seconds. Press Ctrl-C to stop."
    )
    if open_browser and not webbrowser.open(url):
        print("Could not open a browser automatically; open the URL above.", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard.")
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
    return 0
