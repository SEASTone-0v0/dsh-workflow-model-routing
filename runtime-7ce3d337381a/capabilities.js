/**
 * @local/dsh-workflow-model-routing — capability detection + local cache (phase A).
 *
 * Phase A of the economy-mode plan is the data layer only: this module holds the
 * pure logic for reasoning-effort capability detection and the local capability
 * cache. It is imported by `index.js` and unit-tested by `test/smoke.mjs`. It is
 * self-contained (zero imports from index.js) so the two never form a cycle.
 *
 * Runtime contract the detection is built against (verified via
 * `cordis_inspect_query host Service.listService` on the running `llm` service):
 *
 *   listProviders():  LlmProviderInfo[]            { id, name }
 *   listConfigurableProviders(): LlmConfigurableProvider[]
 *     { provider, displayName, settingsNs, settingsPath: string[], declared?,
 *       defaultBaseURL?, baseURLEnv?: string[], nativeAuth?: { env: string[], oauth },
 *       error? }
 *   listModels(provider): Promise<LlmModelInfo[]>  { provider, id, name, ... }
 *   resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
 *     extends LlmModelInfo + { context?, defaultMaxTokens?,
 *       reasoning?: LlmModelReasoningInfo, systemPromptUpdate?, toolUpdate? }
 *   LlmModelReasoningInfo { efforts: readonly LlmReasoningEffortInfo[],
 *                           defaultEffort?: ReasoningEffortId }
 *   LlmReasoningEffortInfo { id, name, description? }
 *
 * Important: the contract exposes `reasoning.efforts` (an array of `{id,name}`
 * objects), NOT a `supportedEfforts` string array, and it does NOT expose an
 * adapter version or a `canDisableThinking` flag. Both are recorded as `null`
 * here and listed as unresolved boundaries in the phase-A report.
 *
 * Zero runtime dependencies: `node:crypto` + `node:fs/promises` builtins only.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const CAPABILITIES_FILE = "dsh-economy-capabilities.json";
export const CAPABILITIES_SCHEMA_VERSION = 1;
export const CAPABILITIES_TTL_MS = 24 * 60 * 60 * 1000; // 24h default TTL

/* ------------------------------------------------------------------ *
 * Fingerprint — a non-secret provider/endpoint identity hash
 * ------------------------------------------------------------------ */

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Build the stable, non-secret source object a fingerprint is derived from.
 * Only the hash of this object is ever persisted; the raw endpoint URL and env
 * *names* are folded into the hash, and no credential value is ever read.
 */
export function fingerprintSource(providerInfo, configurableEntry) {
  return {
    id: typeof providerInfo?.id === "string" ? providerInfo.id : "",
    name: typeof providerInfo?.name === "string" ? providerInfo.name : "",
    defaultBaseURL:
      typeof configurableEntry?.defaultBaseURL === "string" ? configurableEntry.defaultBaseURL : "",
    settingsNs: typeof configurableEntry?.settingsNs === "string" ? configurableEntry.settingsNs : "",
    settingsPath: Array.isArray(configurableEntry?.settingsPath) ? configurableEntry.settingsPath : [],
    baseURLEnv: Array.isArray(configurableEntry?.baseURLEnv) ? configurableEntry.baseURLEnv : [],
    nativeAuthEnv: Array.isArray(configurableEntry?.nativeAuth?.env)
      ? configurableEntry.nativeAuth.env
      : [],
  };
}

/** Provider + endpoint config fingerprint. A change in any source field changes this. */
export function providerFingerprint(providerInfo, configurableEntry) {
  return sha256Hex(JSON.stringify(fingerprintSource(providerInfo, configurableEntry)));
}

/* ------------------------------------------------------------------ *
 * Reasoning-effort helpers (contract shape + legacy compatibility)
 * ------------------------------------------------------------------ */

/**
 * Effort ids declared by a resolved model's reasoning metadata.
 *
 * Reads the correct runtime shape first (`reasoning.efforts`, an array of
 * `{ id, name, description? }`), then tolerates the legacy `supportedEfforts`
 * string-array shape so older adapters / older smoke fakes keep working.
 */
export function declaredEfforts(info) {
  const reasoning = info?.reasoning;
  if (reasoning === null || typeof reasoning !== "object") return [];
  if (Array.isArray(reasoning.efforts)) {
    return reasoning.efforts
      .map((entry) =>
        typeof entry === "string" ? entry : typeof entry?.id === "string" ? entry.id : "",
      )
      .filter((id) => typeof id === "string" && id !== "");
  }
  if (Array.isArray(reasoning.supportedEfforts)) {
    return reasoning.supportedEfforts.filter((id) => typeof id === "string" && id !== "");
  }
  return [];
}

export function declaredDefaultEffort(info) {
  const value = info?.reasoning?.defaultEffort;
  return typeof value === "string" && value !== "" ? value : null;
}

/** id → display name map. Display names exist only in the `efforts` object shape. */
export function effortDisplayNames(info) {
  const reasoning = info?.reasoning;
  if (reasoning === null || typeof reasoning !== "object" || !Array.isArray(reasoning.efforts)) {
    return {};
  }
  const out = {};
  for (const entry of reasoning.efforts) {
    if (entry !== null && typeof entry === "object" && typeof entry.id === "string") {
      out[entry.id] = typeof entry.name === "string" ? entry.name : entry.id;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Capability records
 * ------------------------------------------------------------------ */

/**
 * One route's capability record. `info` is the resolved model info (or null when
 * only catalog membership is known); `declared` says whether the route appeared
 * in `listModels`; `error` is the exception from a failed `resolveModelInfo`.
 *
 * `source` records where the capability came from (declaration vs measurement):
 *   "catalog"  — listed by `listModels` (a directory declaration)
 *   "unknown"  — not listed (an explicitly probed route with no metadata)
 *
 * `resolveModelInfo` returns adapter-declared metadata, not a live endpoint
 * probe, so it never qualifies as "measured" here: nothing verifies against a
 * real provider, and `lastVerifiedAt` is therefore never newly set by detection
 * (it only survives when a previous record already carried a verification).
 */
export function capabilityRecord(
  provider,
  model,
  fingerprint,
  {
    info = null,
    declared = false,
    error = null,
    detectedAt = new Date().toISOString(),
    lastVerifiedAt = null,
    generation = 0,
  } = {},
) {
  const efforts = info ? declaredEfforts(info) : [];
  const names = info ? effortDisplayNames(info) : {};
  const source = declared ? "catalog" : "unknown";
  const status = info ? "ok" : error !== null ? "failed" : "unknown";
  return {
    provider,
    model,
    fingerprint,
    // not exposed by the runtime contract; recorded null (see report)
    adapterVersion: null,
    canDisableThinking: null,
    configSource: "declared",
    // the store generation this record was detected under; a later invalidation
    // bumps the store generation, which marks every older record "stale" at read
    // time without trusting the (directory-declaration) fingerprint alone.
    generation,
    efforts: efforts.map((id) => ({ id, name: names[id] ?? id })),
    defaultEffort: info ? declaredDefaultEffort(info) : null,
    source,
    status,
    error: error === null ? null : String(error?.message ?? error),
    detectedAt,
    lastVerifiedAt: lastVerifiedAt ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Detection — read-only adapter metadata, never a paid request
 * ------------------------------------------------------------------ */

/**
 * Detect the current capability for every provider/model the llm service knows.
 * listProviders/listConfigurableProviders/listModels/resolveModelInfo are all
 * local adapter-metadata lookups; none of them issues a model call, so a refresh
 * never spends money.
 *
 * Returns `{ providers, configurable, records }`, or `{ error }` when the service
 * is unavailable. Never throws.
 */
export async function detectCapabilities(llm, { now = Date.now(), signal, generation = 0 } = {}) {
  if (llm === null || typeof llm !== "object") {
    return { providers: [], configurable: [], records: [], error: "llm-unavailable" };
  }
  let providerList;
  try {
    providerList = (await llm.listProviders()) ?? [];
  } catch (error) {
    return { providers: [], configurable: [], records: [], error: String(error?.message ?? error) };
  }

  const configurableByProvider = new Map();
  try {
    if (typeof llm.listConfigurableProviders === "function") {
      const entries = (await llm.listConfigurableProviders()) ?? [];
      for (const entry of entries) {
        if (entry !== null && typeof entry === "object" && typeof entry.provider === "string") {
          configurableByProvider.set(entry.provider, entry);
        }
      }
    }
  } catch {
    /* the configurable-provider directory is optional */
  }

  const providers = [];
  const configurable = [];
  const records = [];

  for (const providerInfo of providerList) {
    const providerId = providerInfo?.id;
    if (typeof providerId !== "string" || providerId === "") continue;
    const configurableEntry = configurableByProvider.get(providerId);
    const fingerprint = providerFingerprint(providerInfo, configurableEntry);
    providers.push({
      id: providerId,
      name: typeof providerInfo?.name === "string" ? providerInfo.name : providerId,
      fingerprint,
      adapterVersion: null,
    });
    if (configurableEntry !== undefined) configurable.push(configurableEntry);

    let models = [];
    try {
      models = (await llm.listModels(providerId)) ?? [];
    } catch {
      models = [];
    }
    for (const modelInfo of models) {
      const modelId = modelInfo?.id;
      if (typeof modelId !== "string" || modelId === "") continue;
      let info = null;
      let error = null;
      try {
        const resolved = await llm.resolveModelInfo(providerId, modelId, signal);
        info = resolved !== null && typeof resolved === "object" ? resolved : null;
      } catch (err) {
        error = err;
      }
      records.push(
        capabilityRecord(providerId, modelId, fingerprint, {
          info,
          declared: true,
          error,
          detectedAt: new Date(now).toISOString(),
          generation,
        }),
      );
    }
  }

  return { providers, configurable, records };
}

/* ------------------------------------------------------------------ *
 * Cache merge — invalidation on fingerprint change and effort narrowing
 * ------------------------------------------------------------------ */

/**
 * Merge freshly detected records into an existing cache payload. Pure: returns a
 * new payload and does not touch disk.
 *
 * - fingerprint changed  → the old record is dropped and replaced (invalidated)
 * - effort list narrowed → reported in `narrowed` so stale fixed tiers can be
 *   flagged invalid (the stored `lastVerifiedAt` survives across refreshes)
 * - route vanished        → dropped from the cache and reported in `dropped`
 */
export function mergeCapabilityCache(existing, detected, { now = Date.now(), generation = 0 } = {}) {
  const previous = new Map();
  for (const record of existing?.records ?? []) {
    if (record && typeof record.provider === "string" && typeof record.model === "string") {
      previous.set(`${record.provider}\u0000${record.model}`, record);
    }
  }

  const invalidated = [];
  const narrowed = [];
  const records = [];
  for (const fresh of detected) {
    const key = `${fresh.provider}\u0000${fresh.model}`;
    const old = previous.get(key);
    if (old !== undefined) {
      if (old.fingerprint !== fresh.fingerprint) {
        invalidated.push({ provider: fresh.provider, model: fresh.model, reason: "fingerprint" });
      } else {
        const oldIds = new Set((old.efforts ?? []).map((entry) => entry.id));
        const freshIds = new Set((fresh.efforts ?? []).map((entry) => entry.id));
        const lost = [...oldIds].filter((id) => !freshIds.has(id));
        if (lost.length > 0) narrowed.push({ provider: fresh.provider, model: fresh.model, lost });
        fresh.lastVerifiedAt = old.lastVerifiedAt ?? null;
      }
      previous.delete(key);
    }
    records.push(fresh);
  }

  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    generation:
      typeof generation === "number"
        ? generation
        : typeof existing?.generation === "number"
          ? existing.generation
          : 0,
    updatedAt: new Date(now).toISOString(),
    records,
    invalidated,
    narrowed,
    dropped: [...previous.values()].map((row) => ({ provider: row.provider, model: row.model })),
  };
}

/* ------------------------------------------------------------------ *
 * Read-time status and the later execution/UI interface
 * ------------------------------------------------------------------ */

/**
 * Effective freshness/validity of one record at read time. "expired" is computed
 * here (from detectedAt + TTL), never stored, so a stored "ok" record degrades
 * without a rewrite.
 */
export function effectiveStatus(
  record,
  { now = Date.now(), ttlMs = CAPABILITIES_TTL_MS, fingerprint, generation } = {},
) {
  if (record?.status === "failed") return "failed";
  if (record?.status === "unknown") return "unknown";
  // A store generation newer than the record's detection generation means an
  // explicit invalidation happened after this record was written: treat it as
  // stale (not "ok") even though the directory-declaration fingerprint is
  // unchanged. This is the real invalidation path — a settings/llm change bumps
  // the store generation and persists it, rather than merely clearing memory.
  if (
    typeof generation === "number" &&
    typeof record?.generation === "number" &&
    record.generation !== generation
  ) {
    return "stale";
  }
  if (typeof fingerprint === "string" && fingerprint !== "" && record?.fingerprint !== fingerprint) {
    return "invalidated";
  }
  const detectedAt = Date.parse(record?.detectedAt ?? "");
  if (Number.isNaN(detectedAt)) return "unknown";
  if (now - detectedAt > ttlMs) return "expired";
  return "ok";
}

export function isEffortSupported(record, effort, options) {
  if (effectiveStatus(record, options) !== "ok") return false;
  return (record?.efforts ?? []).some((entry) => entry.id === effort);
}

/**
 * Choose the reasoningEffort id to actually send for one route.
 *
 * This is the interface the phase-C execution wiring (and the phase-B UI for
 * preview) will call. It is pure and unit-tested now but not wired into dispatch
 * yet.
 *
 *   policy "default" → undefined (send no reasoningEffort; adapter default)
 *   policy "fixed"   → config.fixedEffort, only when it exactly matches a declared id
 *   policy "smart"   → config.smartMap[difficulty], only when it matches a declared id
 *
 * Unknown/expired/failed capability, an undeclared tier, or a fixed effort that
 * does not exactly match all resolve to `undefined` — never a guess, never a
 * low/medium/high menu item.
 */
export function resolveEffortForPolicy(record, config, difficulty, options) {
  if (effectiveStatus(record, options) !== "ok") return undefined;
  const efforts = (record?.efforts ?? []).map((entry) => entry.id);
  if (efforts.length === 0) return undefined;
  const policy = config?.reasoningPolicy ?? config?.policy;
  const normalized = policy === "fixed" || policy === "smart" ? policy : "default";
  if (normalized === "default") return undefined;
  if (normalized === "fixed") {
    const fixed =
      typeof config?.reasoningEffort === "string"
        ? config.reasoningEffort
        : typeof config?.fixedEffort === "string"
          ? config.fixedEffort
          : "";
    return fixed !== "" && efforts.includes(fixed) ? fixed : undefined;
  }
  const tier = difficulty === "low" || difficulty === "high" ? difficulty : "medium";
  const mapped = typeof config?.smartMap?.[tier] === "string" ? config.smartMap[tier] : "";
  return mapped !== "" && efforts.includes(mapped) ? mapped : undefined;
}

/* ------------------------------------------------------------------ *
 * Persistence — atomic tmp + rename (mirrors the role store)
 * ------------------------------------------------------------------ */

export async function readCapabilitiesFile(file) {
  if (file === "") return null;
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeCapabilitiesFile(file, payload) {
  if (file === "") return false;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, "utf8");
  await fs.rename(temporary, file);
  return true;
}
