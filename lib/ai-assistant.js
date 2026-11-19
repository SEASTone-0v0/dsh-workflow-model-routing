/**
 * @local/dsh-workflow-model-routing — AI assistant half (v2.4.0).
 *
 * Pure, testable library backing the `/ai/configure`, `/ai/recommend` and
 * `/release-notes` endpoints. It never writes the role store, the modes store
 * or the settings entry: it only turns a selected (already authorized) model
 * into configuration / recommendation suggestions that the FRONTEND merges into
 * its drafts and explicitly saves. All real model calls go through the LLM
 * service the host injects; nothing here talks to a network directly.
 *
 * Streaming contract (per the runtime, distinct from the legacy probeRoute):
 *   - text arrives on `chunk.type === "text-delta"` as `chunk.text`.
 *   - `chunk.type === "block-end"` may carry `chunk.text` as a dedup fallback.
 *   - completion/abort/error arrives on `chunk.type === "finish"` with
 *     `chunk.reason.kind` (e.g. "stop" | "error" | "aborted").
 *
 * Zero runtime dependencies beyond `node:*` builtins and `./tiers.js`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODE_DESCRIPTIONS, MODE_INTERPRETATIONS } from "./modes.js";
import * as routePolicy from "./route-policy.js";

export const MODE_IDS = Object.freeze(["economy", "normal", "performance", "broke"]);
export const REASONING_POLICIES = Object.freeze(["default", "fixed", "smart"]);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_NOTES_FILE = path.join(PKG_ROOT, "release-notes.json");

const AI_STREAM_TIMEOUT_MS = 90_000;
const AI_MAX_OUTPUT_CHARS = 80_000;
const AI_MAX_TOKENS = 8000;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function routeKey(provider, model) {
  return `${String(provider ?? "")}/${String(model ?? "")}`;
}

function describeRoute(route) {
  if (route === null || route === undefined) return "";
  return `${String(route.provider ?? "")}/${String(route.model ?? "")}`;
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

/**
 * Collect one streaming response into text, defensively honouring BOTH the real
 * chunk contract (`{type:"text-delta",text:"..."}` / `{type:"finish",reason:{kind:"..."}}`)
 * and the legacy shape (`{type:"text-delta",delta:"..."}` / `{type:"finish",finish:{reason:"..."}}`).
 * Text collection never double-joins the same fragment: `chunk.text` is
 * authoritative, `chunk.delta` is only used when `chunk.text` is absent, and
 * block-end replays are suffix-deduped. Never retries. A network throw, an
 * aborted timer, an empty body, or a finish with an error/aborted reason all
 * surface as `{ ok: false }` with the underlying error passed through verbatim.
 */
export async function streamText(llm, options) {
  const provider = String(options?.provider ?? "").trim();
  const model = String(options?.model ?? "").trim();
  if (provider === "" || model === "") {
    return { ok: false, text: "", reason: null, error: "missing provider/model" };
  }
  const timeoutMs = Number.isInteger(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : AI_STREAM_TIMEOUT_MS;
  const maxOutputChars = Number.isInteger(options?.maxOutputChars) && options.maxOutputChars > 0
    ? options.maxOutputChars
    : AI_MAX_OUTPUT_CHARS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  let reason = null;
  let finishError = null;
  let failure = null;
  let truncated = false;
  const appendText = (fragment) => {
    if (typeof fragment !== "string" || fragment === "") return;
    text += fragment;
  };
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: Array.isArray(options.messages) ? options.messages : [],
      maxTokens: Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : AI_MAX_TOKENS,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== "object") continue;
      const type = chunk.type;
      if (type === "block-end") {
        // A block-end chunk replays the whole accumulated text: replace when it
        // extends what we already have, skip when it is an exact suffix, append
        // only when it is genuinely new. This avoids double-concatenation.
        if (typeof chunk.text === "string" && chunk.text !== "") {
          if (chunk.text.startsWith(text)) {
            text = chunk.text;
          } else if (!text.endsWith(chunk.text)) {
            text += chunk.text;
          }
        }
      } else {
        // Real contract puts incremental text in `chunk.text`; the legacy shape
        // puts it in `chunk.delta` on text-delta chunks. `chunk.text` wins, and
        // `chunk.delta` is only a fallback so a chunk carrying both never appends
        // the same text twice.
        if (typeof chunk.text === "string" && chunk.text !== "") {
          appendText(chunk.text);
        } else if (type === "text-delta" && typeof chunk.delta === "string" && chunk.delta !== "") {
          appendText(chunk.delta);
        }
      }
      if (type === "finish") {
        reason = extractFinishReason(chunk);
        const err = extractFinishError(chunk);
        if (err !== null) finishError = err;
      }
      if (text.length > maxOutputChars) {
        text = text.slice(0, maxOutputChars);
        truncated = true;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }

  if (failure !== null) {
    const status = Number.isInteger(failure?.status) ? failure.status : null;
    return {
      ok: false,
      text,
      reason: null,
      error: formatError(failure),
      kind: errorKind(failure),
      status,
      truncated,
    };
  }
  if (reason === "error" || reason === "aborted") {
    const kind = finishError !== null ? errorKind(finishError) : (reason === "aborted" ? "aborted" : "unknown");
    const status = finishError !== null && typeof finishError === "object" && Number.isInteger(finishError.status) ? finishError.status : null;
    return {
      ok: false,
      text,
      reason,
      error: finishError !== null ? formatError(finishError) : `stream finished with ${reason}`,
      kind,
      status,
      truncated,
    };
  }
  if (text.trim() === "") {
    return { ok: false, text, reason, error: "empty stream output", status: null, truncated };
  }
  return { ok: true, text, reason, error: null, truncated };
}

/** Extract the finish reason from either `chunk.reason` (real) or `chunk.finish` (legacy). */
function extractFinishReason(chunk) {
  const r = chunk?.reason;
  if (typeof r === "string" && r !== "") return r;
  if (r !== null && typeof r === "object" && typeof r.kind === "string" && r.kind !== "") return r.kind;
  const f = chunk?.finish;
  if (typeof f === "string" && f !== "") return f;
  if (f !== null && typeof f === "object") {
    if (typeof f.reason === "string" && f.reason !== "") return f.reason;
    if (typeof f.type === "string" && f.type !== "") return f.type;
    const fr = f.reason;
    if (fr !== null && typeof fr === "object" && typeof fr.kind === "string" && fr.kind !== "") return fr.kind;
  }
  return null;
}

/**
 * Extract the raw error value from a finish chunk (permission/rate-limit/network
 * passthrough). Returns a string, an error-like object, or `null` — callers pass
 * it through `formatError`/`errorKind` so nested `cause`/`code`/`status` survive.
 * Reads the real `{ reason: { kind, message, error } }` shape first, then the
 * legacy `{ finish: { message, error } }` shape, then a top-level error.
 */
function extractFinishError(chunk) {
  const r = chunk?.reason;
  if (r !== null && typeof r === "object") {
    if (r.error !== undefined && r.error !== null) return r.error;
    if (typeof r.message === "string" && r.message !== "") return r.message;
  }
  const f = chunk?.finish;
  if (f !== null && typeof f === "object") {
    if (f.error !== undefined && f.error !== null) return f.error;
    if (typeof f.message === "string" && f.message !== "") return f.message;
  }
  if (chunk?.error !== undefined && chunk?.error !== null) return chunk.error;
  if (typeof chunk?.message === "string" && chunk.message !== "") return chunk.message;
  return null;
}

/* ------------------------------------------------------------------ *
 * Error formatting & classification (v2.6.1)
 * ------------------------------------------------------------------ */

const ERROR_MAX_DEPTH = 4;
const ERROR_MAX_LENGTH = 600;
const ERROR_MAX_AGG_ITEMS = 4;

/**
 * Safely render an error into a single string, preserving the nested `cause`
 * chain, `code`, `status`, and a bounded-depth `AggregateError.errors` list,
 * without ever touching `.stack`, arbitrary keys (credentials can live there),
 * circular references, or large objects. Throwing in this path would mask the
 * original failure, so every access is guarded.
 */
export function formatError(error, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : ERROR_MAX_DEPTH;
  const maxLength = Number.isInteger(options.maxLength) && options.maxLength > 0 ? options.maxLength : ERROR_MAX_LENGTH;
  const seen = new WeakSet();

  function render(err, depth) {
    if (err === null || err === undefined) return String(err);
    if (typeof err !== "object" && typeof err !== "function") return String(err);
    if (depth > maxDepth) return "[…]";
    if (seen.has(err)) return "[Circular]";
    seen.add(err);
    try {
      const parts = [];
      if (typeof err.name === "string" && err.name !== "" && err.name !== "Error") parts.push(err.name);
      if (typeof err.message === "string" && err.message !== "") parts.push(err.message);
      if (typeof err.code === "string" && err.code !== "") parts.push(`code=${err.code}`);
      if (typeof err.status === "number" && Number.isFinite(err.status)) parts.push(`status=${err.status}`);
      if (err.errors !== undefined && err.errors !== null) {
        const list = Array.isArray(err.errors) ? err.errors : [err.errors];
        const items = list.slice(0, ERROR_MAX_AGG_ITEMS).map((item) => render(item, depth + 1));
        if (list.length > ERROR_MAX_AGG_ITEMS) items.push(`…(+${list.length - ERROR_MAX_AGG_ITEMS})`);
        parts.push(`errors=[${items.join(" | ")}]`);
      }
      if (err.cause !== undefined && err.cause !== null && err.cause !== err) {
        parts.push(`cause=${render(err.cause, depth + 1)}`);
      }
      if (parts.length === 0) parts.push(String(err));
      return parts.join(" ");
    } finally {
      seen.delete(err);
    }
  }

  const result = render(error, 0);
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}

/**
 * Classify an error into a coarse, UI-actionable kind without leaking internals:
 * "auth" (permission/credential), "rate-limit", "network", "timeout", "aborted",
 * "http", or "unknown". Follows the `cause` chain when the top-level error is
 * unclassified.
 */
export function errorKind(error) {
  if (error === null || error === undefined) return "unknown";
  if (typeof error !== "object" && typeof error !== "function") {
    return errorKind({ message: String(error) });
  }
  const name = typeof error.name === "string" ? error.name : "";
  const code = typeof error.code === "string" ? error.code : "";
  const status = typeof error.status === "number" ? error.status : null;
  const message = typeof error.message === "string" ? error.message : "";
  const text = `${name} ${code} ${message}`.toLowerCase();

  if (status === 401 || status === 403 || /auth|permission|forbidden|unauthorized|missing_credential|invalid_api_key/i.test(text)) return "auth";
  if (status === 429 || /rate[-_ ]?limit|too many requests/i.test(text)) return "rate-limit";
  if (name === "AbortError" || /abort/i.test(text)) return "aborted";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/fetch failed|failed to fetch|network|econnrefused|econnreset|enotfound|eai_again|etimedout|dns|socket|connect/i.test(text)) return "network";
  if (status !== null || code !== "") return "http";
  if (error.cause !== undefined && error.cause !== null) return errorKind(error.cause);
  return "unknown";
}

/* ------------------------------------------------------------------ *
 * JSON extraction (fence-tolerant, otherwise strict)
 * ------------------------------------------------------------------ */

export function extractJson(text) {
  let source = String(text ?? "").trim();
  if (source === "") return { ok: false, error: "empty output" };
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) source = fence[1].trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, error: "no JSON object found" };
  }
  source = source.slice(start, end + 1);
  try {
    return { ok: true, data: JSON.parse(source) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ------------------------------------------------------------------ *
 * Catalog flattening
 * ------------------------------------------------------------------ */

/**
 * Flatten the `/catalog` payload into a `provider/model`-keyed map plus a list.
 * Each entry carries whatever reasoning / modality / description metadata the
 * catalogue declared — models are never dropped, only their long descriptions
 * are truncated (the id/name and declared efforts always survive).
 */
export function flattenCatalog(catalog) {
  catalog = routePolicy.preferredCatalog(catalog);
  const routes = {};
  const list = [];
  const warnings = [];
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
  const mergeEntry = (existing, entry) => {
    // Prefer the more-complete metadata on an exact provider/model key collision.
    if (!existing.name || existing.name === existing.model) existing.name = entry.name;
    if (existing.reasoningEfforts.length === 0) existing.reasoningEfforts = entry.reasoningEfforts;
    if (existing.defaultEffort === null) existing.defaultEffort = entry.defaultEffort;
    if (!existing.canDisableThinking) existing.canDisableThinking = entry.canDisableThinking;
    if (existing.modalities.length === 0) existing.modalities = entry.modalities;
    if (!existing.description) existing.description = entry.description;
  };
  for (const provider of providers) {
    const pid = typeof provider?.id === "string" ? provider.id : "";
    if (pid === "") continue;
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      const mid = typeof model?.id === "string" ? model.id : "";
      if (mid === "") continue;
      const key = routeKey(pid, mid);
      const entry = {
        provider: pid,
        model: mid,
        name: typeof model?.name === "string" && model.name !== "" ? model.name : mid,
        reasoningEfforts: Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.slice() : [],
        defaultEffort: typeof model?.defaultEffort === "string" ? model.defaultEffort : null,
        canDisableThinking: model?.canDisableThinking === true,
        modalities: Array.isArray(model?.modalities) ? model.modalities.slice() : [],
        inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.slice() : [],
        description:
          typeof model?.description === "string" ? model.description.slice(0, 200) : "",
      };
      if (routes[key]) {
        mergeEntry(routes[key], entry);
        warnings.push(`catalog 模型 ${pid}/${mid} 重复，已合并元数据`);
        continue;
      }
      routes[key] = entry;
      list.push(entry);
    }
  }
  return { routes, list, warnings };
}

/* ------------------------------------------------------------------ *
 * Reasoning-config validation against DECLARED efforts
 * ------------------------------------------------------------------ */

function defaultReasoning() {
  return { reasoningPolicy: "default", reasoningEffort: null, smartMap: null };
}

/**
 * Validate an AI-supplied reasoning config against a route's declared efforts.
 *   - default   → always accepted (effort/map dropped).
 *   - fixed     → effort must be declared, else fall back to default + warning.
 *   - smart     → low/medium/high must all be present AND all declared, else the
 *                 WHOLE position falls back to default + warning (never a
 *                 half-filled map, never a guessed enum).
 */
export function validateReasoning(aiValue, declaredEfforts, label) {
  const declared = Array.isArray(declaredEfforts) ? declaredEfforts : [];
  const raw = aiValue !== null && typeof aiValue === "object" && !Array.isArray(aiValue) ? aiValue : {};
  const policy = REASONING_POLICIES.includes(raw.reasoningPolicy) ? raw.reasoningPolicy : "default";
  if (policy === "default") return { reasoning: defaultReasoning(), warning: null };

  if (policy === "fixed") {
    const effort = typeof raw.reasoningEffort === "string" && raw.reasoningEffort.trim() !== ""
      ? raw.reasoningEffort.trim()
      : null;
    if (effort === null || !declared.includes(effort)) {
      return {
        reasoning: defaultReasoning(),
        warning: `${label}: fixed 档位 ${effort ?? "(未设置)"} 未在已声明档位中，已整体回退 default`,
      };
    }
    return { reasoning: { reasoningPolicy: "fixed", reasoningEffort: effort, smartMap: null }, warning: null };
  }

  // smart
  const sm = raw.smartMap !== null && typeof raw.smartMap === "object" && !Array.isArray(raw.smartMap)
    ? raw.smartMap
    : null;
  const low = sm && typeof sm.low === "string" && sm.low.trim() !== "" ? sm.low.trim() : null;
  const medium = sm && typeof sm.medium === "string" && sm.medium.trim() !== "" ? sm.medium.trim() : null;
  const high = sm && typeof sm.high === "string" && sm.high.trim() !== "" ? sm.high.trim() : null;
  if (
    low === null ||
    medium === null ||
    high === null ||
    !declared.includes(low) ||
    !declared.includes(medium) ||
    !declared.includes(high)
  ) {
    return {
      reasoning: defaultReasoning(),
      warning: `${label}: smart 需 low/medium/high 齐全且均已声明，已整体回退 default`,
    };
  }
  return {
    reasoning: { reasoningPolicy: "smart", reasoningEffort: null, smartMap: { low, medium, high } },
    warning: null,
  };
}

/* ------------------------------------------------------------------ *
 * Route validation against the local catalog
 * ------------------------------------------------------------------ */

function cleanExistingRoute(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (provider === "" || model === "") return null;
  return { provider, model };
}

/** Rebuild a `{providers:[...]}` catalog shape from a flattened list, so the
 *  shared route policy can resolve a vision-alias route to its non-vision
 *  target using the exact same index construction as every other entry point. */
function catalogFromFlat(flat) {
  const byProvider = new Map();
  for (const entry of Array.isArray(flat?.list) ? flat.list : []) {
    if (entry === null || typeof entry !== "object") continue;
    const pid = typeof entry.provider === "string" ? entry.provider : "";
    if (pid === "") continue;
    if (!byProvider.has(pid)) byProvider.set(pid, []);
    byProvider.get(pid).push({
      id: entry.model,
      name: typeof entry.name === "string" ? entry.name : entry.model,
      reasoningEfforts: Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [],
      modalities: Array.isArray(entry.modalities) ? entry.modalities : [],
    });
  }
  return { providers: [...byProvider.entries()].map(([id, models]) => ({ id, models })) };
}

/**
 * Validate one AI route: it must be a real local-catalog model, and its
 * reasoning config must verify against that model's declared efforts. A
 * hallucinated (non-local) route falls back to the existing legal route with a
 * warning. A vision-alias route (defense in depth — the prompt never offers
 * one) is migrated to its non-vision target under the same-name priority policy
 * before validation. Returns `{ route, warning }`.
 */
export function validateAiRoute(aiValue, existingValue, flat, label) {
  const index = routePolicy.buildCatalogIndex(catalogFromFlat(flat));
  function legal(value) {
    const raw = cleanExistingRoute(value);
    if (!raw) return null;
    const migrated = routePolicy.migrateRouteObject(raw, index, label);
    return migrated.error ? null : migrated.value;
  }
  const existing = legal(existingValue);
  const raw = aiValue !== null && typeof aiValue === "object" && !Array.isArray(aiValue) ? aiValue : null;
  if (raw === null || typeof raw.provider !== "string" || typeof raw.model !== "string") {
    return { route: existing, warning: null };
  }

  if (routePolicy.isVisionRoute(raw) || (legal(raw) && (legal(raw).provider !== raw.provider || legal(raw).model !== raw.model))) {
    const index = routePolicy.buildCatalogIndex(catalogFromFlat(flat));
    const migrated = routePolicy.migrateRouteObject(raw, index, label);
    if (migrated.error) {
      return {
        route: existing,
        warning: `${label}: AI 输出了 vision 路由 ${raw.provider}/${raw.model}，但无对应非 vision 目标，已回退现有合法路线 ${describeRoute(existing)}`,
      };
    }
    const targetKey = routeKey(migrated.value.provider, migrated.value.model);
    const info = flat.routes[targetKey];
    if (info === undefined) {
      return {
        route: existing,
        warning: `${label}: vision 路由迁移目标 ${targetKey} 不在本地目录，已回退现有合法路线 ${describeRoute(existing)}`,
      };
    }
    return {
      route: {
        provider: info.provider,
        model: info.model,
        reasoningPolicy: migrated.value.reasoningPolicy ?? "default",
        reasoningEffort: migrated.value.reasoningEffort ?? null,
        smartMap: migrated.value.smartMap ?? null,
      },
      warning: migrated.warning ?? null,
    };
  }

  const key = routeKey(raw.provider, raw.model);
  const info = flat.routes[key];
  if (info === undefined) {
    return {
      route: existing,
      warning: `${label}: 模型 ${key} 不在本地目录，已回退现有合法路线 ${describeRoute(existing)}`,
    };
  }
  const { reasoning, warning } = validateReasoning(raw, info.reasoningEfforts, label);
  return {
    route: {
      provider: info.provider,
      model: info.model,
      ...reasoning,
    },
    warning,
  };
}

/* ------------------------------------------------------------------ *
 * Mode merge (configure) — preserves every safety field
 * ------------------------------------------------------------------ */

function mergeConfiguredMode(modeId, base, aiData, flat, warnings) {
  const modeWarnings = [];
  let out = clone(base ?? {});

  const leadRes = validateAiRoute(aiData?.lead, base?.lead, flat, "lead");
  out.lead = leadRes.route;
  if (leadRes.warning) modeWarnings.push(leadRes.warning);

  const advisorBase = base?.upgradeAdvisor ?? null;
  const advisorRes = validateAiRoute(aiData?.upgradeAdvisor, advisorBase, flat, "upgradeAdvisor");
  out.upgradeAdvisor = {
    ...(advisorBase !== null && typeof advisorBase === "object" ? advisorBase : {}),
    provider: advisorRes.route?.provider ?? advisorBase?.provider ?? null,
    model: advisorRes.route?.model ?? advisorBase?.model ?? null,
    reasoningPolicy: advisorRes.route?.reasoningPolicy ?? "default",
    reasoningEffort: advisorRes.route?.reasoningEffort ?? null,
    smartMap: advisorRes.route?.smartMap ?? null,
  };
  if (advisorRes.warning) modeWarnings.push(advisorRes.warning);

  const aiRoles = {};
  for (const role of Array.isArray(aiData?.roles) ? aiData.roles : []) {
    if (role !== null && typeof role === "object" && typeof role.id === "string" && role.id !== "") {
      aiRoles[role.id] = role;
    }
  }
  out.roles = (Array.isArray(base?.roles) ? base.roles : []).map((role) => {
    const aiRole = aiRoles[role.id];
    if (aiRole === undefined) return role;
    const next = { ...role };
    for (const slot of ["primary", "backup", "upgrade"]) {
      const label = `roles.${role.id}.${slot}`;
      const res = validateAiRoute(aiRole[slot], role[slot], flat, label);
      next[slot] = res.route;
      if (res.warning) modeWarnings.push(res.warning);
    }
    return next;
  });

  // Surface any slot the mode should have but is still empty — never silently
  // claim "all matched". Standard roles are expected to carry a primary/backup/
  // upgrade; reviewer (pairings) and privacy (no routes) are exempt because
  // their wiring is structural, not route-based.
  const requiredSlots = ["primary", "backup", "upgrade"];
  for (const role of out.roles) {
    if (role?.kind !== "standard") continue;
    for (const slot of requiredSlots) {
      if (cleanExistingRoute(role[slot]) === null) {
        modeWarnings.push(`roles.${role.id}.${slot}: 该模式仍未配置`);
      }
    }
  }

  const aiTeam = aiData?.team !== null && typeof aiData?.team === "object" ? aiData.team : {};
  const teamBase = base?.team !== null && typeof base?.team === "object" ? base.team : {};
  out.team = { ...teamBase };
  for (const slot of ["planner", "executor", "reviewer", "advisor"]) {
    const label = `team.${slot}`;
    const res = validateAiRoute(aiTeam[slot], teamBase[slot], flat, label);
    out.team[slot] = res.route;
    if (res.warning) modeWarnings.push(res.warning);
  }

  // Drop any field the AI may have tried to smuggle in that we never merge.
  out.modeId = base?.modeId ?? modeId;
  return { mode: out, warnings: modeWarnings };
}

function catalogSummary(flat, authorizedModels) {
  return {
    routeCount: flat.list.length,
    providers: [...new Set(flat.list.map((entry) => entry.provider))].sort(),
    authorizedCount: Array.isArray(authorizedModels) ? authorizedModels.length : 0,
  };
}

function roleIdentityList(roles) {
  return (Array.isArray(roles) ? roles : []).map((role) => ({
    id: role.id,
    name: role.name,
    purpose: role.purpose,
    kind: role.kind,
    enabled: role.enabled !== false,
  }));
}

function buildConfigurePrompt(modeId, base, roles, flat, authorizedModels) {
  const lines = [];
  lines.push(`你是模型路由配置助手。为运行模式 "${modeId}" 生成一份 JSON 配置。`);
  lines.push(`模式定位：${MODE_DESCRIPTIONS[modeId] ?? base?.description ?? ""}`);
  const configureSummary = MODE_INTERPRETATIONS[modeId]?.summary;
  if (configureSummary) lines.push(`解读：${configureSummary}`);
  lines.push("");
  lines.push("角色清单（仅身份，路由必须你来填）：");
  for (const role of roles) {
    lines.push(`- ${role.id}｜${role.name}｜${role.purpose ?? ""}｜kind=${role.kind}｜enabled=${role.enabled}`);
  }
  lines.push("");
  lines.push("本机完整可用模型目录（只能从下面选择 provider/model，禁止编造）：");
  for (const entry of flat.list) {
    const bits = [
      `${entry.provider}/${entry.model}`,
      entry.reasoningEfforts.length > 0 ? `档位=[${entry.reasoningEfforts.join(",")}]` : "档位=未声明",
    ];
    if (entry.modalities.length > 0) bits.push(`模态=[${entry.modalities.join(",")}]`);
    if (entry.description) bits.push(`描述=${entry.description}`);
    lines.push(`- ${bits.join("；")}`);
  }
  if (Array.isArray(authorizedModels) && authorizedModels.length > 0) {
    lines.push("");
    lines.push(`当前已授权模型：${authorizedModels.map(describeRoute).join(", ")}（新路线可来自整个目录，前端会自动并入授权草稿）。`);
  }
  lines.push("");
  lines.push("只输出一个 JSON 对象，结构如下（不要解释，不要 Markdown 以外的文字）：");
  lines.push(`{
  "lead": { "provider": "...", "model": "...", "reasoningPolicy": "default|fixed|smart", "reasoningEffort": "...", "smartMap": { "low": "...", "medium": "...", "high": "..." } },
  "upgradeAdvisor": { "provider": "...", "model": "...", "reasoningPolicy": "...", "reasoningEffort": "...", "smartMap": {} },
  "roles": [ { "id": "<角色id>", "primary": {...}, "backup": {...}, "upgrade": {...} } ],
  "team": { "planner": {...}, "executor": {...}, "reviewer": {...}, "advisor": {...} }
}`);
  lines.push("规则：");
  lines.push("同名/同版本模型优先 kimi-subscription、antigravity 分组；优先分组没有才使用其他分组。禁止 -vision 衍生 provider，原生图片输入能力不受影响。");
  lines.push("1. 只从上面目录选 provider/model；reasoningPolicy=default 时 reasoningEffort/smartMap 置 null。");
  lines.push("2. 选 fixed 时 reasoningEffort 必须是该模型已声明的档位之一；选 smart 时 low/medium/high 必须齐全且都是该模型已声明的档位。");
  lines.push("3. 不要增删角色，roles 只按 id 返回 primary/backup/upgrade。");
  lines.push("4. 不要改团队预算、并发、写隔离、taskTargets、revision 等安全字段。");
  return lines.join("\n");
}

/**
 * Generate four mode configs (one llm.stream per mode). Returns
 * `{ ok, provider, model, catalogSummary, results }` where each result is
 * `{ modeId, ok, mode?, warnings?, error? }`. Partial failures are reported, the
 * caller must NOT write anything.
 */
function withoutVisionRoutes(value) {
  if (!value || typeof value !== "object") return value;
  if (routePolicy.isVisionRoute(value)) return null;
  if (Array.isArray(value)) return value.map(withoutVisionRoutes);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,withoutVisionRoutes(v)]));
}

export async function configureModes({ llm, provider, model, authorizedModels = [], catalog = null, modesStore = {}, roles = [] }) {
  if (routePolicy.isVisionAliasProvider(provider)) throw new Error("vision-executor-forbidden");
  const index = routePolicy.buildCatalogIndex(catalog);
  const repaired = routePolicy.migrateModesStore(modesStore, index);
  // A missing legacy alias must not reappear via an omitted AI slot. Clear it
  // only in this generated draft, reporting the position; persisted migration
  // remains fail-stop if any alias has no target.
  modesStore = withoutVisionRoutes(repaired.value);
  roles = routePolicy.migrateRoles(roles, index).value;
  authorizedModels = routePolicy.filterVisionRoutes(authorizedModels);
  const flat = flattenCatalog(catalog);
  const summary = catalogSummary(flat, authorizedModels);
  const catalogWarnings = [...(Array.isArray(catalog?.warnings) ? catalog.warnings : []), ...repaired.errors.map(e=>e.message)];

  const jobs = MODE_IDS.map((modeId) => async () => {
    const base = modesStore?.modes?.[modeId] ?? null;
    if (base === null) {
      return { modeId, ok: false, error: `unknown-mode:${modeId}` };
    }
    // Each mode configures ITS OWN roles (per-mode custom roles survive); the
    // global roleStore.roles is only a fallback for a mode with no roles of its
    // own.
    const modeRoles = roleIdentityList(Array.isArray(base?.roles) && base.roles.length > 0 ? base.roles : roles);
    const prompt = buildConfigurePrompt(modeId, base, modeRoles, flat, authorizedModels);
    const stream = await streamText(llm, {
      provider,
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    if (!stream.ok) {
      return { modeId, ok: false, error: stream.error };
    }
    const parsed = extractJson(stream.text);
    if (!parsed.ok) {
      return { modeId, ok: false, error: `json: ${parsed.error}` };
    }
    const merged = mergeConfiguredMode(modeId, base, parsed.data, flat, []);
    return { modeId, ok: true, mode: merged.mode, warnings: merged.warnings, error: null };
  });

  // SERIAL execution (maxActive=1): run one mode at a time so a single-mode
  // failure is recorded and the loop continues (no auto-retry, no silent swap).
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await job());
    } catch (error) {
      results.push({ modeId: MODE_IDS[results.length], ok: false, error: String(error?.message ?? error) });
    }
  }

  return { ok: true, provider, model, catalogSummary: summary, catalogWarnings, results };
}

/* ------------------------------------------------------------------ *
 * Recommend — per-mode, per-role candidates
 * ------------------------------------------------------------------ */

function buildRecommendPrompt(modeId, base, roles, flat, authorizedModels) {
  const lines = ["同名/同版本模型优先 kimi-subscription、antigravity 分组，优先分组没有才使用其他分组；不得选择 -vision 衍生 provider。原生图片输入能力保留。"];
  lines.push(`你是模型选型顾问。为运行模式 "${modeId}" 的每个角色推荐市场模型候选。`);
  lines.push(`模式定位：${MODE_DESCRIPTIONS[modeId] ?? base?.description ?? ""}`);
  const recommendSummary = MODE_INTERPRETATIONS[modeId]?.summary;
  if (recommendSummary) lines.push(`解读：${recommendSummary}`);
  lines.push("");
  lines.push("角色职责（按此定位推荐）：");
  for (const role of roles) {
    lines.push(`- ${role.id}｜${role.name}｜${role.purpose ?? ""}｜kind=${role.kind}`);
  }
  lines.push("");
  lines.push("本机已部署模型目录（availableLocally 只能对这里的模型为 true）：");
  for (const entry of flat.list) {
    const bits = [`${entry.provider}/${entry.model}`];
    if (entry.reasoningEfforts.length > 0) bits.push(`档位=[${entry.reasoningEfforts.join(",")}]`);
    if (entry.modalities.length > 0) bits.push(`模态=[${entry.modalities.join(",")}]`);
    if (entry.description) bits.push(`描述=${entry.description}`);
    lines.push(`- ${bits.join("；")}`);
  }
  lines.push("");
  lines.push("只输出一个 JSON 对象：");
  lines.push(`{ "roles": [ { "id": "<角色id>", "candidates": [ { "provider": "...", "model": "...", "source": "local-catalog|model-knowledge", "reason": "...", "strengths": "...", "cautions": "..." } ] } ] }`);
  lines.push("规则：");
  lines.push("1. 市场候选可以来自你的知识，但 source 必须标注 model-knowledge 或 local-catalog；只有目录里的模型 availableLocally 才为 true（本地候选前端会自行判定，无需你写 availableLocally）。");
  lines.push(`2. 普通模式每角色最多 3 个候选，理由必须各有特色。`);
  lines.push("3. 不要写入配置、不要授权、不要保存。");
  return lines.join("\n");
}

function normalizeCandidate(raw, flat) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  let provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  let model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (provider === "" || model === "") return null;
  const target = routePolicy.findNonVisionTarget({ provider, model }, routePolicy.buildCatalogIndex(catalogFromFlat(flat)));
  if (target) { provider = target.provider; model = target.model; }
  if (routePolicy.isVisionAliasProvider(provider)) return null;
  const availableLocally = flat.routes[routeKey(provider, model)] !== undefined;
  const source = raw.source === "local-catalog" ? "local-catalog" : "model-knowledge";
  return {
    provider,
    model,
    source,
    availableLocally,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "",
    strengths: typeof raw.strengths === "string" ? raw.strengths.slice(0, 300) : "",
    cautions: typeof raw.cautions === "string" ? raw.cautions.slice(0, 300) : "",
  };
}

function isVisionRole(role) {
  return role?.id === "vision" || role?.id === "multimodal-researcher";
}

function localCandidatesForRole(role, flat, modeId) {
  const out = [];
  for (const entry of flat.list) {
    if (isVisionRole(role)) {
      // Native multimodal: vision/multimodal-researcher roles require image
      // INPUT capability, NOT a `-vision` provider alias (that alias is the
      // deployment directory we are hiding, not a capability signal). All
      // non-vision providers with image input remain eligible.
      const mods = entry.inputModalities ?? entry.modalities ?? [];
      const hasImage = mods.some((m) => /image|vision/i.test(String(m)));
      if (!hasImage) continue;
    }
    out.push({
      provider: entry.provider,
      model: entry.model,
      source: "local-catalog",
      availableLocally: true,
      reason: `${role.name ?? role.id}（${role.purpose ?? ""}）：本机可用候选`,
      strengths: entry.description || entry.name,
      cautions: "",
    });
  }
  return out;
}

function recommendForMode(modeId, base, aiData, flat, roles, warnings) {
  const modeWarnings = [];
  const aiRoles = {};
  for (const role of Array.isArray(aiData?.roles) ? aiData.roles : []) {
    if (role !== null && typeof role === "object" && typeof role.id === "string" && role.id !== "") {
      aiRoles[role.id] = role;
    }
  }
  const resultRoles = (Array.isArray(roles) ? roles : []).map((role) => {
    const aiRole = aiRoles[role.id];
    let candidates = (Array.isArray(aiRole?.candidates) ? aiRole.candidates : [])
      .map((raw) => normalizeCandidate(raw, flat))
      .filter((candidate) => candidate !== null);
    // Dedupe by provider/model.
    const seen = new Set();
    candidates = candidates.filter((candidate) => {
      const key = routeKey(candidate.provider, candidate.model);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (candidates.length > 3) {
      candidates = candidates.slice(0, 3);
      modeWarnings.push(`角色 ${role.id}：候选超过 3 个，已截断到前 3 个`);
    }
    // The AI must not leave a role with a single candidate when qualified local
    // models are available: fill up to 2–3 (deduped, role-relevant reasons).
    if (candidates.length < 2) {
      for (const local of localCandidatesForRole(role, flat, modeId)) {
        if (candidates.length >= 3) break;
        const key = routeKey(local.provider, local.model);
        if (!seen.has(key)) {
          candidates.push(local);
          seen.add(key);
        }
      }
      if (candidates.length < 2) {
        modeWarnings.push(`角色 ${role.id}：合格候选不足 2 个`);
      }
    }
    return { id: role.id, name: role.name, candidates };
  });
  return { roles: resultRoles, warnings: modeWarnings };
}

/**
 * Generate per-mode, per-role recommendations (one llm.stream per mode). Never
 * writes configuration or authorization. Returns `{ ok, provider, model,
 * catalogSummary, results }`.
 */
export async function recommendModels({ llm, provider, model, authorizedModels = [], catalog = null, modesStore = {}, roles = [] }) {
  if (routePolicy.isVisionAliasProvider(provider)) throw new Error("vision-executor-forbidden");
  const index = routePolicy.buildCatalogIndex(catalog);
  const repaired = routePolicy.migrateModesStore(modesStore, index);
  // A missing legacy alias must not reappear via an omitted AI slot. Clear it
  // only in this generated draft, reporting the position; persisted migration
  // remains fail-stop if any alias has no target.
  modesStore = withoutVisionRoutes(repaired.value);
  roles = routePolicy.migrateRoles(roles, index).value;
  authorizedModels = routePolicy.filterVisionRoutes(authorizedModels);
  const flat = flattenCatalog(catalog);
  const summary = catalogSummary(flat, authorizedModels);
  const catalogWarnings = [...(Array.isArray(catalog?.warnings) ? catalog.warnings : []), ...repaired.errors.map(e=>e.message)];

  const jobs = MODE_IDS.map((modeId) => async () => {
    const base = modesStore?.modes?.[modeId] ?? null;
    if (base === null) return { modeId, ok: false, error: `unknown-mode:${modeId}` };
    // Per-mode roles (global only as fallback), so a mode's custom roles are
    // recommended against their own duties, never the global role set.
    const modeRoles = Array.isArray(base?.roles) && base.roles.length > 0 ? base.roles : roles;
    const prompt = buildRecommendPrompt(modeId, base, modeRoles, flat, authorizedModels);
    const stream = await streamText(llm, { provider, model, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
    if (!stream.ok) return { modeId, ok: false, error: stream.error };
    const parsed = extractJson(stream.text);
    if (!parsed.ok) return { modeId, ok: false, error: `json: ${parsed.error}` };
    const recommended = recommendForMode(modeId, base, parsed.data, flat, modeRoles, []);
    return { modeId, ok: true, roles: recommended.roles, warnings: recommended.warnings, error: null };
  });

  // SERIAL execution (maxActive=1): one mode at a time; per-mode failure is
  // recorded and the loop continues (no auto-retry, no silent swap).
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await job());
    } catch (error) {
      results.push({ modeId: MODE_IDS[results.length], ok: false, error: String(error?.message ?? error) });
    }
  }

  return { ok: true, provider, model, catalogSummary: summary, catalogWarnings, results };
}

/* ------------------------------------------------------------------ *
 * Release notes
 * ------------------------------------------------------------------ */

/**
 * Read the package-root `release-notes.json`. Returns `{ ok, data }` on a valid
 * read+parse, else `{ ok: false, error }` (the handler maps this to 503).
 */
export async function readReleaseNotes(file = RELEASE_NOTES_FILE) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    return { ok: false, error: `release-notes unreadable: ${String(error?.message ?? error)}` };
  }
  try {
    const data = JSON.parse(raw);
    if (data === null || typeof data !== "object" || !Array.isArray(data.versions)) {
      return { ok: false, error: "release-notes invalid schema" };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: `release-notes parse failed: ${String(error?.message ?? error)}` };
  }
}

export default {
  MODE_IDS,
  streamText,
  extractJson,
  flattenCatalog,
  validateReasoning,
  validateAiRoute,
  configureModes,
  recommendModels,
  readReleaseNotes,
  RELEASE_NOTES_FILE,
};
