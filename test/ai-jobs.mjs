/**
 * Offline unit test for the in-memory AI job manager (v2.6.2).
 *
 * The v2.6.1 AI configure/recommend handlers ran four serial llm.stream calls
 * inside a single HTTP request (up to 4 × 90s). Holding a browser↔host
 * connection idle that long made the browser `fetch` reject before the handler
 * wrote any bytes. v2.6.2 turns that into an immediate in-memory job + short
 * polling, while the four-mode serial work still runs in the background
 * (maxActive = 1).
 *
 * No DSH runtime is involved and no model call is made — every `run` closure is
 * a plain async function supplied by this test.
 *
 * Run: node test/ai-jobs.mjs   (from the bundle directory)
 */
import assert from "node:assert/strict";
import { createJobManager, MAX_UNFINISHED, MAX_RETAINED, JOB_TTL_MS } from "../lib/ai-jobs.js";

let passed = 0;
function ok(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${label}`);
    });
}

const unhandled = [];
const onUnhandledRejection = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandledRejection);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function untilJob(mgr, id, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = mgr.get(id);
    if (job === null) throw new Error(`job ${id} was evicted`);
    if (job.status === "succeeded" || job.status === "failed") {
      await tick(); // let schedule()'s .finally() run eviction/next-schedule
      return job;
    }
    if (Date.now() > deadline) throw new Error(`job ${id} timed out (status ${job.status})`);
    await tick();
  }
}

await ok("enqueue returns a queued snapshot before the run starts", async () => {
  const mgr = createJobManager();
  let started = false;
  const r = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    run: async () => {
      started = true;
      return "done";
    },
  });
  assert.equal(r.ok, true);
  assert.equal(typeof r.job.jobId, "string");
  assert.equal(r.job.status, "queued", "the returned snapshot is queued, not running");
  assert.equal(started, false, "run has not started synchronously");
  const job = await untilJob(mgr, r.job.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result, "done");
  mgr.dispose();
});

await ok("a deferred run stays queryable while unresolved, then succeeds", async () => {
  const mgr = createJobManager();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const r = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    run: async () => {
      await gate;
      return "done";
    },
  });
  assert.equal(r.job.status, "queued", "returned snapshot is queued");
  const pending = mgr.get(r.job.jobId);
  assert.equal(pending.status, "running", "record is running while the run is deferred");
  release();
  const job = await untilJob(mgr, r.job.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result, "done");
  mgr.dispose();
});

await ok("runs execute serially (global maxActive = 1)", async () => {
  const mgr = createJobManager();
  let release1;
  const gate1 = new Promise((resolve) => {
    release1 = resolve;
  });
  let started2 = false;
  const r1 = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    run: async () => {
      await gate1;
      return 1;
    },
  });
  const r2 = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    run: async () => {
      started2 = true;
      return 2;
    },
  });
  await tick();
  await tick();
  assert.equal(started2, false, "second job must not start while the first is running");
  release1();
  const j1 = await untilJob(mgr, r1.job.jobId);
  assert.equal(j1.status, "succeeded");
  assert.equal(j1.result, 1);
  const j2 = await untilJob(mgr, r2.job.jobId);
  assert.equal(started2, true, "second job started only after the first finished");
  assert.equal(j2.status, "succeeded");
  assert.equal(j2.result, 2);
  mgr.dispose();
});

await ok("a failed run keeps the nested cause, code, and kind", async () => {
  const mgr = createJobManager();
  const r = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    run: async () => {
      const cause = new Error("ECONNREFUSED 127.0.0.1:7890");
      cause.code = "ECONNREFUSED";
      const err = new TypeError("fetch failed");
      err.cause = cause;
      throw err;
    },
  });
  const job = await untilJob(mgr, r.job.jobId);
  assert.equal(job.status, "failed");
  assert.ok(job.error.includes("fetch failed"), "top-level message kept");
  assert.ok(job.error.includes("ECONNREFUSED"), "nested cause kept");
  assert.ok(job.error.includes("code=ECONNREFUSED"), "nested code kept");
  assert.equal(job.kind, "network", "classified as network");
  mgr.dispose();
});

await ok("requestId dedups the same task and conflicts on a different task", async () => {
  const mgr = createJobManager();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const r1 = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    requestId: "rid-1",
    run: async () => {
      await gate;
      return 1;
    },
  });
  const r2 = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    requestId: "rid-1",
    run: async () => 2,
  });
  assert.equal(r2.ok, true, "same requestId + same task is idempotent");
  assert.equal(r2.job.jobId, r1.job.jobId, "returns the same job");
  const conflict = mgr.enqueue({
    operation: "recommend",
    provider: "p",
    model: "m",
    requestId: "rid-1",
    run: async () => 3,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "request-id-conflict");
  assert.equal(conflict.jobId, r1.job.jobId);
  release();
  await untilJob(mgr, r1.job.jobId);
  mgr.dispose();
});

await ok(`enqueue is refused once ${MAX_UNFINISHED} jobs are unfinished`, async () => {
  const mgr = createJobManager();
  const releases = [];
  const runs = [];
  for (let i = 0; i < MAX_UNFINISHED; i++) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    runs.push(
      mgr.enqueue({
        operation: "configure",
        provider: "p",
        model: "m",
        run: async () => {
          await gate;
          return i;
        },
      }),
    );
  }
  const fifth = mgr.enqueue({
    operation: "configure",
    provider: "p",
    model: "m",
    run: async () => 99,
  });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.error, "capacity-full");
  for (const release of releases) release();
  for (const r of runs) await untilJob(mgr, r.job.jobId);
  mgr.dispose();
});

await ok(`retained jobs are bounded to ${MAX_RETAINED} total (oldest finished evicted)`, async () => {
  const mgr = createJobManager();
  const ids = [];
  const total = MAX_RETAINED + 8;
  for (let i = 0; i < total; i++) {
    const r = mgr.enqueue({
      operation: "configure",
      provider: "p",
      model: "m",
      run: async () => i,
    });
    ids.push(r.job.jobId);
    await untilJob(mgr, r.job.jobId);
  }
  assert.equal(mgr.get(ids[0]), null, "oldest finished evicted");
  assert.equal(mgr.get(ids[total - MAX_RETAINED - 1]), null, "evicted up to the retention window");
  const recent = mgr.get(ids[total - 1]);
  assert.equal(recent.status, "succeeded", "recent finished retained");
  assert.equal(recent.result, total - 1);
  mgr.dispose();
});

await ok("get returns null for an unknown id", async () => {
  const mgr = createJobManager();
  assert.equal(mgr.get("no-such-job"), null);
  mgr.dispose();
});

await ok("dispose stops new work and clears state", async () => {
  const mgr = createJobManager();
  mgr.dispose();
  const r = mgr.enqueue({ operation: "configure", provider: "p", model: "m", run: async () => 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "disposed");
});

await ok("finished jobs expire after JOB_TTL_MS (Date.now mocked)", async () => {
  const mgr = createJobManager();
  const realNow = Date.now;
  const base = 1_700_000_000_000;
  Date.now = () => base;
  try {
    const r = mgr.enqueue({
      operation: "configure",
      provider: "p",
      model: "m",
      run: async () => "done",
    });
    const job = await untilJob(mgr, r.job.jobId);
    assert.equal(job.status, "succeeded");
    assert.notEqual(mgr.get(r.job.jobId), null, "retained before TTL");
    Date.now = () => base + JOB_TTL_MS + 1;
    assert.equal(mgr.get(r.job.jobId), null, "expired after TTL");
  } finally {
    Date.now = realNow;
    mgr.dispose();
  }
});

await ok("no unhandled rejection was observed across the whole suite", async () => {
  await tick();
  process.removeListener("unhandledRejection", onUnhandledRejection);
  assert.equal(unhandled.length, 0, "every background job rejection is handled");
});

console.log(`\n${passed} passed`);
