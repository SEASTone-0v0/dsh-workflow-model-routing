/**
 * test/ai-assistant.mjs — pure-library tests for the AI assistant half (v2.4.0).
 *
 * Offline: no real model calls; a fake `llm.stream` emits the `text-delta`/`finish`
 * chunk contract. Covers the v2.4.0 acceptance surface:
 *   - fence-tolerant JSON extraction, strict rejection of invalid config
 *   - hallucinated (non-local) route fallback + warning
 *   - fixed/smart reasoning validation against DECLARED efforts (full fallback,
 *     never a half-filled map, never a guessed enum)
 *   - broke mode is free-choice (no hard filter/fallback/disable)
 *   - role/team safety-field preservation
 *   - normal-mode recommendations: 2–3 per role, dedupe, role-relevant reason
 *   - broke recommendations: free-choice, uniform ≤3 cap
 *   - stream error/abort handling (no retry)
 *   - canonical mode text (stale stored description/interpretation ignored)
 *   - serial execution (maxActive=1) with per-mode failure continue
 */

import assert from "node:assert/strict";

import * as ai from "../lib/ai-assistant.js";

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`  ${String(error?.stack ?? error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const CATALOG = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoningEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "gpt-6-astra", name: "GPT-6 Astra", reasoningEfforts: ["low", "medium", "high"] },
      ],
    },
    {
      id: "deepseek-account",
      name: "DeepSeek",
      models: [
        { id: "deepseek-v4-pro", name: "V4 Pro", reasoningEfforts: ["low", "medium", "high"] },
        { id: "deepseek-flash", name: "Flash", reasoningEfforts: ["low"] },
        { id: "deepseek-flash-lite", name: "Flash Lite", reasoningEfforts: ["low"] },
      ],
    },
    {
      id: "moonshotai",
      name: "Moonshot",
      models: [
        { id: "kimi-k3", name: "Kimi K3", reasoningEfforts: ["low", "medium"] },
      ],
    },
    {
      id: "google",
      name: "Google",
      models: [
        { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoningEfforts: ["low"] },
      ],
    },
    {
      id: "deepseek-account-vision",
      name: "Vision",
      models: [
        { id: "deepseek-v4-pro", name: "Vision Pro", reasoningEfforts: ["low", "medium", "high"], modalities: ["image"] },
        { id: "deepseek-flash", name: "Vision Flash", reasoningEfforts: ["low"], modalities: ["image"] },
      ],
    },
  ],
};

function baseRoles() {
  return [
    {
      id: "lead",
      name: "总协调员",
      purpose: "澄清、拆解、协调、聚合",
      kind: "standard",
      enabled: true,
      primary: { provider: "openai", model: "gpt-6.1-sol" },
      backup: { provider: "deepseek-account", model: "deepseek-v4-pro" },
      upgrade: { provider: "openai", model: "gpt-6-astra" },
      switchRule: "confirm",
    },
    {
      id: "reviewer",
      name: "独立审查员",
      purpose: "独立复核",
      kind: "reviewer",
      enabled: true,
      primary: null,
      backup: null,
      upgrade: null,
      switchRule: "confirm",
      pairings: [{ authorProviders: ["openai"], reviewer: { provider: "deepseek-account", model: "deepseek-v4-pro" } }],
    },
    {
      id: "privacy-memory",
      name: "隐私与记忆管理员",
      purpose: "画像与删除",
      kind: "privacy",
      enabled: true,
      primary: null,
      backup: null,
      upgrade: null,
      switchRule: "confirm",
    },
    {
      id: "vision",
      name: "图像解读员",
      purpose: "图片解读",
      kind: "standard",
      enabled: true,
      primary: { provider: "deepseek-account-vision", model: "deepseek-v4-pro" },
      backup: null,
      upgrade: null,
      switchRule: "confirm",
    },
  ];
}

function teamBase() {
  return {
    planner: { provider: "openai", model: "gpt-6.1-sol" },
    executor: null,
    reviewer: null,
    advisor: { provider: "openai", model: "gpt-6-astra" },
    maxConcurrentWorkers: 4,
    writeScopeIsolation: true,
    failureRetryLimit: 3,
    escalationThreshold: 2,
    budgetLimit: 128,
  };
}

function makeModesStore() {
  const modes = {};
  for (const modeId of ai.MODE_IDS) {
    modes[modeId] = {
      modeId,
      label: modeId,
      description: `${modeId} 模式`,
      interpretation: { summary: `${modeId} 定位摘要` },
      revision: 0,
      lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" },
      upgradeAdvisor: { enabled: true, provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default", condition: "auto" },
      roles: baseRoles(),
      team: teamBase(),
      taskTargets: { native: { enabled: true }, taskBoard: { enabled: false } },
    };
  }
  return { currentModeId: "normal", modes };
}

const AUTHORIZED = [
  { provider: "openai", model: "gpt-6.1-sol" },
  { provider: "deepseek-account", model: "deepseek-v4-pro" },
];

/** Fake LLM: emits `text` as text-delta chunks then a `finish` chunk. */
function fakeLlm(responder) {
  const calls = [];
  return {
    calls,
    stream: async function* (options) {
      calls.push({
        provider: options.provider,
        model: options.model,
        messages: options.messages,
      });
      const text = await responder(options);
      for (let index = 0; index < text.length; index += 21) {
        yield { type: "text-delta", text: text.slice(index, index + 21) };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

function modeIdOf(options) {
  const prompt = options.messages?.[0]?.content?.[0]?.text ?? "";
  const match = /运行模式 "([a-z]+)"/.exec(prompt);
  return match ? match[1] : "normal";
}

/* ------------------------------------------------------------------ *
 * extractJson
 * ------------------------------------------------------------------ */

await ok("extractJson parses a plain object", () => {
  assert.deepEqual(ai.extractJson('{"a":1}').data, { a: 1 });
});

await ok("extractJson strips a ```json fence", () => {
  const out = ai.extractJson('```json\n{"lead": {"provider": "openai"}}\n```');
  assert.equal(out.ok, true);
  assert.equal(out.data.lead.provider, "openai");
});

await ok("extractJson rejects invalid JSON", () => {
  assert.equal(ai.extractJson("not json at all").ok, false);
});

await ok("extractJson rejects empty output", () => {
  assert.equal(ai.extractJson("").ok, false);
});

/* ------------------------------------------------------------------ *
 * validateReasoning
 * ------------------------------------------------------------------ */

await ok("validateReasoning: default is always accepted and drops effort/map", () => {
  const { reasoning, warning } = ai.validateReasoning(
    { reasoningPolicy: "default", reasoningEffort: "high", smartMap: { low: "low" } },
    ["low", "medium", "high"],
    "lead",
  );
  assert.equal(reasoning.reasoningPolicy, "default");
  assert.equal(reasoning.reasoningEffort, null);
  assert.equal(reasoning.smartMap, null);
  assert.equal(warning, null);
});

await ok("validateReasoning: fixed with a declared effort is accepted", () => {
  const { reasoning, warning } = ai.validateReasoning(
    { reasoningPolicy: "fixed", reasoningEffort: "medium" },
    ["low", "medium", "high"],
    "lead",
  );
  assert.equal(reasoning.reasoningPolicy, "fixed");
  assert.equal(reasoning.reasoningEffort, "medium");
  assert.equal(warning, null);
});

await ok("validateReasoning: fixed with an undeclared effort falls back to default", () => {
  const { reasoning, warning } = ai.validateReasoning(
    { reasoningPolicy: "fixed", reasoningEffort: "ultra" },
    ["low", "medium", "high"],
    "lead",
  );
  assert.equal(reasoning.reasoningPolicy, "default");
  assert.ok(warning);
});

await ok("validateReasoning: smart with all declared efforts is accepted", () => {
  const { reasoning, warning } = ai.validateReasoning(
    { reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "high" } },
    ["low", "medium", "high"],
    "lead",
  );
  assert.equal(reasoning.reasoningPolicy, "smart");
  assert.deepEqual(reasoning.smartMap, { low: "low", medium: "medium", high: "high" });
  assert.equal(warning, null);
});

await ok("validateReasoning: smart missing high falls back entirely (no half map)", () => {
  const { reasoning, warning } = ai.validateReasoning(
    { reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium" } },
    ["low", "medium", "high"],
    "lead",
  );
  assert.equal(reasoning.reasoningPolicy, "default");
  assert.equal(reasoning.smartMap, null);
  assert.ok(warning);
});

await ok("validateReasoning: smart with an undeclared effort falls back entirely", () => {
  const { reasoning, warning } = ai.validateReasoning(
    { reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "ultra" } },
    ["low", "medium", "high"],
    "lead",
  );
  assert.equal(reasoning.reasoningPolicy, "default");
  assert.ok(warning);
});

/* ------------------------------------------------------------------ *
 * validateAiRoute (hallucinated routes)
 * ------------------------------------------------------------------ */

await ok("validateAiRoute: hallucinated (non-local) route falls back to existing + warns", () => {
  const flat = ai.flattenCatalog(CATALOG);
  const existing = { provider: "openai", model: "gpt-6.1-sol" };
  const { route, warning } = ai.validateAiRoute(
    { provider: "nope", model: "nope-model" },
    existing,
    flat,
    "lead",
  );
  assert.deepEqual(route, existing);
  assert.ok(warning);
});

await ok("validateAiRoute: a valid local route with smart reasoning is accepted", () => {
  const flat = ai.flattenCatalog(CATALOG);
  const { route, warning } = ai.validateAiRoute(
    { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "high" } },
    null,
    flat,
    "lead",
  );
  assert.equal(route.provider, "openai");
  assert.equal(route.model, "gpt-6.1-sol");
  assert.equal(route.reasoningPolicy, "smart");
  assert.equal(warning, null);
});

/* ------------------------------------------------------------------ *
 * configureModes
 * ------------------------------------------------------------------ */

const configureResponder = (options) => {
  const modeId = modeIdOf(options);
  const lead = modeId === "broke"
    ? { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed", reasoningEffort: "high" }
    : { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: "high" } };
  return JSON.stringify({
    lead,
    upgradeAdvisor: { provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default" },
    roles: [
      {
        id: "lead",
        primary: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "fixed", reasoningEffort: "medium" },
        backup: { provider: "deepseek-account", model: "deepseek-flash", reasoningPolicy: "default" },
        upgrade: { provider: "moonshotai", model: "kimi-k3", reasoningPolicy: "default" },
      },
      {
        id: "vision",
        primary: { provider: "deepseek-account-vision", model: "deepseek-v4-pro", reasoningPolicy: "default" },
        backup: null,
        upgrade: null,
      },
    ],
    team: {
      planner: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default" },
      executor: null,
      reviewer: null,
      advisor: { provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default" },
    },
  });
};

await ok("configureModes: four modes, safety fields preserved", async () => {
  const llm = fakeLlm(configureResponder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 4);
  for (const modeResult of result.results) {
    assert.equal(modeResult.ok, true, `mode ${modeResult.modeId} should succeed`);
    const mode = modeResult.mode;
    // Safety fields preserved.
    assert.equal(mode.team.maxConcurrentWorkers, 4);
    assert.equal(mode.team.writeScopeIsolation, true);
    assert.equal(mode.team.budgetLimit, 128);
    assert.equal(mode.taskTargets.native.enabled, true);
    // Role identity preserved (no AI add/remove).
    assert.equal(mode.roles.length, 4);
    const leadRole = mode.roles.find((role) => role.id === "lead");
    assert.equal(leadRole.name, "总协调员");
    assert.equal(leadRole.kind, "standard");
    assert.equal(leadRole.enabled, true);
    assert.equal(mode.roles.find((role) => role.id === "reviewer").kind, "reviewer");
    assert.equal(mode.roles.find((role) => role.id === "privacy-memory").kind, "privacy");
  }
});

await ok("configureModes: broke mode is free-choice (no forced fallback, advisor disable, or upgrade null)", async () => {
  const llm = fakeLlm(configureResponder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const broke = result.results.find((modeResult) => modeResult.modeId === "broke");
  assert.equal(broke.ok, true);
  const mode = broke.mode;
  // Free choice: the AI's high-value lead is KEPT (no forced broke fallback).
  assert.equal(mode.lead.provider, "openai");
  assert.equal(mode.lead.model, "gpt-6.1-sol");
  assert.equal(mode.lead.reasoningPolicy, "fixed");
  assert.equal(mode.lead.reasoningEffort, "high");
  // The advisor is not force-disabled.
  assert.equal(mode.upgradeAdvisor.enabled, true);
  assert.equal(mode.upgradeAdvisor.provider, "openai");
  assert.equal(mode.upgradeAdvisor.model, "gpt-6-astra");
  assert.equal(mode.team.advisor.provider, "openai");
  // Role upgrade is preserved (not forced null).
  const leadRole = mode.roles.find((role) => role.id === "lead");
  assert.equal(leadRole.upgrade.provider, "moonshotai");
  assert.equal(leadRole.upgrade.model, "kimi-k3");
});

await ok("configureModes: an invalid JSON per-mode is reported as a partial failure", async () => {
  const llm = fakeLlm((options) => (modeIdOf(options) === "normal" ? "this is not json" : configureResponder(options)));
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const normal = result.results.find((modeResult) => modeResult.modeId === "normal");
  assert.equal(normal.ok, false);
  assert.ok(normal.error);
  const economy = result.results.find((modeResult) => modeResult.modeId === "economy");
  assert.equal(economy.ok, true);
});

await ok("configureModes: a stream throw is reported per-mode (no retry, no crash)", async () => {
  const attempted = [];
  const llm = {
    stream: async function* (options) {
      attempted.push(modeIdOf(options));
      if (modeIdOf(options) === "performance") throw new Error("network dropped");
      const text = await configureResponder(options);
      for (let index = 0; index < text.length; index += 21) {
        yield { type: "text-delta", text: text.slice(index, index + 21) };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const performance = result.results.find((modeResult) => modeResult.modeId === "performance");
  assert.equal(performance.ok, false);
  assert.match(performance.error, /network dropped/);
  // No automatic retry: the failing mode stream was called exactly once.
  assert.equal(attempted.filter((id) => id === "performance").length, 1);
});

await ok("configureModes: empty primary on a standard role surfaces an explicit warning", async () => {
  // Null out the lead standard role's routes so an AI that leaves it empty
  // triggers the "still unconfigured" warning instead of inheriting the base.
  const store = makeModesStore();
  for (const mode of Object.values(store.modes)) {
    const lead = mode.roles.find((role) => role.id === "lead");
    lead.primary = null;
    lead.backup = null;
    lead.upgrade = null;
  }
  const responder = () =>
    JSON.stringify({
      lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" },
      upgradeAdvisor: { provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default" },
      roles: [{ id: "lead", primary: null, backup: null, upgrade: null }],
      team: {},
    });
  const llm = fakeLlm(responder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: store,
    roles: baseRoles(),
  });
  const normal = result.results.find((modeResult) => modeResult.modeId === "normal");
  assert.equal(normal.ok, true);
  assert.ok(
    normal.warnings.some((warning) => warning.includes("roles.lead.primary")),
    `should warn about empty primary, got ${JSON.stringify(normal.warnings)}`,
  );
});

/* ------------------------------------------------------------------ *
 * recommendModels
 * ------------------------------------------------------------------ */

const recommendResponder = (options) => {
  const modeId = modeIdOf(options);
  const leadCandidates = [
    { provider: "openai", model: "gpt-6.1-sol", source: "model-knowledge", reason: "总协调员需要强规划，适合拆解", strengths: "规划强", cautions: "贵" },
    { provider: "moonshotai", model: "kimi-k3", source: "model-knowledge", reason: "中文协调与长文适配", strengths: "中文强", cautions: "需核价" },
    { provider: "google", model: "gemini-3-flash", source: "local-catalog", reason: "低成本协调候选", strengths: "便宜", cautions: "能力有限" },
    { provider: "deepseek-account", model: "deepseek-v4-pro", source: "local-catalog", reason: "本机Pro复核", strengths: "本地", cautions: "" },
  ];
  return JSON.stringify({
    roles: [
      { id: "lead", candidates: leadCandidates },
      { id: "vision", candidates: [{ provider: "openai", model: "gpt-6-astra", source: "model-knowledge", reason: "图像候选", strengths: "", cautions: "" }] },
    ],
  });
};

await ok("recommendModels: normal mode dedupes and truncates to at most 3 per role", async () => {
  const llm = fakeLlm(recommendResponder);
  const result = await ai.recommendModels({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  assert.equal(result.ok, true);
  const normal = result.results.find((modeResult) => modeResult.modeId === "normal");
  const leadRole = normal.roles.find((role) => role.id === "lead");
  assert.ok(leadRole.candidates.length >= 2 && leadRole.candidates.length <= 3);
  // Dedupe: no repeated provider/model.
  const keys = new Set(leadRole.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`));
  assert.equal(keys.size, leadRole.candidates.length);
  // Reasons relate to the role (backfilled local candidates carry the role name).
  for (const candidate of leadRole.candidates) {
    assert.ok(candidate.reason.length > 0, "every candidate must have a reason");
  }
});

await ok("recommendModels: a role left with a single AI candidate is filled to 2–3 locally", async () => {
  const responder = (options) => {
    const modeId = modeIdOf(options);
    return JSON.stringify({
      roles: [
        { id: "lead", candidates: [{ provider: "openai", model: "gpt-6.1-sol", source: "model-knowledge", reason: "协调候选", strengths: "", cautions: "" }] },
      ],
    });
  };
  const llm = fakeLlm(responder);
  const result = await ai.recommendModels({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const normal = result.results.find((modeResult) => modeResult.modeId === "normal");
  const leadRole = normal.roles.find((role) => role.id === "lead");
  assert.ok(
    leadRole.candidates.length >= 2,
    `single AI candidate should be backfilled, got ${leadRole.candidates.length}`,
  );
  const keys = new Set(leadRole.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`));
  assert.equal(keys.size, leadRole.candidates.length);
});

await ok("recommendModels: broke mode is free-choice (no hard filter, normal ≤3 cap)", async () => {
  const llm = fakeLlm(recommendResponder);
  const result = await ai.recommendModels({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const broke = result.results.find((modeResult) => modeResult.modeId === "broke");
  const leadRole = broke.roles.find((role) => role.id === "lead");
  // Free choice: high-value candidates are allowed and the ≤3 cap applies
  // uniformly (no broke hard filter, no unlimited backfill).
  assert.ok(leadRole.candidates.length >= 1, `broke lead should have candidates, got ${leadRole.candidates.length}`);
  assert.ok(leadRole.candidates.length <= 3, `broke lead should be capped at 3, got ${leadRole.candidates.length}`);
});

await ok("streamText: a finish with reason.kind 'error' fails without retry", async () => {
  let calls = 0;
  const llm = {
    stream: async function* () {
      calls += 1;
      yield { type: "text-delta", text: "partial" };
      yield { type: "finish", reason: { kind: "error" } };
    },
  };
  const result = await ai.streamText(llm, { provider: "openai", model: "gpt-6.1-sol", messages: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /error/);
  assert.equal(calls, 1);
});

await ok("streamText: legacy text-delta.delta is collected and legacy finish.finish.reason 'error' fails verbatim", async () => {
  // Legacy chunk shapes (probeRoute-compatible): incremental text in `delta`,
  // finish reason nested under `finish.reason`, and the error passed verbatim.
  let calls = 0;
  const llm = {
    stream: async function* () {
      calls += 1;
      yield { type: "text-delta", delta: '{"lead": {"provider": "openai", "model": "gpt-6.1-sol"}}' };
      yield { type: "finish", finish: { reason: "error", message: "permission denied (403)" } };
    },
  };
  const result = await ai.streamText(llm, { provider: "openai", model: "gpt-6.1-sol", messages: [] });
  assert.equal(result.ok, false);
  // The collected legacy delta text must survive so callers can see what arrived.
  assert.ok(result.text.includes("gpt-6.1-sol"), "legacy delta text must be collected");
  // The underlying permission error is surfaced verbatim, never masked as ok.
  assert.match(result.error, /permission denied \(403\)/);
  assert.equal(calls, 1);
});

await ok("streamText: real reason-shape finish error keeps nested message/cause/code/status and kind", async () => {
  // Real provider contract: the finish chunk carries the error object nested
  // under `reason.error` (with its own cause/code/status), which must survive
  // formatting and classification instead of collapsing to a generic string.
  let calls = 0;
  const llm = {
    stream: async function* () {
      calls += 1;
      yield { type: "text-delta", text: "partial" };
      yield {
        type: "finish",
        reason: {
          kind: "error",
          error: {
            message: "permission denied (403)",
            code: "AUTH_FAILED",
            status: 403,
            cause: { message: "token expired", code: "TOKEN_EXPIRED" },
          },
        },
      };
    },
  };
  const result = await ai.streamText(llm, { provider: "openai", model: "gpt-6.1-sol", messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
  assert.equal(result.kind, "auth");
  assert.equal(result.status, 403);
  assert.ok(result.error.includes("permission denied (403)"));
  assert.ok(result.error.includes("code=AUTH_FAILED"));
  assert.ok(result.error.includes("status=403"));
  assert.ok(result.error.includes("token expired"));
  assert.ok(result.error.includes("code=TOKEN_EXPIRED"));
  assert.equal(calls, 1);
});

await ok("streamText: empty output is never disguised as ok", async () => {
  const llm = { stream: async function* () { yield { type: "finish", reason: { kind: "stop" } }; } };
  const result = await ai.streamText(llm, { provider: "openai", model: "gpt-6.1-sol", messages: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/i);
});

await ok("flattenCatalog excludes vision aliases but retains native multimodal models", () => {
  const flat = ai.flattenCatalog(CATALOG);
  const keys = new Set(flat.list.map((entry) => `${entry.provider}/${entry.model}`));
  assert.ok(keys.has("openai/gpt-6.1-sol"));
  assert.ok(keys.has("deepseek-account/deepseek-flash-lite"));
  assert.ok(!keys.has("deepseek-account-vision/deepseek-v4-pro"));
  assert.ok(keys.has("deepseek-account/deepseek-v4-pro"));
  assert.equal(flat.routes["openai/gpt-6.1-sol"].reasoningEfforts.length, 3);
});

await ok("configureModes: broke mode preserves a legal broke route's fixed reasoning (never reset to default)", async () => {
  const responder = (options) => {
    const isBroke = modeIdOf(options) === "broke";
    return JSON.stringify({
      lead: isBroke
        ? { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "fixed", reasoningEffort: "high" }
        : { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" },
      upgradeAdvisor: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default" },
      roles: [
        {
          id: "lead",
          primary: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "fixed", reasoningEffort: "high" },
          backup: { provider: "deepseek-account", model: "deepseek-flash", reasoningPolicy: "default" },
          upgrade: null,
        },
      ],
      team: {
        planner: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default" },
        advisor: { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default" },
      },
    });
  };
  const llm = fakeLlm(responder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const broke = result.results.find((modeResult) => modeResult.modeId === "broke");
  assert.equal(broke.ok, true);
  // A legal broke route must keep its already-validated reasoning config.
  assert.equal(broke.mode.lead.provider, "deepseek-account");
  assert.equal(broke.mode.lead.model, "deepseek-v4-pro");
  assert.equal(broke.mode.lead.reasoningPolicy, "fixed", "legal broke lead must keep fixed policy");
  assert.equal(broke.mode.lead.reasoningEffort, "high", "legal broke lead must keep declared effort");
  const leadRole = broke.mode.roles.find((role) => role.id === "lead");
  assert.equal(leadRole.primary.reasoningPolicy, "fixed");
  assert.equal(leadRole.primary.reasoningEffort, "high");
});

await ok("configureModes: broke with only high-value models keeps the AI route (free choice)", async () => {
  const highOnlyCatalog = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        models: [
          { id: "gpt-6.1-sol", name: "Sol", reasoningEfforts: ["low", "medium", "high"] },
          { id: "gpt-6-astra", name: "Astra", reasoningEfforts: ["low", "medium", "high"] },
        ],
      },
      {
        id: "google",
        name: "Google",
        models: [{ id: "gemini-3-flash", name: "Gemini", reasoningEfforts: ["low"] }],
      },
    ],
  };
  const responder = () =>
    JSON.stringify({
      lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" },
      upgradeAdvisor: { provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default" },
      roles: [
        {
          id: "lead",
          primary: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" },
          backup: { provider: "google", model: "gemini-3-flash", reasoningPolicy: "default" },
          upgrade: null,
        },
      ],
      team: {
        planner: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" },
        advisor: { provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default" },
      },
    });
  const llm = fakeLlm(responder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: highOnlyCatalog,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  const broke = result.results.find((modeResult) => modeResult.modeId === "broke");
  assert.equal(broke.ok, true);
  // Free choice: the AI's local high-value route is kept, never nulled or
  // replaced with a hallucinated broke route.
  assert.equal(broke.mode.lead.provider, "openai");
  assert.equal(broke.mode.lead.model, "gpt-6.1-sol");
});

await ok("configureModes: uses per-mode custom roles (not the global role list)", async () => {
  const store = makeModesStore();
  store.modes.performance.roles = [
    ...baseRoles(),
    {
      id: "perf-optimizer",
      name: "性能优化员",
      purpose: "性能调优",
      kind: "standard",
      enabled: true,
      primary: { provider: "openai", model: "gpt-6-astra" },
      backup: null,
      upgrade: null,
      switchRule: "confirm",
    },
  ];
  const llm = fakeLlm(configureResponder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: store,
    roles: baseRoles(),
  });
  const perf = result.results.find((modeResult) => modeResult.modeId === "performance");
  const custom = perf.mode.roles.find((role) => role.id === "perf-optimizer");
  assert.ok(custom, "per-mode custom role must survive configure");
  assert.equal(custom.name, "性能优化员");
  assert.equal(custom.kind, "standard");
  assert.equal(custom.enabled, true);
});

/* ------------------------------------------------------------------ *
 * v2.6: canonical prompt text (stale stored copy must not leak)
 * ------------------------------------------------------------------ */

function promptTextOf(call) {
  return call?.messages?.[0]?.content?.[0]?.text ?? "";
}

await ok("configureModes: prompt uses canonical mode text, ignoring stale stored description/interpretation", async () => {
  const store = makeModesStore();
  store.modes.broke.description = "穷鬼模式就是吃土去，别指望质量了。";
  store.modes.broke.interpretation = { summary: "穷鬼只能选 deepseek，其他一律禁用！" };
  const llm = fakeLlm(configureResponder);
  const result = await ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: store,
    roles: baseRoles(),
  });
  assert.equal(result.ok, true);
  const brokeCall = llm.calls.find((call) => modeIdOf({ messages: call.messages }) === "broke");
  assert.ok(brokeCall, "a broke-mode prompt must be emitted");
  const prompt = promptTextOf(brokeCall);
  assert.doesNotMatch(prompt, /吃土去/, "stale insult must not leak into the prompt");
  assert.doesNotMatch(prompt, /一律禁用/, "stale model-binding restriction must not leak");
  assert.match(prompt, /穷鬼：极限节约成本，优先低开销模型/, "canonical description must be present");
  assert.match(prompt, /🔴 穷鬼：极限节约成本，优先低开销模型（偏好，非禁用）/, "canonical interpretation must be present");
});

await ok("recommendModels: prompt uses canonical mode text, ignoring stale stored description/interpretation", async () => {
  const store = makeModesStore();
  store.modes.performance.description = "性能模式就是无脑堆最贵的模型，疯狂烧钱。";
  store.modes.performance.interpretation = { summary: "性能模式禁用一切便宜模型！" };
  const llm = fakeLlm(recommendResponder);
  const result = await ai.recommendModels({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: store,
    roles: baseRoles(),
  });
  assert.equal(result.ok, true);
  const perfCall = llm.calls.find((call) => modeIdOf({ messages: call.messages }) === "performance");
  assert.ok(perfCall, "a performance-mode prompt must be emitted");
  const prompt = promptTextOf(perfCall);
  assert.doesNotMatch(prompt, /无脑堆最贵/, "stale insult must not leak into the prompt");
  assert.doesNotMatch(prompt, /禁用一切便宜模型/, "stale model-binding restriction must not leak");
  assert.match(prompt, /性能：质量与复杂任务优先，允许更高的推理预算与异构复核/, "canonical description must be present");
  assert.match(prompt, /🔵 性能：质量与复杂任务优先，允许更高推理预算与异构复核/, "canonical interpretation must be present");
});

/* ------------------------------------------------------------------ *
 * v2.6: serial execution (maxActive=1)
 * ------------------------------------------------------------------ */

function concurrencyLlm(responder, opts = {}) {
  const calls = [];
  const releases = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    activeCount: () => active,
    maxActiveCount: () => maxActive,
    release: (index) => { if (typeof releases[index] === "function") releases[index](); },
    stream: async function* (options) {
      const index = calls.length;
      calls.push(options);
      active += 1;
      if (active > maxActive) maxActive = active;
      // HANG until the test releases this stream, so any overlap is observable.
      await new Promise((resolve) => { releases[index] = resolve; });
      active -= 1;
      const modeId = modeIdOf(options);
      if (opts.failModes && opts.failModes.includes(modeId)) {
        throw new Error(`mode ${modeId} failed (test)`);
      }
      const text = await responder(options);
      for (let offset = 0; offset < text.length; offset += 21) {
        yield { type: "text-delta", text: text.slice(offset, offset + 21) };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

async function until(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("until: timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

await ok("configureModes: serial execution (maxActive=1) with a single-mode failure that continues", async () => {
  const llm = concurrencyLlm(configureResponder, { failModes: ["normal"] });
  const promise = ai.configureModes({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  for (let index = 0; index < 4; index += 1) {
    await until(() => llm.calls.length === index + 1);
    assert.equal(llm.activeCount(), 1, `job ${index}: exactly one stream active`);
    assert.equal(llm.maxActiveCount(), 1, `job ${index}: concurrency never exceeded 1`);
    llm.release(index);
  }
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 4);
  const failed = result.results.filter((r) => r.ok === false);
  assert.equal(failed.length, 1, "exactly one mode fails");
  assert.equal(failed[0].modeId, "normal");
  assert.equal(llm.calls.length, 4, "all four modes were attempted");
  assert.equal(llm.maxActiveCount(), 1, "max active stayed at 1 across the whole run");
});

await ok("recommendModels: serial execution (maxActive=1) with a single-mode failure that continues", async () => {
  const llm = concurrencyLlm(recommendResponder, { failModes: ["broke"] });
  const promise = ai.recommendModels({
    llm,
    provider: "openai",
    model: "gpt-6.1-sol",
    authorizedModels: AUTHORIZED,
    catalog: CATALOG,
    modesStore: makeModesStore(),
    roles: baseRoles(),
  });
  for (let index = 0; index < 4; index += 1) {
    await until(() => llm.calls.length === index + 1);
    assert.equal(llm.activeCount(), 1, `job ${index}: exactly one stream active`);
    assert.equal(llm.maxActiveCount(), 1, `job ${index}: concurrency never exceeded 1`);
    llm.release(index);
  }
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 4);
  const failed = result.results.filter((r) => r.ok === false);
  assert.equal(failed.length, 1, "exactly one mode fails");
  assert.equal(failed[0].modeId, "broke");
  assert.equal(llm.calls.length, 4, "all four modes were attempted");
  assert.equal(llm.maxActiveCount(), 1, "max active stayed at 1 across the whole run");
});

await ok("formatError: preserves nested cause chain plus code/status without leaking stack frames", () => {
  const cause = new Error("ECONNREFUSED 127.0.0.1:7890");
  cause.code = "ECONNREFUSED";
  const top = new TypeError("fetch failed");
  top.cause = cause;
  top.status = 502;
  const rendered = ai.formatError(top);
  assert.match(rendered, /fetch failed/);
  assert.match(rendered, /ECONNREFUSED/);
  assert.match(rendered, /cause=/);
  assert.match(rendered, /code=ECONNREFUSED/);
  assert.match(rendered, /status=502/);
  assert.doesNotMatch(rendered, / {4}at /, "no stack frames leaked");
});

await ok("formatError: AggregateError.errors is bounded and never recurses infinitely", () => {
  const agg = new AggregateError(
    [new Error("a"), new Error("b"), new Error("c"), new Error("d"), new Error("e")],
    "several failures",
  );
  const rendered = ai.formatError(agg);
  assert.match(rendered, /several failures/);
  assert.match(rendered, /errors=\[/);
  assert.match(rendered, /\+1/, "fifth item folded into a count");
});

await ok("formatError: a circular cause reference is guarded", () => {
  const a = new Error("loop-a");
  const b = new Error("loop-b");
  a.cause = b;
  b.cause = a;
  const rendered = ai.formatError(a);
  assert.match(rendered, /loop-a/);
  assert.match(rendered, /loop-b/);
  assert.match(rendered, /Circular/);
});

await ok("formatError: never iterates arbitrary keys (credentials stay out of output)", () => {
  const err = new Error("boom");
  err.apiKey = "test-api-key-fixture";
  err.authorization = "Bearer test-authorization-fixture";
  const rendered = ai.formatError(err);
  assert.doesNotMatch(rendered, /test-api-key-fixture/);
  assert.doesNotMatch(rendered, /test-authorization-fixture/);
});

await ok("errorKind: classifies auth / rate-limit / network / timeout / aborted and follows cause", () => {
  const withProps = (name, message, extra) => Object.assign(Object.assign(new Error(message), { name }), extra || {});
  assert.equal(ai.errorKind(withProps("Error", "permission denied", { status: 403 })), "auth");
  assert.equal(ai.errorKind(withProps("Error", "authorization failed", { code: "AUTH_FAILED" })), "auth");
  assert.equal(ai.errorKind(withProps("Error", "rate limit exceeded", { status: 429 })), "rate-limit");
  assert.equal(ai.errorKind(withProps("TypeError", "fetch failed")), "network");
  assert.equal(ai.errorKind(withProps("Error", "connect ECONNREFUSED")), "network");
  assert.equal(ai.errorKind(withProps("Error", "request timed out")), "timeout");
  assert.equal(ai.errorKind(withProps("AbortError", "This operation was aborted")), "aborted");
  const wrapped = new Error("wrapped");
  wrapped.cause = withProps("TypeError", "fetch failed");
  assert.equal(ai.errorKind(wrapped), "network");
  assert.equal(ai.errorKind(withProps("Error", "something odd")), "unknown");
});

await ok("streamText: a network throw is formatted with kind plus nested cause", async () => {
  let calls = 0;
  const llm = {
    stream: async function* () {
      calls += 1;
      const cause = new Error("ECONNREFUSED 127.0.0.1:7890");
      cause.code = "ECONNREFUSED";
      const failure = new TypeError("fetch failed");
      failure.cause = cause;
      throw failure;
    },
  };
  const result = await ai.streamText(llm, { provider: "openai", model: "gpt-6.1-sol", messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "network");
  assert.match(result.error, /fetch failed/);
  assert.match(result.error, /ECONNREFUSED/);
  assert.match(result.error, /cause=/);
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
