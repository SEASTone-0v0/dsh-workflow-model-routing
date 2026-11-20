/**
 * Offline smoke test for the role-first settings plugin (v2.2.0).
 *
 * v2.1 separates model authorization from role assignment: authorised models
 * are chosen explicitly, and a role route must be a subset of them.
 *
 * No DSH runtime is involved. The test emulates the services the plugin talks
 * to (settings, llm, sessions, subagents, tools, systemPrompt), drives the six
 * HTTP routes with fake request/response objects, and mounts the client half in
 * jsdom against the real Host routes.
 *
 * Run: node test/smoke.mjs   (from the bundle directory)
 */
import { EventEmitter } from "node:events";
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

/** The role store writes into the profile directory; give it a scratch one. */
const scratch = await fs.mkdtemp(join(os.tmpdir(), "mrs-smoke-"));
process.env.DSH_PROFILE_DIR = scratch;

let passed = 0;
function ok(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${label}`);
    });
}

/* ------------------------------------------------------------------ *
 * fake runtime
 * ------------------------------------------------------------------ */

function fakeRequest({ method = "GET", body = null, headers = {}, url } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { host: "127.0.0.1:60229", ...headers };
  request.url = url;
  request.socket = { localAddress: "127.0.0.1" };
  request.pause = () => {};
  request.signal = undefined;
  if (body !== null) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    queueMicrotask(() => {
      request.emit("data", Buffer.from(text));
      request.emit("end");
    });
  }
  return request;
}

function fakeResponse() {
  const response = new EventEmitter();
  response.statusCode = 0;
  response.headers = {};
  response.body = "";
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers || {};
  };
  response.end = (chunk) => {
    if (chunk !== undefined) response.body += String(chunk);
    response.finished = true;
  };
  response.destroy = () => {
    response.finished = true;
  };
  return response;
}

async function call(handler, options) {
  const request = fakeRequest(options);
  const response = fakeResponse();
  await handler(request, response);
  let payload = null;
  try {
    payload = response.body === "" ? null : JSON.parse(response.body);
  } catch {
    payload = response.body;
  }
  return { status: response.statusCode, body: payload, headers: response.headers };
}

function makeSettings(initial) {
  const state = {
    ns: "subagent-model-selection-settings",
    revision: 7,
    value: {
      enabled: initial.enabled,
      allowedModels: initial.allowedModels.map((item) => ({ ...item })),
    },
    failNextReplace: null,
  };
  return {
    documentPath: join(scratch, "cordis.patch.yml"),
    describe() {
      return [
        { ns: "some-other-plugin", revision: 1, value: { other: true }, applies: "live" },
        {
          ns: state.ns,
          revision: state.revision,
          value: {
            enabled: state.value.enabled,
            allowedModels: state.value.allowedModels.map((item) => ({ ...item })),
          },
          base: { enabled: false, allowedModels: [] },
          user: { enabled: state.value.enabled, allowedModels: state.value.allowedModels.map((item) => ({ ...item })) },
          applies: "live",
        },
      ];
    },
    async replace(ns, section, expectedRevision) {
      assert.ok(String(ns).includes("subagent-model-selection"), `unexpected ns ${ns}`);
      if (state.failNextReplace !== null) {
        const code = state.failNextReplace;
        state.failNextReplace = null;
        const error = new Error(code === "SETTINGS_CONFLICT" ? "conflict" : "boom");
        error.code = code;
        throw error;
      }
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        const error = new Error("conflict");
        error.code = "SETTINGS_CONFLICT";
        throw error;
      }
      state.value.enabled = section.enabled;
      state.value.allowedModels = section.allowedModels.map((item) => ({ ...item }));
      state.revision += 1;
    },
    peek: () => state,
  };
}

function makeLlm() {
  const calls = [];
  const failing = new Set();
  // Scripted streaming for the AI routes: when set, stream() yields these exact
  // chunks instead of the default probe reply, so the AI tests can exercise the
  // `text-delta`→`chunk.text` / `finish`→`chunk.reason.kind` contract.
  let script = null;
  const configurableState = [
    { provider: "deepseek-account", displayName: "DeepSeek", defaultBaseURL: "https://api.deepseek.com/v1" },
    { provider: "openai", displayName: "OpenAI", defaultBaseURL: "https://api.openai.com/v1" },
  ];
  const modelCatalog = {
    "deepseek-account": [
      { id: "deepseek-flash", name: "DeepSeek Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
    openai: [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-6-astra", name: "GPT-6 Astra" },
    ],
    "kimi-subscription": [
      { id: "k3", name: "Kimi K3" },
      { id: "k3.1-pro", name: "Kimi K3.1 Pro" },
    ],
    google: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
      { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    ],
    "deepseek-account-vision": [
      { id: "deepseek-flash", name: "DeepSeek Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
    broken: [],
  };
  // Per-model reasoning capability, kept separate from listModels so catalogue
  // rows stay unchanged. resolveModelInfo is what the host consults for tiers.
  // The runtime contract exposes `reasoning.efforts` as an array of { id, name }
  // objects (NOT a `supportedEfforts` string array); the fake uses that shape so
  // the smoke test exercises the real contract. Legacy-string compatibility is
  // asserted separately against the capabilities module.
  const reasoningInfo = {
    "deepseek-account/deepseek-flash": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }], defaultEffort: "low" },
    "deepseek-account/deepseek-v4-pro": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "openai/gpt-6.1-sol": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "openai/gpt-5.3-codex": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "openai/gpt-6-astra": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "openai/gpt-5.6-sol": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "kimi-subscription/k3": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }], defaultEffort: "low" },
    "kimi-subscription/k3.1-pro": { efforts: [], defaultEffort: null },
    "google/gemini-3.1-pro-preview": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "google/gemini-3-flash-preview": { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" },
    "google/gemini-4-argon": { efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
    "deepseek-account-vision/deepseek-flash": { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" },
    "deepseek-account-vision/deepseek-v4-pro": { efforts: [{ id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" },
  };
  return {
    calls,
    failing,
    configurableState,
    listProviders() {
      return Object.keys(modelCatalog).map((id) => ({ id, name: id }));
    },
    listConfigurableProviders() {
      return configurableState.map((entry) => ({ ...entry }));
    },
    async listModels(provider) {
      if (provider === "broken") throw new Error("provider is not configured");
      return (modelCatalog[provider] || []).map((model) => ({ provider, ...model }));
    },
    async resolveModelInfo(provider, model) {
      const info = reasoningInfo[provider + "/" + model];
      return info ? { reasoning: info } : null;
    },
    stream(options) {
      const key = `${options.provider}/${options.model}`;
      calls.push(key);
      const shouldFail = failing.has(key);
      return (async function* () {
        if (shouldFail) {
          const error = new Error("no longer available to new users");
          error.code = "MODEL_NOT_FOUND";
          error.status = 404;
          throw error;
        }
        if (script !== null) {
          for (const chunk of script) yield chunk;
          return;
        }
        yield { type: "text-delta", delta: "OK" };
        yield { type: "finish", finish: "stop" };
      })();
    },
    setScript(chunks) {
      script = chunks;
    },
    clearScript() {
      script = null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * host half
 * ------------------------------------------------------------------ */

const host = await import(new URL("../lib/index.js", import.meta.url).href);
const capabilities = await import(new URL("../lib/capabilities.js", import.meta.url).href);
const modes = await import(new URL("../lib/modes.js", import.meta.url).href);
const execution = await import(new URL("../lib/execution.js", import.meta.url).href);
const tiers = await import(new URL("../lib/tiers.js", import.meta.url).href);

console.log("host routes");

const settings = makeSettings({ enabled: true, allowedModels: [] });
const llm = makeLlm();
const systemPromptContexts = [];
const systemPrompt = {
  context(spec) {
    systemPromptContexts.push(spec);
  },
};

const sessions = new Map();
const sessionsService = {
  get(id) {
    return sessions.get(id);
  },
};

const activations = [];
// Mutable spawn provider state so the negative dispatch tests can simulate a
// missing spawn provider (null) or a spawn without agentOptions ({ agentOptions: false }).
let subagentSpawnState = { agentOptions: true };
const subagentsService = {
  getProvider(name) {
    if (name === "spawn" && subagentSpawnState !== null) {
      return {
        name,
        capabilities: { agentOptions: subagentSpawnState.agentOptions, agentPreset: true, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
      };
    }
    return undefined;
  },
  async startActivation(spec) {
    activations.push(spec);
    return { childId: `child-${activations.length}`, result: Promise.resolve({}) };
  },
};

const toolDefinitions = [];
const toolsService = {
  register(definition) {
    toolDefinitions.push(definition);
    return () => {};
  },
};

// Phase-C: fake agentDefaultModel so the enable handler can persist a lead.
const leadSelections = [];
let leadSelectionFailuresRemaining = 0;
let leadReadFailuresRemaining = 0;
const agentDefaultModelService = {
  currentSelection() {
    if (leadReadFailuresRemaining > 0) {
      leadReadFailuresRemaining -= 1;
      throw new Error("currentSelection rejected (test)");
    }
    return leadSelections.length > 0
      ? leadSelections[leadSelections.length - 1]
      : { provider: "deepseek-account", model: "deepseek-v4-pro" };
  },
  async saveSelection(next) {
    if (leadSelectionFailuresRemaining > 0) {
      leadSelectionFailuresRemaining -= 1;
      throw new Error("saveSelection rejected (test)");
    }
    leadSelections.push(next);
  },
};

// Phase-C: fake agentTeams so the taskBoard target can be exercised offline.
const teamTasks = [];
const agentTeamsService = {
  isEnabled: () => true,
  async createTask(caller, request) {
    const task = {
      id: `team-${teamTasks.length + 1}`,
      revision: 1,
      subject: request.subject,
      description: request.description,
      status: "pending",
      blockedBy: [],
      writeScopes: [],
      ready: true,
      writeScopeWarnings: [],
    };
    teamTasks.push(task);
    return task;
  },
};

const services = {
  settings,
  llm,
  systemPrompt,
  sessions: sessionsService,
  subagents: subagentsService,
  tools: toolsService,
  agentDefaultModel: agentDefaultModelService,
  agentTeams: agentTeamsService,
};
const routes = new Map();
const listeners = new Map();
const ctx = {
  get: (name) => services[name] ?? null,
  logger: { warn: (message) => console.log("  warn:", message) },
  on: (event, handler) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
  inject: (names, callback) => {
    if (Array.isArray(names) && names.length === 1 && names[0] !== "webServer") {
      callback({
        [names[0]]: services[names[0]],
        get: (name) => services[name] ?? null,
      });
      return;
    }
    assert.deepEqual(names, ["webServer"]);
    callback({
      webServer: {
        register(route) {
          assert.equal(route.kind, "exact");
          if (routes.has(route.path)) throw new Error("duplicate route");
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
      get: (name) => services[name] ?? null,
    });
  },
};

host.apply(ctx);
assert.equal(typeof host.default.apply, "function");
assert.equal(routes.size, 19, "nineteen routes registered");
assert.ok(listeners.has("llm/stream"), "llm/stream observed");
assert.ok(listeners.has("tools/post-execute"), "tools/post-execute observed");
assert.ok(listeners.has("subagent/end"), "subagent/end observed");
assert.ok(listeners.has("agent/created"), "agent/created observed");
assert.ok(listeners.has("settings/document-updated"), "settings/document-updated observed");
assert.ok(listeners.has("llm/adapters-updated"), "llm/adapters-updated observed");
assert.ok(listeners.has("llm/models-updated"), "llm/models-updated observed");
assert.equal(systemPromptContexts.length, 1, "systemPrompt context registered");
assert.equal(toolDefinitions.length, 1, "role dispatch tool registered");
assert.equal(toolDefinitions[0].name, "role_subagent");

const STATE = "/plugins/dsh-workflow-model-routing/state";
const CATALOG = "/plugins/dsh-workflow-model-routing/catalog";
const ROLES_ROUTE = "/plugins/dsh-workflow-model-routing/roles";
const VALIDATE = "/plugins/dsh-workflow-model-routing/roles/validate";
const SAVE = "/plugins/dsh-workflow-model-routing/roles/save";
const SUBAGENTS_ROUTE = "/plugins/dsh-workflow-model-routing/subagents";
const MODES = "/plugins/dsh-workflow-model-routing/modes";
const MODE_SAVE = "/plugins/dsh-workflow-model-routing/modes/save";
const MODE_ENABLE = "/plugins/dsh-workflow-model-routing/modes/enable";
const CAPABILITIES = "/plugins/dsh-workflow-model-routing/capabilities";
const CAPABILITIES_REFRESH = "/plugins/dsh-workflow-model-routing/capabilities/refresh";
const EXECUTION_INTEGRATION = "/plugins/dsh-workflow-model-routing/execution-integration";
const TIERS_ROUTE = "/plugins/dsh-workflow-model-routing/tiers";
const TIERS_REFRESH = "/plugins/dsh-workflow-model-routing/tiers/refresh";
const AI_CONFIGURE = "/plugins/dsh-workflow-model-routing/ai/configure";
const AI_RECOMMEND = "/plugins/dsh-workflow-model-routing/ai/recommend";
const AI_JOBS = "/plugins/dsh-workflow-model-routing/ai/jobs";
const RELEASE_NOTES = "/plugins/dsh-workflow-model-routing/release-notes";

const STORE_FILE = join(scratch, "dsh-workflow-model-routing.state.json");

function storeRev() {
  const store = storeFileJson();
  return store === null ? 0 : store.revision;
}

function storeFileJson() {
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf8"));
  } catch {
    return null;
  }
}

const initialView = (await call(routes.get(ROLES_ROUTE), {})).body;
const DEFAULTS = initialView.roles;
const DEFAULT_AUTHORIZED = initialView.authorizedModels;
const defaultDraft = {
  enabled: true,
  roles: JSON.parse(JSON.stringify(DEFAULTS)),
  authorizedModels: JSON.parse(JSON.stringify(DEFAULT_AUTHORIZED)),
};
function draftCopy(extra) {
  return JSON.parse(JSON.stringify({ ...defaultDraft, ...(extra || {}) }));
}

await ok("GET /state reads the official policy", async () => {
  const response = await call(routes.get(STATE), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.ns, "subagent-model-selection-settings");
  assert.equal(response.body.enabled, true);
  assert.equal(response.body.plan.models.length, 10);
});

await ok("GET /roles exposes 14 roles and the ten authorized models", async () => {
  const response = await call(routes.get(ROLES_ROUTE), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.roles.length, 14);
  assert.equal(response.body.authorizedModels.length, 10);
  assert.equal(response.body.defaultAuthorizedModels.length, 10);
  assert.equal(response.body.references.length, 10);
  assert.equal(response.body.references.every((row) => Array.isArray(row.roles)), true);
  assert.equal(response.body.conflicts.length, 0);
  assert.equal(response.body.migrated, false);
  assert.equal(response.body.planModels.length, 10);
  assert.equal(response.body.persistent, true);
  const reviewer = response.body.roles.find((role) => role.id === "reviewer");
  assert.equal(reviewer.primary, null);
  assert.equal(reviewer.pairings.length, 2);
  const openaiPairing = reviewer.pairings.find((p) => p.authorProviders.includes("openai"));
  assert.equal(openaiPairing.reviewer.provider, "deepseek-account");
  assert.equal(openaiPairing.reviewer.model, "deepseek-v4-pro");
  assert.equal(openaiPairing.reviewer.reasoningPolicy, "default");
  const otherPairing = reviewer.pairings.find((p) => !p.authorProviders.includes("openai"));
  assert.equal(otherPairing.reviewer.provider, "openai");
  assert.equal(otherPairing.reviewer.model, "gpt-6.1-sol");
  assert.ok(otherPairing.authorProviders.includes("deepseek-account"));
  assert.ok(otherPairing.authorProviders.includes("kimi-subscription"));
  const privacy = response.body.roles.find((role) => role.id === "privacy-memory");
  assert.equal(privacy.status, "manual-or-verified-local-only");
  const routesJson = JSON.stringify(response.body.authorizedModels) + JSON.stringify(response.body.roles);
  assert.ok(!routesJson.includes("moonshotai/"), "no legacy moonshotai provider alias survives");
});

await ok("GET /catalog skips an unreadable provider", async () => {
  const response = await call(routes.get(CATALOG), {});
  assert.equal(response.status, 200);
  const ids = response.body.providers.map((provider) => provider.id);
  assert.ok(ids.includes("openai"));
  assert.ok(!ids.includes("broken"));
});

await ok("GET /catalog populates reasoningEfforts from resolveModelInfo (not listModels)", async () => {
  const response = await call(routes.get(CATALOG), {});
  assert.equal(response.status, 200);
  const openai = response.body.providers.find((provider) => provider.id === "openai");
  assert.ok(openai, "openai provider present");
  const sol = openai.models.find((model) => model.id === "gpt-6.1-sol");
  assert.ok(sol, "gpt-6.1-sol model present");
  // listModels returns {id,name} only; reasoning efforts must come from resolveModelInfo.
  assert.deepEqual(sol.reasoningEfforts, ["low", "medium", "high"], "efforts from resolveModelInfo");
  assert.equal(sol.defaultEffort, "medium", "default effort from resolveModelInfo");
  const kimiSub = response.body.providers.find((provider) => provider.id === "kimi-subscription");
  assert.ok(kimiSub, "kimi-subscription provider present");
  const kimi31 = kimiSub.models.find((model) => model.id === "k3.1-pro");
  assert.ok(kimi31, "k3.1-pro model present");
  assert.deepEqual(kimi31.reasoningEfforts, [], "k3.1-pro has no declared efforts (default-only)");
});

await ok("save without a validation token writes roles and the authorized set", async () => {
  const response = await call(routes.get(SAVE), { method: "POST", body: draftCopy() });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.revision, 1);
  assert.equal(settings.peek().value.allowedModels.length, 10, "policy written without a token");
  assert.equal(storeFileJson().revision, 1, "store written without a token");
});

await ok("validate probes each distinct route exactly once", async () => {
  llm.calls.length = 0;
  const response = await call(routes.get(VALIDATE), { method: "POST", body: draftCopy() });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.checked, 10);
  assert.equal(response.body.results.length, 10);
  assert.equal(llm.calls.length, 10, "one probe per route");
  assert.equal(new Set(llm.calls).size, 10, "no duplicate probes");
  assert.equal(typeof response.body.token, "string");
});

await ok("save with the token writes roles and the authorized set", async () => {
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draftCopy() });
  const expected = storeRev();
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draftCopy(), expectedRevision: expected, validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.revision, 2);
  assert.equal(settings.peek().value.allowedModels.length, 10);
  const store = storeFileJson();
  assert.equal(store.version, 3);
  assert.equal(store.authorizedModels.length, 10);
  assert.equal(store.revision, 2);
  assert.equal(store.roles.length, 14);
});

await ok("a draft changed after validation cannot reuse the token", async () => {
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draftCopy() });
  const changed = draftCopy();
  changed.authorizedModels = changed.authorizedModels.concat([{ provider: "google", model: "gemini-3-flash-preview" }]);
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...changed, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "validation-required");
  assert.equal(storeFileJson().revision, 2, "store untouched");
});

await ok("a failing route blocks the save and keeps the old configuration", async () => {
  llm.failing.add("google/gemini-3.1-pro-preview");
  try {
    const draft = draftCopy();
    const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
    assert.equal(validated.body.ok, false);
    assert.equal(validated.body.failed.length, 1);
    assert.equal(validated.body.failed[0].code, "MODEL_NOT_FOUND");
    const response = await call(routes.get(SAVE), {
      method: "POST",
      body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "validation-failed");
    assert.equal(storeFileJson().revision, 2, "store untouched");
    assert.equal(settings.peek().value.allowedModels.length, 10, "policy untouched");
  } finally {
    llm.failing.delete("google/gemini-3.1-pro-preview");
  }
});

await ok("a standard role without a primary is rejected", async () => {
  const draft = draftCopy();
  const role = draft.roles.find((row) => row.id === "coder");
  role.primary = null;
  const response = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /主用/);
});

await ok("reviewer and privacy roles cannot be pinned to a fixed model", async () => {
  const draft = draftCopy();
  const reviewer = draft.roles.find((row) => row.id === "reviewer");
  reviewer.primary = { provider: "openai", model: "gpt-6.1-sol" };
  const privacy = draft.roles.find((row) => row.id === "privacy-memory");
  privacy.upgrade = { provider: "openai", model: "gpt-6.1-sol" };
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  const saved = response.body.roles.find((row) => row.id === "reviewer");
  assert.equal(saved.primary, null);
  assert.equal(saved.pairings.length, 2);
  assert.equal(saved.pairings[0].reviewer.provider, "deepseek-account");
  assert.equal(saved.pairings[0].reviewer.model, "deepseek-v4-pro");
  const savedPrivacy = response.body.roles.find((row) => row.id === "privacy-memory");
  assert.equal(savedPrivacy.upgrade, null);
});

await ok("reviewer pairings preserve an explicit edit instead of reverting to the default", async () => {
  const draft = draftCopy();
  const reviewer = draft.roles.find((row) => row.id === "reviewer");
  reviewer.pairings = [
    { authorProviders: ["openai"], reviewer: { provider: "openai", model: "gpt-6.1-sol" } },
    { authorProviders: ["deepseek-account"], reviewer: { provider: "deepseek-account", model: "deepseek-v4-pro" } },
  ];
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  const saved = response.body.roles.find((row) => row.id === "reviewer");
  assert.equal(saved.pairings.length, 2);
  const openaiPairing = saved.pairings.find((pairing) => pairing.authorProviders.includes("openai"));
  assert.equal(openaiPairing.reviewer.provider, "openai");
  assert.equal(openaiPairing.reviewer.model, "gpt-6.1-sol");
  const deepseekPairing = saved.pairings.find((pairing) => pairing.authorProviders.includes("deepseek-account"));
  assert.equal(deepseekPairing.reviewer.provider, "deepseek-account");
  assert.equal(deepseekPairing.reviewer.model, "deepseek-v4-pro");
});

await ok("a failed policy write rolls the role store back", async () => {
  const before = storeFileJson();
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draftCopy() });
  settings.peek().failNextReplace = "SETTINGS_WRITE_FAILED";
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draftCopy(), expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "policy-write-failed");
  const after = storeFileJson();
  assert.equal(after.revision, before.revision, "store rolled back");
});

await ok("a role route outside the authorized set is refused by the host", async () => {
  const draft = draftCopy();
  draft.roles.find((row) => row.id === "coder").primary = { provider: "google", model: "gemini-3-flash-preview" };
  const response = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "unauthorized_route");
  assert.match(response.body.message, /未授权/);
});

await ok("revoking a model a role still uses is refused", async () => {
  const draft = draftCopy();
  draft.authorizedModels = draft.authorizedModels.filter(
    (row) => !(row.provider === "deepseek-account" && row.model === "deepseek-v4-pro"),
  );
  const revBefore = storeRev();
  const response = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "unauthorized_route");
  assert.match(response.body.message, /任务秘书/);
  assert.equal(storeFileJson().revision, revBefore, "nothing was written");
});

await ok("deleting roles does not change the authorized set", async () => {
  const draft = draftCopy();
  draft.roles = draft.roles.filter((row) => row.id !== "creative-writer" && row.id !== "long-document");
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.authorizedModels.length, 10, "authorizations survive the deletion");
  assert.equal(response.body.roles.length, 12);
  const kimi = response.body.references.find((row) => row.model === "k3");
  assert.ok(kimi, "k3 is still in the authorized set");
  assert.equal(kimi.roles.length, 1, "k3 remains referenced by the researcher upgrade");
});

await ok("the built-in special roles cannot be deleted", async () => {
  const draft = draftCopy();
  draft.roles = draft.roles.filter((row) => row.id !== "reviewer");
  const response = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "bad_roles");
  assert.match(response.body.message, /不能被删除/);
});

await ok("a disabled role may leave every tier unset", async () => {
  const draft = draftCopy();
  const coder = draft.roles.find((row) => row.id === "coder");
  coder.enabled = false;
  coder.primary = null;
  coder.backup = null;
  coder.upgrade = null;
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  const saved = response.body.roles.find((row) => row.id === "coder");
  assert.equal(saved.enabled, false);
  assert.equal(saved.primary, null);
});

await ok("restore the canonical role set before the dispatch checks", async () => {
  const draft = draftCopy();
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.roles.length, 14);
  assert.equal(response.body.authorizedModels.length, 10);
});

await ok("role dispatch refuses a route the role store does not authorize", async () => {
  const tool = toolDefinitions[0];
  const store = storeFileJson();
  store.authorizedModels = store.authorizedModels.filter(
    (row) => !(row.provider === "deepseek-account" && row.model === "deepseek-v4-pro"),
  );
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
  try {
    await assert.rejects(
      () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-ok" }, signal: undefined }),
      /未获授权/,
    );
  } finally {
    await fs.rm(STORE_FILE, { force: true });
    // The store cache lives for two seconds; let it expire so the next read
    // sees the defaults again.
    await new Promise((resolve) => setTimeout(resolve, 2100));
  }
});

await ok("role dispatch refuses a session without a snapshot", async () => {
  const tool = toolDefinitions[0];
  sessions.set("session-nopolicy", { snapshotEvents: () => [] });
  await assert.rejects(
    () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-nopolicy" }, signal: undefined }),
    /没有模型授权快照/,
  );
});

await ok("role dispatch refuses a route outside the session authorization", async () => {
  const tool = toolDefinitions[0];
  sessions.set("session-narrow", {
    snapshotEvents: () => [
      { type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-flash" }] } },
    ],
  });
  await assert.rejects(
    () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-narrow" }, signal: undefined }),
    /不在本会话授权范围内/,
  );
});

await ok("role dispatch resolves the configured route and records identity", async () => {
  const tool = toolDefinitions[0];
  sessions.set("session-ok", {
    snapshotEvents: () => [
      {
        type: "subagent/model-selection-policy",
        data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] },
      },
    ],
  });
  const result = await tool.execute(
    { roleId: "coder", prompt: "修复这个测试\n第二行", description: "修复测试" },
    { agent: { id: "session-ok" }, signal: undefined },
  );
  assert.equal(result.kind, "activation");
  assert.equal(result.roleName, "代码执行员");
  assert.equal(result.routeProvider, "deepseek-account");
  assert.equal(result.routeModel, "deepseek-v4-pro");
  // Phase-C: dispatch reads the frozen mode snapshot. The seeded "normal" mode
  // keeps every role at reasoningPolicy "default", so no reasoningEffort is sent
  // (adapter default) instead of the legacy complexity-based "high".
  assert.equal(result.modeId, "normal");
  assert.equal(result.routeSource, "role-primary");
  assert.equal(typeof result.modeRevision, "number");
  const spec = activations[activations.length - 1];
  assert.equal(spec.provider, "spawn");
  assert.equal(spec.delivery, "parent");
  assert.equal(spec.request, undefined);
  assert.deepEqual(spec.agentOptions, { provider: "deepseek-account", model: "deepseek-v4-pro" });
  assert.equal(result.routeReasoningEffort, "");
  assert.equal(spec.prompt[0].text, "修复这个测试\n第二行");
  assert.equal(spec.parent.id, "session-ok");
});

await ok("role dispatch sends no reasoningEffort for a default-policy route", async () => {
  const tool = toolDefinitions[0];
  sessions.set("session-vision", {
    snapshotEvents: () => [
      { type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } },
    ],
  });
  const result = await tool.execute(
    { roleId: "vision", prompt: "描述这张图" },
    { agent: { id: "session-vision" }, signal: undefined },
  );
  const spec = activations[activations.length - 1];
  // vision role migrated to non-vision deepseek-account/deepseek-v4-pro with
  // reasoningPolicy "default", so no reasoningEffort field is ever sent.
  assert.equal(spec.request, undefined);
  assert.deepEqual(spec.agentOptions, { provider: "deepseek-account", model: "deepseek-v4-pro" });
  assert.equal(result.routeReasoningEffort, "");
});

await ok("role dispatch refuses the privacy role", async () => {
  const tool = toolDefinitions[0];
  await assert.rejects(
    () => tool.execute({ roleId: "privacy-memory", prompt: "hi" }, { agent: { id: "session-ok" }, signal: undefined }),
    /不允许自动云端派发/,
  );
});

await ok("a new authorization is never assigned to a role automatically", async () => {
  const draft = draftCopy();
  draft.authorizedModels = draft.authorizedModels.concat([{ provider: "google", model: "gemini-3-flash-preview" }]);
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  assert.equal(validated.body.checked, 11, "the new route is probed once as well");
  const response = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.authorizedModels.length, 11);
  const fresh = response.body.references.find((row) => row.model === "gemini-3-flash-preview");
  assert.equal(fresh.roles.length, 0, "authorizing does not assign");
  assert.equal(response.body.roles.length, 14, "roles untouched");
});

await ok("a disabled role cannot be dispatched", async () => {
  const tool = toolDefinitions[0];
  const draft = draftCopy();
  draft.authorizedModels = draft.authorizedModels.filter((row) => row.model !== "gemini-3-flash-preview");
  const secretary = draft.roles.find((row) => row.id === "secretary");
  secretary.enabled = false;
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  const saved = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(saved.status, 200);
  await assert.rejects(
    () => tool.execute({ roleId: "secretary", prompt: "hi" }, { agent: { id: "session-ok" }, signal: undefined }),
    /已停用|停用/,
  );
});

await ok("a custom role can be added and saved, then removed again", async () => {
  const draft = draftCopy();
  draft.roles.push({
    id: "custom-1",
    name: "测试角色",
    purpose: "验证自定义角色",
    kind: "standard",
    enabled: true,
    primary: { provider: "openai", model: "gpt-6.1-sol" },
    backup: null,
    upgrade: null,
    switchRule: "confirm",
    custom: true,
  });
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draft });
  assert.equal(validated.status, 200);
  const saved = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draft, expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.roles.length, 15);
  const custom = saved.body.roles.find((row) => row.id === "custom-1");
  assert.equal(custom.kind, "standard");
  assert.equal(custom.purpose, "验证自定义角色");

  const again = draftCopy();
  again.roles = again.roles.filter((row) => row.id !== "custom-1");
  const validated2 = await call(routes.get(VALIDATE), { method: "POST", body: again });
  const saved2 = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...again, expectedRevision: storeRev(), validationToken: validated2.body.token },
  });
  assert.equal(saved2.status, 200);
  assert.equal(saved2.body.roles.length, 14);
  assert.equal(saved2.body.authorizedModels.length, 10);
});

await ok("plain subagent dispatch is still recorded with an inferred role", async () => {
  const post = listeners.get("tools/post-execute");
  post(
    {
      name: "subagent",
      arguments: {
        description: "代码执行员：验证 1+1=2",
        prompt: "Reply with exactly: 2",
        provider: "openai",
        model: "gpt-5.3-codex",
      },
      agent: { id: "session-b5eb7881" },
    },
    { isError: false, value: { kind: "activation", subagentId: "child-plain" } },
    () => "NEXT",
  );
  listeners.get("llm/stream")({ sessionId: "child-plain", provider: "openai", model: "gpt-5.3-codex" }, () => "NEXT");
  const response = await call(routes.get(SUBAGENTS_ROUTE), { url: "/plugins/dsh-workflow-model-routing/subagents?parentSessionId=session-b5eb7881" });
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
  const entry = response.body.subagents[0];
  assert.equal(entry.roleId, "coder");
  assert.equal(entry.roleName, "代码执行员");
  assert.equal(entry.requestedProvider, "openai");
  assert.equal(entry.actualModel, "gpt-5.3-codex");
  assert.equal(entry.status, "running");
});

await ok("the child system prompt carries the same identity record", async () => {
  const text = systemPromptContexts[0].text({ scope: { id: "child-plain" } });
  assert.match(text, /【子代理身份】/);
  assert.match(text, /角色：代码执行员/);
  assert.match(text, /任务：Reply with exactly: 2/);
  assert.match(text, /调用路线：openai\/gpt-5.3-codex/);
});

await ok("subagent settlement updates the ledger status", async () => {
  listeners.get("subagent/end")({ childId: "child-plain", reason: "completed" });
  const response = await call(routes.get(SUBAGENTS_ROUTE), {});
  const entry = response.body.subagents.find((row) => row.childId === "child-plain");
  assert.equal(entry.status, "completed");
});

await ok("the role store survives a reload", async () => {
  const validated = await call(routes.get(VALIDATE), { method: "POST", body: draftCopy() });
  const saved = await call(routes.get(SAVE), {
    method: "POST",
    body: { ...draftCopy(), expectedRevision: storeRev(), validationToken: validated.body.token },
  });
  assert.equal(saved.status, 200);
  const store = storeFileJson();
  assert.equal(store.roles.length, 14);
  assert.equal(store.authorizedModels.length, 10);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const response = await call(routes.get(ROLES_ROUTE), {});
  assert.equal(response.body.roles.length, 14);
  assert.equal(response.body.revision, store.revision);
});

await ok("a v2 store migrates to explicit authorizations without auto-granting", async () => {
  const store = {
    version: 2,
    revision: 5,
    updatedAt: new Date().toISOString(),
    roles: JSON.parse(JSON.stringify(DEFAULTS)),
    extraModels: [],
  };
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
  // Drop the two-second store cache so the migrated file is actually read.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const response = await call(routes.get(ROLES_ROUTE), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.migrated, true);
  assert.equal(response.body.storeVersion, 2);
  assert.equal(response.body.revision, 5, "migration does not bump the revision");
  assert.equal(response.body.authorizedModels.length, 10, "the ten official routes become the baseline");
  assert.equal(response.body.roles.length, 14, "role ids survive the migration");
  await fs.rm(STORE_FILE, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const clean = await call(routes.get(ROLES_ROUTE), {});
  assert.equal(clean.body.revision, 0);
  assert.equal(clean.body.authorizedModels.length, 10);
});

/* ------------------------------------------------------------------ *
 * AI configure / recommend / release notes (v2.4.0)
 * ------------------------------------------------------------------ */

// Warm up the modes store so the AI handlers read the seeded file instead of
// writing it during the test.
await call(routes.get(MODES), {});
const modesFilePath = join(scratch, modes.MODES_FILE);
const modesBaseline = readFileSync(modesFilePath, "utf8");

await ok("GET /release-notes serves the package release notes", async () => {
  const response = await call(routes.get(RELEASE_NOTES), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.currentVersion, "2.6.4");
  assert.equal(Array.isArray(response.body.versions), true);
  assert.ok(response.body.versions.length >= 8);
  const latest = response.body.versions[0];
  assert.equal(latest.version, "v2.6.4");
  assert.equal(typeof latest.title.zh, "string");
  assert.equal(Array.isArray(latest.sections), true);
  // release-notes.json is Lead-owned; the v2.6.3 entry uses `links` while older
  // entries use `files`. Accept either so this smoke test is schema-tolerant.
  assert.equal(Array.isArray(latest.files) || Array.isArray(latest.links), true, "latest release note lists affected files or links");
});

await ok("AI configure rejects an unauthorized execution model without probing", async () => {
  llm.calls.length = 0;
  const response = await call(routes.get(AI_CONFIGURE), {
    method: "POST",
    body: { provider: "google", model: "gemini-3-flash-preview" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, "unauthorized-model");
  assert.equal(llm.calls.length, 0, "no llm call before the auth check");
});

await ok("AI configure streams via chunk.text, never writes the store, and never retries", async () => {
  llm.setScript([
    { type: "text-delta", text: JSON.stringify({ lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" } }) },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  llm.calls.length = 0;
  const revBefore = storeRev();
  const response = await call(routes.get(AI_CONFIGURE), {
    method: "POST",
    body: { provider: "openai", model: "gpt-6.1-sol" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.results.length, 4);
  assert.equal(response.body.results.every((result) => result.ok === true), true, "chunk.text produced parseable JSON");
  assert.equal(llm.calls.length, 4, "one llm call per mode, no retry");
  assert.equal(storeRev(), revBefore, "role store untouched");
  assert.equal(readFileSync(modesFilePath, "utf8"), modesBaseline, "modes file untouched");
  llm.clearScript();
});

await ok("AI recommend streams via chunk.text and returns display-only candidates", async () => {
  llm.setScript([
    { type: "text-delta", text: JSON.stringify({ roles: [] }) },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  llm.calls.length = 0;
  const revBefore = storeRev();
  const response = await call(routes.get(AI_RECOMMEND), {
    method: "POST",
    body: { provider: "openai", model: "gpt-6.1-sol" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.results.length, 4);
  assert.equal(llm.calls.length, 4, "one llm call per mode, no retry");
  assert.equal(storeRev(), revBefore, "role store untouched");
  assert.equal(readFileSync(modesFilePath, "utf8"), modesBaseline, "modes file untouched");
  llm.clearScript();
});

await ok("AI configure surfaces per-mode stream failures without retrying or writing", async () => {
  llm.failing.add("openai/gpt-6.1-sol");
  try {
    llm.calls.length = 0;
    const revBefore = storeRev();
    const response = await call(routes.get(AI_CONFIGURE), {
      method: "POST",
      body: { provider: "openai", model: "gpt-6.1-sol" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.results.every((result) => result.ok === false), true, "stream throw surfaced per-mode");
    assert.equal(response.body.results.every((result) => typeof result.error === "string"), true);
    assert.equal(llm.calls.length, 4, "no retry after a stream throw");
    assert.equal(storeRev(), revBefore, "role store untouched");
    assert.equal(readFileSync(modesFilePath, "utf8"), modesBaseline, "modes file untouched");
  } finally {
    llm.failing.delete("openai/gpt-6.1-sol");
  }
});

await ok("v2.6.1: AI configure handler surfaces a nested network cause (no top-level-only error)", async () => {
  host.__resetCatalogCache();
  const originalListProviders = llm.listProviders;
  llm.listProviders = () => {
    const cause = new Error("ECONNREFUSED 127.0.0.1:7890");
    cause.code = "ECONNREFUSED";
    const error = new TypeError("fetch failed");
    error.cause = cause;
    throw error;
  };
  try {
    const response = await call(routes.get(AI_CONFIGURE), {
      method: "POST",
      body: { provider: "openai", model: "gpt-6.1-sol" },
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.error, "ai-configure-failed");
    assert.ok(response.body.message.includes("fetch failed"), "top-level message kept");
    assert.ok(response.body.message.includes("ECONNREFUSED"), "nested cause kept");
    assert.ok(response.body.message.includes("code=ECONNREFUSED"), "nested code kept");
    assert.equal(response.body.kind, "network", "classified as network");
  } finally {
    llm.listProviders = originalListProviders;
    host.__resetCatalogCache();
  }
});

/* v2.6.2 async job flow */

await ok("AI jobs POST returns 202 queued immediately and polls to a 4-mode success", async () => {
  llm.setScript([
    { type: "text-delta", text: JSON.stringify({ lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default" } }) },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  llm.calls.length = 0;
  const revBefore = storeRev();
  const post = await call(routes.get(AI_JOBS), {
    method: "POST",
    body: { operation: "configure", provider: "openai", model: "gpt-6.1-sol" },
  });
  assert.equal(post.status, 202, "immediate 202, not a long synchronous response");
  assert.equal(post.body.ok, true);
  assert.equal(typeof post.body.jobId, "string");
  assert.equal(post.body.status, "queued", "POST reports queued before the run starts");
  const deadline = Date.now() + 2000;
  let job = null;
  for (;;) {
    const poll = await call(routes.get(AI_JOBS), { method: "GET", url: `${AI_JOBS}?id=${post.body.jobId}` });
    assert.equal(poll.status, 200);
    job = poll.body.job;
    if (job.status === "succeeded" || job.status === "failed") break;
    assert.ok(Date.now() < deadline, "job reached a terminal state before the poll deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(job.status, "succeeded");
  assert.equal(job.operation, "configure");
  assert.equal(job.provider, "openai");
  assert.equal(job.model, "gpt-6.1-sol");
  assert.equal(job.result.results.length, 4, "four-mode result preserved");
  assert.equal(job.result.results.every((result) => result.ok === true), true);
  assert.equal(llm.calls.length, 4, "four llm calls, no retry");
  assert.equal(storeRev(), revBefore, "role store untouched");
  assert.equal(readFileSync(modesFilePath, "utf8"), modesBaseline, "modes file untouched");
  llm.clearScript();
});

await ok("AI jobs POST rejects an unauthorized execution model with zero calls", async () => {
  llm.calls.length = 0;
  const post = await call(routes.get(AI_JOBS), {
    method: "POST",
    body: { operation: "configure", provider: "google", model: "gemini-3-flash-preview" },
  });
  assert.equal(post.status, 403);
  assert.equal(post.body.error, "unauthorized-model");
  assert.equal(llm.calls.length, 0, "no llm call before the auth check");
});

await ok("AI jobs GET returns 404 for an unknown id", async () => {
  const poll = await call(routes.get(AI_JOBS), { method: "GET", url: `${AI_JOBS}?id=no-such-job` });
  assert.equal(poll.status, 404);
  assert.equal(poll.body.error, "job-not-found");
});

/* ------------------------------------------------------------------ *
 * client half
 * ------------------------------------------------------------------ */

console.log("client half");

const { JSDOM } = sharedRequire("jsdom");

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
  url: "http://127.0.0.1:60229/",
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

/** Serve the real routes through a fetch shim so the page talks to the Host. */
function fetchForRoutes(url, init) {
  const path = new URL(url, "http://127.0.0.1:60229").pathname;
  const handler = routes.get(path);
  assert.ok(handler, `page requested an unknown route: ${path}`);
  const options = {
    method: (init && init.method) || "GET",
    headers: { host: "127.0.0.1:60229", ...((init && init.headers) || {}) },
    body: init && init.body ? init.body : null,
  };
  return call(handler, options).then((result) => ({
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.body,
  }));
}

const captured = [];
const sandboxWindow = {
  __ModuleLoader__: {
    load(definition) {
      captured.push(definition);
    },
  },
  confirm: () => true,
};
vm.runInNewContext(readFileSync(join(bundleRoot, "lib/client.js"), "utf8"), {
  window: sandboxWindow,
  URL,
  console,
  fetch: fetchForRoutes,
  document: window.document,
  setTimeout,
  clearTimeout,
  queueMicrotask,
});

assert.equal(captured.length, 1, "client module registered");
const definition = captured[0];
assert.equal(definition.id, "@local/dsh-workflow-model-routing");

const clientExports = definition.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require(${name})`);
});
assert.equal(clientExports.inject.length, 1);
assert.equal(clientExports.inject[0], "slots");

const registrations = [];
const clientCtx = {
  get: () => null,
  slots: {
    inject(name, callback) {
      assert.ok(name === "settings.section" || name === "settings.section.icon");
      callback();
    },
    register(registration, component) {
      /* SlotCore.register(definition, component): the renderable is the
       * SECOND argument, stored on the entry as `.component`. */
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
const section = registrations.find((entry) => entry.name === "settings.section");
assert.equal(section.id, "subagent-roles-and-models");
assert.equal(typeof section.label(), "string");

function setControlValue(element, value) {
  const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor.set.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

await ok("the page shows the three-tab run-mode panel with no legacy role/authorized cards", async () => {
  const act = reactAct;
  const container = window.document.getElementById("root");
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(section.component));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const text = container.textContent;
  assert.match(text, /运行模式与团队路由/);
  assert.match(text, /主会话与派工控制/);
  assert.match(text, /模型与角色中心/);
  assert.match(text, /模型配置/);
  assert.equal(container.querySelectorAll(".mrs-msubtab").length, 3, "exactly three sub-tabs");
  // the legacy tree is gone: no hidden role/authorized cards
  assert.equal(container.querySelectorAll(".mrs-role").length, 0, "legacy role cards removed");
  assert.equal(container.querySelectorAll(".mrs-card .mrs-listrow").length, 0, "legacy authorized list removed");
  assert.equal(container.querySelectorAll(".mrs-roles-table").length, 0, "legacy roles table removed");
  assert.doesNotMatch(text, /验证并保存/);
  assert.doesNotMatch(text, /恢复默认角色/);
});

await ok("roles and models tabs render their cards and navigation never probes", async () => {
  const act = reactAct;
  const container = window.document.getElementById("root");
  const subTab = (label) =>
    [...container.querySelectorAll(".mrs-msubtab")].find((node) => node.textContent.includes(label));
  llm.calls.length = 0;

  await act(async () => {
    subTab("模型与角色中心").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(container.querySelector('.mrs-mroute[data-role-id]'), "role cards render on the roles tab");
  assert.ok(
    container.querySelector('.mrs-mroute[data-role-id] .mrs-mroute__model select'),
    "role model picker present",
  );

  await act(async () => {
    subTab("模型配置").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(container.querySelector(".mrs-capgrid"), "authorized model grid renders on the models tab");
  assert.ok(container.querySelector(".mrs-tierbadge"), "tier badges render on the models tab");
  assert.match(container.textContent, /恢复默认授权/, "restore-authorization button present on the models tab");

  assert.equal(llm.calls.length, 0, "tab navigation and rendering issue no model probe");
});

/* ------------------------------------------------------------------ *
 * Phase A — three-mode data layer + capability cache (offline)
 * ------------------------------------------------------------------ */

await ok("capabilities module reads the runtime efforts shape and tolerates legacy", async () => {
  const runtimeShape = { reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" } };
  assert.deepEqual(capabilities.declaredEfforts(runtimeShape), ["low", "high"]);
  assert.equal(capabilities.declaredDefaultEffort(runtimeShape), "low");
  assert.deepEqual(capabilities.effortDisplayNames(runtimeShape), { low: "Low", high: "High" });
  const legacyShape = { reasoning: { supportedEfforts: ["low", "medium"] } };
  assert.deepEqual(capabilities.declaredEfforts(legacyShape), ["low", "medium"]);
  assert.deepEqual(capabilities.declaredEfforts({ reasoning: null }), []);
});

await ok("capability effort resolution never guesses (default/fixed/smart/unknown)", async () => {
  const record = {
    status: "ok",
    detectedAt: new Date().toISOString(),
    efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
  };
  assert.equal(capabilities.resolveEffortForPolicy(record, { policy: "default" }, "high"), undefined);
  assert.equal(capabilities.resolveEffortForPolicy(record, { policy: "fixed", fixedEffort: "high" }, "low"), "high");
  assert.equal(capabilities.resolveEffortForPolicy(record, { policy: "fixed", fixedEffort: "medium" }, "low"), undefined, "undeclared fixed tier → undefined");
  assert.equal(capabilities.resolveEffortForPolicy(record, { policy: "smart", smartMap: { low: "low", medium: "low", high: "high" } }, "high"), "high");
  assert.equal(capabilities.resolveEffortForPolicy(record, { policy: "smart", smartMap: { low: "low", medium: "low", high: "low" } }, "high"), "low");
  assert.equal(capabilities.resolveEffortForPolicy(null, { policy: "fixed", fixedEffort: "high" }, "high"), undefined, "unknown capability → undefined");
  const expired = { ...record, detectedAt: new Date(Date.now() - 25 * 3600_000).toISOString() };
  assert.equal(capabilities.resolveEffortForPolicy(expired, { policy: "fixed", fixedEffort: "high" }, "high"), undefined, "expired → undefined");
});

await ok("mode presets carry the six dimensions and preserve custom roles per mode", async () => {
  const roles = [{ id: "custom-1", name: "自定义角色", primary: { provider: "deepseek-account", model: "deepseek-v4-pro" }, enabled: true, kind: "standard" }];
  const store = modes.seedModesStore({ roles });
  assert.deepEqual(Object.keys(store.modes).sort(), ["broke", "economy", "normal", "performance"]);
  assert.equal(store.currentModeId, "normal");
  for (const modeId of ["broke", "economy", "normal", "performance"]) {
    const mode = store.modes[modeId];
    assert.ok(mode.lead.provider && mode.lead.model, `${modeId} has a lead`);
    assert.equal(typeof mode.team.maxConcurrentWorkers === "number" || mode.team.maxConcurrentWorkers === null, true);
    assert.equal(typeof mode.taskTargets.native.enabled, "boolean");
    assert.equal(mode.roles.length, 15, `${modeId} seeds the 14 recommended roles plus the custom role`);
    assert.ok(mode.roles.some((role) => role.id === "custom-1"), `${modeId} preserves the custom role`);
  }
  assert.notEqual(store.modes.economy.roles, store.modes.normal.roles, "independent role copies");
  store.modes.economy.roles.find((role) => role.id === "custom-1").name = "改过的";
  assert.equal(store.modes.normal.roles.find((role) => role.id === "custom-1").name, "自定义角色", "mutating one mode never leaks to another");
});

await ok("enable-time validation refuses unauthorized or malformed modes", async () => {
  const authorized = [
    { provider: "deepseek-account", model: "deepseek-v4-pro" },
    { provider: "openai", model: "gpt-6.1-sol" },
  ];
  const mode = modes.normalizeMode("economy", {});
  mode.upgradeAdvisor.enabled = false;
  mode.roles = [{ id: "coder", name: "代码执行员", kind: "standard", enabled: true, primary: { provider: "deepseek-account", model: "deepseek-v4-pro" }, backup: null, upgrade: null }];
  mode.lead = { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default", reasoningEffort: null, smartMap: null };
  assert.deepEqual(modes.validateModeForEnable(mode, authorized), { ok: true, errors: [] });
  mode.lead = { provider: "google", model: "gemini-3-flash-preview", reasoningPolicy: "default", reasoningEffort: null, smartMap: null };
  const invalid = modes.validateModeForEnable(mode, authorized);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => /未获授权/.test(error)));
  mode.lead = { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed", reasoningEffort: null, smartMap: null };
  const noFixed = modes.validateModeForEnable(mode, authorized);
  assert.equal(noFixed.ok, false);
  assert.ok(noFixed.errors.some((error) => /fixed/.test(error)));
});

await ok("GET /modes seeds four modes and normal inherits the existing roles", async () => {
  const response = await call(routes.get(MODES), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.currentModeId, "normal");
  assert.deepEqual(Object.keys(response.body.modes).sort(), ["broke", "economy", "normal", "performance"]);
  assert.equal(response.body.modes.normal.roles.length, 14, "normal inherits the 14 existing roles");
  assert.equal(response.body.modes.normal.inheritance.from, "migrated");
  assert.ok(response.body.migration !== null, "migration record present");
  assert.ok(response.body.authorizedModels.length >= 10, "authorizedModels surfaced");
  assert.equal(response.body.persistent, true);
});

await ok("v2.5.0: performance preset uses a full smart map (high=xhigh) and a fixed xhigh advisor", async () => {
  const response = await call(routes.get(MODES), {});
  assert.equal(response.status, 200);
  const perf = response.body.modes.performance;
  assert.equal(perf.lead.reasoningPolicy, "smart");
  assert.deepEqual(perf.lead.smartMap, { low: "low", medium: "medium", high: "xhigh" });
  assert.equal(perf.upgradeAdvisor.reasoningPolicy, "fixed");
  assert.equal(perf.upgradeAdvisor.reasoningEffort, "xhigh");
  for (const id of ["economy", "normal", "performance", "broke"]) {
    assert.equal(response.body.modes[id].taskTargets.taskBoard.enabled, false, `${id} taskBoard target disabled`);
  }
});

await ok("v2.5.0: every recommended preset route is within the 10 default authorized models", async () => {
  const authorized = new Set(DEFAULT_AUTHORIZED.map((r) => `${r.provider}\u0000${r.model}`));
  const presets = modes.recommendedPresets();
  const seen = [];
  const collect = (route) => {
    if (route && route.provider && route.model) seen.push(`${route.provider}\u0000${route.model}`);
  };
  for (const id of ["economy", "normal", "performance", "broke"]) {
    const mode = presets[id];
    collect(mode.lead);
    if (mode.upgradeAdvisor && mode.upgradeAdvisor.enabled) collect(mode.upgradeAdvisor);
    for (const k of ["planner", "executor", "reviewer", "advisor"]) collect(mode.team && mode.team[k]);
    for (const role of mode.roles) {
      if (role.enabled === false) continue;
      collect(role.primary);
      collect(role.backup);
      collect(role.upgrade);
      for (const p of role.pairings || []) collect(p.reviewer);
    }
  }
  assert.ok(seen.length > 0, "presets reference routes");
  for (const route of seen) {
    assert.ok(authorized.has(route), `recommended route ${route} must be in the default authorization`);
  }
});

await ok("GET /modes?mode=economy returns a single mode", async () => {
  const response = await call(routes.get(MODES), { url: `${MODES}?mode=economy` });
  assert.equal(response.status, 200);
  assert.equal(response.body.mode.modeId, "economy");
  assert.equal(response.body.modes, undefined);
});

await ok("POST /modes/save persists a draft without enabling it", async () => {
  const before = (await call(routes.get(MODES), {})).body;
  const economy = JSON.parse(JSON.stringify(before.modes.economy));
  economy.lead.reasoningPolicy = "default";
  const response = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "economy", mode: economy } });
  assert.equal(response.status, 200);
  assert.equal(response.body.saved, true);
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.revision, 1);
  const after = (await call(routes.get(MODES), {})).body;
  assert.equal(after.currentModeId, "normal", "save does not enable");
  assert.equal(after.modes.economy.revision, 1);
});

await ok("POST /modes/enable activates after validation and records the switch", async () => {
  const response = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "economy" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.currentModeId, "economy");
  assert.equal(response.body.previousModeId, "normal");
  const after = (await call(routes.get(MODES), {})).body;
  assert.equal(after.currentModeId, "economy");
});

await ok("POST /modes/enable refuses an unauthorized mode and rolls back", async () => {
  const view = (await call(routes.get(MODES), {})).body;
  const performance = JSON.parse(JSON.stringify(view.modes.performance));
  performance.lead.provider = "google";
  performance.lead.model = "gemini-3-flash-preview";
  const saved = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "performance", mode: performance } });
  assert.equal(saved.status, 200);
  const response = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "performance" } });
  assert.equal(response.status, 422);
  assert.equal(response.body.ok, false);
  assert.ok(response.body.errors.some((error) => /未获授权/.test(error)));
  const after = (await call(routes.get(MODES), {})).body;
  assert.equal(after.currentModeId, "economy", "failed enable leaves the previous mode active");
});

await ok("POST /modes/save rejects an unknown mode id", async () => {
  const response = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "bogus", mode: {} } });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "UNKNOWN_MODE");
});

await ok("GET /capabilities is empty before a refresh and issues no model call", async () => {
  llm.calls.length = 0;
  const response = await call(routes.get(CAPABILITIES), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.empty, true);
  assert.deepEqual(response.body.records, []);
  assert.equal(llm.calls.length, 0, "read does not issue a model call");
});

await ok("POST /capabilities/refresh detects and caches without a paid request", async () => {
  llm.calls.length = 0;
  const response = await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(response.body.records.length >= 10, "one record per catalogued model");
  assert.ok(Array.isArray(response.body.invalidated));
  assert.ok(Array.isArray(response.body.narrowed));
  assert.ok(Array.isArray(response.body.dropped));
  assert.equal(llm.calls.length, 0, "refresh reads adapter metadata only, never streams");
  const deepseekPro = response.body.records.find((row) => row.provider === "deepseek-account" && row.model === "deepseek-v4-pro");
  assert.ok(deepseekPro, "record for a known model");
  assert.equal(deepseekPro.source, "catalog");
  assert.equal(deepseekPro.configSource, "declared");
  assert.equal(deepseekPro.status, "ok");
  assert.equal(deepseekPro.adapterVersion, null, "adapter version is not exposed by the runtime contract");
  assert.equal(deepseekPro.canDisableThinking, null, "canDisableThinking is not exposed by the runtime contract");
  assert.equal(typeof deepseekPro.fingerprint, "string");
  assert.ok(deepseekPro.fingerprint.length >= 32, "fingerprint is a sha256 hex");
  assert.ok(deepseekPro.efforts.some((effort) => effort.id === "high"));
  const read = await call(routes.get(CAPABILITIES), {});
  assert.equal(read.body.empty, false);
  assert.equal(read.body.records.length, response.body.records.length);
  assert.ok(read.body.records.every((row) => typeof row.effectiveStatus === "string"));
});

await ok("capability fingerprint hashes non-secret identity and changes with it", async () => {
  const provider = { id: "deepseek-account", name: "DeepSeek" };
  const entry = {
    provider: "deepseek-account",
    defaultBaseURL: "https://api.deepseek.com/v1",
    baseURLEnv: ["DEEPSEEK_BASE_URL"],
    nativeAuth: { env: ["DEEPSEEK_API_KEY"], oauth: false },
  };
  const source = capabilities.fingerprintSource(provider, entry);
  const text = JSON.stringify(source);
  assert.ok(text.includes("DEEPSEEK_API_KEY"), "env NAME (never the value) is part of the fingerprint");
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(text), "no credential value is ever read");
  const first = capabilities.providerFingerprint(provider, entry);
  assert.notEqual(first, capabilities.providerFingerprint({ ...provider, name: "Renamed" }, entry));
  assert.notEqual(first, capabilities.providerFingerprint(provider, { ...entry, baseURLEnv: ["OTHER"] }));
});

await ok("role dispatch fails explicitly when no spawn provider is registered", async () => {
  const tool = toolDefinitions[0];
  sessions.set("session-ok", {
    snapshotEvents: () => [
      { type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } },
    ],
  });
  subagentSpawnState = null;
  const before = activations.length;
  try {
    await assert.rejects(
      () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-ok" }, signal: undefined }),
      /没有已注册的子代理 provider/,
    );
    assert.equal(activations.length, before, "no activation when spawn is missing");
  } finally {
    subagentSpawnState = { agentOptions: true };
  }
});

await ok("role dispatch fails explicitly when spawn lacks agentOptions", async () => {
  const tool = toolDefinitions[0];
  sessions.set("session-ok", {
    snapshotEvents: () => [
      { type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } },
    ],
  });
  subagentSpawnState = { agentOptions: false };
  const before = activations.length;
  try {
    await assert.rejects(
      () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-ok" }, signal: undefined }),
      /不支持显式模型路由/,
    );
    assert.equal(activations.length, before, "no activation when agentOptions is unsupported");
  } finally {
    subagentSpawnState = { agentOptions: true };
  }
});

await ok("mode reasoning config round-trips flat and accepts the legacy shape", async () => {
  const legacy = modes.normalizeMode("economy", {
    lead: { provider: "openai", model: "gpt-6.1-sol", policy: "fixed", fixedEffort: "high" },
  });
  assert.equal(legacy.lead.reasoningPolicy, "fixed");
  assert.equal(legacy.lead.reasoningEffort, "high");
  const bare = modes.normalizeMode("economy", {
    lead: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "medium" },
  });
  assert.equal(bare.lead.reasoningPolicy, "fixed", "a bare reasoningEffort is an implicit fixed tier");
  assert.equal(bare.lead.reasoningEffort, "medium");
  const flat = modes.normalizeMode("economy", {
    lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", smartMap: { low: "low", medium: "medium", high: null } },
  });
  assert.equal(flat.lead.reasoningPolicy, "smart");
  assert.deepEqual(flat.lead.smartMap, { low: "low", medium: "medium", high: null }, "missing smart tier stays null, never guessed");
});

await ok("enable validation checks every referenced position against declared efforts", async () => {
  const authorized = [
    { provider: "deepseek-account", model: "deepseek-v4-pro" },
    { provider: "openai", model: "gpt-6.1-sol" },
  ];
  const capabilityFor = (provider, model) =>
    provider === "openai" && model === "gpt-6.1-sol"
      ? { status: "ok", efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] }
      : undefined;
  const mode = modes.normalizeMode("economy", {});
  mode.upgradeAdvisor.enabled = false;
  mode.roles = [];
  mode.team = { planner: null, executor: null, reviewer: null, advisor: null, maxConcurrentWorkers: null, writeScopeIsolation: true, failureRetryLimit: null, escalationThreshold: null, budgetLimit: null };
  mode.lead = { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed", reasoningEffort: "medium", smartMap: null };
  const fixedBad = modes.validateModeForEnable(mode, { authorizedModels: authorized, capabilityFor });
  assert.equal(fixedBad.ok, false);
  assert.ok(fixedBad.errors.some((error) => /medium/.test(error)), "an undeclared fixed tier is blocked");
  mode.lead = { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "fixed", reasoningEffort: "high", smartMap: null };
  assert.equal(modes.validateModeForEnable(mode, { authorizedModels: authorized, capabilityFor }).ok, true, "a declared fixed tier passes");
  mode.lead = { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "smart", reasoningEffort: null, smartMap: { low: "low", medium: "medium", high: "high" } };
  const smartBad = modes.validateModeForEnable(mode, { authorizedModels: authorized, capabilityFor });
  assert.equal(smartBad.ok, false);
  assert.ok(smartBad.errors.some((error) => /medium/.test(error)), "a smart mapping outside declared efforts is blocked");
  const unknown = modes.validateModeForEnable(mode, { authorizedModels: authorized, capabilityFor: () => undefined });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((error) => /能力未检测或已过期/.test(error)), "an unknown capability blocks a fixed/smart position");
});

await ok("POST /modes/save and /modes/enable reject a stale expectedRevision", async () => {
  const view = (await call(routes.get(MODES), {})).body;
  const economy = JSON.parse(JSON.stringify(view.modes.economy));
  const saveConflict = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "economy", mode: economy, expectedRevision: 9999 } });
  assert.equal(saveConflict.status, 409);
  assert.equal(saveConflict.body.error, "mode-save-conflict");
  const enableConflict = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "economy", expectedRevision: 9999 } });
  assert.equal(enableConflict.status, 409);
  assert.equal(enableConflict.body.error, "mode-enable-conflict");
});

await ok("the enabled mode is snapshotted so later drafts cannot mutate it", async () => {
  const view = (await call(routes.get(MODES), {})).body;
  assert.equal(view.currentModeId, "economy");
  const snapshot = view.activeSnapshot;
  assert.ok(snapshot !== null && typeof snapshot === "object", "activeSnapshot surfaced");
  assert.equal(snapshot.modeId, "economy");
  assert.equal(snapshot.config.modeId, "economy");
  assert.ok(typeof snapshot.enabledAt === "string");
});

await ok("mode store file survives a fresh disk read (write/read round-trip)", async () => {
  const view = (await call(routes.get(MODES), {})).body;
  const economy = JSON.parse(JSON.stringify(view.modes.economy));
  const saved = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "economy", mode: economy, expectedRevision: economy.revision } });
  assert.equal(saved.status, 200);
  const modesFile = join(scratch, "dsh-economy-mode.state.json");
  const raw = await fs.readFile(modesFile, "utf8");
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.modes.economy.revision, saved.body.revision);
  const reloaded = await modes.readModesFile(modesFile);
  assert.equal(reloaded.modes.economy.revision, onDisk.modes.economy.revision);
  assert.equal(reloaded.modes.economy.lead.reasoningPolicy, onDisk.modes.economy.lead.reasoningPolicy);
});

await ok("capability cache degrades to invalidated when the endpoint fingerprint changes", async () => {
  await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  const before = (await call(routes.get(CAPABILITIES), {})).body;
  const deepseekRecord = before.records.find((row) => row.provider === "deepseek-account");
  assert.equal(deepseekRecord.effectiveStatus, "ok");
  llm.configurableState.find((entry) => entry.provider === "deepseek-account").defaultBaseURL = "https://changed.example.com/v1";
  try {
    const after = (await call(routes.get(CAPABILITIES), {})).body;
    const changed = after.records.find((row) => row.provider === "deepseek-account");
    assert.equal(changed.effectiveStatus, "invalidated", "a fingerprint change invalidates the cached record on read");
  } finally {
    llm.configurableState.find((entry) => entry.provider === "deepseek-account").defaultBaseURL = "https://api.deepseek.com/v1";
  }
});

await ok("backupExistingStore never reports a phantom backup path on failure", async () => {
  assert.equal(await modes.backupExistingStore(join(scratch, "does-not-exist.state.json")), null, "missing source → no migration record, no phantom backup");
});

/* ------------------------------------------------------------------ *
 * phase-C: execution wiring (offline, no real model calls)
 * ------------------------------------------------------------------ */

await ok("phase-C: enable persists the lead default via agentDefaultModel.saveSelection", async () => {
  assert.equal(leadSelections.length, 1, "the economy enable called saveSelection once");
  assert.equal(leadSelections[0].provider, "openai");
  assert.equal(leadSelections[0].model, "gpt-6.1-sol");
  assert.equal(leadSelections[0].reasoningEffort, null, "default policy → no fixed effort");
});

await ok("phase-C: enable rolls back to the prior mode when saveSelection fails", async () => {
  const before = (await call(routes.get(MODES), {})).body;
  const normal = JSON.parse(JSON.stringify(before.modes.normal));
  leadSelectionFailuresRemaining = 1;
  try {
    const res = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "normal", expectedRevision: normal.revision } });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, "lead-default-failed");
    const after = (await call(routes.get(MODES), {})).body;
    assert.equal(after.currentModeId, before.currentModeId, "active mode unchanged after failed enable");
    assert.equal(leadSelections.length, 2, "the failed enable restored (re-persisted) the prior selection");
    assert.equal(leadSelections[1].provider, "openai", "restored the prior lead, not a new enable");
  } finally {
    leadSelectionFailuresRemaining = 0;
  }
});

await ok("phase-C: enable reports inconsistency when save and restore both fail", async () => {
  const before = (await call(routes.get(MODES), {})).body;
  const normal = JSON.parse(JSON.stringify(before.modes.normal));
  leadSelectionFailuresRemaining = 2;
  try {
    const res = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "normal", expectedRevision: normal.revision } });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "inconsistent");
    const after = (await call(routes.get(MODES), {})).body;
    assert.equal(after.currentModeId, before.currentModeId, "active mode unchanged after inconsistent enable");
  } finally {
    leadSelectionFailuresRemaining = 0;
  }
});

await ok("phase-C: agent/created freezes the active snapshot for the new session", async () => {
  execution.clearSessionSnapshots();
  const listener = listeners.get("agent/created");
  assert.equal(typeof listener, "function");
  await listener({ agent: { id: "session-frozen" }, source: "startup" });
  assert.equal(execution.snapshotCount(), 1, "one session snapshot frozen");
  const snap = execution.readSessionSnapshot("session-frozen");
  assert.ok(snap !== null && snap !== undefined);
  assert.equal(snap.modeId, "economy", "frozen snapshot matches the active mode");
  assert.equal(snap.modeRevision, snap.config.revision);
  execution.clearSessionSnapshots();
});

await ok("phase-C: a mode switch only affects subsequent sessions", async () => {
  execution.clearDispatches();
  await listeners.get("agent/created")({ agent: { id: "session-freeze-economy" }, source: "startup" });
  const view = (await call(routes.get(MODES), {})).body;
  const normal = JSON.parse(JSON.stringify(view.modes.normal));
  const enabled = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "normal", expectedRevision: normal.revision } });
  assert.equal(enabled.status, 200);
  const tool = toolDefinitions[0];
  const policy = {
    snapshotEvents: () => [{ type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } }],
  };
  sessions.set("session-freeze-economy", policy);
  const frozen = await tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-freeze-economy" }, signal: undefined });
  assert.equal(frozen.modeId, "economy", "frozen session keeps its enabled-mode snapshot");
  sessions.set("session-new-normal", policy);
  const fresh = await tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-new-normal" }, signal: undefined });
  assert.equal(fresh.modeId, "normal", "a new session adopts the newly enabled mode");
  execution.clearSessionSnapshots();
  execution.clearDispatches();
});

await ok("phase-C: plugin-scoped concurrency limit is enforced", async () => {
  // The active mode is "normal" with maxConcurrentWorkers=2. Pre-fill two
  // tracked dispatches so the next one hits the limit before startActivation.
  execution.clearDispatches();
  execution.trackDispatch("busy-1", { roleId: "coder", roleName: "代码执行员", modeId: "normal" });
  execution.trackDispatch("busy-2", { roleId: "coder", roleName: "代码执行员", modeId: "normal" });
  sessions.set("session-conc", {
    snapshotEvents: () => [{ type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } }],
  });
  const tool = toolDefinitions[0];
  const before = activations.length;
  await assert.rejects(
    () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-conc" }, signal: undefined }),
    /团队并发上限/,
  );
  assert.equal(activations.length, before, "no activation when at the concurrency limit");
  execution.clearDispatches();
});

await ok("phase-C: taskBoard target is rejected (no real business service, no fabricated success)", async () => {
  sessions.set("session-tb", {
    snapshotEvents: () => [{ type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } }],
  });
  const tool = toolDefinitions[0];
  const tasksBefore = teamTasks.length;
  const nativeBefore = activations.length;
  await assert.rejects(
    () => tool.execute(
      { roleId: "coder", prompt: "跨会话任务", description: "团队任务", target: "taskBoard" },
      { agent: { id: "session-tb" }, signal: undefined },
    ),
    /任务板独立会话执行目标不受支持/,
  );
  assert.equal(teamTasks.length, tasksBefore, "no team task fabricated");
  assert.equal(activations.length, nativeBefore, "no native activation fabricated");
  execution.clearDispatches();
});

await ok("phase-C: GET /execution-integration reports wired scope and advisory boundaries", async () => {
  const res = await call(routes.get(EXECUTION_INTEGRATION), {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.leadDefault.wired, true, "agentDefaultModel wired");
  assert.equal(res.body.nativeDispatch.wired, true);
  assert.equal(res.body.sessionSnapshot.wired, true);
  assert.equal(res.body.taskBoard.wired, false, "taskBoard not wired (shared TODO ledger only)");
  assert.ok(
    res.body.unsupported.some((s) => /任务板|task_board|taskBoard/.test(s)),
    "task_board unsupported is listed",
  );
  assert.equal(typeof res.body.advisory.concurrency, "string");
  assert.equal(typeof res.body.advisory.budget, "string");
  assert.ok(Array.isArray(res.body.unsupported));
});

await ok("phase-C: native execution target disabled is rejected", async () => {
  const view = (await call(routes.get(MODES), {})).body;
  const normal = JSON.parse(JSON.stringify(view.modes.normal));
  normal.taskTargets.native.enabled = false;
  const saved = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "normal", mode: normal, expectedRevision: normal.revision } });
  assert.equal(saved.status, 200);
  const enabled = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "normal", expectedRevision: saved.body.revision } });
  assert.equal(enabled.status, 200);
  sessions.set("session-native-off", {
    snapshotEvents: () => [{ type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } }],
  });
  const tool = toolDefinitions[0];
  const before = activations.length;
  await assert.rejects(
    () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-native-off" }, signal: undefined }),
    /当前模式未启用原生执行目标/,
  );
  assert.equal(activations.length, before, "no activation when the native target is disabled");
  const view2 = (await call(routes.get(MODES), {})).body;
  const normal2 = JSON.parse(JSON.stringify(view2.modes.normal));
  normal2.taskTargets.native.enabled = true;
  const saved2 = await call(routes.get(MODE_SAVE), { method: "POST", body: { modeId: "normal", mode: normal2, expectedRevision: normal2.revision } });
  assert.equal(saved2.status, 200);
  const restored = await call(routes.get(MODE_ENABLE), { method: "POST", body: { modeId: "normal", expectedRevision: saved2.body.revision } });
  assert.equal(restored.status, 200);
  execution.clearDispatches();
});

await ok("phase-C: a pending reservation blocks dispatch before the startActivation await", async () => {
  execution.clearDispatches();
  execution.trackDispatch("busy-active", { roleId: "coder", roleName: "代码执行员", modeId: "normal" });
  const pendingToken = execution.reserveDispatch(2, { roleId: "coder", roleName: "代码执行员", modeId: "normal" });
  assert.ok(pendingToken, "one pending reservation acquired");
  assert.equal(execution.pendingReservationCount(), 1);
  sessions.set("session-pending", {
    snapshotEvents: () => [{ type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } }],
  });
  const tool = toolDefinitions[0];
  const before = activations.length;
  await assert.rejects(
    () => tool.execute({ roleId: "coder", prompt: "hi" }, { agent: { id: "session-pending" }, signal: undefined }),
    /团队并发上限/,
  );
  assert.equal(activations.length, before, "no activation while a reservation is pending");
  execution.releaseReservation(pendingToken);
  assert.equal(execution.pendingReservationCount(), 0);
  execution.clearDispatches();
});

await ok("phase-C: capability cache generation bump marks records stale on read", async () => {
  await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  const listener = listeners.get("settings/document-updated");
  assert.equal(typeof listener, "function");
  const filtered = await listener("include:subagent-model-selection-settings", 99);
  assert.equal(filtered, undefined, "self ns is filtered out (no invalidation)");
  await listener("some.other.namespace", 42);
  const after = (await call(routes.get(CAPABILITIES), {})).body;
  const stale = (after.records ?? []).filter((r) => r.effectiveStatus === "stale");
  assert.ok(stale.length > 0, "records now read as stale after a generation bump");
});

// --- task-7: final audit — compensation failure + capability fail-closed ---

await ok("phase-C audit: enable rejects before any change when the prior lead read fails", async () => {
  const before = (await call(routes.get(MODES), {})).body;
  const prevModeId = before.currentModeId;
  const leadBefore = leadSelections.length;
  leadReadFailuresRemaining = 1;
  const res = await call(routes.get(MODE_ENABLE), {
    method: "POST",
    body: { modeId: "economy", expectedRevision: before.modes.economy.revision },
  });
  leadReadFailuresRemaining = 0;
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "lead-read-failed");
  assert.equal(leadSelections.length, leadBefore, "no saveSelection when the prior read fails");
  const after = (await call(routes.get(MODES), {})).body;
  assert.equal(after.currentModeId, prevModeId, "active mode unchanged (no change applied)");
});

await ok("phase-C audit: enable returns 502 and restores lead when the modes write fails", async () => {
  const before = (await call(routes.get(MODES), {})).body;
  const prevModeId = before.currentModeId;
  const leadBefore = leadSelections.length;
  host.__setTestFaults({ modesWrite: 1 });
  const res = await call(routes.get(MODE_ENABLE), {
    method: "POST",
    body: { modeId: "economy", expectedRevision: before.modes.economy.revision },
  });
  host.__setTestFaults(null);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "mode-write-failed");
  assert.equal(leadSelections.length, leadBefore + 2, "saveSelection then restore both fired");
  const after = (await call(routes.get(MODES), {})).body;
  assert.equal(after.currentModeId, prevModeId, "active mode rolled back");
});

await ok("phase-C audit: enable reports inconsistency when modes write AND rollback both fail", async () => {
  const before = (await call(routes.get(MODES), {})).body;
  const prevModeId = before.currentModeId;
  host.__setTestFaults({ modesWrite: 2 });
  const res = await call(routes.get(MODE_ENABLE), {
    method: "POST",
    body: { modeId: "economy", expectedRevision: before.modes.economy.revision },
  });
  host.__setTestFaults(null);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "inconsistent");
  assert.match(res.body.message, /补偿未完全成功/);
  const after = (await call(routes.get(MODES), {})).body;
  assert.equal(after.currentModeId, prevModeId, "disk still holds the pre-enable mode");
});

await ok("phase-C audit: a failed capability invalidation still fails closed (no resurrection)", async () => {
  await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  const before = (await call(routes.get(CAPABILITIES), {})).body;
  assert.ok((before.records ?? []).length > 0, "records present before the failed invalidation");
  host.__setTestFaults({ capabilitiesWrite: 1 });
  await listeners.get("llm/models-updated")();
  host.__setTestFaults(null);
  const after = (await call(routes.get(CAPABILITIES), {})).body;
  assert.ok((after.records ?? []).length > 0, "records still present (read from disk)");
  assert.ok(
    (after.records ?? []).every((r) => r.effectiveStatus !== "ok"),
    "no record reads ok after a failed invalidation (memory barrier holds)",
  );
  assert.ok(
    (after.records ?? []).some((r) => r.effectiveStatus === "stale"),
    "records read stale after a failed invalidation",
  );
});

await ok("phase-C audit: capability refresh write failure does not resurrect old records", async () => {
  await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  const before = (await call(routes.get(CAPABILITIES), {})).body;
  assert.ok(
    (before.records ?? []).every((r) => r.effectiveStatus === "ok"),
    "a fresh refresh reads ok before the injected fault",
  );
  host.__setTestFaults({ capabilitiesWrite: 1 });
  const res = await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  host.__setTestFaults(null);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "capabilities-refresh-write-failed");
  const after = (await call(routes.get(CAPABILITIES), {})).body;
  assert.ok(
    (after.records ?? []).every((r) => r.effectiveStatus !== "ok"),
    "no record reads ok after a failed refresh write (memory barrier holds)",
  );
});

await ok("phase-C audit: concurrent refresh and invalidation do not corrupt the cache", async () => {
  await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  const invalidate = listeners.get("llm/adapters-updated")();
  const refresh = call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  await Promise.all([invalidate, refresh]);
  // A clean refresh after the serialized pair must recover to all-ok: this
  // proves the capability write lock prevented a torn generation/records state.
  const recover = await call(routes.get(CAPABILITIES_REFRESH), { method: "POST", body: {} });
  assert.equal(recover.status, 200);
  const after = (await call(routes.get(CAPABILITIES), {})).body;
  assert.ok(
    (after.records ?? []).every((r) => r.effectiveStatus === "ok"),
    "a clean refresh after concurrent invalidate+refresh recovers to all-ok",
  );
});



await ok("v2.6.0: tiers are advisory badges only (no broke eligibility gating)", async () => {
  assert.equal(tiers.classifyRouteTier("deepseek-account", "deepseek-v4-pro").tierId, "broke");
  assert.equal(tiers.classifyRouteTier("moonshotai", "k3").tierId, "economy");
  assert.equal(tiers.classifyRouteTier("openai", "gpt-6.1-sol").tierId, "normal");
  assert.equal(tiers.classifyRouteTier("openai", "gpt-6-astra").tierId, "performance");
  assert.equal(tiers.classifyRouteTier("openai", "gpt-5.3-codex").tierId, "normal");
  assert.equal(tiers.classifyRouteTier("google", "gemini-3.1-pro-preview").tierId, "normal");
  // v2.6.0: the classifier only returns tierId + badge — no selection gating.
  assert.equal(tiers.classifyRouteTier("openai", "gpt-6.1-sol").brokeSelectable, undefined);
  assert.equal(tiers.isBrokeAllowedRoute, undefined, "isBrokeAllowedRoute is gone");
});

await ok("v2.3.0: loadModelTiers returns four tiers and tolerates a missing source", async () => {
  const result = await tiers.loadModelTiers({
    authorizedModels: [{ provider: "openai", model: "gpt-6.1-sol" }],
    sourcePath: join(scratch, "no-such-tiers.md"),
  });
  assert.equal(result.tiers.length, 4);
  assert.ok(result.tiers.some((t) => t.id === "broke"));
  assert.equal(result.source.note, "file not found; using built-in fallback tiers");
  assert.equal(result.modelTierMap["openai/gpt-6.1-sol"].tierId, "normal");
  const unconfigured = await tiers.loadModelTiers({ sourcePath: "" });
  assert.equal(unconfigured.source.note, "not configured; using built-in fallback tiers");
});

await ok("v2.6.0: canonicalizeModeDisplay fixes misplaced label/description but preserves revision/updatedAt/routes", async () => {
  const routes = [
    { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
    { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
  ];
  const input = {
    modeId: "broke",
    label: "错误标签",
    description: "旧版：穷鬼模式禁用所有升级",
    interpretation: { summary: "旧版：只能选 deepseek，其他一律禁用！", quip: "吃土去" },
    revision: 7,
    updatedAt: "2026-11-15T05:00:00.000Z",
    lead: { provider: "openai", model: "gpt-6.1-sol" },
    roles: [],
    team: {},
    taskTargets: {},
    routes,
  };
  const out = modes.canonicalizeModeDisplay(input);
  assert.equal(out.label, "穷鬼");
  assert.equal(out.description, "穷鬼：极限节约成本，优先低开销模型。这是成本偏好，不禁用任何已授权模型。");
  assert.equal(out.interpretation.summary, "🔴 穷鬼：极限节约成本，优先低开销模型（偏好，非禁用）。");
  assert.equal(out.interpretation.quip, null);
  assert.equal(out.revision, 7, "revision preserved");
  assert.equal(out.updatedAt, "2026-11-15T05:00:00.000Z", "updatedAt preserved");
  assert.equal(out.routes, routes, "routes identity preserved (read-only display fix)");
  assert.equal(out.lead.provider, "openai", "lead route preserved");
});

await ok("v2.6.0: legacy advisor-condition sentinel 吃土去 is normalized (custom conditions preserved)", async () => {
  assert.equal(modes.normalizeAdvisorCondition("吃土去"), "极限节约时默认关闭，可按需开启");
  assert.equal(modes.normalizeAdvisorCondition("  吃土去  "), "极限节约时默认关闭，可按需开启", "whitespace tolerated");
  assert.equal(modes.normalizeAdvisorCondition("自定义条件"), "自定义条件", "custom preserved verbatim");
  assert.equal(modes.normalizeAdvisorCondition(""), "", "empty preserved");
  assert.equal(modes.normalizeAdvisorCondition(undefined), undefined, "non-string preserved");

  const routes = [{ provider: "openai", model: "gpt-6.1-sol" }];
  const input = {
    modeId: "broke",
    label: "穷鬼",
    description: "穷鬼：极限节约成本，优先低开销模型。这是成本偏好，不禁用任何已授权模型。",
    revision: 3,
    updatedAt: "2026-11-16T00:00:00.000Z",
    upgradeAdvisor: { enabled: false, provider: null, model: null, condition: "吃土去" },
    routes,
  };
  const out = modes.canonicalizeModeDisplay(input);
  assert.equal(out.upgradeAdvisor.condition, "极限节约时默认关闭，可按需开启", "sentinel replaced");
  assert.equal(out.upgradeAdvisor.provider, null, "advisor route untouched");
  assert.equal(out.upgradeAdvisor.enabled, false, "advisor enabled flag untouched");
  assert.equal(out.revision, 3, "revision preserved");
  assert.equal(out.updatedAt, "2026-11-16T00:00:00.000Z", "updatedAt preserved");
  assert.equal(out.routes, routes, "routes identity preserved");
});

await ok("v2.6.0: buildCatalog dedups providers and models by exact key, merges metadata, warns, and never merges across providers", async () => {
  host.__resetCatalogCache();
  const dupLlm = {
    listProviders() {
      return [
        { id: "openai", name: "OpenAI" },
        { id: "openai", name: "OpenAI (dup)" },
        { id: "moonshotai", name: "Moonshot" },
      ];
    },
    async listModels(providerId) {
      if (providerId === "openai") {
        return [
          { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
          { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "richer", badge: "旗舰" },
          { id: "codex", name: "Codex" },
        ];
      }
      if (providerId === "moonshotai") {
        return [{ id: "k3", name: "Kimi K3" }];
      }
      return [];
    },
    async resolveModelInfo() {
      return null;
    },
  };
  const result = await host.buildCatalog(dupLlm);
  assert.equal(result.providers.length, 2, "duplicate provider merged, not cross-merged");
  const openai = result.providers.find((p) => p.id === "openai");
  const moonshot = result.providers.find((p) => p.id === "moonshotai");
  assert.ok(openai, "openai present");
  assert.ok(moonshot, "moonshotai present");
  const sol = openai.models.find((m) => m.id === "gpt-6.1-sol");
  assert.ok(sol, "gpt-6.1-sol present");
  assert.equal(openai.models.filter((m) => m.id === "gpt-6.1-sol").length, 1, "model deduped");
  assert.equal(sol.description, "richer", "richer metadata merged");
  assert.equal(sol.badge, "旗舰", "extra metadata merged");
  assert.equal(openai.models.length, 2, "gpt-6.1-sol + codex");
  assert.ok(moonshot.models.some((m) => m.id === "k3"), "cross-provider model isolated");
  assert.equal(moonshot.models.some((m) => m.id === "gpt-6.1-sol"), false, "no cross-provider bleed");
  const warnings = result.warnings ?? [];
  assert.ok(warnings.includes("provider openai 模型 gpt-6.1-sol 重复，已合并元数据"), "model-dup warning");
  assert.ok(warnings.includes("provider openai 重复出现，已合并模型列表"), "provider-dup warning");
  host.__resetCatalogCache();
});

await ok("brokePreset is free-choice: keeps user routes and uses a neutral advisor condition", async () => {
  const roles = [
    { id: "secretary", name: "秘书", kind: "standard", enabled: true, primary: { provider: "openai", model: "gpt-6.1-sol" }, backup: null, upgrade: { provider: "openai", model: "gpt-6-astra" } },
    { id: "vision", name: "视觉", kind: "standard", enabled: true, primary: { provider: "google", model: "gemini-3.1-pro-preview" }, backup: null, upgrade: null },
    { id: "coder", name: "编码", kind: "standard", enabled: true, primary: { provider: "openai", model: "gpt-6.1-sol" }, backup: null, upgrade: null },
    { id: "reviewer", name: "复核", kind: "reviewer", enabled: true, primary: null, pairings: [{ authorProviders: ["openai"], reviewer: { provider: "openai", model: "gpt-6.1-sol" } }] },
  ];
  const broke = modes.brokePreset(roles);
  assert.equal(broke.lead.provider, "deepseek-account");
  assert.equal(broke.lead.model, "deepseek-v4-pro");
  assert.equal(broke.upgradeAdvisor.enabled, false);
  assert.equal(broke.upgradeAdvisor.provider, null);
  assert.equal(broke.upgradeAdvisor.model, null);
  assert.equal(broke.upgradeAdvisor.condition, "极限节约时默认关闭，可按需开启");
  assert.equal(broke.team.advisor, null);
  assert.equal(broke.team.escalationThreshold, null);
  const secretary = broke.roles.find((r) => r.id === "secretary");
  assert.equal(secretary.primary.provider, "openai", "secretary route preserved");
  assert.equal(secretary.primary.model, "gpt-6.1-sol");
  assert.equal(secretary.upgrade.provider, "openai", "secretary upgrade preserved");
  assert.equal(secretary.upgrade.model, "gpt-6-astra");
  const vision = broke.roles.find((r) => r.id === "vision");
  assert.equal(vision.primary.provider, "google", "vision route preserved");
  const coder = broke.roles.find((r) => r.id === "coder");
  assert.equal(coder.primary.provider, "openai", "coder route preserved");
  const reviewer = broke.roles.find((r) => r.id === "reviewer");
  assert.equal(reviewer.pairings[0].reviewer.provider, "openai", "reviewer pairing preserved");
  assert.equal(reviewer.pairings[0].reviewer.model, "gpt-6.1-sol");
});

await ok("normalizeMode preserves broke routes (no forced clear)", async () => {
  const mode = modes.normalizeMode("broke", {
    lead: { provider: "openai", model: "gpt-6-astra" },
    upgradeAdvisor: { enabled: true, provider: "openai", model: "gpt-6-astra" },
    roles: [{ id: "coder", name: "编码", kind: "standard", enabled: true, primary: { provider: "openai", model: "gpt-6.1-sol" }, upgrade: { provider: "openai", model: "gpt-6-astra" } }],
  });
  assert.equal(mode.upgradeAdvisor.enabled, true, "advisor stays enabled");
  assert.equal(mode.upgradeAdvisor.provider, "openai");
  assert.equal(mode.upgradeAdvisor.model, "gpt-6-astra");
  assert.equal(mode.roles[0].upgrade.provider, "openai", "role upgrade preserved");
  assert.equal(mode.roles[0].upgrade.model, "gpt-6-astra");
  assert.equal(mode.label, "穷鬼", "canonical label has no 模式 suffix");
});

await ok("validateModeForEnable keeps general auth validation but no longer blocks broke upgrades/high-value models", async () => {
  const authorized = [
    { provider: "deepseek-account", model: "deepseek-v4-pro" },
    { provider: "deepseek-account", model: "deepseek-flash" },
    { provider: "deepseek-account-vision", model: "deepseek-v4-pro" },
    { provider: "openai", model: "gpt-6-astra" },
  ];
  const broke = modes.brokePreset([]);
  broke.roles = [];
  assert.deepEqual(modes.validateModeForEnable(broke, authorized), { ok: true, errors: [] });
  broke.upgradeAdvisor = { enabled: true, provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default", reasoningEffort: null, smartMap: null, condition: "" };
  const upgradeErr = modes.validateModeForEnable(broke, authorized);
  assert.equal(upgradeErr.ok, true, "authorized broke upgrade is now allowed (no BROKE_UPGRADE_FORBIDDEN)");
  assert.ok(!upgradeErr.errors.some((e) => e.code === "BROKE_UPGRADE_FORBIDDEN"));
  broke.lead = { provider: "openai", model: "gpt-6-astra", reasoningPolicy: "default", reasoningEffort: null, smartMap: null };
  const leadErr = modes.validateModeForEnable(broke, authorized);
  assert.equal(leadErr.ok, true, "authorized high-value broke lead is now allowed (no BROKE_HIGH_VALUE_FORBIDDEN)");
  assert.ok(!leadErr.errors.some((e) => e.code === "BROKE_HIGH_VALUE_FORBIDDEN"));
  // General auth validation is still effective: an unauthorized route is refused.
  broke.lead = { provider: "kimi-subscription", model: "k3", reasoningPolicy: "default", reasoningEffort: null, smartMap: null };
  const unauthErr = modes.validateModeForEnable(broke, authorized);
  assert.equal(unauthErr.ok, false, "unauthorized route still refused");
  assert.ok(unauthErr.errors.length > 0);
});

await ok("v2.3.0: ensureAllModes backfills a missing broke mode", async () => {
  const store = modes.seedModesStore({ roles: [] });
  delete store.modes.broke;
  const filled = modes.ensureAllModes(store);
  assert.ok(filled.modes.broke, "broke mode backfilled");
  assert.deepEqual(filled.filledModes, ["broke"]);
  assert.equal(filled.modes.broke.lead.model, "deepseek-v4-pro");
});

await ok("GET /tiers returns four tiers for the authorized set", async () => {
  const response = await call(routes.get(TIERS_ROUTE), {});
  assert.equal(response.status, 200);
  assert.equal(response.body.tiers.length, 4);
  assert.ok(response.body.tiers.some((t) => t.id === "broke"));
  assert.ok(typeof response.body.modelTierMap === "object");
});

await ok("POST /tiers/refresh re-reads the tier plan", async () => {
  const response = await call(routes.get(TIERS_REFRESH), { method: "POST", body: {} });
  assert.equal(response.status, 200);
  assert.equal(response.body.tiers.length, 4);
});

await ok("GET /modes surfaces interpretations, version and changelog", async () => {
  const response = await call(routes.get(MODES), {});
  assert.equal(response.body.version, "2.6.4");
  assert.ok(Array.isArray(response.body.changelog) && response.body.changelog.length >= 6);
  assert.equal(response.body.interpretations.broke.quip, null);
  assert.ok(response.body.modes.broke.interpretation, "broke mode carries an interpretation");
});


const MIGRATE = "/plugins/dsh-workflow-model-routing/migrate-deployment-routes";
let migrationDry;
await ok("v2.6.3: vision executor is rejected before stream/enqueue", async () => {
  const n=llm.calls.length;
  const r=await call(routes.get(AI_JOBS),{method:"POST",body:{operation:"configure",provider:"deepseek-account-vision",model:"deepseek-v4-pro",requestId:"no-vision"}});
  assert.equal(r.status,400); assert.equal(r.body.error,"vision-executor-forbidden"); assert.equal(llm.calls.length,n);
});
await ok("v2.6.3: migration dry-run reads disk and preserves custom nested routes", async () => {
  const roleFile=storeFileJson() ?? { version:3, revision:3, roles:DEFAULTS, authorizedModels:DEFAULT_AUTHORIZED }; roleFile.customMigrationField={foo:"keep",nested:{provider:"deepseek-account-vision",model:"deepseek-v4-pro"}};
  await fs.writeFile(STORE_FILE,JSON.stringify(roleFile));
  const before=await fs.readFile(STORE_FILE,"utf8"), n=llm.calls.length;
  migrationDry=await call(routes.get(MIGRATE),{method:"POST",body:{}});
  assert.equal(migrationDry.status,200,JSON.stringify(migrationDry.body)); assert.ok(migrationDry.body.expected.storeHash);
  assert.equal(await fs.readFile(STORE_FILE,"utf8"),before); assert.equal(llm.calls.length,n);
  assert.ok(migrationDry.body.plan.roles.migrated.some(r=>r.position.includes("customMigrationField")));
});
await ok("v2.6.3: migration requires complete CAS including active snapshot content", async () => {
  let r=await call(routes.get(MIGRATE),{method:"POST",body:{apply:true}}); assert.equal(r.status,409);
  const file=join(scratch,modes.MODES_FILE), orig=await fs.readFile(file,"utf8"), payload=JSON.parse(orig);
  payload.activeSnapshot.enabledAt="concurrent-snapshot-change"; await fs.writeFile(file,JSON.stringify(payload));
  r=await call(routes.get(MIGRATE),{method:"POST",body:{apply:true,expected:migrationDry.body.expected}}); assert.equal(r.status,409);
  await fs.writeFile(file,orig);
});
await ok("v2.6.3: backup failure prevents all migration writes", async () => {
  const originalWrite=fs.writeFile, before=await fs.readFile(STORE_FILE,"utf8");
  fs.writeFile=async (file,...args)=>{if(String(file).includes('.bak-')) throw new Error('backup denied');return originalWrite(file,...args);};
  try {const r=await call(routes.get(MIGRATE),{method:"POST",body:{apply:true,expected:migrationDry.body.expected}});assert.equal(r.status,500);assert.deepEqual(r.body.committed,[]);assert.equal(await fs.readFile(STORE_FILE,"utf8"),before);} finally {fs.writeFile=originalWrite;}
});
await ok("v2.6.3: failed official policy CAS rolls both files back exactly", async () => {
  const mf=join(scratch,modes.MODES_FILE), rolesBefore=await fs.readFile(STORE_FILE,"utf8"), modesBefore=await fs.readFile(mf,"utf8");
  settings.peek().failNextReplace="SETTINGS_CONFLICT";
  const r=await call(routes.get(MIGRATE),{method:"POST",body:{apply:true,expected:migrationDry.body.expected}});
  assert.equal(r.status,409); assert.equal(r.body.error,"rolled-back"); assert.equal(await fs.readFile(STORE_FILE,"utf8"),rolesBefore);assert.equal(await fs.readFile(mf,"utf8"),modesBefore);assert.ok(r.body.recoveryPath);
});
await ok("v2.6.3: migration applies with backups and keeps mode, enable flag, snapshot timestamp and custom data", async () => {
  const mf=join(scratch,modes.MODES_FILE), before=JSON.parse(await fs.readFile(mf,"utf8")), enabled=settings.peek().value.enabled, n=llm.calls.length;
  const r=await call(routes.get(MIGRATE),{method:"POST",body:{apply:true,expected:migrationDry.body.expected}});
  assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.ok,true); assert.deepEqual(r.body.committed,["modes","roles","settings"]);
  for(const file of Object.values(r.body.backupFiles)) assert.ok((await fs.stat(file)).isFile());
  const after=JSON.parse(await fs.readFile(mf,"utf8")), rolesAfter=storeFileJson();
  assert.equal(after.currentModeId,before.currentModeId); assert.equal(after.activeSnapshot.enabledAt,before.activeSnapshot.enabledAt); assert.equal(settings.peek().value.enabled,enabled);assert.equal(llm.calls.length,n);
  assert.deepEqual(rolesAfter.customMigrationField,{foo:"keep",nested:{provider:"deepseek-account",model:"deepseek-v4-pro"}});
});

console.log(`\n${passed} checks passed`);
await fs.rm(scratch, { recursive: true, force: true });
