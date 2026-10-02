# Cluster Watcher operating guide for agents

Cluster Watcher is the user's local gateway to several Slurm clusters. Use its
versioned loopback APIs for structured observations instead of inventing SSH
commands or scraping the HTML dashboard. The normal service address is
`http://127.0.0.1:8080`; a different port may be configured by the user.

The service has no HTTP authentication or TLS. Keep it on loopback and use an
SSH tunnel when access must cross a machine boundary. Never ask for, capture,
store, or print a password or OTP. A human starts reusable SSH sessions when
interactive MFA is required.

## Capability and authority matrix

| Goal | Preferred interface | Requirement | Changes remote state? |
| --- | --- | --- | --- |
| Inspect cluster, partition, node, CPU, and GPU capacity | `GET /api/v1/snapshot` | Running `serve` process | No |
| Compare cluster-scoped GPU/APU models, VRAM, and Tensor throughput | `GET /api/v1/snapshot` | Cataloged hardware profile | No |
| Read advisory GPU-job wait projections | `GET /api/v1/snapshot` | Completed wait probes | No; probes use `sbatch --test-only` |
| Inspect active and recent personal jobs | `GET /api/v1/jobs` | Service started with `--jobs-api` | No |
| Read stdout or stderr | `GET /api/v1/jobs/{cluster}/{job_id}/log` | `--jobs-api`; resolvable or allowed path | No |
| Cancel one personal job | `POST /api/v1/jobs/{cluster}/{job_id}/cancel` | `--jobs-api` and explicit user approval | **Yes** |
| Inspect reusable SSH sessions | `cluster-watcher sessions --json` | Local configuration | No |
| Inspect sessions over HTTP | `GET /api/v1/sessions` | `--command-api` | No |
| Run a non-interactive remote command | `cluster-watcher exec` or `POST /api/v1/commands` | Existing SSH master; HTTP also needs `--command-api` | Potentially **yes** |
| Open an interactive remote shell | `cluster-watcher shell MACHINE` | Existing SSH master and a human terminal | Potentially **yes** |
| Present live terminal views | `cluster-watcher status [SECONDS]` and `cluster-watcher jobs [SECONDS]` | May prompt if no SSH master exists | No |

The browser and VS Code extension are human interfaces, not automation
contracts. Their archives and expanded/collapsed state are local UI state and
do not archive, hold, or modify jobs in Slurm.

## Service modes

The user chooses which HTTP capabilities to expose when starting the service:

```bash
cluster-watcher serve --no-browser                 # capacity snapshot only
cluster-watcher serve --jobs-api --no-browser      # add personal jobs/logs/cancel
cluster-watcher serve --command-api --no-browser   # add sessions/remote commands
```

`--jobs-api` and `--command-api` may be combined, but neither is needed to read
the capacity snapshot. Do not ask the user to enable the command API for an
observational task. Startup can require password/OTP interaction; an agent must
not try to automate those secret prompts. The user's normal browser and VS Code
clients can attach to the same running service and shared SSH masters.

## Discover and read the service

Start with:

```text
GET http://127.0.0.1:8080/api/v1/snapshot
```

A connection refusal normally means no service is running. HTTP `503` with
`Retry-After: 1` means startup collection is still in progress; retry after the
indicated delay. A `200` response contains `schema_version`, `generated_at`,
refresh intervals, and one record for every visible configured cluster. Use
the versioned `/api/v1/*` routes rather than the dashboard's private
`/api/status` payload.

The snapshot includes:

- Per-cluster reachability and partial collection errors.
- Partitions and nodes, administrative/node states, CPU threads, GPU/APU
  allocation, and `schedulable_idle` resources.
- Cluster-scoped model names and cataloged per-device VRAM and dense
  FP16/BF16 Tensor/Matrix TFLOPS.
- Aggregate-partition markers and advisory queue-wait probes for representative
  GPU counts, node shapes, memory requests, and walltimes.

It deliberately excludes login usernames and personal jobs. Use the separately
gated jobs and session APIs only when those data are required.

Use `gpus.schedulable_idle`, not raw `gpus.idle`, when deciding whether a new
eligible job could use a device now. Raw idle counts can include devices on
drained, down, reserved, powered-off, failed, or otherwise unavailable nodes.
Do not add an `aggregate: true` partition's capacity to its constituent
partitions: those entries can refer to the same physical nodes.

Hardware specifications come from the cluster-scoped `gpu_profiles.toml`
catalog. A missing/null catalog field is unknown, not zero. A model name on one
cluster must not be assumed to identify the same hardware on another cluster.
Cluster Watcher's default compute ordering emphasizes per-device VRAM first
and cataloged Tensor throughput second; it is a routing hint, not an application
benchmark.

## Interpret wait information carefully

Partition wait estimates are hypothetical `sbatch --test-only` scheduler
projections. They account for the configured user/account, current QOS and
fairshare, requested GPU/node shape, host-memory request, and requested
walltime. They are cached more slowly than capacity data; inspect
`wait_estimates_updated_at`, the request shape, and each estimate's `error`.

An expected start is not a reservation or guarantee. Priority changes, new
jobs, reservations, dependencies, topology, licenses, and jobs ending early or
late can change it. A failed or permission-denied probe means that shape was
not estimable for this account; it does not necessarily prove the partition is
globally unusable. Report the uncertainty and any probe error with a routing
recommendation.

## Inspect jobs and page logs

The personal jobs API is absent unless the service was started with
`--jobs-api`:

```text
GET /api/v1/jobs
```

By default it merges the live queue with the preceding 24 hours of accounting.
It includes canonical array-task IDs, state, partition, resource requests,
submission/start/end times, elapsed time, exit status, scheduler reason,
dependency, and an expected start when Slurm provides one. One cluster's
failure does not invalidate successful results from other clusters.

Supported filters are repeatable `cluster` and `job_id`, `state` equal to
`active`, `terminal`, or `both`, and an ISO 8601 `since` timestamp. Prefer one
filtered request over repeatedly fetching the entire history. A parent array
ID matches its tasks.

Fetch logs only when they are relevant:

```text
GET /api/v1/jobs/{cluster}/{job_id}/log?stream=err&tail=2000&before=0
```

`stream` is `out` or `err`. `tail` is capped at 2,000 lines. If `more_before`
is true, increment `before` by the returned line count to request the preceding
page. This pages backward on the remote machine instead of repeatedly
downloading newer output. Do not implement rapid log polling. Automatic Slurm
paths are resolved from job metadata; a caller-supplied absolute `path` must
canonicalize beneath that cluster's configured `job_log_roots`.

For a job investigation:

1. Query the exact cluster and job ID.
2. Inspect `state`, `reason`, `dependency`, timestamps, requested resources,
   and exit status before reading logs.
3. Fetch the smallest useful stdout/stderr page, then page backward only if
   needed.
4. Preserve and report partial-cluster and accounting errors instead of
   treating missing data as an empty queue.

## Reuse existing SSH sessions

`cluster-watcher sessions --json` checks local OpenSSH control masters without
logging in. The corresponding HTTP route, `/api/v1/sessions`, is available only
with `--command-api`. A session marked `available` has been verified with
`ssh -O check`. Remaining lifetime is approximate because OpenSSH does not
publish its exact idle-expiry deadline and unrelated SSH clients can extend it.

CLI, web service, and VS Code use the same user-private control paths when they
run as the same Unix user on the same machine with the same endpoint settings.
Sessions cannot be shared across a laptop and a VS Code Remote host. Neither
`exec`, `shell`, nor the HTTP command endpoint authenticates or silently opens
a missing session.

The local CLI form is:

```bash
cluster-watcher exec MACHINE -- COMMAND ARGUMENT...
```

It has no execution timeout unless `--timeout SECONDS` is supplied. It retains
at most 1 MiB from each output stream. `cluster-watcher shell MACHINE` is an
interactive human facility and should not be driven as an automation protocol.

The HTTP command endpoint accepts JSON containing `machine`, `command`, and an
optional `timeout_seconds` from 1 through 300 (default 30). It has no TTY or
stdin, limits command text to 64 KiB, caps stdout and stderr at 1 MiB each, and
serializes commands per machine. A nonzero remote exit is returned as HTTP
`200`, so always inspect `exit_code`, `timed_out`, truncation flags, and
`connection_dropped`.

## Mutation rules

Observation does not grant authority to act. Before cancelling a job or
running a command that can submit, overwrite, delete, signal, requeue, or alter
remote data, obtain explicit user authorization for that concrete action.

Cancellation is the only dedicated job mutation endpoint:

```text
POST /api/v1/jobs/{cluster}/{job_id}/cancel
Content-Type: application/json

{}
```

It invokes `scancel` constrained to the configured username and clears the
jobs cache. Confirm the exact cluster and job ID before calling it. Do not infer
permission to cancel from a request merely to inspect or diagnose a job.

The command API permits arbitrary execution with the remote user's privileges
and is therefore broader and riskier than its name suggests. It must remain
loopback-only. Prefer purpose-built observational endpoints whenever they can
answer the question.

## What Cluster Watcher does not currently provide

- There is no dedicated job-submission, requeue, reprioritization, reservation,
  or Slurm-script-generation API.
- It does not provide a complete policy oracle for maximum CPUs per GPU,
  memory, accounts, QOS, licenses, constraints, or filesystem requirements.
  Some configured partition walltime limits and test-only rejection messages
  are available, but site documentation remains authoritative.
- It does not guarantee that currently idle resources are usable by a
  particular job or that an estimated start time will hold.
- It does not store passwords or OTPs, answer MFA prompts for an agent, or
  transfer an authenticated session between machines.
- It does not expose unbounded remote files. Logs are intentionally bounded and
  paged.
- UI archive state is not a durable shared job database and has no scheduler
  effect.

If the user explicitly authorizes submission, an existing session can run
`sbatch` through `exec` or the command API. That is arbitrary remote execution,
not a validated submission service: inspect the target script, cluster,
partition, account/QOS requirements, and requested resources with the user
before acting.

## Recommended routing workflow

When asked where a rough GPU job should run:

1. Read one fresh snapshot and retain each cluster's error state.
2. Exclude unavailable partitions, aggregates when a concrete partition is
   required, and models that do not satisfy per-device VRAM or hardware needs.
3. Check that the request fits a feasible per-node shape; total free devices
   alone do not prove a multi-GPU job can be placed.
4. Compare `schedulable_idle`, representative wait estimates, walltime, and
   their timestamps/errors.
5. Return a ranked recommendation with assumptions and uncertainty. Do not
   submit unless separately and explicitly authorized.

## Project-development rules

Preserve the split between configuration, credentials, SSH transport, Slurm
parsing, personal-job/log services, command policy, snapshot generation,
terminal rendering, dashboard hosting, and CLI orchestration. Document every
behavior change in `README.md`, add focused unit coverage, and run:

```bash
python3 -m unittest discover -s tests -v
```
