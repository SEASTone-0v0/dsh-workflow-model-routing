/**
 * @local/dsh-workflow-model-routing — model tier classification (v2.6).
 *
 * This module owns the ADVISORY four-tier model classification used by the
 * `/tiers` endpoints. Tier badges are display-only guidance; they never
 * restrict which routes a mode may reference.
 *
 *   - `classifyRouteTier(provider, model)` — maps a route to one of the four
 *     tiers (`broke` / `economy` / `normal` / `performance`) for its badge.
 *   - `loadModelTiers({ authorizedModels, sourcePath })` — reads the curated
 *     tier plan (best-effort, never throws) and returns a minimal display
 *     summary: the four tiers plus a per-authorized-model tier map.
 *
 * It is self-contained (only `node:fs/promises`) so it can be unit-tested in
 * isolation. The full baseline database (capability scores, price redlines,
 * cost-perf rules) is kept as an INTERNAL structure for the maintenance cadence
 * and is NOT part of the public display summary.
 */

import fs from "node:fs/promises";

export const DEFAULT_SOURCE_PATH =
  process.env.DSH_WORKFLOW_MODEL_ROUTING_TIERS_FILE?.trim() || "";

const BROKE_BADGE = "🔴 穷鬼档";
const ECONOMY_BADGE = "🟡 经济档";
const NORMAL_BADGE = "🟢 普通档";
const PERFORMANCE_BADGE = "🔵 性能档";

/** Four-tier display metadata (concise — used for the `/tiers` summary). */
const TIER_META = Object.freeze({
  broke: { id: "broke", badge: BROKE_BADGE, name: "穷鬼档" },
  economy: { id: "economy", badge: ECONOMY_BADGE, name: "经济档" },
  normal: { id: "normal", badge: NORMAL_BADGE, name: "普通档" },
  performance: { id: "performance", badge: PERFORMANCE_BADGE, name: "性能档" },
});

/**
 * Internal baseline database. Kept in-module so the maintenance AI can refresh
 * the pools (capability ≥ 55, output-price redlines, cost-perf factor = ability
 * ÷ output price) without widening the public display contract. NEVER returned
 * by `loadModelTiers`.
 */
const INTERNAL_BASELINE = Object.freeze({
  admission: { minCapabilityScore: 55, requiresPublicApiOrOpenWeights: true },
  costPerfFactor: "能力分 ÷ 输出价格($/1M tok)，分层基线的人工维护参考",
  priceRedlinePerMtokOutput: { broke: "< $1", economy: "$1–5", normal: "$5–20", performance: "无上限" },
  referenceModels: Object.freeze({
    broke: ["DeepSeek V4 Flash", "DeepSeek V4 Pro", "Gemini 3.5 Flash-Lite", "Qwen3.8（自托管）"],
    economy: ["GPT-6.1 Terra", "Claude Haiku 4.5", "Kimi K3.1 Pro"],
    normal: ["Claude Sonnet 5.5", "GPT-6.1 Sol", "GPT-5.6 Sol", "Kimi K3.1 Pro", "Gemini 4 Argon"],
    performance: ["Claude Fable 5.2", "Claude Sonnet 5.5", "GPT-6 Astra", "Gemini 4 Carbon", "Opus 5.5"],
  }),
});

/**
 * Classify a route into one of the four tiers (advisory badge only).
 *
 * Precedence (most specific first):
 *   1. `deepseek*`                     → broke
 *   2. `astra`/`fable`/`opus`/`carbon` → performance
 *   3. `sonnet`/`sol`/`argon` or the explicit
 *      `gpt-5.3-codex` / `gemini-3.1-pro-preview` → normal
 *   4. `moonshotai*` (kimi) / `terra` / `haiku` → economy
 *   5. `flash-lite` / `free` / `qwen`  → broke
 *   6. fallback                        → normal
 */
export function classifyRouteTier(provider, model) {
  const p = String(provider ?? "").toLowerCase().trim();
  const m = String(model ?? "").toLowerCase().trim();

  if (p.startsWith("deepseek")) {
    return { tierId: "broke", badge: BROKE_BADGE };
  }
  if (/(astra|fable|opus|carbon)/.test(m)) {
    return { tierId: "performance", badge: PERFORMANCE_BADGE };
  }
  if (/(sonnet|sol|argon)/.test(m) || m === "gpt-5.3-codex" || m === "gemini-3.1-pro-preview") {
    return { tierId: "normal", badge: NORMAL_BADGE };
  }
  if (p.startsWith("moonshotai") || /(terra|haiku)/.test(m)) {
    return { tierId: "economy", badge: ECONOMY_BADGE };
  }
  if (/(flash-lite|free|qwen)/.test(m)) {
    return { tierId: "broke", badge: BROKE_BADGE };
  }
  return { tierId: "normal", badge: NORMAL_BADGE };
}

/**
 * Load the tier display summary for a set of authorized models.
 *
 * The source plan file is read best-effort: when it exists we record its
 * modification time and a parse signal; when it is absent (or unreadable) we
 * still return a summary and record the note — it never throws.
 *
 * Returns `{ tiers, modelTierMap, source }` where:
 *   - `tiers`       — four entries `{ id, badge, name, referenceModels,
 *                      matchedAuthorized }` (badges are advisory)
 *   - `modelTierMap`— keyed by `provider/model`, each `{ provider, model,
 *                      tierId, badge }`
 *   - `source`      — `{ path, read, parsed, mtimeMs?, note? }`
 */
export async function loadModelTiers({ authorizedModels = [], sourcePath = DEFAULT_SOURCE_PATH } = {}) {
  const source = { path: sourcePath, read: false, parsed: false, mtimeMs: null, note: null };
  if (!sourcePath) {
    source.note = "not configured; using built-in fallback tiers";
  } else {
    try {
      const stat = await fs.stat(sourcePath);
      source.mtimeMs = stat.mtimeMs;
      try {
        const raw = await fs.readFile(sourcePath, "utf8");
        source.read = true;
        source.parsed = raw.includes("高价值模型") && raw.includes("四档模式");
      } catch (error) {
        source.note = `read failed: ${String(error?.message ?? error)}`;
      }
    } catch {
      source.note = "file not found; using built-in fallback tiers";
    }
  }

  const modelTierMap = {};
  const authorized = Array.isArray(authorizedModels) ? authorizedModels : [];
  for (const row of authorized) {
    const provider = String(row?.provider ?? "").trim();
    const model = String(row?.model ?? "").trim();
    if (provider === "" || model === "") continue;
    const key = `${provider}/${model}`;
    const tier = classifyRouteTier(provider, model);
    modelTierMap[key] = { provider, model, tierId: tier.tierId, badge: tier.badge };
  }

  const tiers = Object.values(TIER_META).map((meta) => {
    const matchedAuthorized = Object.values(modelTierMap)
      .filter((entry) => entry.tierId === meta.id)
      .map((entry) => `${entry.provider}/${entry.model}`);
    return {
      id: meta.id,
      badge: meta.badge,
      name: meta.name,
      referenceModels: INTERNAL_BASELINE.referenceModels[meta.id] ?? [],
      matchedAuthorized,
    };
  });

  return { tiers, modelTierMap, source };
}
