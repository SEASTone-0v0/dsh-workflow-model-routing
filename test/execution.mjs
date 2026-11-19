// Offline unit tests for lib/execution.js (phase-C execution wiring).
// No Host, no network, no model calls. Run: node test/execution.mjs
import assert from "node:assert/strict";
import * as execution from "../lib/execution.js";
import * as modes from "../lib/modes.js";

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

// A minimal mode config used throughout (roles mirror the seeded shape).
function modeConfig(overrides = {}) {
  return {
    modeId: "normal",
    label: "普通模式",
    description: "test",
    schemaVersion: 1,
    revision: 0,
    updatedAt: "2026-11-14T00:00:00.000Z",
    source: "migrated",
    lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
    upgradeAdvisor: { enabled: true, provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default", reasoningEffort: null, smartMap: null, condition: "" },
    roles: [
      { id: "coder", name: "代码执行员", purpose: "实现", kind: "standard", enabled: true, primary: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default", reasoningEffort: null, smartMap: null }, backup: null, upgrade: null },
      { id: "secretary", name: "秘书", purpose: "汇总", kind: "standard", enabled: true, primary: { provider: "deepseek-account", model: "deepseek-flash", reasoningPolicy: "default", reasoningEffort: null, smartMap: null }, backup: null, upgrade: null },
      { id: "privacy-memory", name: "隐私记忆", purpose: "隐私", kind: "privacy", enabled: true, primary: { provider: "deepseek-account", model: "deepseek-flash", reasoningPolicy: "default", reasoningEffort: null, smartMap: null }, backup: null, upgrade: null },
    ],
    team: {
      planner: null,
      executor: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
      reviewer: null,
      advisor: null,
      maxConcurrentWorkers: 2,
      writeScopeIsolation: true,
      failureRetryLimit: 2,
      escalationThreshold: null,
      budgetLimit: null,
    },
    taskTargets: { native: { enabled: true }, taskBoard: { enabled: false } },
    inheritance: { from: "existing-store", note: "" },
    ...overrides,
  };
}

const authorized = [
  { provider: "deepseek-account", model: "deepseek-v4-pro" },
  { provider: "deepseek-account", model: "deepseek-flash" },
  { provider: "openai", model: "gpt-6.1-sol" },
];

await ok("freezeSessionSnapshot freezes a deep copy and returns true", () => {
  execution.clearSessionSnapshots();
  const config = modeConfig();
  const snapshot = { modeId: "normal", config };
  assert.equal(execution.freezeSessionSnapshot("s1", snapshot), true);
  const frozen = execution.readSessionSnapshot("s1");
  assert.equal(frozen.modeId, "normal");
  assert.equal(frozen.modeRevision, 0);
  assert.equal(typeof frozen.frozenAt, "number");
  // Deep copy: mutating the source does not mutate the frozen snapshot.
  config.lead.model = "changed";
  assert.equal(frozen.config.lead.model, "gpt-6.1-sol");
  assert.equal(execution.snapshotCount(), 1);
});

await ok("freezeSessionSnapshot refuses empty ids and unusable snapshots", () => {
  execution.clearSessionSnapshots();
  assert.equal(execution.freezeSessionSnapshot("", { modeId: "normal", config: modeConfig() }), false);
  assert.equal(execution.freezeSessionSnapshot("s", null), false);
  assert.equal(execution.freezeSessionSnapshot("s", { modeId: "", config: modeConfig() }), false);
  assert.equal(execution.snapshotCount(), 0);
});

await ok("ensureSessionSnapshot freezes lazily and keeps an existing freeze", () => {
  execution.clearSessionSnapshots();
  const snapshot = { modeId: "normal", config: modeConfig() };
  const first = execution.ensureSessionSnapshot("s1", snapshot);
  assert.equal(first.modeId, "normal");
  snapshot.modeId = "economy";
  const second = execution.ensureSessionSnapshot("s1", snapshot);
  assert.equal(second.modeId, "normal", "an existing freeze is not overwritten");
  assert.equal(execution.ensureSessionSnapshot("", snapshot), null);
  execution.clearSessionSnapshots();
});

await ok("leadSelectionFor carries only fixed efforts and null otherwise", () => {
  const config = modeConfig();
  assert.deepEqual(execution.leadSelectionFor(config), { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: null });
  config.lead.reasoningPolicy = "smart";
  config.lead.smartMap = { low: "low", medium: "medium", high: "high" };
  assert.deepEqual(execution.leadSelectionFor(config), { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: null });
  config.lead.reasoningPolicy = "fixed";
  config.lead.reasoningEffort = "high";
  assert.deepEqual(execution.leadSelectionFor(config), { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "high" });
  assert.equal(execution.leadSelectionFor(null), null);
  assert.equal(execution.leadSelectionFor({ lead: { provider: "", model: "x" } }), null);
});

await ok("applyLeadDefault calls saveSelection and reports honest failures", async () => {
  const calls = [];
  const service = { async saveSelection(next) { calls.push(next); } };
  const config = modeConfig();
  config.lead.reasoningPolicy = "fixed";
  config.lead.reasoningEffort = "medium";
  const result = await execution.applyLeadDefault(service, config);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "medium" });
  assert.equal(calls.length, 1);

  assert.equal((await execution.applyLeadDefault(null, config)).ok, false);
  assert.equal((await execution.applyLeadDefault(service, { lead: null })).ok, false);

  const failing = { async saveSelection() { throw new Error("boom"); } };
  const failed = await execution.applyLeadDefault(failing, config);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "boom");
});

await ok("resolveEffortStrict never guesses and distinguishes fixed failure from default", () => {
  const capability = (provider, model) =>
    provider === "openai"
      ? { status: "ok", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] }
      : { status: "unknown", efforts: [] };
  const capabilityFor = (p, m) => capability(p, m);

  // default → adapter default, no field
  const def = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" }, complexity: "high", capabilityFor });
  assert.equal(def.ok, true);
  assert.equal(def.reasoningEffort, undefined);

  // fixed with a declared effort passes
  const fixedOk = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed", reasoningEffort: "medium" }, complexity: "high", capabilityFor });
  assert.equal(fixedOk.ok, true);
  assert.equal(fixedOk.reasoningEffort, "medium");

  // fixed with an undeclared effort fails explicitly
  const fixedBad = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed", reasoningEffort: "super" }, complexity: "high", capabilityFor });
  assert.equal(fixedBad.ok, false);
  assert.equal(fixedBad.code, "fixed-effort-undeclared");

  // fixed with unknown capability fails explicitly
  const fixedUnknown = execution.resolveEffortStrict({ route: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "fixed", reasoningEffort: "medium" }, complexity: "high", capabilityFor });
  assert.equal(fixedUnknown.ok, false);
  assert.equal(fixedUnknown.code, "capability-unavailable");

  // fixed without an effort fails explicitly
  const fixedMissing = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed" }, complexity: "high", capabilityFor });
  assert.equal(fixedMissing.ok, false);
  assert.equal(fixedMissing.code, "fixed-effort-missing");

  // smart maps a difficulty that is declared
  const smartOk = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "high" } }, complexity: "high", capabilityFor });
  assert.equal(smartOk.ok, true);
  assert.equal(smartOk.reasoningEffort, "high");

  // smart with a missing mapping falls back to adapter default (never guesses)
  const smartDefault = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", smartMap: { low: "low" } }, complexity: "high", capabilityFor });
  assert.equal(smartDefault.ok, true);
  assert.equal(smartDefault.reasoningEffort, undefined);

  // smart mapping to an undeclared effort falls back to default, not a guess
  const smartUndeclared = execution.resolveEffortStrict({ route: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "super" } }, complexity: "high", capabilityFor });
  assert.equal(smartUndeclared.ok, true);
  assert.equal(smartUndeclared.reasoningEffort, undefined);

  // smart with unknown capability falls back to default
  const smartUnknown = execution.resolveEffortStrict({ route: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "high" } }, complexity: "high", capabilityFor });
  assert.equal(smartUnknown.ok, true);
  assert.equal(smartUnknown.reasoningEffort, undefined);
});

await ok("resolveRoleDispatch honours override > teamRole > role tier", () => {
  const capabilityFor = () => ({ status: "ok", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] });
  const config = modeConfig();

  // role tier
  const role = execution.resolveRoleDispatch({ snapshotConfig: config, modeId: "normal", modeRevision: 0, roleId: "coder", tier: "primary", complexity: "high", capabilityFor, authorizedModels: authorized });
  assert.equal(role.ok, true);
  assert.equal(role.route.provider, "deepseek-account");
  assert.equal(role.route.model, "deepseek-v4-pro");
  assert.equal(role.routeSource, "role-primary");

  // team role overrides the role tier
  const team = execution.resolveRoleDispatch({ snapshotConfig: config, modeId: "normal", modeRevision: 0, roleId: "coder", tier: "primary", teamRole: "executor", complexity: "high", capabilityFor, authorizedModels: authorized });
  assert.equal(team.ok, true);
  assert.equal(team.routeSource, "team-executor");
  assert.equal(team.route.model, "deepseek-v4-pro");

  // single-task override beats both
  const override = execution.resolveRoleDispatch({ snapshotConfig: config, modeId: "normal", modeRevision: 0, roleId: "coder", tier: "primary", teamRole: "executor", override: { provider: "openai", model: "gpt-6.1-sol" }, complexity: "high", capabilityFor, authorizedModels: authorized });
  assert.equal(override.ok, true);
  assert.equal(override.routeSource, "task-override");
  assert.equal(override.route.provider, "openai");
  assert.equal(override.route.model, "gpt-6.1-sol");
});

await ok("resolveRoleDispatch fails on unknown/disabled/privacy/no-route/unauthorized", () => {
  const capabilityFor = () => ({ status: "ok", efforts: [{ id: "low" }] });
  const config = modeConfig();

  assert.equal(execution.resolveRoleDispatch({ snapshotConfig: null, roleId: "coder", authorizedModels: authorized }).ok, false);
  assert.equal(execution.resolveRoleDispatch({ snapshotConfig: config, roleId: "nope", authorizedModels: authorized }).code, "unknown-role");

  const disabled = modeConfig();
  disabled.roles.find((r) => r.id === "coder").enabled = false;
  assert.equal(execution.resolveRoleDispatch({ snapshotConfig: disabled, roleId: "coder", authorizedModels: authorized }).code, "role-disabled");

  assert.equal(execution.resolveRoleDispatch({ snapshotConfig: config, roleId: "privacy-memory", authorizedModels: authorized }).code, "privacy-role");

  const noRoute = modeConfig();
  noRoute.roles.find((r) => r.id === "coder").primary = null;
  assert.equal(execution.resolveRoleDispatch({ snapshotConfig: noRoute, roleId: "coder", authorizedModels: authorized }).code, "no-route");

  // a route outside the authorized set is refused even via override
  const badOverride = execution.resolveRoleDispatch({ snapshotConfig: config, roleId: "coder", override: { provider: "google", model: "gemini-3-flash-preview" }, authorizedModels: authorized });
  assert.equal(badOverride.ok, false);
  assert.equal(badOverride.code, "unauthorized");

  // fixed with undeclared effort fails explicitly
  const fixedBad = modeConfig();
  fixedBad.roles.find((r) => r.id === "coder").primary = { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "fixed", reasoningEffort: "super" };
  const fixedResult = execution.resolveRoleDispatch({ snapshotConfig: fixedBad, roleId: "coder", authorizedModels: authorized, capabilityFor });
  assert.equal(fixedResult.ok, false);
  assert.equal(fixedResult.code, "fixed-effort-undeclared");
});

await ok("concurrency tracking is plugin-scoped and idempotent on untrack", () => {
  execution.clearDispatches();
  assert.equal(execution.activeDispatchCount(), 0);
  execution.trackDispatch("a", { roleId: "coder" });
  execution.trackDispatch("b", { roleId: "coder" });
  assert.equal(execution.activeDispatchCount(), 2);
  execution.trackDispatch("", {}); // empty key ignored
  assert.equal(execution.activeDispatchCount(), 2);
  execution.untrackDispatch("a");
  execution.untrackDispatch("a"); // idempotent
  assert.equal(execution.activeDispatchCount(), 1);
  execution.clearDispatches();
  assert.equal(execution.activeDispatchCount(), 0);
});

await ok("createTeamTask never fabricates success", async () => {
  // missing service
  assert.equal((await execution.createTeamTask(null, {}, {}, undefined)).ok, false);
  assert.equal((await execution.createTeamTask(null, {}, {}, undefined)).code, "taskboard-unsupported");

  // disabled
  const disabled = { isEnabled: () => false, createTask: async () => ({ id: "t1" }) };
  const d = await execution.createTeamTask(disabled, {}, {}, undefined);
  assert.equal(d.ok, false);
  assert.equal(d.code, "taskboard-disabled");

  // success
  const okService = { isEnabled: () => true, createTask: async () => ({ id: "t1" }) };
  const s = await execution.createTeamTask(okService, {}, {}, undefined);
  assert.equal(s.ok, true);
  assert.equal(s.task.id, "t1");

  // failure with persistence-unconfirmed flag
  const failing = { createTask: async () => { const e = new Error("unconfirmed"); e.code = "TEAM_TASK_PERSISTENCE_UNCONFIRMED"; throw e; } };
  const f = await execution.createTeamTask(failing, {}, {}, undefined);
  assert.equal(f.ok, false);
  assert.equal(f.persistenceUnconfirmed, true);
});

await ok("executionIntegration reports wired scope and advisory boundaries", () => {
  const full = execution.executionIntegration({ agentDefaultModel: { saveSelection: async () => {} }, agentTeams: { createTask: async () => ({}) } });
  assert.equal(full.leadDefault.wired, true);
  assert.equal(full.nativeDispatch.wired, true);
  assert.equal(full.sessionSnapshot.wired, true);
  assert.equal(full.taskBoard.wired, false);
  assert.equal(full.advisory.concurrency.includes("plugin-scoped"), true);
  assert.ok(Array.isArray(full.unsupported));
  assert.ok(full.unsupported.some((s) => /任务板|task_board|taskBoard/.test(s)), "task board reported as unsupported");

  const none = execution.executionIntegration({});
  assert.equal(none.leadDefault.wired, false);
  assert.equal(none.taskBoard.wired, false);
});

await ok("reserveDispatch/settle/release provide an atomic pre-await slot", () => {
  execution.clearDispatches();
  assert.equal(execution.activeDispatchCount(), 0);
  assert.equal(execution.pendingReservationCount(), 0);

  const t1 = execution.reserveDispatch(2, { roleId: "coder" });
  assert.ok(t1, "first reservation acquired");
  assert.equal(execution.pendingReservationCount(), 1);
  assert.equal(execution.activeDispatchCount(), 0);

  execution.trackDispatch("busy", { roleId: "coder" });
  assert.equal(execution.activeDispatchCount(), 1);

  const t2 = execution.reserveDispatch(2, { roleId: "coder" });
  assert.equal(t2, null, "reserve blocked when active+pending reach max");

  execution.settleReservation(t1, "settled");
  assert.equal(execution.pendingReservationCount(), 0);
  assert.equal(execution.activeDispatchCount(), 2);

  execution.untrackDispatch("settled");
  execution.untrackDispatch("busy");
  assert.equal(execution.activeDispatchCount(), 0);

  const t3 = execution.reserveDispatch(1, { roleId: "coder" });
  assert.ok(t3, "a pending reservation is acquired after clearing active");
  assert.equal(execution.pendingReservationCount(), 1);
  execution.releaseReservation(t3);
  assert.equal(execution.pendingReservationCount(), 0);

  execution.clearDispatches();
  assert.equal(execution.activeDispatchCount(), 0);
  assert.equal(execution.pendingReservationCount(), 0);
});

await ok("readCurrentSelection and restoreLeadDefault report honest outcomes", async () => {
  assert.equal(await execution.readCurrentSelection(undefined), null);
  assert.equal(await execution.readCurrentSelection({}), null);

  const r0 = await execution.restoreLeadDefault(undefined, { provider: "x", model: "y" });
  assert.equal(r0.ok, false);
  assert.ok(r0.error.includes("saveSelection"));

  const svc = {
    current: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: null },
    saved: [],
    currentSelection() { return this.current; },
    async saveSelection(s) { this.saved.push(s); this.current = s; },
  };
  const sel = await execution.readCurrentSelection(svc);
  assert.equal(sel.provider, "openai");
  assert.equal(sel.model, "gpt-6.1-sol");

  const r1 = await execution.restoreLeadDefault(svc, { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningEffort: null });
  assert.equal(r1.ok, true);
  assert.equal(svc.current.model, "deepseek-v4-pro");

  const r2 = await execution.restoreLeadDefault(svc, null);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes("无先前"));
});

await ok("freezeSessionSnapshot no longer evicts under pressure", () => {
  execution.clearSessionSnapshots();
  const active = { modeId: "economy", config: modeConfig(), enabledAt: "2026-11-14T00:00:00.000Z" };
  for (let i = 0; i < 1200; i += 1) {
    execution.freezeSessionSnapshot(`session-${i}`, active);
  }
  assert.equal(execution.snapshotCount(), 1200, "unbounded: no eviction of old sessions");
  const first = execution.readSessionSnapshot("session-0");
  assert.equal(first.modeId, "economy");
  execution.clearSessionSnapshots();
});

console.log(`\n${passed} checks passed`);
