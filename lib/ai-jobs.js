/*
 * @local/dsh-workflow-model-routing — in-memory AI job manager (v2.6.2).
 *
 * The v2.6.1 AI configure/recommend handlers ran four serial llm.stream calls
 * inside a single HTTP request (up to 4 × 90s = 360s). Holding a browser↔host
 * connection idle for that long made the browser `fetch` reject with
 * `TypeError: Failed to fetch` before the handler wrote any bytes. This module
 * turns that into an immediate in-memory job + short polling:
 *
 *   - POST /ai/jobs enqueues a job and returns 202 with a jobId immediately.
 *   - The four-mode serial work still runs in the background (maxActive = 1),
 *     using the exact same configureModes/recommendModels code path.
 *   - GET /ai/jobs?id=… returns the job status.
 *
 * Jobs are in-memory only (no persistence): a Host restart makes every id
 * invalid, which the client must report as a clear failure. Nothing here makes
 * a model call by itself — the caller supplies the `run` closure.
 */

import { randomUUID } from "node:crypto";
import { formatError, errorKind } from "./ai-assistant.js";

export const JOB_TTL_MS = 30 * 60_000; // finished jobs are retained at most 30min
export const MAX_UNFINISHED = 4; // queued + running
export const MAX_RETAINED = 32; // finished jobs kept for polling before eviction

export function createJobManager() {
  const jobs = new Map(); // id -> internal record
  let active = 0; // currently running jobs
  let disposed = false;

  function pruneExpired() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt >= JOB_TTL_MS) {
        if (job.timer) clearTimeout(job.timer);
        jobs.delete(id);
      }
    }
  }

  function countUnfinished() {
    let n = 0;
    for (const job of jobs.values()) {
      if (job.status === "queued" || job.status === "running") n += 1;
    }
    return n;
  }

  function evictIfNeeded() {
    // Evict the oldest finished jobs while the pool exceeds MAX_RETAINED.
    // Unfinished jobs are capped at MAX_UNFINISHED (< MAX_RETAINED), so the
    // pool always has enough finished jobs to evict and the retained total
    // converges to at most MAX_RETAINED.
    while (jobs.size > MAX_RETAINED) {
      let oldest = null;
      for (const job of jobs.values()) {
        if (!job.finishedAt) continue;
        if (oldest === null || job.finishedAt < oldest.finishedAt) oldest = job;
      }
      if (oldest === null) break; // nothing evictable left
      if (oldest.timer) clearTimeout(oldest.timer);
      jobs.delete(oldest.id);
    }
  }

  function armTtlTimer(job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (jobs.get(job.id) === job) jobs.delete(job.id);
    }, JOB_TTL_MS);
    if (typeof job.timer.unref === "function") job.timer.unref();
  }

  function publicStatus(job) {
    const out = {
      jobId: job.id,
      operation: job.operation,
      provider: job.provider,
      model: job.model,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    };
    if (job.status === "succeeded") out.result = job.result;
    if (job.status === "failed") {
      out.error = job.error;
      out.kind = job.kind;
    }
    return out;
  }

  function schedule() {
    if (disposed || active >= 1) return;
    let next = null;
    for (const job of jobs.values()) {
      if (job.status === "queued") {
        next = job;
        break;
      }
    }
    if (next === null) return;
    next.status = "running";
    next.startedAt = Date.now();
    active += 1;

    Promise.resolve()
      .then(() => next.run())
      .then(
        (result) => {
          next.status = "succeeded";
          next.result = result;
          next.finishedAt = Date.now();
          armTtlTimer(next);
        },
        (error) => {
          next.status = "failed";
          next.error = formatError(error);
          next.kind = errorKind(error);
          next.finishedAt = Date.now();
          armTtlTimer(next);
        },
      )
      .finally(() => {
        active -= 1;
        evictIfNeeded();
        schedule();
      });
  }

  function enqueue({ operation, provider, model, requestId = null, run }) {
    if (disposed) return { ok: false, error: "disposed" };
    pruneExpired();

    const rid = requestId === null || requestId === undefined || String(requestId) === "" ? null : String(requestId);
    if (rid !== null) {
      for (const job of jobs.values()) {
        if (job.requestId !== rid) continue;
        if (job.operation === operation && job.provider === provider && job.model === model) {
          // Same request re-submitted → return the SAME job (idempotent).
          return { ok: true, job: publicStatus(job) };
        }
        // Same requestId reused for a different task → conflict.
        return { ok: false, error: "request-id-conflict", jobId: job.id };
      }
    }

    if (countUnfinished() >= MAX_UNFINISHED) {
      return { ok: false, error: "capacity-full" };
    }

    const job = {
      id: randomUUID(),
      operation,
      provider,
      model,
      requestId: rid,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      kind: null,
      run,
      timer: null,
    };
    jobs.set(job.id, job);
    evictIfNeeded();
    // Fix the queued snapshot BEFORE schedule() so the POST response reports
    // "queued" as the contract requires. schedule() only flips the record to
    // "running" in a microtask, so the returned snapshot stays "queued".
    const snapshot = publicStatus(job);
    schedule();
    return { ok: true, job: snapshot };
  }

  function get(id) {
    pruneExpired();
    const job = jobs.get(id);
    return job ? publicStatus(job) : null;
  }

  function dispose() {
    disposed = true;
    for (const job of jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
    }
    jobs.clear();
    active = 0;
  }

  return { enqueue, get, dispose };
}
