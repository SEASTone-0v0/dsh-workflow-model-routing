/**
 * Offline UI test for the Phase B three-mode settings panel (run modes).
 *
 * Mirrors test/smoke.mjs harness conventions: loads the real lib/client.js in a
 * vm context, serves the run-mode HTTP routes through a fetch shim, and mounts
 * the exported ModesPanel component in jsdom against a stateful fake backend.
 *
 * Covers:
 *   - pure helper functions (route normalization, effort options, reasoning
 *     preview, capability status/source mapping, mode-route options)
 *   - three-mode rendering + current-mode badge
 *   - per-mode draft isolation (editing one mode never leaks into another)
 *   - reasoning policy editing (default/fixed/smart) driven ONLY by cached
 *     efforts; unknown / expired / invalidated capability is read-only and
 *     never offers a free-text effort (no guessed enums); model switch clears
 *     any stored effort
 *   - save (draft) vs enable (activate) separation, expectedRevision CAS
 *   - enable blocked while the draft is dirty
 *   - restore default / copy-from (client-local, no nonexistent API)
 *   - capability panel (source/status/effectiveStatus) + explicit local refresh
 *
 * No DSH runtime, no real model calls: the fetch shim only serves the
 * run-mode/capability/integration/tiers/validate routes and throws on anything
 * else, which is exactly how "metadata refresh is not a paid test" is enforced
 * here (test-connection goes through the real-probe POST /roles/validate).
 *
 * Run: node test/modes-client.mjs   (from the bundle directory)
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const bundleRoot = join(here, "..");
const sharedRequire = createRequire(import.meta.url);

const scratch = await fs.mkdtemp(join(os.tmpdir(), "mrs-modes-"));
process.env.DSH_PROFILE_DIR = scratch;

const ROUTE_BASE = "/plugins/dsh-workflow-model-routing";
const MODES_PATH = ROUTE_BASE + "/modes";
const MODE_SAVE_PATH = ROUTE_BASE + "/modes/save";
const MODE_ENABLE_PATH = ROUTE_BASE + "/modes/enable";
const ROLES_PATH = ROUTE_BASE + "/roles";
const SAVE_PATH = ROUTE_BASE + "/roles/save";
const VALIDATE_PATH = ROUTE_BASE + "/roles/validate";
const CAPABILITIES_PATH = ROUTE_BASE + "/capabilities";
const CAPABILITIES_REFRESH_PATH = ROUTE_BASE + "/capabilities/refresh";
const EXECUTION_INTEGRATION_PATH = ROUTE_BASE + "/execution-integration";
const TIERS_PATH = ROUTE_BASE + "/tiers";
const TIERS_REFRESH_PATH = ROUTE_BASE + "/tiers/refresh";
const AI_CONFIGURE_PATH = ROUTE_BASE + "/ai/configure";
const AI_RECOMMEND_PATH = ROUTE_BASE + "/ai/recommend";
const AI_JOBS_PATH = ROUTE_BASE + "/ai/jobs";
const RELEASE_NOTES_PATH = ROUTE_BASE + "/release-notes";
const BASE_URL = "http://127.0.0.1:60229";

let passed = 0;
let failed = 0;
async function ok(label, fn) {
  try {
    await Promise.resolve().then(fn);
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${label}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

/** Deep-compare vm-realm objects by round-tripping through JSON (their
 * prototypes differ from the test realm's, so assert.deepEqual would reject
 * structurally-identical values). */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * pure helpers (no DOM) — the client exports them for exactly this
 * ------------------------------------------------------------------ */

function route(provider, model, policy = "default", effort = null, smart = null) {
  return { provider, model, reasoningPolicy: policy, reasoningEffort: effort, smartMap: smart };
}

/* ------------------------------------------------------------------ *
 * load the client module (same vm harness as smoke.mjs)
 * ------------------------------------------------------------------ */

const { JSDOM } = sharedRequire("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
  url: BASE_URL + "/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
} catch {
  /* Node 22 exposes navigator as a getter */
}
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = sharedRequire("react");
const ReactDOMClient = sharedRequire("react-dom/client");
const ReactTestUtils = sharedRequire("react-dom/test-utils");
const reactAct = React.act ?? ReactTestUtils.act;

/* ------------------------------------------------------------------ *
 * stateful fake backend for the five run-mode routes
 * ------------------------------------------------------------------ */

function makeBackend() {
  const authorizedModels = [
    { provider: "openai", model: "gpt-6.1-sol" },
    { provider: "openai", model: "gpt-6-astra" },
    { provider: "openai", model: "codex" },
    { provider: "deepseek-account", model: "deepseek-flash" },
    { provider: "deepseek-account", model: "deepseek-v4-pro" },
    { provider: "moonshotai", model: "kimi-k3" },
    { provider: "google", model: "gemini-3.1-pro" },
    { provider: "google", model: "gemini-3-flash" },
  ];

  function makeRoles() {
    return [
      {
        id: "lead-coordinator", name: "总协调员", purpose: "澄清、拆解、协调、聚合",
        kind: "standard", enabled: true, switchRule: "confirm",
        primary: route("openai", "gpt-6.1-sol"), backup: null, upgrade: null,
      },
      {
        id: "independent-reviewer", name: "独立审查员", purpose: "同模型复核",
        kind: "reviewer", enabled: true, switchRule: "confirm",
        primary: null, backup: null, upgrade: null,
        pairings: [{ authorProviders: ["openai", "deepseek-account"], reviewer: route("openai", "gpt-6-astra") }],
      },
      {
        id: "privacy-manager", name: "隐私与记忆管理员", purpose: "隐私规则",
        kind: "privacy", enabled: true, switchRule: "confirm",
        primary: null, backup: null, upgrade: null,
      },
    ];
  }

  const baseTargets = { native: { enabled: true }, taskBoard: { enabled: false } };

  const modesStore = {
    ok: true,
    currentModeId: "normal",
    migration: { from: "legacy", migratedAt: "2026-11-14T05:00:00.000Z", backupFile: null, backedUp: false, roleCount: 3 },
    activeSnapshot: { modeId: "normal", config: {}, enabledAt: "2026-11-14T05:00:00.000Z" },
    authorizedModels,
    persistent: true,
    file: join(scratch, "dsh-economy-mode.state.json"),
    modes: {
      economy: {
        modeId: "economy", label: "经济", description: "默认低开销", schemaVersion: 2, revision: 0,
        updatedAt: "2026-11-14T05:00:00.000Z", source: "preset",
        lead: route("openai", "gpt-6.1-sol"),
        upgradeAdvisor: { enabled: true, ...route("openai", "gpt-6-astra"), condition: "两次有证据失败或高风险决策才咨询" },
        roles: makeRoles(),
        team: {
          planner: route("openai", "gpt-6.1-sol"),
          executor: route("google", "gemini-3-flash"),
          reviewer: route("moonshotai", "kimi-k3", "fixed", "low"), advisor: null,
          maxConcurrentWorkers: 2, writeScopeIsolation: true, failureRetryLimit: 2,
          escalationThreshold: "两次有证据失败", budgetLimit: null,
        },
        taskTargets: baseTargets,
        inheritance: { from: null, note: null },
      },
      normal: {
        modeId: "normal", label: "普通", description: "迁移起点", schemaVersion: 2, revision: 0,
        updatedAt: "2026-11-14T05:00:00.000Z", source: "preset",
        lead: route("openai", "gpt-6.1-sol"),
        upgradeAdvisor: { enabled: true, ...route("openai", "gpt-6-astra"), condition: "按需咨询，不默认双开" },
        roles: makeRoles(),
        team: {
          planner: route("openai", "gpt-6.1-sol"),
          executor: route("openai", "codex"),
          reviewer: route("google", "gemini-3.1-pro", "fixed", "low"),
          advisor: route("openai", "gpt-6.1-sol", "fixed", "ultra"),
          maxConcurrentWorkers: 2, writeScopeIsolation: true, failureRetryLimit: null,
          escalationThreshold: null, budgetLimit: null,
        },
        taskTargets: baseTargets,
        inheritance: { from: null, note: null },
      },
      performance: {
        modeId: "performance", label: "性能", description: "允许更强执行模型", schemaVersion: 2, revision: 0,
        updatedAt: "2026-11-14T05:00:00.000Z", source: "preset",
        lead: route("openai", "gpt-6.1-sol", "smart", null, { low: "low", medium: "medium", high: "high" }),
        upgradeAdvisor: { enabled: true, ...route("openai", "gpt-6-astra"), condition: "高风险或复杂架构才咨询" },
        roles: makeRoles(),
        team: {
          planner: route("openai", "gpt-6.1-sol", "smart", null, { low: "low", medium: "medium", high: "high" }),
          executor: route("deepseek-account", "deepseek-v4-pro", "smart", null, { low: "low", medium: "medium", high: "high" }),
          reviewer: route("openai", "gpt-6-astra", "smart", null, { low: "low", medium: "medium", high: "high" }),
          advisor: route("deepseek-account", "deepseek-flash", "smart", null, { low: "low", medium: "low", high: "low" }),
          maxConcurrentWorkers: null, writeScopeIsolation: true, failureRetryLimit: null,
          escalationThreshold: null, budgetLimit: null,
        },
        taskTargets: { native: { enabled: true }, taskBoard: { enabled: true } },
        inheritance: { from: null, note: null },
      },
      broke: {
        modeId: "broke", label: "穷鬼", description: "极限节约成本，但不禁选任何已授权模型。", schemaVersion: 2, revision: 0,
        updatedAt: "2026-11-15T05:00:00.000Z", source: "preset",
        lead: route("deepseek-account", "deepseek-v4-pro"),
        upgradeAdvisor: { enabled: false, provider: null, model: null, reasoningPolicy: "default", reasoningEffort: null, smartMap: null, condition: "禁用顾问" },
        roles: makeRoles().map(function (r) {
          return r.kind === "standard" ? { ...r, primary: route("deepseek-account", "deepseek-v4-pro"), backup: null, upgrade: null } : r;
        }),
        team: {
          planner: route("deepseek-account", "deepseek-v4-pro"),
          executor: route("deepseek-account", "deepseek-flash"),
          reviewer: null, advisor: null,
          maxConcurrentWorkers: 1, writeScopeIsolation: true, failureRetryLimit: 1,
          escalationThreshold: null, budgetLimit: null,
        },
        taskTargets: baseTargets,
        inheritance: { from: null, note: null },
      },
    },
  };

  // v2.5.0: the backend is the single source of truth for the recommended
  // presets + default authorizations (the client no longer hardcodes them).
  modesStore.recommendedPresets = {
    economy: modesStore.modes.economy,
    normal: modesStore.modes.normal,
    performance: modesStore.modes.performance,
    broke: modesStore.modes.broke,
  };
  modesStore.recommendedAuthorizedModels = [
    { provider: "deepseek-account", model: "deepseek-flash" },
    { provider: "deepseek-account", model: "deepseek-v4-pro" },
    { provider: "deepseek-account-vision", model: "deepseek-flash" },
    { provider: "deepseek-account-vision", model: "deepseek-v4-pro" },
    { provider: "openai", model: "gpt-6.1-sol" },
    { provider: "openai", model: "gpt-6-astra" },
    { provider: "openai", model: "gpt-5.6-sol" },
    { provider: "openai", model: "gpt-5.3-codex" },
    { provider: "moonshotai-cn", model: "kimi-k3" },
    { provider: "moonshotai-cn", model: "kimi-k3.1-pro" },
    { provider: "google", model: "gemini-3.1-pro-preview" },
    { provider: "google", model: "gemini-4-argon" },
  ];

  // Global role store (GET /roles, POST /roles/save): the decoupled
  // authorizedModels/roles/enabled ledger. MODE_SAVE never mutates it — a
  // non-current mode draft must not silently overwrite these live values.
  const globalStore = {
    ok: true,
    revision: 5,
    enabled: true,
    roles: makeRoles(),
    authorizedModels: authorizedModels.slice(),
  };

  const capsRecords = [
    { provider: "openai", model: "gpt-6.1-sol", fingerprint: "fp-sol", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium", source: "catalog", status: "ok", error: null, detectedAt: "2026-11-14T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "ok" },
    { provider: "openai", model: "gpt-6-astra", fingerprint: "fp-astra", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium", source: "catalog", status: "ok", error: null, detectedAt: "2026-11-14T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "ok" },
    { provider: "openai", model: "codex", fingerprint: "fp-codex", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [], defaultEffort: null, source: "catalog", status: "failed", error: "no metadata", detectedAt: "2026-11-14T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "failed" },
    { provider: "deepseek-account", model: "deepseek-v4-pro", fingerprint: "fp-v4pro", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium", source: "catalog", status: "ok", error: null, detectedAt: "2026-11-14T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "ok" },
    { provider: "google", model: "gemini-3-flash", fingerprint: "fp-gem", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [{ id: "low", name: "Low" }], defaultEffort: "low", source: "unknown", status: "unknown", error: null, detectedAt: null, lastVerifiedAt: null, effectiveStatus: "unknown" },
    { provider: "moonshotai", model: "kimi-k3", fingerprint: "fp-kimi", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }], defaultEffort: "medium", source: "catalog", status: "ok", error: null, detectedAt: "2026-11-10T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "expired" },
    { provider: "google", model: "gemini-3.1-pro", fingerprint: "fp-g31", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [], defaultEffort: null, source: "catalog", status: "ok", error: null, detectedAt: "2026-11-14T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "ok" },
    { provider: "deepseek-account", model: "deepseek-flash", fingerprint: "fp-dsf", adapterVersion: null, canDisableThinking: null, configSource: "declared", efforts: [{ id: "low", name: "Low" }], defaultEffort: "low", source: "catalog", status: "ok", error: null, detectedAt: "2026-11-14T05:00:00.000Z", lastVerifiedAt: null, effectiveStatus: "invalidated" },
  ];

  const integration = {
    ok: true,
    leadDefault: { wired: true, entryPoint: "agentDefaultModel.saveSelection", note: "called only on explicit enable" },
    nativeDispatch: { wired: true, entryPoint: "role_subagent tool", note: "per-position default/fixed/smart validation" },
    sessionSnapshot: { wired: true, entryPoint: "agent/created", note: "new sessions freeze the active snapshot" },
    taskBoard: { wired: false, entryPoint: "agentTeams.createTask", note: "service missing" },
    advisory: { concurrency: true, retry: true, budget: true, writeIsolation: true },
    unsupported: [],
  };

  const releaseNotesFixture = {
    currentVersion: "2.4.0",
    versions: [
      { version: "2.4.0", date: "2026-11-15", title: { zh: "AI 智能配置与推荐", en: "AI configure & recommend" }, sections: [{ title: { zh: "新功能", en: "Features" }, items: { zh: ["一键配置", "一键推荐"], en: ["One-click configure", "One-click recommend"] } }], files: ["lib/ai-assistant.js"] },
      { version: "2.3.0", date: "2026-11-14", title: { zh: "四模式", en: "Four modes" }, sections: [{ title: { zh: "模式", en: "Modes" }, items: { zh: ["四模式"], en: ["Four modes"] } }], files: ["lib/modes.js"] },
      { version: "2.2.0", date: "2026-11-13", title: { zh: "旧版2", en: "Old 2" }, sections: [], files: [] },
      { version: "2.1.0", date: "2026-11-12", title: { zh: "旧版1", en: "Old 1" }, sections: [], files: [] },
      { version: "1.0.0", date: "2026-11-11", title: { zh: "初版", en: "Initial" }, sections: [], files: [] },
    ],
  };

  const aiConfigureResponse = {
    ok: true, provider: "openai", model: "gpt-6.1-sol", catalogSummary: { providers: 3, models: 8 },
    results: [
      { modeId: "economy", ok: true, mode: { modeId: "economy", lead: route("anthropic", "claude-3-opus"), roles: makeRoles(), team: {} }, warnings: [] },
      { modeId: "normal", ok: true, mode: { modeId: "normal", lead: route("deepseek-account", "deepseek-v4-pro"), roles: makeRoles(), team: {} }, warnings: ["roles.lead-coordinator.backup: 该模式仍未配置"] },
      { modeId: "performance", ok: false, error: "AI 未返回有效配置" },
      { modeId: "broke", ok: true, mode: { modeId: "broke", lead: route("deepseek-account", "deepseek-v4-pro"), roles: makeRoles(), team: {} }, warnings: [] },
    ],
  };

  const aiRecommendResponse = {
    ok: true, provider: "openai", model: "gpt-6.1-sol", catalogSummary: { providers: 3, models: 8 },
    results: [
      { modeId: "economy", ok: true, roles: [
        { id: "lead-coordinator", name: "总协调员", candidates: [
          { provider: "openai", model: "gpt-6-astra", source: "local-catalog", reason: "适合协调", strengths: "强", cautions: "无", availableLocally: true },
          { provider: "anthropic", model: "claude-opus", source: "model-knowledge", reason: "市场推荐", strengths: "强推理", cautions: "需核对", availableLocally: false },
        ] },
      ] },
      { modeId: "normal", ok: true, roles: [] },
      { modeId: "performance", ok: false, error: "AI 未返回" },
      { modeId: "broke", ok: true, roles: [
        { id: "lead-coordinator", name: "总协调员", candidates: [
          { provider: "deepseek-account", model: "deepseek-flash", source: "local-catalog", reason: "穷鬼合规", strengths: "免费", cautions: "能力有限", availableLocally: true },
        ] },
      ] },
    ],
  };

  const requests = [];
  // Fault injection switches: flip to exercise partial-failure error paths.
  const faults = { rolesSave: false, rolesLoad: false, rolesSaveThrow: false, aiConfigureFail: false, aiConfigureHold: false, fetchReject: null, aiRawNonJson: false, aiPollReject: 0 };
  // Deferred AI-configure gate for testing the in-flight-edit skip behavior.
  const aiDeferred = { resolve: null };
  // In-memory AI job store simulating the /ai/jobs route (POST create + GET poll).
  const aiJobs = new Map();
  let aiJobSeq = 0;

  function json(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  }

  function handle(url, init) {
    const parsed = new URL(url, BASE_URL);
    const path = parsed.pathname;
    const search = parsed.search;
    const method = (init && init.method) || "GET";
    let body = null;
    if (init && init.body) body = JSON.parse(init.body);
    requests.push({ path, search, method, body });

    if (path === MODES_PATH && method === "GET") {
      return json(modesStore);
    }
    if (path === MODE_SAVE_PATH && method === "POST") {
      const modeId = body && body.modeId;
      const m = modesStore.modes[modeId];
      if (!m) return json({ error: "UNKNOWN_MODE" }, 400);
      if (body.expectedRevision !== undefined && body.expectedRevision !== m.revision) {
        return json({ error: "mode-save-conflict" }, 409);
      }
      const newRev = (m.revision || 0) + 1;
      const saved = { ...body.mode, modeId, revision: newRev, updatedAt: "2026-11-14T06:00:00.000Z" };
      modesStore.modes[modeId] = saved;
      return json({ ok: true, mode: saved, revision: newRev, saved: true, enabled: false });
    }
    if (path === MODE_ENABLE_PATH && method === "POST") {
      const modeId = body && body.modeId;
      const m = modesStore.modes[modeId];
      if (!m) return json({ error: "unknown-mode" }, 404);
      if (body.expectedRevision !== undefined && body.expectedRevision !== m.revision) {
        return json({ error: "mode-enable-conflict" }, 409);
      }
      const prev = modesStore.currentModeId;
      modesStore.currentModeId = modeId;
      modesStore.activeSnapshot = { modeId, config: m, enabledAt: "2026-11-14T06:00:00.000Z" };
      return json({ ok: true, currentModeId: modeId, previousModeId: prev, enabled: true });
    }
    if (path === ROLES_PATH && method === "GET") {
      if (faults.rolesLoad) return json({ ok: false, error: "roles-load-failed" }, 500);
      return json({ ok: true, revision: globalStore.revision, enabled: globalStore.enabled, roles: globalStore.roles.map((r) => ({ ...r })), authorizedModels: globalStore.authorizedModels.slice() });
    }
    if (path === SAVE_PATH && method === "POST") {
      if (faults.rolesSave) return json({ ok: false, error: "roles-save-failed" }, 500);
      if (faults.rolesSaveThrow) throw new Error("roles-save-network-down");
      // Global role-store save with CAS: a stale expectedRevision is a conflict.
      const expected = body && body.expectedRevision;
      if (expected !== undefined && expected !== null && expected !== globalStore.revision) {
        return json({ ok: false, error: "conflict", expected: globalStore.revision, actual: expected }, 409);
      }
      globalStore.enabled = (body && body.enabled) === true;
      globalStore.roles = (body && body.roles) || globalStore.roles;
      globalStore.authorizedModels = (body && body.authorizedModels) || globalStore.authorizedModels;
      globalStore.revision += 1;
      return json({ ok: true, revision: globalStore.revision, saved: true });
    }
    if (path === VALIDATE_PATH && method === "POST") {
      // Real probe result: gpt-6.1-sol passes (green), codex fails (red).
      const results = ((body && body.authorizedModels) || []).map((a) => ({
        provider: a.provider,
        model: a.model,
        ok: a.model !== "codex",
        code: a.model === "codex" ? 401 : 200,
        status: a.model === "codex" ? "unauthorized" : "ok",
        error: a.model === "codex" ? "probe failed" : null,
        transient: false,
        at: "2026-11-14T06:00:00.000Z",
      }));
      const failed = results
        .filter((r) => !r.ok)
        .map((r) => ({ provider: r.provider, model: r.model, code: r.code, status: r.status, message: r.error, transient: false }));
      return json({ ok: failed.length === 0, token: "tok-test", hash: "hash-test", checked: results.length, durationMs: 3, results, failed, note: "验证只说明此刻这条路线能完成一次最小请求…" });
    }
    if (path === CAPABILITIES_PATH && method === "GET") {
      return json({ ok: true, schemaVersion: 2, updatedAt: "2026-11-14T05:00:00.000Z", empty: false, persistent: true, file: join(scratch, "dsh-economy-capabilities.json"), records: capsRecords });
    }
    if (path === CAPABILITIES_REFRESH_PATH && method === "POST") {
      return json({ ok: true, updatedAt: "2026-11-14T06:00:00.000Z", providers: ["openai", "deepseek-account", "google", "moonshotai"], records: capsRecords, invalidated: 0, narrowed: 0, dropped: 0, note: "刷新只读取本地适配器元数据（listProviders/listModels/resolveModelInfo），不发起付费模型请求。" });
    }
    if (path === EXECUTION_INTEGRATION_PATH && method === "GET") {
      return json(integration);
    }
    // No real backend /tiers route exists yet; returning 404 exercises the
    // client's front-end tier fallback (tiersFailed → tiersFallbackNote).
    if (path === TIERS_PATH && method === "GET") {
      return json({ ok: false, error: "not-found" }, 404);
    }
    if (path === TIERS_REFRESH_PATH && method === "POST") {
      return json({ ok: false, error: "not-found" }, 404);
    }
    if (path === RELEASE_NOTES_PATH && method === "GET") {
      return json(releaseNotesFixture);
    }
    if (path === AI_CONFIGURE_PATH && method === "POST") {
      if (faults.aiRawNonJson) return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); } };
      if (faults.aiConfigureFail) return json({ ok: false, error: "ai-configure-failed" }, 500);
      if (faults.aiConfigureHold) {
        return new Promise((resolve) => { aiDeferred.resolve = () => resolve(json(aiConfigureResponse)); });
      }
      return json(aiConfigureResponse);
    }
    if (path === AI_RECOMMEND_PATH && method === "POST") {
      if (faults.aiRawNonJson) return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); } };
      return json(aiRecommendResponse);
    }
    if (path === AI_JOBS_PATH && method === "POST") {
      const operation = body && body.operation;
      const jobId = "job-" + (++aiJobSeq);
      const job = {
        jobId,
        operation,
        provider: body && body.provider,
        model: body && body.model,
        status: "queued",
        createdAt: "2026-11-14T06:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      };
      aiJobs.set(jobId, job);
      const response = operation === "recommend" ? aiRecommendResponse : aiConfigureResponse;
      const complete = () => {
        job.startedAt = "2026-11-14T06:00:01.000Z";
        if (faults.aiConfigureFail) {
          job.status = "failed";
          job.error = "ai-configure-failed";
          job.kind = "http";
        } else {
          job.status = "succeeded";
          job.result = response;
        }
        job.finishedAt = "2026-11-14T06:00:02.000Z";
      };
      if (faults.aiConfigureHold) {
        aiDeferred.resolve = complete;
      } else {
        queueMicrotask(complete);
      }
      return json({ ok: true, jobId, status: "queued" }, 202);
    }
    if (path === AI_JOBS_PATH && method === "GET") {
      if (faults.aiRawNonJson) return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); } };
      if (faults.aiPollReject > 0) {
        faults.aiPollReject -= 1;
        const err = new Error("Failed to fetch");
        err.name = "TypeError";
        err.cause = new Error("ECONNRESET 127.0.0.1:7890");
        throw err;
      }
      const jobId = new URL(url, BASE_URL).searchParams.get("id");
      const job = aiJobs.get(jobId);
      if (!job) return json({ error: "job-not-found", message: "任务不存在或已过期（可能因服务重启而丢失）" }, 404);
      return json({ ok: true, job });
    }
    throw new Error("unexpected route: " + method + " " + path);
  }

  return { modesStore, capsRecords, integration, requests, faults, globalStore, releaseNotesFixture, aiConfigureResponse, aiRecommendResponse, aiDeferred, aiJobs, handle };
}

/* ------------------------------------------------------------------ *
 * load + export the client
 * ------------------------------------------------------------------ */

// A controllable Date for the client's poll deadline (Date.now()). The client
// only uses `Date.now()` (poll deadline) and `new Date(value)` (a display
// helper), so extending Date with a mutable `now` lets the timeout test advance
// the clock 480001ms without waiting 8 real minutes. The host Date used by this
// test file is unaffected.
let fakeNowMs = Date.now();
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(fakeNowMs);
    else super(...args);
  }
  static now() {
    return fakeNowMs;
  }
}

const backend = makeBackend();
const captured = [];
const confirms = [];
const sandboxWindow = {
  __ModuleLoader__: {
    load(definition) {
      captured.push(definition);
    },
  },
  confirm(message) {
    confirms.push(String(message));
    return true;
  },
};

vm.runInNewContext(readFileSync(join(bundleRoot, "lib/client.js"), "utf8"), {
  window: sandboxWindow,
  URL,
  Date: FakeDate,
  console,
  fetch: (url, init) => {
    if (backend.faults.fetchReject) {
      const spec = backend.faults.fetchReject;
      const error = new Error(spec.message || "Failed to fetch");
      error.name = spec.name || "TypeError";
      if (spec.cause) error.cause = spec.cause;
      throw error;
    }
    return backend.handle(url, init);
  },
  document: window.document,
  setTimeout,
  clearTimeout,
  queueMicrotask,
});

assert.equal(captured.length, 1, "client module registered");
const definition = captured[0];
const clientExports = definition.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require(${name})`);
});

const helpers = clientExports.__modesHelpers;
const ModesPanel = clientExports.ModesPanel;
const copy = helpers.COPY.zh;
assert.ok(typeof ModesPanel === "function", "ModesPanel exported");
assert.ok(helpers.COPY.zh && helpers.COPY.en, "zh/en copy exported");

/* ------------------------------------------------------------------ *
 * pure-helper assertions
 * ------------------------------------------------------------------ */

await ok("normalizeReasonedRoute fills a flat reasoned route", () => {
  assert.deepEqual(
    plain(helpers.normalizeReasonedRoute({ provider: "openai", model: "gpt-6.1-sol" })),
    { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
  );
  assert.deepEqual(
    plain(helpers.normalizeReasonedRoute({ provider: "openai", model: "x", reasoningPolicy: "fixed", reasoningEffort: "high" })),
    { provider: "openai", model: "x", reasoningPolicy: "fixed", reasoningEffort: "high", smartMap: null },
  );
  assert.deepEqual(
    plain(helpers.normalizeReasonedRoute({ provider: "openai", model: "x", reasoningPolicy: "smart", smartMap: { low: "low", high: "high" } })),
    { provider: "openai", model: "x", reasoningPolicy: "smart", reasoningEffort: null, smartMap: { low: "low", medium: null, high: "high" } },
  );
  assert.equal(helpers.normalizeReasonedRoute(null), null);
  assert.equal(helpers.normalizeReasonedRoute({}), null);
  assert.equal(helpers.normalizeReasonedRoute({ provider: "", model: "" }), null);
  assert.equal(helpers.normalizeReasonedRoute({ provider: "openai", model: "x", reasoningPolicy: "bogus" }).reasoningPolicy, "default");
});

await ok("effortOptionsOf only returns raw IDs from the cached record", () => {
  assert.deepEqual(
    plain(helpers.effortOptionsOf({ efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] })),
    [{ value: "low", label: "low · Low" }, { value: "high", label: "high · High" }],
  );
  assert.equal(helpers.effortOptionsOf({ efforts: [] }), null);
  assert.equal(helpers.effortOptionsOf({}), null);
  assert.equal(helpers.effortOptionsOf(null), null);
});

await ok("capMapOf keys by provider\\u0000model and capabilityStatus maps each state", () => {
  const map = helpers.capMapOf(backend.capsRecords);
  assert.equal(map["openai\u0000gpt-6.1-sol"].effectiveStatus, "ok");
  assert.equal(map["google\u0000gemini-3-flash"].effectiveStatus, "unknown");
  assert.equal(helpers.capabilityStatus("invalidated", copy), copy.capStatusInvalidated);
  assert.equal(helpers.capabilityStatus("expired", copy), copy.capStatusExpired);
  assert.equal(helpers.capabilityStatus("failed", copy), copy.capStatusFailed);
  assert.equal(helpers.capabilityStatus("ok", copy), copy.capStatusOk);
  assert.equal(helpers.capabilityStatus("nope", copy), copy.capStatusUnknown);
  assert.equal(helpers.capabilitySource("catalog", copy), copy.capSourceCatalog);
  assert.equal(helpers.capabilitySource("unknown", copy), copy.capSourceUnknown);
});

await ok("reasoningPreview reports invalid when effort is not in the cached list", () => {
  const sol = helpers.capMapOf(backend.capsRecords)["openai\u0000gpt-6.1-sol"];
  assert.match(helpers.reasoningPreview(route("openai", "gpt-6.1-sol", "fixed", "high"), sol, copy), /high/);
  assert.equal(helpers.reasoningPreview(route("openai", "gpt-6.1-sol", "fixed", "ultra"), sol, copy), copy.reasoningPreviewInvalid);
  assert.equal(helpers.reasoningPreview(route("openai", "gpt-6.1-sol", "default"), sol, copy), copy.reasoningPreviewDefault);
  assert.equal(helpers.reasoningPreview(route("openai", "gpt-6.1-sol", "smart", null, { low: "low", medium: "medium", high: "high" }), sol, copy), copy.reasoningPreviewSmart);
  assert.equal(helpers.reasoningPreview(route("openai", "gpt-6.1-sol", "smart", null, { low: "low", medium: "ultra", high: "high" }), sol, copy), copy.reasoningPreviewInvalid);
});

await ok("reasoningValid accepts only declared efforts on a known capability, rejects stale states", () => {
  const cap = helpers.capMapOf(backend.capsRecords);
  const sol = cap["openai\u0000gpt-6.1-sol"];
  const expired = cap["moonshotai\u0000kimi-k3"];
  const invalidated = cap["deepseek-account\u0000deepseek-flash"];
  const unknown = cap["google\u0000gemini-3-flash"];
  const noEfforts = cap["google\u0000gemini-3.1-pro"];
  // default is always valid (no effort constraint)
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "default"), sol), true);
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "default"), unknown), true);
  // fixed: exact ID only
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "fixed", "high"), sol), true);
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "fixed", "ultra"), sol), false, "residual ID is invalid");
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "fixed", null), sol), false, "missing effort is invalid");
  // smart: every difficulty must be a declared ID
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "smart", null, { low: "low", medium: "medium", high: "high" }), sol), true);
  assert.equal(helpers.reasoningValid(route("openai", "gpt-6.1-sol", "smart", null, { low: "low", medium: "ultra", high: "high" }), sol), false);
  // unknown / expired / invalidated / no-efforts capability blocks fixed and smart
  assert.equal(helpers.reasoningValid(route("moonshotai", "kimi-k3", "fixed", "low"), expired), false, "expired blocks fixed");
  assert.equal(helpers.reasoningValid(route("deepseek-account", "deepseek-flash", "smart", null, { low: "low", medium: "low", high: "low" }), invalidated), false, "invalidated blocks smart");
  assert.equal(helpers.reasoningValid(route("google", "gemini-3-flash", "fixed", "low"), unknown), false, "unknown blocks fixed");
  assert.equal(helpers.reasoningValid(route("google", "gemini-3.1-pro", "fixed", "low"), noEfforts), false, "no declared efforts blocks fixed");
});

await ok("wiringSummary reflects the actual backend integration and never claims a global effect", () => {
  const label = "经济";
  const full = helpers.wiringSummary(backend.integration, copy, label);
  assert.match(full, new RegExp(copy.modeEnabled.replace("{label}", label)));
  assert.match(full, new RegExp(copy.wiringLeadDefault));
  assert.match(full, new RegExp(copy.wiringNative));
  assert.match(full, new RegExp(copy.wiringSession));
  assert.match(full, new RegExp(copy.wiringTaskBoard));
  assert.match(full, new RegExp(copy.wiringOn));
  assert.match(full, new RegExp(copy.wiringOff));
  assert.ok(full.includes(copy.wiringScopeNote), "scope note present");
  assert.doesNotMatch(full, /阶段 ?C/, "no hardcoded phase-C pending copy");
  const none = helpers.wiringSummary(null, copy, label);
  assert.match(none, new RegExp(copy.modeEnabledUnknown));
  assert.match(none, new RegExp(copy.modeEnabled.replace("{label}", label)));
});

await ok("modeRouteOptions lists only authorized models and flags the unauthorised current value", () => {
  const opts = helpers.modeRouteOptions(
    [{ provider: "openai", model: "gpt-6.1-sol" }, { provider: "google", model: "gemini-3-flash" }],
    "openai\u0000codex",
    copy,
  );
  assert.equal(opts.length, 3);
  assert.equal(opts[2].value, "openai\u0000codex");
  assert.match(opts[2].label, new RegExp(copy.unauthorizedOption));
});

await ok("v2.6.3: vision aliases cannot reappear via authorized or old-current route fallback", () => {
  const opts = helpers.modeRouteOptions([
    {provider:"openai-vision",model:"gpt-6.1-sol"},
    {provider:"antigravity",model:"gemini-3.1-flash-image"},
    {provider:"kimi-subscription",model:"k3.1-pro"}
  ], "google-vision\u0000gemini-4-argon", copy);
  assert.equal(opts.length, 2);
  assert.ok(opts.every(o => !o.value.includes("-vision")));
  assert.ok(opts.some(o => o.value.includes("flash-image")), "native image models stay visible");
});

await ok("tierOfProvider maps providers to the four tiers", () => {
  assert.equal(helpers.tierOfProvider("deepseek-account"), "broke");
  assert.equal(helpers.tierOfProvider("deepseek-account-vision"), "broke");
  assert.equal(helpers.tierOfProvider("openai"), "performance");
  assert.equal(helpers.tierOfProvider("anthropic"), "performance");
  assert.equal(helpers.tierOfProvider("google"), "economy");
  assert.equal(helpers.tierOfProvider("moonshotai"), "normal");
  assert.equal(helpers.tierOfProvider("unknown-provider"), "normal");
});

await ok("broke-mode restriction helpers are removed (free-choice contract)", () => {
  assert.equal(helpers.isBrokeMode, undefined, "isBrokeMode removed");
  assert.equal(helpers.isHighValueModel, undefined, "isHighValueModel removed");
});

await ok("tierLabelOf prefixes the tier emoji and localized label", () => {
  assert.match(helpers.tierLabelOf("broke", copy), /🔴/);
  assert.match(helpers.tierLabelOf("economy", copy), /🟡/);
  assert.match(helpers.tierLabelOf("normal", copy), /🟢/);
  assert.match(helpers.tierLabelOf("performance", copy), /🔵/);
  assert.match(helpers.tierLabelOf("broke", copy), new RegExp(copy.tierBroke));
});

await ok("versionList exposes the four changelog entries, v2.3.0 first", () => {
  const versions = helpers.versionList();
  assert.equal(versions.length, 4);
  assert.equal(versions[0].version, "v2.3.0");
  assert.ok(versions.every((v) => typeof v.zh === "string" && typeof v.en === "string"));
});

await ok("modeRouteOptions returns every authorized route selectable (no broke disable)", () => {
  const opts = helpers.modeRouteOptions(
    [{ provider: "deepseek-account", model: "deepseek-v4-pro" }, { provider: "openai", model: "gpt-6.1-sol" }],
    "",
    copy,
  );
  assert.equal(opts.length, 2);
  assert.equal(opts[0].disabled, undefined, "deepseek model stays selectable");
  assert.equal(opts[1].disabled, undefined, "openai model stays selectable (free choice)");
});

await ok("routeTierId prefers the modelTierMap (slash key) over provider fallback", () => {
  const tiers = {
    modelTierMap: {
      "openai/gpt-6.1-sol": { tierId: "normal", badge: "🟢" },
      "google/gemini-3-flash": { tierId: "broke", badge: "🔴" },
    },
  };
  assert.equal(helpers.routeTierId({ provider: "openai", model: "gpt-6.1-sol" }, tiers), "normal", "model key beats provider fallback");
  assert.equal(helpers.routeTierId({ provider: "google", model: "gemini-3-flash" }, tiers), "broke");
  // missing entry falls back to provider tier (deepseek-account → broke)
  assert.equal(helpers.routeTierId({ provider: "deepseek-account", model: "deepseek-v4-pro" }, tiers), "broke");
  // no tiers object → pure provider fallback
  assert.equal(helpers.routeTierId({ provider: "openai", model: "gpt-6.1-sol" }, null), "performance");
  assert.equal(helpers.routeTierId({ provider: "openai", model: "gpt-6.1-sol" }, { modelTierMap: {} }), "performance");
  assert.equal(helpers.routeTierId(null, tiers), "normal");
});

/* ------------------------------------------------------------------ *
 * integration: apply registers the same two slots as before
 * ------------------------------------------------------------------ */

await ok("apply registers exactly the two settings slots (unchanged)", () => {
  const registrations = [];
  const clientCtx = {
    get: () => null,
    slots: {
      inject(name, callback) {
        assert.ok(name === "settings.section" || name === "settings.section.icon");
        callback();
      },
      register(registration, component) {
        registrations.push(Object.assign({ component }, registration));
        return () => {};
      },
    },
  };
  clientExports.apply(clientCtx);
  assert.deepEqual(
    registrations.map((entry) => entry.name),
    ["settings.section", "settings.section.icon"],
  );
  assert.equal(registrations[0].id, "subagent-roles-and-models");
});

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

function q(container, selector) {
  return container.querySelector(selector);
}
function qa(container, selector) {
  return [...container.querySelectorAll(selector)];
}
function findButton(container, text) {
  return qa(container, "button").find((b) => b.textContent.includes(text));
}
function modeTab(container, label) {
  return qa(container, ".mrs-mtab").find((b) => b.textContent.includes(label));
}

async function changeSelect(act, select, value) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
    descriptor.set.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

async function changeInput(act, input, value) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    descriptor.set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function clickButton(act, button) {
  await act(async () => {
    // HTMLElement.click() runs the default action (e.g. toggles a checkbox's
    // `checked`), which dispatchEvent(MouseEvent) does not, so React's onChange
    // for checkboxes reads the post-toggle value.
    button.click();
  });
}

/* ------------------------------------------------------------------ *
 * mount ModesPanel once and drive it through the interaction sequence
 * ------------------------------------------------------------------ */

const container = window.document.getElementById("root");
const root = ReactDOMClient.createRoot(container);

await ok("ModesPanel renders four full-width mode buttons with green-current / red-dirty dots", async () => {
  await reactAct(async () => {
    root.render(React.createElement(ModesPanel, { copy }));
  });
  await reactAct(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const tabs = qa(container, ".mrs-mtab");
  assert.equal(tabs.length, 4);
  const text = container.textContent;
  assert.match(text, new RegExp(copy.runModeTitle));
  assert.match(text, /经济/);
  assert.match(text, /普通/);
  assert.match(text, /性能/);
  assert.match(text, /穷鬼/);
  assert.match(text, new RegExp(copy.modeCurrentShort));
  assert.match(text, new RegExp(copy.tabTeam));
  assert.match(text, new RegExp(copy.tabHub));
  assert.match(text, new RegExp(copy.tabModels));
  // the mode bar is a horizontal full-width grid (verified via the installed CSS)
  const bar = q(container, ".mrs-mbar");
  assert.ok(bar, "mode bar exists");
  assert.equal(bar.querySelectorAll(".mrs-mtab").length, 4, "four mode buttons inside the bar");
  const styleText = qa(window.document, "style").map((s) => s.textContent).join("\n");
  assert.ok(styleText.includes(".mrs-mbar{display:grid"), "mode bar uses CSS grid");
  assert.ok(styleText.includes("repeat(4,minmax(0,1fr))"), "four equal full-width columns");
  // current mode shows a green dot, not a text pill
  const normalTab = modeTab(container, "普通");
  assert.match(normalTab.textContent, new RegExp(copy.modeCurrentShort));
  assert.ok(q(normalTab, ".mrs-mdot--current"), "green current dot present");
  assert.ok(!q(normalTab, ".mrs-badge"), "no legacy badge pill");
});

await ok("task board target is now a read-only note (no independent-session toggle)", async () => {
  const teamGroup = qa(container, ".mrs-mbody .mrs-mgroup")[1];
  const checks = qa(teamGroup, ".mrs-check");
  const boardLabel = checks.find((lab) => lab.textContent.includes(copy.targetBoard));
  assert.equal(boardLabel, undefined, "task board independent-session checkbox is gone in v2.5.0");
  const nativeLabel = checks.find((lab) => lab.textContent.includes(copy.targetNative));
  assert.ok(nativeLabel, "native same-tree target checkbox remains");
  assert.equal(q(nativeLabel, "input[type=checkbox]").disabled, false, "native target stays editable");
  assert.ok(teamGroup.textContent.includes(copy.nativeScopeNote), "native dispatch scope note is shown");
});

await ok("team tab keeps concurrency + native toggle but team-role editors moved to the Role Hub", async () => {
  const act = reactAct;
  const teamGroup = qa(container, ".mrs-mbody .mrs-mgroup")[1];
  assert.ok(teamGroup.textContent.includes(copy.teamConcurrency), "concurrency field remains");
  assert.ok(!teamGroup.textContent.includes(copy.teamRetry), "failureRetryLimit hidden");
  assert.ok(!teamGroup.textContent.includes(copy.teamEscalation), "escalationThreshold hidden");
  assert.ok(!teamGroup.textContent.includes(copy.teamBudget), "budgetLimit hidden");
  assert.ok(!teamGroup.textContent.includes(copy.teamWriteIsolation), "writeScopeIsolation hidden");
  assert.ok(!teamGroup.textContent.includes(copy.teamPlanner), "planner editor no longer on team tab");
  assert.ok(!teamGroup.textContent.includes(copy.teamExecutor), "executor editor no longer on team tab");
  assert.ok(!teamGroup.textContent.includes(copy.teamReviewer), "reviewer editor no longer on team tab");
  assert.ok(!teamGroup.textContent.includes(copy.teamAdvisor), "advisor editor no longer on team tab");

  // moved editors live under the Role Hub's two advanced <details> groups
  await clickButton(act, subTab(container, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const details = qa(container, ".mrs-details");
  assert.equal(details.length, 2, "two advanced groups on the Role Hub");
  assert.ok(details[0].textContent.includes(copy.teamOverrideTitle), "collaboration identity override group");
  assert.ok(details[0].textContent.includes(copy.teamOverrideHint), "override > teamRole > role[tier] priority hint shown");
  assert.ok(details[0].textContent.includes(copy.teamPlanner), "planner editor on roles tab");
  assert.ok(details[0].textContent.includes(copy.teamExecutor), "executor editor on roles tab");
  assert.ok(details[0].textContent.includes(copy.teamReviewer), "reviewer editor on roles tab");
  assert.ok(details[0].textContent.includes(copy.teamAdvisor), "advisor editor on roles tab");
  assert.ok(details[1].textContent.includes(copy.advisorGroupTitle), "collaboration advice group");
  assert.ok(details[1].textContent.includes(copy.advisorEnabled), "advisor enable control on roles tab");
  assert.ok(details[1].textContent.includes(copy.advisorCondition), "advisor condition control on roles tab");

  // back to team tab for the following lead-editor tests
  await clickButton(act, subTab(container, copy.tabTeam));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
});

await ok("mode draft isolation: editing economy never leaks into normal", async () => {
  const act = reactAct;
  // normal is selected and clean; switch to economy
  await clickButton(act, modeTab(container, "经济"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  // change economy's lead model to codex
  const ecoLead = q(container, ".mrs-mbody .mrs-mroute");
  assert.equal(q(ecoLead, "select").value, "openai\u0000gpt-6.1-sol");
  await changeSelect(act, q(ecoLead, "select"), "openai\u0000codex");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.match(modeTab(container, "经济").textContent, new RegExp(copy.modeDirtyShort));

  // switch to normal: its lead is untouched
  await clickButton(act, modeTab(container, "普通"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const normalLead = q(container, ".mrs-mbody .mrs-mroute");
  assert.equal(q(normalLead, "select").value, "openai\u0000gpt-6.1-sol", "normal lead untouched");

  // switch back to economy: the codex edit is preserved
  await clickButton(act, modeTab(container, "经济"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const ecoLead2 = q(container, ".mrs-mbody .mrs-mroute");
  assert.equal(q(ecoLead2, "select").value, "openai\u0000codex", "economy lead edit preserved");

  // return to normal so the fixed/smart reasoning tests run on a known route
  await clickButton(act, modeTab(container, "普通"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
});

await ok("reasoning policy fixed offers only cached efforts (no guessed enums)", async () => {
  const act = reactAct;
  const leadEditor = q(container, ".mrs-mbody .mrs-mroute");
  const policySelect = q(leadEditor, ".mrs-mroute__policy select");
  assert.ok(policySelect, "policy select present");
  assert.equal(policySelect.value, "default");
  await changeSelect(act, policySelect, "fixed");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const effortSelect = q(leadEditor, ".mrs-mroute__efforts select");
  assert.ok(effortSelect, "effort select appears for a known capability");
  const effortValues = [...effortSelect.options].map((o) => o.value).filter((v) => v !== "");
  assert.deepEqual(effortValues, ["low", "medium", "high"], "only the model's declared effort IDs, in order");
  assert.ok(!effortValues.includes("ultra"), "no guessed enum");

  // set fixed effort = high, preview reflects it
  await changeSelect(act, effortSelect, "high");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.match(leadEditor.textContent, /high/);
});

await ok("reasoning policy smart maps task difficulty to cached effort IDs", async () => {
  const act = reactAct;
  const leadEditor = q(container, ".mrs-mbody .mrs-mroute");
  const policySelect = q(leadEditor, ".mrs-mroute__policy select");
  await changeSelect(act, policySelect, "smart");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const smartSelects = qa(leadEditor, ".mrs-mroute__efforts select");
  assert.equal(smartSelects.length, 3, "low/medium/high difficulty selects");
  for (const s of smartSelects) {
    const values = [...s.options].map((o) => o.value).filter((v) => v !== "");
    assert.deepEqual(values, ["low", "medium", "high"]);
  }
});

await ok("unknown capability is read-only: fixed/smart disabled, no free text", async () => {
  const act = reactAct;
  // economy executor = google/gemini-3-flash (effectiveStatus unknown)
  await clickButton(act, modeTab(container, "经济"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await clickButton(act, subTab(container, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const overrideGroup = qa(container, ".mrs-details")[0];
  assert.ok(overrideGroup, "collaboration identity override group present");
  const executorEditor = qa(overrideGroup, ".mrs-mroute").find((n) => q(n, "select") && q(n, "select").value === "google\u0000gemini-3-flash");
  assert.ok(executorEditor, "executor editor found");
  const policySelect = q(executorEditor, ".mrs-mroute__policy select");
  assert.ok(policySelect, "policy select present");
  assert.equal(policySelect.value, "default", "unknown capability stays on model default");
  const fixedOpt = [...policySelect.options].find((o) => o.value === "fixed");
  const smartOpt = [...policySelect.options].find((o) => o.value === "smart");
  assert.equal(fixedOpt.disabled, true, "fixed is disabled for unknown capability");
  assert.equal(smartOpt.disabled, true, "smart is disabled for unknown capability");
  assert.equal(qa(executorEditor, ".mrs-mroute__efforts select").length, 0, "no guessed effort select");
  assert.equal(qa(executorEditor, ".mrs-mroute__efforts input[type=text]").length, 0, "no free-text effort input");
  assert.match(executorEditor.textContent, new RegExp(copy.reasoningFallback), "fallback hint shown");

  // back to team tab for the following save/lead tests
  await clickButton(act, subTab(container, copy.tabTeam));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
});

await ok("save posts the draft with expectedRevision and does not change the current mode", async () => {
  const act = reactAct;
  const before = backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length;
  const leadEditor = q(container, ".mrs-mbody .mrs-mroute");
  const saveBtn = findButton(container, copy.saveSettings);
  assert.ok(saveBtn, "save button present");
  // economy was switched to but is not dirty yet (only policy edits above were on economy's
  // executor, which made it dirty)
  assert.equal(saveBtn.disabled, false, "save enabled while dirty");
  await clickButton(act, saveBtn);
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const saves = backend.requests.filter((r) => r.path === MODE_SAVE_PATH);
  assert.equal(saves.length, before + 1, "one save request sent");
  const last = saves[saves.length - 1];
  assert.equal(last.method, "POST");
  assert.equal(last.body.modeId, "economy");
  assert.equal(last.body.expectedRevision, 0, "revision sent as CAS guard");
  assert.equal(backend.modesStore.currentModeId, "normal", "saving a draft does not activate it");
  // economy is NOT the current mode and auth is unchanged → global roles are NOT synced
  const rolesSaves = backend.requests.filter((r) => r.path === SAVE_PATH && r.method === "POST");
  assert.equal(rolesSaves.length, 0, "saving a non-current mode must not touch global roles");
  assert.match(container.textContent, new RegExp(copy.modeSaved));
});

await ok("enable activates the saved mode and shows the actual wiring scope (no hardcoded phase-C)", async () => {
  const act = reactAct;
  const enableBtn = findButton(container, copy.enableMode);
  assert.equal(enableBtn.disabled, false, "enable enabled once the draft is clean");
  await clickButton(act, enableBtn);
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const enables = backend.requests.filter((r) => r.path === MODE_ENABLE_PATH);
  assert.equal(enables.length, 1, "one enable request sent");
  assert.equal(enables[0].body.modeId, "economy");
  assert.equal(enables[0].body.expectedRevision, 1, "revision advanced after save");
  assert.equal(backend.modesStore.currentModeId, "economy");
  assert.match(modeTab(container, "经济").textContent, new RegExp(copy.modeCurrentShort));
  assert.match(container.textContent, new RegExp(copy.modeEnabled.replace("{label}", "经济")));
  assert.match(container.textContent, new RegExp(copy.wiringLeadDefault));
  assert.match(container.textContent, new RegExp(copy.wiringNative));
  assert.match(container.textContent, new RegExp(copy.wiringSession));
  assert.match(container.textContent, new RegExp(copy.wiringTaskBoard));
  assert.match(container.textContent, new RegExp(copy.wiringOn));
  assert.match(container.textContent, new RegExp(copy.wiringOff));
  assert.ok(container.textContent.includes(copy.wiringScopeNote), "scope note present");
  assert.doesNotMatch(container.textContent, /阶段 ?C/, "never a hardcoded phase-C pending copy");
});

await ok("enable is blocked while the draft is dirty (no request fired)", async () => {
  const act = reactAct;
  const before = backend.requests.filter((r) => r.path === MODE_ENABLE_PATH).length;
  await clickButton(act, modeTab(container, "性能"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  // make performance dirty via its lead model
  const leadEditor = q(container, ".mrs-mbody .mrs-mroute");
  const modelSelect = q(leadEditor, "select");
  await changeSelect(act, modelSelect, "openai\u0000codex");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const enableBtn = findButton(container, copy.enableMode);
  assert.equal(enableBtn.disabled, true, "enable disabled while dirty");
  assert.equal(backend.requests.filter((r) => r.path === MODE_ENABLE_PATH).length, before, "no enable request while dirty");
});

await ok("restore default resets lead/advisor/team to the client preset (keeps roles)", async () => {
  const act = reactAct;
  const before = confirms.length;
  await clickButton(act, findButton(container, copy.restorePreset));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(confirms.length, before + 1, "restore asks for confirmation");
  const leadEditor = q(container, ".mrs-mbody .mrs-mroute");
  assert.equal(q(leadEditor, "select").value, "openai\u0000gpt-6.1-sol", "lead restored to preset");
  assert.match(container.textContent, new RegExp(copy.modeRestored));
});

await ok("copy-from clones another mode's config into the draft (client-local)", async () => {
  const act = reactAct;
  const sourceSelect = qa(container, ".mrs-mactions select").find((s) => [...s.options].some((o) => o.value === "economy"));
  assert.ok(sourceSelect, "copy-from source select present");
  await changeSelect(act, sourceSelect, "economy");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const before = confirms.length;
  await clickButton(act, findButton(container, copy.copyMode));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(confirms.length, before + 1, "copy asks for confirmation");
  assert.match(container.textContent, new RegExp(copy.modeCopied));
  assert.equal(backend.requests.filter((r) => r.path.includes("copy")).length, 0, "no copy API exists; it stayed client-local");
});

await ok("Model config tab shows tier badges, fallback note, cache/effort/ref columns, and real-probe dots", async () => {
  const act = reactAct;
  await clickButton(act, qa(container, ".mrs-msubtab").find((b) => b.textContent.includes(copy.tabModels)));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  // exactly the four tier badges (no hidden benchmark database)
  const tierBadges = qa(container, ".mrs-tierbadge");
  assert.equal(tierBadges.length, 4, "four tier badges only");
  assert.match(container.textContent, /🔴/);
  assert.match(container.textContent, /🟡/);
  assert.match(container.textContent, /🟢/);
  assert.match(container.textContent, /🔵/);
  assert.match(container.textContent, new RegExp(copy.tierBroke));

  // tiers route 404s in this harness → front-end fallback note is shown
  assert.match(container.textContent, new RegExp(copy.tiersFallbackNote));

  // one row per authorized model (not the full 176-model catalog), plus one header row
  const head = q(container, ".mrs-caprow--head");
  assert.ok(head, "grid header present");
  assert.ok(head.textContent.includes(copy.capCacheStatus), "cache-status column");
  assert.ok(head.textContent.includes(copy.capEfforts), "efforts column");
  assert.ok(head.textContent.includes(copy.referencedBy), "reference column");
  const rows = qa(container, ".mrs-caprow:not(.mrs-caprow--head)");
  assert.equal(rows.length, backend.modesStore.authorizedModels.length, "only authorized models are listed");

  // the test-probe dot is neutral before any probe; the capability-cache dot is separate
  assert.ok(rows.every((row) => {
    const dot = q(row, ".mrs-caprow__test .mrs-dot");
    return dot && !dot.classList.contains("mrs-dot--ok") && !dot.classList.contains("mrs-dot--bad");
  }), "neutral test dot before testing");

  // capability-cache column reflects the cached effectiveStatus, not the probe
  const solRow = rows.find((row) => row.textContent.includes("gpt-6.1-sol"));
  assert.ok(q(solRow, ".mrs-caprow__cache .mrs-dot--ok"), "gpt-6.1-sol cache dot is ok");
  assert.ok(solRow.textContent.includes(copy.capStatusOk), "gpt-6.1-sol cache label is 可用");
  const codexRow = rows.find((row) => row.textContent.includes("codex"));
  assert.ok(q(codexRow, ".mrs-caprow__cache .mrs-dot--bad"), "codex cache dot is failed");
  assert.ok(codexRow.textContent.includes(copy.capEffortsOff), "codex has no efforts → off");

  // reference column: referenced model shows a badge, unreferenced shows the empty hint
  assert.ok(solRow.textContent.includes(copy.referencedBy), "referenced model shows reference tag");
  assert.ok(solRow.textContent.includes("总协调员"), "referenced by the lead-coordinator role");
  const kimiRow = rows.find((row) => row.textContent.includes("kimi-k3"));
  assert.ok(kimiRow.textContent.includes(copy.notReferenced), "unreferenced model shows empty hint");

  // test connection is a distinct button; it posts a real probe (POST /roles/validate)
  const testBtn = findButton(container, copy.testConnection);
  assert.ok(testBtn, "test connection button present");
  const refreshBtn = findButton(container, copy.capRefresh);
  assert.ok(refreshBtn, "refresh capability button present");
  assert.match(refreshBtn.textContent, /付费/);
  const before = backend.requests.filter((r) => r.path === VALIDATE_PATH).length;
  await clickButton(act, testBtn);
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(backend.requests.filter((r) => r.path === VALIDATE_PATH).length, before + 1, "test connection sends a real probe");
  const validateReq = backend.requests.filter((r) => r.path === VALIDATE_PATH).pop();
  assert.equal(validateReq.method, "POST", "validate is a POST");
  assert.ok(Array.isArray(validateReq.body.authorizedModels), "validate payload carries authorized models");
  assert.ok(Array.isArray(validateReq.body.roles), "validate payload carries roles");

  // after testing: pass = green, fail = red (from the real probe, not capability cache)
  const solRow2 = qa(container, ".mrs-caprow:not(.mrs-caprow--head)").find((row) => row.textContent.includes("gpt-6.1-sol"));
  assert.ok(q(solRow2, ".mrs-caprow__test .mrs-dot--ok"), "passing model shows a green test dot");
  const codexRow2 = qa(container, ".mrs-caprow:not(.mrs-caprow--head)").find((row) => row.textContent.includes("codex"));
  assert.ok(q(codexRow2, ".mrs-caprow__test .mrs-dot--bad"), "failing model shows a red test dot");
});

/* ------------------------------------------------------------------ *
 * fresh remount: drive the read-only effort states with clean drafts
 * ------------------------------------------------------------------ */

const container2 = window.document.createElement("div");
container2.id = "root2";
window.document.body.appendChild(container2);
const root2 = ReactDOMClient.createRoot(container2);

await ok("fresh remount: expired capability shows a stored fixed effort read-only", async () => {
  await reactAct(async () => {
    root2.render(React.createElement(ModesPanel, { copy }));
  });
  await reactAct(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const act = reactAct;
  // fresh mount starts on the current mode (economy); its reviewer = kimi-k3 (expired), fixed low
  await clickButton(act, modeTab(container2, "经济"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await clickButton(act, subTab(container2, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const overrideGroup = qa(container2, ".mrs-details")[0];
  const reviewer = qa(overrideGroup, ".mrs-mroute").find((n) => q(n, "select") && q(n, "select").value === "moonshotai\u0000kimi-k3");
  assert.ok(reviewer, "expired reviewer editor found");
  const policySelect = q(reviewer, ".mrs-mroute__policy select");
  assert.equal(policySelect.value, "fixed", "stored fixed policy preserved");
  assert.equal([...policySelect.options].find((o) => o.value === "fixed").disabled, true, "fixed disabled when expired");
  assert.equal([...policySelect.options].find((o) => o.value === "smart").disabled, true, "smart disabled when expired");
  assert.equal(qa(reviewer, ".mrs-mroute__efforts select").length, 0, "no effort select for expired");
  assert.equal(qa(reviewer, ".mrs-mroute__efforts input[type=text]").length, 0, "no free-text effort for expired");
  assert.match(reviewer.textContent, new RegExp(copy.reasoningStale), "stale hint shown");
});

await ok("fresh remount: invalidated capability is read-only for a stored smart map", async () => {
  const act = reactAct;
  // performance advisor = deepseek-account/deepseek-flash (invalidated), stored smart
  await clickButton(act, modeTab(container2, "性能"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const overrideGroup = qa(container2, ".mrs-details")[0];
  const advisor = qa(overrideGroup, ".mrs-mroute").find((n) => q(n, "select") && q(n, "select").value === "deepseek-account\u0000deepseek-flash");
  assert.ok(advisor, "invalidated advisor editor found");
  const policySelect = q(advisor, ".mrs-mroute__policy select");
  assert.equal(policySelect.value, "smart", "stored smart policy preserved");
  assert.equal([...policySelect.options].find((o) => o.value === "fixed").disabled, true);
  assert.equal([...policySelect.options].find((o) => o.value === "smart").disabled, true);
  assert.equal(qa(advisor, ".mrs-mroute__efforts select").length, 0, "no tier selects for invalidated");
  assert.equal(qa(advisor, ".mrs-mroute__efforts input[type=text]").length, 0, "no free-text for invalidated");
  assert.match(advisor.textContent, new RegExp(copy.reasoningStale));
});

await ok("fresh remount: known capability with no declared efforts is read-only", async () => {
  const act = reactAct;
  // normal reviewer = google/gemini-3.1-pro (ok but efforts:[]), stored fixed low
  await clickButton(act, modeTab(container2, "普通"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const overrideGroup = qa(container2, ".mrs-details")[0];
  const reviewer = qa(overrideGroup, ".mrs-mroute").find((n) => q(n, "select") && q(n, "select").value === "google\u0000gemini-3.1-pro");
  assert.ok(reviewer, "no-efforts reviewer editor found");
  const policySelect = q(reviewer, ".mrs-mroute__policy select");
  assert.equal(policySelect.value, "fixed", "stored fixed policy preserved");
  assert.equal([...policySelect.options].find((o) => o.value === "fixed").disabled, true, "fixed disabled when no efforts");
  assert.equal([...policySelect.options].find((o) => o.value === "smart").disabled, true, "smart disabled when no efforts");
  assert.equal(qa(reviewer, ".mrs-mroute__efforts select").length, 0, "no effort select when no efforts");
  assert.equal(qa(reviewer, ".mrs-mroute__efforts input[type=text]").length, 0, "no free-text when no efforts");
  assert.match(reviewer.textContent, new RegExp(copy.reasoningNoEfforts), "no-efforts hint shown");
});

await ok("fresh remount: residual (undeclared) ID is a disabled option, never silently kept", async () => {
  const act = reactAct;
  // normal advisor = openai/gpt-6.1-sol (known), stored fixed "ultra" (undeclared)
  const overrideGroup = qa(container2, ".mrs-details")[0];
  const advisor = qa(overrideGroup, ".mrs-mroute").find((n) => q(n, "select") && q(n, "select").value === "openai\u0000gpt-6.1-sol" && q(n, ".mrs-mroute__efforts select"));
  assert.ok(advisor, "residual advisor editor found (has an effort select)");
  const policySelect = q(advisor, ".mrs-mroute__policy select");
  assert.equal(policySelect.value, "fixed");
  assert.equal([...policySelect.options].find((o) => o.value === "fixed").disabled, false, "fixed stays selectable on a known capability");
  const effortSelect = q(advisor, ".mrs-mroute__efforts select");
  assert.ok(effortSelect, "effort select present for known capability");
  const residualOpt = [...effortSelect.options].find((o) => o.value === "ultra");
  assert.ok(residualOpt, "residual ID present as an option");
  assert.equal(residualOpt.disabled, true, "residual ID is disabled, not silently valid");
  assert.match(residualOpt.label, new RegExp(copy.reasoningResidual));
  assert.match(advisor.textContent, new RegExp(copy.reasoningPreviewInvalid), "preview marks the stored value invalid");
});

await ok("fresh remount: switching model clears any stored effort (policy resets to default)", async () => {
  const act = reactAct;
  // normal lead = openai/gpt-6.1-sol; set fixed+high, then switch to codex
  await clickButton(act, subTab(container2, copy.tabTeam));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const leadEditor = q(container2, ".mrs-mbody .mrs-mroute");
  const modelSelect = q(leadEditor, "select");
  assert.equal(modelSelect.value, "openai\u0000gpt-6.1-sol");
  const policySelect = q(leadEditor, ".mrs-mroute__policy select");
  await changeSelect(act, policySelect, "fixed");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await changeSelect(act, q(leadEditor, ".mrs-mroute__efforts select"), "high");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await changeSelect(act, modelSelect, "openai\u0000codex");
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const policySelect2 = q(leadEditor, ".mrs-mroute__policy select");
  assert.equal(policySelect2.value, "default", "model switch resets policy to default");
  assert.equal(qa(leadEditor, ".mrs-mroute__efforts select").length, 0, "model switch clears the effort select");
  assert.equal(qa(leadEditor, ".mrs-mroute__efforts input[type=text]").length, 0, "and leaves no free-text effort");
});

/* ------------------------------------------------------------------ *
 * fresh remount: v2.3.0 three-tab structure, broke constraints, changelog
 * ------------------------------------------------------------------ */

const container3 = window.document.createElement("div");
container3.id = "root3";
window.document.body.appendChild(container3);
const root3 = ReactDOMClient.createRoot(container3);
await reactAct(async () => {
  root3.render(React.createElement(ModesPanel, { copy }));
});
await reactAct(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

function subTab(container, text) {
  return qa(container, ".mrs-msubtab").find((b) => b.textContent.includes(text));
}

await ok("three sub-tabs switch between team config, Model & Role Hub, and Model config", async () => {
  const act = reactAct;
  const subTabs = qa(container3, ".mrs-msubtab");
  assert.equal(subTabs.length, 3, "three sub-tabs");
  assert.ok(subTabs[0].textContent.includes(copy.tabTeam));
  assert.ok(subTabs[1].textContent.includes(copy.tabHub));
  assert.ok(subTabs[2].textContent.includes(copy.tabModels));
  assert.ok(q(container3, ".mrs-msubtab--active").textContent.includes(copy.tabTeam), "team tab default active");
  assert.ok(q(container3, ".mrs-mbody .mrs-mgroup"), "team tab body rendered");
  assert.equal(qa(container3, ".mrs-details").length, 0, "team tab has no advanced detail groups");

  // roles tab: role cards, no tier badges / authorized grid
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.ok(q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]'), "hub tab shows role cards");
  assert.equal(q(container3, ".mrs-tierbadge"), null, "roles tab has no tier badges");
  assert.equal(q(container3, ".mrs-capgrid"), null, "roles tab has no authorized grid");
  assert.equal(qa(container3, ".mrs-details").length, 2, "roles tab shows two advanced detail groups");

  // models tab: tier badges + authorized grid, no role cards
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.ok(q(container3, ".mrs-tierbadge"), "models tab shows tier badges");
  assert.ok(q(container3, ".mrs-capgrid"), "models tab shows authorized grid");
  assert.equal(q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]'), null, "models tab has no role cards");

  // team tab again
  await clickButton(act, subTab(container3, copy.tabTeam));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.ok(q(container3, ".mrs-mbody .mrs-mgroup"), "team tab body rendered again");
});

await ok("dump the three tab DOM snapshots for the lead's headless review (single mount + offline theme)", async () => {
  const act = reactAct;
  const tmpDir = join(bundleRoot, "..", "tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  // Only the container3 mount is exported (NOT document.documentElement), so
  // sibling test mounts never leak into the snapshot. The injected .mrs CSS is
  // re-emitted, and offline theme tokens are supplied (snapshot-only) so the
  // headless render has real colors instead of white-on-white.
  // React drives <select> through its `value` property, leaving the option
  // `selected` content attribute untouched. Serialized outerHTML would then
  // show the first/placeholder option instead of the real value, so sync the
  // attribute for the snapshot only (runtime is unaffected).
  const syncSelects = () => {
    for (const sel of qa(container3, "select")) {
      const v = sel.value;
      for (const opt of [...sel.options]) {
        if (opt.value === v) {
          opt.setAttribute("selected", "");
        } else {
          opt.removeAttribute("selected");
        }
      }
    }
  };

  const buildSnapshot = (name) => {
    syncSelects();
    const styles = qa(window.document, "style")
      .map((s) => s.textContent || "")
      .filter((t) => t.trim().length > 0)
      .map((t) => "<style>" + t + "</style>")
      .join("\n");
    const theme =
      "<style>" +
      ".mrs{--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#646a73;" +
      "--dsw-alias-brand-primary:#3370ff;--dsw-alias-border-l1:#e3e6ea;" +
      "--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f6f7f8;" +
      "--dsw-alias-state-idle-primary:#8a8f98;--dsw-alias-state-success-primary:#18a058;" +
      "--dsw-alias-state-error-primary:#d03050;--dsw-alias-state-warn-primary:#f0a020;" +
      'font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff;}' +
      ".mrs *{box-sizing:border-box;}" +
      "</style>";
    return (
      "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\">\n" +
      styles + "\n" + theme + "\n</head>\n<body><div class=\"mrs\">" +
      container3.outerHTML +
      "</div></body>\n</html>"
    );
  };

  await clickButton(act, subTab(container3, copy.tabTeam));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await fs.writeFile(join(tmpDir, "hub-review-team.html"), buildSnapshot("team"), "utf8");

  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await fs.writeFile(join(tmpDir, "hub-review-roles.html"), buildSnapshot("roles"), "utf8");

  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await fs.writeFile(join(tmpDir, "hub-review-models.html"), buildSnapshot("models"), "utf8");
});

await ok("injected CSS parses into real rules (no escaped-newline corruption)", async () => {
  const selectors = new Set();
  for (const sheet of [...window.document.styleSheets]) {
    let rules = [];
    try { rules = [...sheet.cssRules]; } catch (e) { /* cross-origin/inaccessible */ }
    for (const rule of rules) {
      if (rule && rule.selectorText) selectors.add(rule.selectorText.trim());
    }
  }
  for (const sel of [".mrs-mbar", ".mrs-caprow", ".mrs-capgrid", ".mrs-mmodes--saving", ".mrs-msubtab", ".mrs-tierbadge"]) {
    assert.ok(selectors.has(sel), `CSS rule "${sel}" parses as an exact selectorText (join produced real newlines)`);
  }
});

await ok("inline reasoning policy in role cards (configured slot has policy, unset slot hides it)", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const roleCard = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  const editors = qa(roleCard, ".mrs-mroute");
  assert.equal(editors.length, 3, "standard role has primary/backup/upgrade editors");
  assert.ok(q(editors[0], ".mrs-mroute__policy select"), "configured primary shows reasoning policy");
  assert.equal(q(editors[1], ".mrs-mroute__policy select"), null, "unset backup hides reasoning policy");
  assert.equal(q(editors[2], ".mrs-mroute__policy select"), null, "unset upgrade hides reasoning policy");
});

await ok("roles tab: add, disable/enable, and delete a role (draft-local)", async () => {
  const act = reactAct;
  assert.equal(qa(container3, '.mrs-mroute[data-role-id]').length, 3, "three role cards initially");

  await clickButton(act, findButton(container3, copy.addRole));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(qa(container3, '.mrs-mroute[data-role-id]').length, 4, "addRole appends a fourth card");
  const customCard = q(container3, '.mrs-mroute[data-role-id="custom-1"]');
  assert.ok(customCard, "new role id is custom-1");

  const leadCard = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  await clickButton(act, q(leadCard, 'input[type="checkbox"]'));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const leadDisabled = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  assert.ok(leadDisabled.className.includes("mrs-mroute--disabled"), "disabled card dimmed");
  assert.ok(leadDisabled.textContent.includes(copy.roleDisabled), "disabled badge shown");

  await clickButton(act, q(leadDisabled, 'input[type="checkbox"]'));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const leadReenabled = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  assert.equal(leadReenabled.className.includes("mrs-mroute--disabled"), false, "re-enabled card not dimmed");

  const confirmsBefore = confirms.length;
  await clickButton(act, findButton(customCard, copy.removeRole));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(confirms.length, confirmsBefore + 1, "delete prompts for confirmation");
  assert.equal(qa(container3, '.mrs-mroute[data-role-id]').length, 3, "custom role removed");
});

await ok("models tab: revoke is blocked while a model is still referenced by roles", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const rows = qa(container3, ".mrs-caprow:not(.mrs-caprow--head)");
  assert.equal(rows.length, 8, "eight authorized rows");

  const solRow = rows.find((r) => r.textContent.includes("gpt-6.1-sol"));
  assert.ok(solRow, "sol row present");
  await clickButton(act, findButton(solRow, copy.revoke));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const errMsg = q(container3, ".mrs-err");
  assert.ok(errMsg, "reference-protection message shown");
  assert.ok(errMsg.textContent.includes("总协调员"), "names the referencing role");
  assert.equal(qa(container3, ".mrs-caprow:not(.mrs-caprow--head)").length, 8, "row count unchanged after blocked revoke");

  const codexRow = qa(container3, ".mrs-caprow:not(.mrs-caprow--head)").find((r) => r.textContent.includes("codex"));
  assert.ok(codexRow, "codex row present");
  await clickButton(act, findButton(codexRow, copy.revoke));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(qa(container3, ".mrs-caprow:not(.mrs-caprow--head)").length, 7, "unreferenced codex revoked");
});

await ok("auth-only save posts only the role save (probe-free) with enabled + expectedRevision", async () => {
  const act = reactAct;
  const modeSavesBefore = backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length;
  const roleSavesBefore = backend.requests.filter((r) => r.path === SAVE_PATH).length;

  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  // mode draft is clean (only the authorization changed) → no mode save fires.
  assert.equal(backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length, modeSavesBefore, "no mode draft to persist");
  assert.equal(backend.requests.filter((r) => r.path === SAVE_PATH).length, roleSavesBefore + 1, "role save fired (authorization changed)");

  const roleBody = backend.requests.filter((r) => r.path === SAVE_PATH).pop().body;
  assert.equal(roleBody.skipValidation, true, "save is probe-free (skipValidation)");
  assert.equal(roleBody.validationToken, undefined, "no validation token sent");
  assert.equal(Array.isArray(roleBody.authorizedModels), true, "authorizedModels is an array");
  assert.equal(Array.isArray(roleBody.roles), true, "roles is an array");
  assert.equal(roleBody.authorizedModels.some((a) => a.model === "codex"), false, "revoked codex is not persisted");
  assert.equal(roleBody.enabled, true, "preserves the server's global enabled flag");
  assert.equal(roleBody.expectedRevision, 5, "global revision sent as CAS guard");
});

await ok("role-only change that fails global sync stays dirty (pendingGlobal) and retries", async () => {
  const act = reactAct;
  // clean state after the auth-only save: authDraft === stored auth, no pending sync
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  // toggle the lead-coordinator off → the mode draft changes roles (modeDirty)
  const leadCard = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  await clickButton(act, q(leadCard, 'input[type="checkbox"]'));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.ok(q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]').className.includes("mrs-mroute--disabled"), "lead disabled in the draft");

  const modeSavesBefore = backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length;
  const roleSavesBefore = backend.requests.filter((r) => r.path === SAVE_PATH).length;

  backend.faults.rolesSave = true;
  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  backend.faults.rolesSave = false;

  // both the mode draft and the global sync fire (current mode + roles changed)
  assert.equal(backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length, modeSavesBefore + 1, "mode save fired");
  assert.equal(backend.requests.filter((r) => r.path === SAVE_PATH).length, roleSavesBefore + 1, "role save fired");
  const lastTwo = backend.requests.slice(-2);
  assert.equal(lastTwo[0].path, MODE_SAVE_PATH, "mode save precedes role save");
  assert.equal(lastTwo[1].path, SAVE_PATH, "role save follows mode save");

  const warn = q(container3, ".mrs-warn");
  assert.ok(warn, "partial failure is a warning, not success");
  assert.ok(warn.textContent.includes(copy.rolesSaveFailed), "explicit global-sync failure feedback");
  assert.ok(warn.textContent.includes(copy.modeSaved), "mode draft still saved");
  // the fix: after MODE_SAVE succeeds (draft==stored), pendingGlobal still keeps the form dirty
  assert.equal(findButton(container3, copy.saveSettings).disabled, false, "save stays enabled (pendingGlobal keeps it dirty)");
  assert.ok(q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]').className.includes("mrs-mroute--disabled"), "unsaved role change preserved");

  // retry without the fault → global sync succeeds and clears the pending flag
  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  assert.equal(backend.requests.filter((r) => r.path === SAVE_PATH).length, roleSavesBefore + 2, "retry fires the role save again");
  assert.equal(q(container3, ".mrs-warn"), null, "warning cleared after the retry succeeds");
  const finalBody = backend.requests.filter((r) => r.path === SAVE_PATH).pop().body;
  assert.equal(finalBody.roles.find((r) => r.id === "lead-coordinator").enabled, false, "disabled role synced to the global store");
});

await ok("partial global-save failure on an auth-only change preserves the unsaved authorization", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const rowsBefore = qa(container3, ".mrs-caprow:not(.mrs-caprow--head)");
  assert.equal(rowsBefore.length, 7, "seven rows after codex revoked");

  const g31Row = rowsBefore.find((r) => r.textContent.includes("gemini-3.1-pro"));
  assert.ok(g31Row, "gemini-3.1-pro row present");
  await clickButton(act, findButton(g31Row, copy.revoke));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(qa(container3, ".mrs-caprow:not(.mrs-caprow--head)").length, 6, "gemini-3.1-pro revoked in the draft");

  backend.faults.rolesSave = true;
  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  backend.faults.rolesSave = false;

  const warn = q(container3, ".mrs-warn");
  assert.ok(warn, "status is a warning, not success");
  assert.ok(warn.textContent.includes(copy.rolesSaveFailed), "explicit partial-failure feedback");
  assert.ok(warn.textContent.includes(copy.modeSaved), "mode draft still saved");
  assert.equal(qa(container3, ".mrs-caprow:not(.mrs-caprow--head)").length, 6, "unsaved revocation preserved (not reverted)");
  assert.equal(findButton(container3, copy.saveSettings).disabled, false, "save re-enabled (draft still dirty)");
});

await ok("global 409 conflict reloads the store and preserves the server enabled flag (no auto-enable)", async () => {
  const act = reactAct;
  // another window changed the global store: disabled + revision advanced
  backend.globalStore.revision = 20;
  backend.globalStore.enabled = false;

  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const conflict = q(container3, ".mrs-warn");
  assert.ok(conflict, "409 shows a conflict warning");
  assert.ok(conflict.textContent.includes(copy.rolesSaveConflict), "conflict feedback names the revision mismatch");
  assert.equal(findButton(container3, copy.saveSettings).disabled, false, "save stays enabled (pendingGlobal) after a conflict");

  // retry: the reload read the server enabled=false, so the next save preserves it
  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const okSave = backend.requests.filter((r) => r.path === SAVE_PATH).pop();
  assert.equal(okSave.body.enabled, false, "preserves the server's disabled flag (no auto-enable)");
  assert.equal(okSave.body.expectedRevision, 20, "resends the reloaded revision as CAS");
});

await ok("unknown global state (GET /roles failed) blocks the save with a retry prompt", async () => {
  const act = reactAct;
  // A fourth mount whose role store never loads: globalEnabled/globalRevision
  // stay null, so a save must not fire a global write or assume enabled=true.
  const container4 = window.document.createElement("div");
  container4.id = "root4";
  window.document.body.appendChild(container4);
  const root4 = ReactDOMClient.createRoot(container4);
  backend.faults.rolesLoad = true;
  await act(async () => { root4.render(React.createElement(ModesPanel, { copy })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  backend.faults.rolesLoad = false;

  // auth-only change: revoke an unreferenced model (mode draft stays clean)
  await clickButton(act, subTab(container4, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const rows = qa(container4, ".mrs-caprow:not(.mrs-caprow--head)");
  const codexRow = rows.find((r) => r.textContent.includes("codex"));
  assert.ok(codexRow, "codex row present on the fresh mount");
  const savesBefore = backend.requests.filter((r) => r.path === SAVE_PATH).length;
  await clickButton(act, findButton(codexRow, copy.revoke));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  await clickButton(act, findButton(container4, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  assert.equal(backend.requests.filter((r) => r.path === SAVE_PATH).length, savesBefore, "no global write while the store state is unknown");
  const err = q(container4, ".mrs-err");
  assert.ok(err, "load-failed error shown");
  assert.ok(err.textContent.includes(copy.globalLoadFailed), "names the load failure and asks to retry");
  assert.equal(findButton(container4, copy.saveSettings).disabled, false, "save stays enabled (dirty preserved)");
  assert.equal(qa(container4, ".mrs-caprow:not(.mrs-caprow--head)").length, 7, "revocation preserved in the draft");
});

await ok("modeDirty path: a network throw after MODE_SAVE keeps the draft dirty (pendingGlobal)", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const leadCard = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  const wasDisabled = leadCard.className.includes("mrs-mroute--disabled");
  await clickButton(act, q(leadCard, 'input[type="checkbox"]'));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const leadAfter = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  assert.equal(leadAfter.className.includes("mrs-mroute--disabled"), !wasDisabled, "role toggle applied to the draft");

  const modeSavesBefore = backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length;
  const roleSavesBefore = backend.requests.filter((r) => r.path === SAVE_PATH).length;

  backend.faults.rolesSaveThrow = true;
  await clickButton(act, findButton(container3, copy.saveSettings));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  backend.faults.rolesSaveThrow = false;

  // MODE_SAVE succeeded, then the global role save network-threw: the outer
  // catch must set pendingGlobal so the form stays dirty (not draft==stored).
  assert.equal(backend.requests.filter((r) => r.path === MODE_SAVE_PATH).length, modeSavesBefore + 1, "mode save fired (modeDirty)");
  assert.equal(backend.requests.filter((r) => r.path === SAVE_PATH).length, roleSavesBefore + 1, "role save attempted then threw");
  assert.ok(q(container3, ".mrs-err"), "network error surfaced to the user");
  assert.equal(findButton(container3, copy.saveSettings).disabled, false, "save stays enabled (pendingGlobal kept the draft dirty)");
});

await ok("broke mode is free-choice: upgrade/advisor slots are fully configurable, no insult tagline", async () => {
  const act = reactAct;
  await clickButton(act, modeTab(container3, "穷鬼"));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  assert.ok(!container3.textContent.includes("蛆"), "no insulting broke tagline");

  await clickButton(act, subTab(container3, copy.tabTeam));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  // Team tab now holds only the lead default route, which must stay a free-choice
  // multi-option select (no forced "吃土去" single).
  const leadSelect = q(container3, ".mrs-mbody .mrs-mroute__model select");
  assert.ok(leadSelect && leadSelect.options.length > 1, "lead route is a multi-option select (free choice)");
  const openaiOpt = [...leadSelect.options].find((o) => o.value.indexOf("openai") === 0);
  assert.ok(openaiOpt, "openai model present");
  assert.equal(openaiOpt.disabled, false, "openai models selectable in broke mode (free choice)");

  // Upgrade advisor + team-role advisor routes moved to the Role Hub's advanced
  // groups; both must stay free-choice multi-option selects with no 吃土去.
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const details = qa(container3, ".mrs-details");
  assert.equal(details.length, 2, "two advanced groups on the Role Hub");

  const overrideModelSelects = qa(details[0], ".mrs-mroute__model select");
  assert.equal(overrideModelSelects.length, 4, "four team-role route editors (planner/executor/reviewer/advisor)");
  assert.ok(overrideModelSelects.every((s) => s.options.length > 1), "team-role routes are multi-option (free choice)");

  const upgradeAdvisorSelect = q(details[1], ".mrs-mroute__model select");
  assert.ok(upgradeAdvisorSelect && upgradeAdvisorSelect.options.length > 1, "upgrade advisor route is multi-option (free choice)");
  assert.ok(![...upgradeAdvisorSelect.options].some((o) => o.textContent === "吃土去"), "no 吃土去 option in upgrade advisor");

  const roleCard = q(container3, '.mrs-mroute[data-role-id="lead-coordinator"]');
  const roleEditors = qa(roleCard, ".mrs-mroute");
  const upgradeSelect = q(roleEditors[2], ".mrs-mroute__model select");
  assert.ok(upgradeSelect.options.length > 1, "role upgrade slot offers more than one option (free choice)");
  assert.ok(![...upgradeSelect.options].some((o) => o.textContent === "吃土去"), "no 吃土去 option");
});

await ok("changelog shows the latest two versions directly and folds the rest into a collapsible history", async () => {
  const act = reactAct;
  const direct = qa(container3, ".mrs-mchangelog > .mrs-mver");
  assert.equal(direct.length, 2, "latest two versions rendered directly");
  assert.ok(direct[0].textContent.includes("2.4.0"), "latest version first");
  assert.ok(direct[1].textContent.includes("2.3.0"), "second version direct");
  const hist = q(container3, ".mrs-mver__history");
  assert.ok(hist, "history group present");
  assert.ok(hist.textContent.includes("历史版本"), "history header localized");
  assert.equal(qa(hist, ".mrs-mver").length, 0, "history collapsed by default");
  assert.equal(qa(container3, ".mrs-mver__body").length, 1, "only latest open initially");
  await clickButton(act, q(hist, ".mrs-mver__head"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const histVers = qa(hist, ".mrs-mver");
  assert.equal(histVers.length, 3, "history expands to show 3 old versions");
  assert.ok(histVers[0].textContent.includes("2.2.0"));
  assert.ok(histVers[1].textContent.includes("2.1.0"));
  assert.ok(histVers[2].textContent.includes("1.0.0"));
  await clickButton(act, q(histVers[0], ".mrs-mver__head"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(qa(container3, ".mrs-mver__body").length, 2, "v2.2.0 expands after click");
});

await ok("AI configure only merges successful modes into drafts and new routes into authDraft (no save/enable)", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const before = backend.requests.length;
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  assert.ok(configureSelect, "configure select present");
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  assert.ok(opt, "authorized execution model option present");
  await changeSelect(act, configureSelect, opt.value);
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  const delta = backend.requests.slice(before);
  const posts = delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "POST");
  const gets = delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "GET");
  assert.equal(posts.length, 1, "exactly one job create (POST /ai/jobs)");
  assert.equal(posts[0].body.operation, "configure", "job operation is configure");
  assert.ok(gets.length >= 1, "at least one job poll (GET /ai/jobs)");
  assert.ok(gets.every((g) => g.search.startsWith("?id=")), "job poll preserves the ?id= query");
  assert.equal(delta.some((r) => r.path === MODE_SAVE_PATH || r.path === MODE_ENABLE_PATH || r.path === SAVE_PATH), false, "configure never saves or enables");
  assert.ok(container3.textContent.includes(copy.aiSaveAllPartial), "configure partial-failure status (warn, not unconditional ok)");
  assert.ok(container3.textContent.includes(copy.aiResultTitle), "result title shown");
  assert.ok(container3.textContent.includes(copy.aiModeOk), "per-mode success shown");
  assert.ok(container3.textContent.includes(copy.aiModeFail), "per-mode failure shown");
  assert.ok(container3.textContent.includes(copy.aiNewAuth), "new-auth hint shown");
});

await ok("AI recommend is display-only and never saves or authorizes", async () => {
  const act = reactAct;
  const before = backend.requests.length;
  const recommendSelect = qa(container3, ".mrs-aicard select")[1];
  assert.ok(recommendSelect, "recommend select present");
  const opt = [...recommendSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, recommendSelect, opt.value);
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[1], copy.aiRecommendButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  const delta = backend.requests.slice(before);
  const posts = delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "POST");
  assert.equal(posts.length, 1, "exactly one job create (POST /ai/jobs)");
  assert.equal(posts[0].body.operation, "recommend", "job operation is recommend");
  assert.equal(delta.some((r) => r.path === MODE_SAVE_PATH || r.path === MODE_ENABLE_PATH || r.path === SAVE_PATH), false, "recommend never saves or authorizes");
  const warnEl = q(container3, ".mrs-warn");
  assert.ok(warnEl, "partial-failure warn status visible");
  assert.ok(warnEl.textContent.includes(copy.aiRecommendPartial), "warn mentions partial recommend failure");
  assert.ok(warnEl.textContent.includes("性能"), "failed mode name surfaced in warn");
  assert.ok(warnEl.textContent.includes("AI 未返回"), "failed mode error surfaced in warn");
  assert.ok(container3.textContent.includes(copy.aiModeFail), "failed mode rendered with error label");
  assert.ok(container3.textContent.includes(copy.aiRecommendEmpty), "empty-role mode shows explicit empty state");
  assert.ok(container3.textContent.includes(copy.aiRecommendNote), "market disclaimer shown");
  assert.ok(container3.textContent.includes("claude-opus"), "success candidate retained");
  assert.ok(container3.textContent.includes("deepseek-flash"), "second success-mode candidate retained");
});

await ok("AI configure failure shows an error and merges nothing", async () => {
  const act = reactAct;
  backend.faults.aiConfigureFail = true;
  const before = backend.requests.length;
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  backend.faults.aiConfigureFail = false;
  const delta = backend.requests.slice(before);
  assert.equal(delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "POST").length, 1, "job create attempted");
  assert.ok(container3.textContent.includes("ai-configure-failed"), "error surfaced");
  const configBtn = findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton);
  assert.equal(configBtn.disabled, false, "aiBusy reset so configure is re-enabled after failure");
});

await ok("AI configure surfaces a network fetch failure with an actionable message (no fake ok)", async () => {
  const act = reactAct;
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);
  backend.faults.fetchReject = { name: "TypeError", message: "Failed to fetch", cause: new Error("ECONNREFUSED 127.0.0.1:7890") };
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  backend.faults.fetchReject = null;
  assert.ok(container3.textContent.includes(copy.aiNoResponse), "semantic no-response hint shown (no duplicate TypeError)");
  assert.ok(container3.textContent.includes("Failed to fetch"), "original browser cause preserved");
  assert.ok(container3.textContent.includes("ECONNREFUSED"), "nested network cause (ECONNREFUSED) preserved");
  assert.doesNotMatch(container3.textContent, /TypeError Failed to fetch cause=TypeError Failed to fetch/, "no duplicate TypeError wrap");
});

await ok("AI configure surfaces an abort as a retryable message (no fake ok)", async () => {
  const act = reactAct;
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);
  backend.faults.fetchReject = { name: "AbortError", message: "The operation was aborted" };
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  backend.faults.fetchReject = null;
  assert.ok(container3.textContent.includes(copy.aiNoResponse), "no-response hint shown (abort is uniformly no-response)");
  assert.ok(container3.textContent.includes("The operation was aborted"), "abort cause preserved");
});

await ok("AI configure surfaces a non-JSON poll response as a JSON parse failure (no fake ok)", async () => {
  const act = reactAct;
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);
  backend.faults.aiRawNonJson = true;
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  backend.faults.aiRawNonJson = false;
  assert.ok(container3.textContent.includes(copy.aiJsonError), "actionable JSON-parse hint shown");
  assert.ok(container3.textContent.includes("Unexpected token"), "parseError message surfaced");
});

await ok("AI recommend surfaces a network fetch failure with an actionable message (no fake ok)", async () => {
  const act = reactAct;
  const recommendSelect = qa(container3, ".mrs-aicard select")[1];
  const opt = [...recommendSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, recommendSelect, opt.value);
  backend.faults.fetchReject = { name: "TypeError", message: "Failed to fetch", cause: new Error("ECONNREFUSED 127.0.0.1:7890") };
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[1], copy.aiRecommendButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  backend.faults.fetchReject = null;
  assert.ok(container3.textContent.includes(copy.aiNoResponse), "semantic no-response hint shown (no duplicate TypeError)");
  assert.ok(container3.textContent.includes("Failed to fetch"), "original browser cause preserved");
  assert.ok(container3.textContent.includes("ECONNREFUSED"), "nested network cause (ECONNREFUSED) preserved");
});

await ok("AI configure tolerates transient poll failures (retries only GET, never re-POST)", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);
  const before = backend.requests.length;
  backend.faults.aiPollReject = 2;
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  // Two transient GET failures (1000ms apart) then a successful poll.
  await act(async () => { await new Promise((r) => setTimeout(r, 2200)); });
  backend.faults.aiPollReject = 0;
  const delta = backend.requests.slice(before);
  const posts = delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "POST");
  const gets = delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "GET");
  assert.equal(posts.length, 1, "exactly one job create (never re-POST)");
  assert.ok(gets.length >= 3, "poll retried after transient failures");
  assert.ok(gets.every((g) => g.search.startsWith("?id=")), "job poll preserves the ?id= query");
  assert.ok(container3.textContent.includes(copy.aiResultTitle), "result applied after transient failures");
});

await ok("AI configure times out at the poll deadline, resets aiBusy, and never re-POSTs", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);
  const before = backend.requests.length;
  const realNow = Date.now();
  fakeNowMs = realNow;
  // Keep the job stuck in "queued" forever so the poll deadline is the only way
  // the request can settle (proves the 480000ms cap fires, not a fake ok).
  backend.faults.aiConfigureHold = true;
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  // First poll observes queued and schedules the next tick at +1000ms.
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  // Advance the mocked clock past the deadline; the next tick must detect it.
  fakeNowMs = realNow + 480001;
  await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
  backend.faults.aiConfigureHold = false;
  fakeNowMs = realNow;
  const delta = backend.requests.slice(before);
  const posts = delta.filter((r) => r.path === AI_JOBS_PATH && r.method === "POST");
  assert.equal(posts.length, 1, "exactly one job create (never re-POST)");
  assert.ok(container3.textContent.includes(copy.aiJobTimeout), "poll timeout message shown");
  assert.ok(container3.textContent.includes(copy.aiJobStillRunning), "do-not-re-generate hint shown");
  assert.ok(container3.textContent.includes("job-"), "jobId surfaced in the timeout message");
  const configBtn = findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton);
  assert.equal(configBtn.disabled, false, "aiBusy reset after timeout");
});

await ok("save all drafts writes each dirty mode then the global store (sequential, probe-free)", async () => {
  const act = reactAct;
  const saveAllBtn = findButton(container3, copy.aiSaveAll);
  assert.ok(saveAllBtn, "save-all button present");
  assert.equal(saveAllBtn.disabled, false, "save-all enabled when drafts are dirty");
  const before = backend.requests.length;
  await clickButton(act, saveAllBtn);
  await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  const delta = backend.requests.slice(before);
  const modeSaves = delta.filter((r) => r.path === MODE_SAVE_PATH);
  const globalSaves = delta.filter((r) => r.path === SAVE_PATH);
  assert.ok(modeSaves.length >= 1, "at least one dirty mode saved");
  assert.equal(globalSaves.length, 1, "global store saved once");
  const lastWrite = delta[delta.length - 1];
  assert.equal(lastWrite.path, SAVE_PATH, "global save is the final write (mode writes precede it)");
  assert.equal(lastWrite.body.skipValidation, true, "probe-free");
  assert.equal(lastWrite.body.validationToken, undefined, "no validation token");
  assert.ok(Array.isArray(lastWrite.body.authorizedModels), "authorizedModels array sent");
  assert.ok(lastWrite.body.authorizedModels.some((a) => a.provider === "anthropic" && a.model === "claude-3-opus"), "new auth route included in global save");
});

await ok("AI configure skips a mode edited while the request was in flight (never overwrites)", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const configureSelect = qa(container3, ".mrs-aicard select")[0];
  const opt = [...configureSelect.options].find((o) => o.textContent.includes("gpt-6.1-sol"));
  await changeSelect(act, configureSelect, opt.value);

  backend.faults.aiConfigureHold = true;
  await clickButton(act, findButton(qa(container3, ".mrs-aicard")[0], copy.aiConfigureButton));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  // Edit the current (economy) draft while the configure request is pending.
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await clickButton(act, findButton(container3, copy.addRole));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const customCard = qa(container3, ".mrs-mroute[data-role-id]").find((c) => c.getAttribute("data-role-id") === "custom-1");
  assert.ok(customCard, "custom role added while configure in flight");

  backend.aiDeferred.resolve();
  // The job now completes, but the client only observes it on its next poll
  // (every 1000ms), so wait past one poll interval for the skipped-edit path.
  await act(async () => { await new Promise((r) => setTimeout(r, 1250)); });
  backend.faults.aiConfigureHold = false;

  const customAfter = qa(container3, ".mrs-mroute[data-role-id]").find((c) => c.getAttribute("data-role-id") === "custom-1");
  assert.ok(customAfter, "edited economy draft preserved (skipped, not overwritten by the AI response)");
  assert.ok(container3.textContent.includes(copy.aiSkippedEdited), "skip warning surfaced");
});

await ok("save-all on a mode 409 preserves the draft (refreshStoredModes, not reloadModes)", async () => {
  const act = reactAct;
  await clickButton(act, subTab(container3, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const leadCard = qa(container3, ".mrs-mroute[data-role-id]").find((c) => c.getAttribute("data-role-id") === "lead-coordinator");
  assert.ok(leadCard, "lead role card present");
  await clickButton(act, q(leadCard, 'input[type="checkbox"]'));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.ok(qa(container3, ".mrs-mroute[data-role-id]").find((c) => c.getAttribute("data-role-id") === "lead-coordinator").className.includes("mrs-mroute--disabled"), "lead role disabled (draft dirty)");

  // Force a server-side revision bump so the next mode save hits a 409 conflict.
  backend.modesStore.modes.economy.revision = 999;

  const saveAllBtn = findButton(container3, copy.aiSaveAll);
  await clickButton(act, saveAllBtn);
  await act(async () => { await new Promise((r) => setTimeout(r, 25)); });

  const leadAfter = qa(container3, ".mrs-mroute[data-role-id]").find((c) => c.getAttribute("data-role-id") === "lead-coordinator");
  assert.ok(leadAfter.className.includes("mrs-mroute--disabled"), "draft preserved after 409 (no reloadModes overwrite)");
  assert.ok(container3.textContent.includes(copy.aiSaveAllPartial), "partial-failure warn surfaced");
});

await ok("restore preset merges referenced routes into the auth draft (add-only)", async () => {
  const act = reactAct;
  // give the economy recommended preset a team route that is NOT yet authorized
  backend.modesStore.recommendedPresets.economy.team.advisor = route("openai", "gpt-5.6-sol");
  const container5 = window.document.createElement("div");
  container5.id = "root5";
  window.document.body.appendChild(container5);
  const root5 = ReactDOMClient.createRoot(container5);
  await act(async () => { root5.render(React.createElement(ModesPanel, { copy })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // economy is the current mode and is selected by default on mount
  const before = confirms.length;
  await clickButton(act, findButton(container5, copy.restorePreset));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(confirms.length, before + 1, "restore asks for confirmation");
  assert.match(container5.textContent, new RegExp(copy.modeRestored));

  // the referenced gpt-5.6-sol route must now be in the auth draft (add-only)
  await clickButton(act, subTab(container5, copy.tabModels));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const rows = qa(container5, ".mrs-caprow:not(.mrs-caprow--head)");
  assert.equal(rows.length, 9, "one new referenced route added to the auth draft (8 → 9)");
  assert.ok(rows.some((r) => r.textContent.includes("gpt-5.6-sol")), "the referenced gpt-5.6-sol route is present");
});

await ok("v2.6.0: misplaced stored labels/descriptions never reach the four mode buttons or the description body", async () => {
  const act = reactAct;
  // Inject legacy/misplaced display metadata into the backend store — an old
  // Host without a reload would otherwise surface these on the buttons/desc.
  backend.modesStore.modes.economy.label = "经济模式";
  backend.modesStore.modes.economy.description = "错位描述：经济";
  backend.modesStore.modes.normal.label = "普通模式";
  backend.modesStore.modes.normal.description = "错位描述：普通";
  backend.modesStore.modes.performance.label = "性能模式";
  backend.modesStore.modes.performance.description = "错位描述：性能";
  backend.modesStore.modes.broke.label = "穷鬼模式";
  backend.modesStore.modes.broke.description = "错位描述：穷鬼";

  const container6 = window.document.createElement("div");
  container6.id = "root6";
  window.document.body.appendChild(container6);
  const root6 = ReactDOMClient.createRoot(container6);
  await act(async () => { root6.render(React.createElement(ModesPanel, { copy })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const tabs = qa(container6, ".mrs-mtab");
  assert.equal(tabs.length, 4, "four mode buttons");
  const tabText = tabs.map((t) => t.textContent).join(" ");
  assert.match(tabText, /经济/);
  assert.match(tabText, /普通/);
  assert.match(tabText, /性能/);
  assert.match(tabText, /穷鬼/);
  assert.doesNotMatch(tabText, /经济模式|普通模式|性能模式|穷鬼模式/, "no misplaced 模式 suffix on buttons");

  // The description body must show canonical copy, never the stored "错位描述".
  const desc = q(container6, ".mrs-mdesc__body");
  assert.ok(desc, "mode description body exists");
  assert.doesNotMatch(desc.textContent, /错位描述/, "stored misplaced description never shown");
  assert.match(desc.textContent, /(经济|普通|性能|穷鬼)：/, "canonical description shown (modeDescription)");
});

await ok("v2.6.0: advisor-condition input never shows the 吃土去 sentinel (custom conditions preserved)", async () => {
  const act = reactAct;
  // Legacy backend/HMR may still carry the sentinel on a stored advisor.
  // (A prior save test replaced the broke mode wholesale, so re-establish the
  // advisor object defensively rather than assuming the fixture still holds.)
  backend.modesStore.modes.broke.upgradeAdvisor = { ...(backend.modesStore.modes.broke.upgradeAdvisor || {}), condition: "吃土去" };
  backend.modesStore.modes.performance.upgradeAdvisor = { ...(backend.modesStore.modes.performance.upgradeAdvisor || {}), condition: "自定义复核时机" };

  const container7 = window.document.createElement("div");
  container7.id = "root7";
  window.document.body.appendChild(container7);
  const root7 = ReactDOMClient.createRoot(container7);
  await act(async () => { root7.render(React.createElement(ModesPanel, { copy })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const advisorInput = () => {
    const field = qa(container7, ".mrs-field").find((f) => {
      const lab = f.querySelector(".mrs-field__label");
      return lab && lab.textContent === copy.advisorCondition;
    });
    return field ? field.querySelector("input[type=text]") : null;
  };

  // broke: legacy sentinel replaced in the live input value (not just textContent).
  await clickButton(act, modeTab(container7, "穷鬼"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await clickButton(act, subTab(container7, copy.tabHub));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const brokeInput = advisorInput();
  assert.ok(brokeInput, "advisor condition input exists");
  assert.equal(brokeInput.value, "极限节约时默认关闭，可按需开启", "sentinel replaced in input.value");
  assert.notEqual(brokeInput.value, "吃土去");

  // performance: a custom condition must pass through verbatim.
  await clickButton(act, modeTab(container7, "性能"));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const perfInput = advisorInput();
  assert.ok(perfInput, "advisor condition input exists for performance");
  assert.equal(perfInput.value, "自定义复核时机", "custom condition preserved");
});

await ok("the panel only ever calls the run-mode routes (no paid model endpoints)", () => {
  const allowed = new Set([MODES_PATH, MODE_SAVE_PATH, MODE_ENABLE_PATH, ROLES_PATH, SAVE_PATH, VALIDATE_PATH, CAPABILITIES_PATH, CAPABILITIES_REFRESH_PATH, EXECUTION_INTEGRATION_PATH, TIERS_PATH, TIERS_REFRESH_PATH, AI_CONFIGURE_PATH, AI_RECOMMEND_PATH, AI_JOBS_PATH, RELEASE_NOTES_PATH]);
  for (const r of backend.requests) {
    assert.ok(allowed.has(r.path), `unexpected route requested: ${r.path}`);
  }
  // metadata refresh must NOT be a paid measurement path
  assert.equal(backend.requests.some((r) => r.path.includes("/catalog") || r.path.includes("/models") || r.path.includes("/infer")), false);
});

/* ------------------------------------------------------------------ */

console.log(`\nmodes-client: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
