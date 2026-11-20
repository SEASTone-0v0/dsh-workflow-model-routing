/**
 * @local/dsh-workflow-model-routing — four-mode config schema + migration (phase A).
 *
 * Phase A is the data layer only. This module owns:
 *   - the four-mode schema (economy / normal / performance / broke) and its presets,
 *   - the migration that seeds "normal" from the existing role store WITHOUT
 *     touching that store or the official `subagent-model-selection-settings`
 *     entry (migration backs up, never silently overwrites),
 *   - validation for the save/enable separation and the authorization rule
 *     ("enabling a mode never expands authorization").
 *
 * It is self-contained (zero imports from index.js) so it can be unit-tested in
 * isolation. Persistence writes a NEW store file `dsh-economy-mode.state.json`,
 * separate from `dsh-workflow-model-routing.state.json`, so the existing v3 role
 * store and the official settings entry stay byte-for-byte intact.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const MODES_FILE = "dsh-economy-mode.state.json";
export const MODE_SCHEMA_VERSION = 1;
export const MODE_IDS = Object.freeze(["economy", "normal", "performance", "broke"]);

export const MODE_LABELS = Object.freeze({
  economy: "经济",
  normal: "普通",
  performance: "性能",
  broke: "穷鬼",
});

export const MODE_DESCRIPTIONS = Object.freeze({
  economy:
    "经济：GPT 不可用或额度不足时，优先高质量、成本可控的国产模型。这是偏好而非禁用，任何已授权模型都可按需选用。",
  normal:
    "普通：在质量、速度与成本之间取平衡，按任务特点匹配合适的模型。",
  performance:
    "性能：质量与复杂任务优先，允许更高的推理预算与异构复核。",
  broke:
    "穷鬼：极限节约成本，优先低开销模型。这是成本偏好，不禁用任何已授权模型。",
});

/**
 * User-facing interpretation per mode (v2.3). `summary` is the copy shown next
 * to the mode selector; `quip` is an optional one-liner (broke only).
 */
export const MODE_INTERPRETATIONS = Object.freeze({
  economy: {
    summary:
      "🟡 经济：GPT 不可用或额度不足时，优先高质量、成本可控的国产模型（偏好，非禁用）。",
    quip: null,
  },
  normal: {
    summary:
      "🟢 普通：质量、速度、成本三者均衡，按任务特点匹配模型。",
    quip: null,
  },
  performance: {
    summary:
      "🔵 性能：质量与复杂任务优先，允许更高推理预算与异构复核。",
    quip: null,
  },
  broke: {
    summary:
      "🔴 穷鬼：极限节约成本，优先低开销模型（偏好，非禁用）。",
    quip: null,
  },
});

const REASONING_POLICIES = Object.freeze(["default", "fixed", "smart"]);

/* ------------------------------------------------------------------ *
 * Local route helpers (kept here to avoid an index.js import cycle)
 * ------------------------------------------------------------------ */

function routeKey(provider, model) {
  return `${String(provider ?? "")}\u0000${String(model ?? "")}`;
}

export function cleanRoute(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (provider === "" || model === "") return null;
  const reasoning = cleanReasoningConfig(value);
  return { provider, model, ...reasoning };
}

function cleanReasoningConfig(value, fallbackPolicy = "default") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { reasoningPolicy: fallbackPolicy, reasoningEffort: null, smartMap: null };
  }
  // Accept both the uniform flat shape (reasoningPolicy/reasoningEffort) and the
  // older shape (policy/fixedEffort). A legacy route that only carried a bare
  // `reasoningEffort` string is an implicit "fixed" tier, not "default".
  const explicitPolicy = REASONING_POLICIES.includes(value.reasoningPolicy)
    ? value.reasoningPolicy
    : REASONING_POLICIES.includes(value.policy)
      ? value.policy
      : null;
  const reasoningEffort =
    typeof value.reasoningEffort === "string" && value.reasoningEffort.trim() !== ""
      ? value.reasoningEffort.trim()
      : typeof value.fixedEffort === "string" && value.fixedEffort.trim() !== ""
        ? value.fixedEffort.trim()
        : null;
  const reasoningPolicy =
    explicitPolicy !== null ? explicitPolicy : reasoningEffort !== null ? "fixed" : fallbackPolicy;
  // Never guess a difficulty→effort mapping: a missing tier stays null.
  const smartMap =
    value.smartMap !== null && typeof value.smartMap === "object" && !Array.isArray(value.smartMap)
      ? {
          low: typeof value.smartMap.low === "string" && value.smartMap.low.trim() !== "" ? value.smartMap.low.trim() : null,
          medium: typeof value.smartMap.medium === "string" && value.smartMap.medium.trim() !== "" ? value.smartMap.medium.trim() : null,
          high: typeof value.smartMap.high === "string" && value.smartMap.high.trim() !== "" ? value.smartMap.high.trim() : null,
        }
      : null;
  return { reasoningPolicy, reasoningEffort, smartMap };
}

function cleanLead(value, fallback = { provider: "openai", model: "gpt-6.1-sol" }) {
  const route = cleanRoute(value);
  if (route !== null) return route;
  const reasoning = cleanReasoningConfig(value);
  return { provider: fallback.provider, model: fallback.model, ...reasoning };
}

/**
 * Legacy v2.3 broke preset used `吃土去` as the advisor condition sentinel.
 * It is now a neutral cost-saving preference; normalize ONLY that exact
 * sentinel (trimmed) so any custom condition the user wrote is preserved.
 */
const LEGACY_ADVISOR_CONDITION_SENTINEL = "吃土去";
const NEUTRAL_BROKE_ADVISOR_CONDITION = "极限节约时默认关闭，可按需开启";

export function normalizeAdvisorCondition(condition) {
  return typeof condition === "string" && condition.trim() === LEGACY_ADVISOR_CONDITION_SENTINEL
    ? NEUTRAL_BROKE_ADVISOR_CONDITION
    : condition;
}

function cleanAdvisor(value) {
  const route = cleanRoute(value);
  const reasoning = cleanReasoningConfig(value);
  return {
    enabled: value?.enabled !== false,
    provider: route?.provider ?? "openai",
    model: route?.model ?? "gpt-6-astra",
    reasoningPolicy: reasoning.reasoningPolicy,
    reasoningEffort: reasoning.reasoningEffort,
    smartMap: reasoning.smartMap,
    condition: normalizeAdvisorCondition(typeof value?.condition === "string" ? value.condition : ""),
  };
}

function cleanTeam(value, preset) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const budgetLimit =
    source.budgetLimit !== null && typeof source.budgetLimit === "object"
      ? {
          maxCost:
            typeof source.budgetLimit.maxCost === "number" && Number.isFinite(source.budgetLimit.maxCost)
              ? source.budgetLimit.maxCost
              : null,
          note: typeof source.budgetLimit.note === "string" ? source.budgetLimit.note : "",
        }
      : null;
  return {
    planner: cleanRoute(source.planner),
    executor: cleanRoute(source.executor),
    reviewer: cleanRoute(source.reviewer),
    advisor: cleanRoute(source.advisor),
    maxConcurrentWorkers:
      typeof source.maxConcurrentWorkers === "number" && Number.isInteger(source.maxConcurrentWorkers)
        ? source.maxConcurrentWorkers
        : preset.maxConcurrentWorkers,
    writeScopeIsolation:
      typeof source.writeScopeIsolation === "boolean" ? source.writeScopeIsolation : preset.writeScopeIsolation,
    failureRetryLimit:
      typeof source.failureRetryLimit === "number" && Number.isInteger(source.failureRetryLimit)
        ? source.failureRetryLimit
        : preset.failureRetryLimit,
    escalationThreshold:
      typeof source.escalationThreshold === "string" ? source.escalationThreshold : preset.escalationThreshold,
    budgetLimit,
  };
}

function cleanTaskTargets(value, preset) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    native: {
      enabled:
        typeof source.native?.enabled === "boolean" ? source.native.enabled : preset.native.enabled,
    },
    taskBoard: {
      enabled:
        typeof source.taskBoard?.enabled === "boolean"
          ? source.taskBoard.enabled
          : preset.taskBoard.enabled,
    },
  };
}

/** Mirrors the role store's persisted-role shape (validateStoredRole in index.js). */
function normalizeStoredRole(row) {
  const id = typeof row?.id === "string" ? row.id : "";
  if (id === "") return null;
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    purpose: typeof row.purpose === "string" ? row.purpose : "",
    kind: row.kind === "reviewer" || row.kind === "privacy" ? row.kind : "standard",
    enabled: row.enabled !== false,
    primary: cleanRoute(row.primary),
    backup: cleanRoute(row.backup),
    upgrade: cleanRoute(row.upgrade),
    switchRule: "confirm",
    ...(Array.isArray(row.pairings)
      ? {
          pairings: row.pairings
            .filter((pairing) => pairing !== null && typeof pairing === "object")
            .map((pairing) => ({
              authorProviders: Array.isArray(pairing.authorProviders)
                ? pairing.authorProviders.filter((entry) => typeof entry === "string")
                : [],
              reviewer: cleanRoute(pairing.reviewer),
            }))
            .filter((pairing) => pairing.reviewer !== null),
        }
      : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
  };
}

function normalizeRoles(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const row of input) {
    const normalized = normalizeStoredRole(row);
    if (normalized === null || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Presets (editable seeds — documented defaults, never enforced guarantees)
 * ------------------------------------------------------------------ */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * Recommended role matrices (v2.5) — full primary/backup/upgrade per mode
 * ------------------------------------------------------------------ */

const RECOMMENDED_ROLE_IDENTITY = Object.freeze([
  { id: "lead", name: "总协调员", purpose: "澄清、拆解、协调、聚合；不代替Host状态权威" },
  { id: "secretary", name: "任务秘书", purpose: "仅处理获准出云的任务分类、摘要、计划草案" },
  { id: "architect", name: "方案架构师", purpose: "依赖、契约、验收标准；小任务由lead兼任" },
  { id: "researcher", name: "资料研究员", purpose: "检索、来源对比、反证；必须附证据定位" },
  { id: "long-document", name: "长文整理员", purpose: "长材料与中文文稿；端点及长度未验证" },
  { id: "analyst", name: "数据分析员", purpose: "数据口径和解释；数值由计算工具产生" },
  { id: "editor", name: "文稿编辑员", purpose: "简单编辑与文稿执行；走Flash，Office结构由相应工具负责" },
  { id: "creative-writer", name: "创意撰稿员", purpose: "创作候选，按用户试稿选择，不声称风格排名" },
  { id: "coder", name: "代码执行员", purpose: "复杂代码实现；执行与代码走Pro，通过仓库样例后启用" },
  { id: "multimodal-researcher", name: "图文研究员", purpose: "图文材料分析候选；输入模态与工具链待验证" },
  { id: "vision", name: "图像解读员", purpose: "图片解读候选，关键数字独立核对" },
  { id: "architecture-challenger", name: "方案质疑员", purpose: "按需挑战方案，不假定与Sol真实异构" },
]);

const RECOMMENDED_REVIEWER_ID = "reviewer";
const RECOMMENDED_REVIEWER_NAME = "独立审查员";
const RECOMMENDED_REVIEWER_PURPOSE =
  "默认 DeepSeek Pro 独立读原始证据复核；同模型复核仅另一次证据检查、不声称异构；高风控可人工改 Sol";
const RECOMMENDED_PRIVACY_ID = "privacy-memory";
const RECOMMENDED_PRIVACY_NAME = "隐私与记忆管理员";
const RECOMMENDED_PRIVACY_PURPOSE = "画像、秘密、来源授权与删除；禁用云端回退，生产记忆未放行";

/** All 14 recommended role ids (12 standard + reviewer + privacy). */
const RECOMMENDED_ROLE_IDS = Object.freeze(
  RECOMMENDED_ROLE_IDENTITY.map((r) => r.id).concat([RECOMMENDED_REVIEWER_ID, RECOMMENDED_PRIVACY_ID]),
);

/** "provider/model" shorthand → a default-reasoning route (or null). */
function rts(spec) {
  if (typeof spec !== "string" || spec === "") return null;
  const idx = spec.indexOf("/");
  if (idx <= 0) return null;
  return {
    provider: spec.slice(0, idx),
    model: spec.slice(idx + 1),
    reasoningPolicy: "default",
    reasoningEffort: null,
    smartMap: null,
  };
}

/** Economy base matrix: [primary, backup, upgrade] per standard role. */
const ECONOMY_MATRIX = Object.freeze({
  lead: ["openai/gpt-6.1-sol", "openai/gpt-5.6-sol", "openai/gpt-6-astra"],
  secretary: ["deepseek-account/deepseek-flash", "deepseek-account/deepseek-v4-pro", null],
  architect: ["openai/gpt-6.1-sol", "openai/gpt-5.6-sol", "openai/gpt-6-astra"],
  researcher: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", "kimi-subscription/k3"],
  "long-document": ["kimi-subscription/k3", "deepseek-account/deepseek-v4-pro", null],
  analyst: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  editor: ["deepseek-account/deepseek-flash", "deepseek-account/deepseek-v4-pro", null],
  "creative-writer": ["kimi-subscription/k3", "deepseek-account/deepseek-v4-pro", null],
  coder: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  "multimodal-researcher": ["google/gemini-3.1-pro-preview", "deepseek-account/deepseek-v4-pro", null],
  vision: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  "architecture-challenger": ["openai/gpt-6-astra", "deepseek-account/deepseek-v4-pro", null],
});

/** Normal-mode additions over economy (only the upgrade slot changes). */
const NORMAL_UPGRADES = Object.freeze({
  "long-document": "kimi-subscription/k3.1-pro",
  "creative-writer": "kimi-subscription/k3.1-pro",
  coder: "openai/gpt-5.3-codex",
  "multimodal-researcher": "google/gemini-4-argon",
  vision: "google/gemini-4-argon",
});

/** Performance-mode full-route overrides (primary/backup/upgrade). */
const PERFORMANCE_MATRIX = Object.freeze({
  "long-document": ["kimi-subscription/k3.1-pro", "kimi-subscription/k3", null],
  "creative-writer": ["kimi-subscription/k3.1-pro", "kimi-subscription/k3", null],
  coder: ["openai/gpt-5.3-codex", "deepseek-account/deepseek-v4-pro", null],
  "multimodal-researcher": ["google/gemini-4-argon", "google/gemini-3.1-pro-preview", null],
  vision: ["google/gemini-4-argon", "deepseek-account/deepseek-v4-pro", null],
});

/** Broke matrix: a RECOMMENDED low-cost preset (upgrade slots left empty by default). */
const BROKE_MATRIX = Object.freeze({
  lead: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-v4-pro", null],
  secretary: ["deepseek-account/deepseek-flash", "deepseek-account/deepseek-v4-pro", null],
  architect: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-v4-pro", null],
  researcher: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  "long-document": ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-v4-pro", null],
  analyst: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  editor: ["deepseek-account/deepseek-flash", "deepseek-account/deepseek-v4-pro", null],
  "creative-writer": ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-v4-pro", null],
  coder: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  "multimodal-researcher": ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-v4-pro", null],
  vision: ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-flash", null],
  "architecture-challenger": ["deepseek-account/deepseek-v4-pro", "deepseek-account/deepseek-v4-pro", null],
});

function matrixFor(modeId) {
  if (modeId === "broke") return BROKE_MATRIX;
  if (modeId === "performance") return { ...ECONOMY_MATRIX, ...PERFORMANCE_MATRIX };
  const base = { ...ECONOMY_MATRIX };
  if (modeId === "normal") {
    for (const [id, upgrade] of Object.entries(NORMAL_UPGRADES)) {
      if (base[id]) base[id] = [base[id][0], base[id][1], upgrade];
    }
  }
  return base;
}

/** The reviewer role (pairings) for a mode. Economy/normal/performance: OpenAI author→v4-pro, others→sol. Broke: all→v4-pro. */
function recommendedReviewerRole(modeId) {
  const v4pro = rts("deepseek-account/deepseek-v4-pro");
  const sol = rts("openai/gpt-6.1-sol");
  const otherProviders = ["kimi-subscription", "google", "deepseek-account"];
  const pairings =
    modeId === "broke"
      ? [{ authorProviders: ["openai"].concat(otherProviders), reviewer: v4pro }]
      : [
          { authorProviders: ["openai"], reviewer: v4pro },
          { authorProviders: otherProviders, reviewer: sol },
        ];
  return {
    id: RECOMMENDED_REVIEWER_ID,
    name: RECOMMENDED_REVIEWER_NAME,
    purpose: RECOMMENDED_REVIEWER_PURPOSE,
    kind: "reviewer",
    enabled: true,
    primary: null,
    backup: null,
    upgrade: null,
    switchRule: "confirm",
    pairings,
  };
}

function recommendedPrivacyRole() {
  return {
    id: RECOMMENDED_PRIVACY_ID,
    name: RECOMMENDED_PRIVACY_NAME,
    purpose: RECOMMENDED_PRIVACY_PURPOSE,
    kind: "privacy",
    enabled: true,
    primary: null,
    backup: null,
    upgrade: null,
    switchRule: "confirm",
    status: "manual-or-verified-local-only",
  };
}

/** Full recommended role list (14 roles) for one mode, normalized. */
export function recommendedRoles(modeId) {
  const matrix = matrixFor(modeId);
  const roles = RECOMMENDED_ROLE_IDENTITY.map((ident) => {
    const slots = matrix[ident.id];
    return {
      id: ident.id,
      name: ident.name,
      purpose: ident.purpose,
      kind: "standard",
      enabled: true,
      primary: rts(slots && slots[0]),
      backup: rts(slots && slots[1]),
      upgrade: rts(slots && slots[2]),
      switchRule: "confirm",
    };
  });
  roles.push(recommendedReviewerRole(modeId));
  roles.push(recommendedPrivacyRole());
  return normalizeRoles(roles);
}

/** Merge custom roles (ids outside the 14 recommended) into a recommended list, preserving an existing `enabled:false`. */
function mergeRecommendedWithExisting(recommended, existing) {
  const existingNorm = normalizeRoles(existing);
  const byId = new Map(existingNorm.map((r) => [r.id, r]));
  const merged = recommended.map((r) => {
    const prev = byId.get(r.id);
    if (prev && prev.enabled === false) return { ...r, enabled: false };
    return r;
  });
  const ids = new Set(merged.map((r) => r.id));
  for (const row of existingNorm) {
    if (!RECOMMENDED_ROLE_IDS.includes(row.id) && !ids.has(row.id)) merged.push(row);
  }
  return merged;
}

/** Full recommended preset for every mode (used by GET /modes and restore-preset). */
export function recommendedPresets() {
  return {
    economy: economyPreset(recommendedRoles("economy")),
    normal: normalPreset(recommendedRoles("normal")),
    performance: performancePreset(recommendedRoles("performance")),
    broke: brokePreset(recommendedRoles("broke")),
  };
}

function baseTeam({ maxConcurrentWorkers = 2, failureRetryLimit = null, escalationThreshold = null } = {}) {
  return {
    planner: null,
    executor: null,
    reviewer: null,
    advisor: null,
    maxConcurrentWorkers,
    writeScopeIsolation: true,
    failureRetryLimit,
    escalationThreshold,
    budgetLimit: null,
  };
}

function baseTaskTargets({ taskBoard = false } = {}) {
  return { native: { enabled: true }, taskBoard: { enabled: taskBoard } };
}

function buildMode({ modeId, roles, lead, advisor, team, taskTargets, source, note }) {
  return {
    modeId,
    label: MODE_LABELS[modeId],
    description: MODE_DESCRIPTIONS[modeId],
    interpretation: MODE_INTERPRETATIONS[modeId] ?? null,
    schemaVersion: MODE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date().toISOString(),
    source,
    lead,
    upgradeAdvisor: advisor,
    roles: clone(roles),
    team,
    taskTargets,
    inheritance: { from: source, note },
  };
}

/** Economy preset — the plan's default low-cost posture. */
export function economyPreset(roles) {
  return buildMode({
    modeId: "economy",
    roles,
    lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
    advisor: {
      enabled: true,
      provider: "openai",
      model: "gpt-6-astra",
      reasoningPolicy: "default",
      reasoningEffort: null,
      smartMap: null,
      condition: "两次有证据失败或高风险决策才咨询",
    },
    team: baseTeam({ maxConcurrentWorkers: 2, failureRetryLimit: 2, escalationThreshold: "两次有证据失败" }),
    taskTargets: baseTaskTargets(),
    source: "preset",
    note: "经济模式预设：默认低开销，不设硬预算上限（无价格数据）。",
  });
}

/** Normal preset — the existing configuration's migration target. */
export function normalPreset(roles) {
  return buildMode({
    modeId: "normal",
    roles,
    lead: { provider: "openai", model: "gpt-6.1-sol", reasoningPolicy: "default", reasoningEffort: null, smartMap: null },
    advisor: {
      enabled: true,
      provider: "openai",
      model: "gpt-6-astra",
      reasoningPolicy: "default",
      reasoningEffort: null,
      smartMap: null,
      condition: "按需咨询，不默认双开",
    },
    team: baseTeam({ maxConcurrentWorkers: 2, failureRetryLimit: null, escalationThreshold: null }),
    taskTargets: baseTaskTargets(),
    source: "migrated",
    note: "普通模式继承现有角色与授权模型，是迁移起点。",
  });
}

/** Performance preset — allows stronger models and higher reasoning budget. */
export function performancePreset(roles) {
  return buildMode({
    modeId: "performance",
    roles,
    lead: {
      provider: "openai",
      model: "gpt-6.1-sol",
      reasoningPolicy: "smart",
      reasoningEffort: null,
      smartMap: { low: "low", medium: "medium", high: "xhigh" },
    },
    advisor: {
      enabled: true,
      provider: "openai",
      model: "gpt-6-astra",
      reasoningPolicy: "fixed",
      reasoningEffort: "xhigh",
      smartMap: null,
      condition: "高风险或复杂架构才咨询",
    },
    team: baseTeam({ maxConcurrentWorkers: null, failureRetryLimit: null, escalationThreshold: null }),
    taskTargets: baseTaskTargets({ taskBoard: false }),
    source: "preset",
    note: "性能模式预设：允许更强执行模型与异构复核，并发与预算不预设上限。",
  });
}

/** Broke preset — extreme low cost mode (preference, not a hard constraint). */
export function brokePreset(roles) {
  return buildMode({
    modeId: "broke",
    roles: normalizeRoles(roles),
    lead: {
      provider: "deepseek-account",
      model: "deepseek-v4-pro",
      reasoningPolicy: "default",
      reasoningEffort: null,
      smartMap: null,
    },
    advisor: {
      enabled: false,
      provider: null,
      model: null,
      reasoningPolicy: "default",
      reasoningEffort: null,
      smartMap: null,
      condition: "极限节约时默认关闭，可按需开启",
    },
    team: baseTeam({ maxConcurrentWorkers: 1, failureRetryLimit: 1, escalationThreshold: null }),
    taskTargets: baseTaskTargets(),
    source: "preset",
    note: "穷鬼模式预设：极限节约成本，优先低开销模型（偏好，非禁用）。",
  });
}

/* ------------------------------------------------------------------ *
 * Store seeding and migration
 * ------------------------------------------------------------------ */

/**
 * Seed the three-mode store from the existing role store's roles. "normal"
 * inherits the roles verbatim (after normalization); economy/performance start
 * from the same roles with their own lead/team/reasoning presets. Each mode owns
 * its own roles copy, so later edits never cross-contaminate.
 */
export function seedModesStore({ roles = [], migration = null, now = new Date().toISOString() } = {}) {
  const existing = normalizeRoles(roles);
  const modes = {};
  for (const modeId of MODE_IDS) {
    const modeRoles = mergeRecommendedWithExisting(recommendedRoles(modeId), existing);
    if (modeId === "normal") modes[modeId] = normalPreset(modeRoles);
    else if (modeId === "economy") modes[modeId] = economyPreset(modeRoles);
    else if (modeId === "performance") modes[modeId] = performancePreset(modeRoles);
    else if (modeId === "broke") modes[modeId] = brokePreset(modeRoles);
    modes[modeId].updatedAt = now;
  }
  return {
    schemaVersion: MODE_SCHEMA_VERSION,
    currentModeId: "normal",
    updatedAt: now,
    migration: migration ?? null,
    activeSnapshot: { modeId: "normal", config: clone(modes.normal), enabledAt: now },
    modes,
  };
}

/**
 * Backfill any missing mode from an existing store. Older state files (v2.2 and
 * earlier) only carried economy/normal/performance; when a mode is absent we
 * synthesize it from the matching preset so the file can be read and switched to
 * broke (or any missing mode) without deleting the existing config. Returns the
 * store with all four modes present and, when anything was filled, a
 * `filledModes` array naming what was synthesized.
 */
export function ensureAllModes(store, now = new Date().toISOString()) {
  const source = store !== null && typeof store === "object" ? store : {};
  const modesObj =
    source.modes !== null && typeof source.modes === "object" && !Array.isArray(source.modes)
      ? source.modes
      : {};
  const baseRoles = Array.isArray(modesObj.normal?.roles) ? modesObj.normal.roles : [];
  const nextModes = {};
  const filledModes = [];
  for (const modeId of MODE_IDS) {
    if (modesObj[modeId] !== null && typeof modesObj[modeId] === "object") {
      nextModes[modeId] = modesObj[modeId];
    } else {
      const preset =
        modeId === "broke"
          ? brokePreset(baseRoles)
          : modeId === "economy"
            ? economyPreset(baseRoles)
            : modeId === "performance"
              ? performancePreset(baseRoles)
              : normalPreset(baseRoles);
      preset.updatedAt = now;
      nextModes[modeId] = preset;
      filledModes.push(modeId);
    }
  }
  return {
    ...source,
    modes: nextModes,
    ...(filledModes.length > 0 ? { filledModes } : {}),
  };
}

/**
 * Back up the existing role store, then return its parsed roles (read-only). The
 * existing file is never modified: only a timestamped `.bak-<ts>` snapshot is
 * written beside it. Returns `null` when there is nothing to migrate.
 */
export async function backupExistingStore(existingFilePath, now = Date.now()) {
  if (existingFilePath === "") return null;
  let raw;
  try {
    raw = await fs.readFile(existingFilePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const roles = Array.isArray(parsed.roles) ? normalizeRoles(parsed.roles) : [];
  const backupFile = `${existingFilePath}.bak-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  let backedUp = false;
  let backupError = null;
  try {
    await fs.copyFile(existingFilePath, backupFile);
    backedUp = true;
  } catch (error) {
    backupError = String(error?.message ?? error);
  }
  return {
    sourceFile: path.basename(existingFilePath),
    backupFile: backedUp ? backupFile : null,
    backedUp,
    ...(backupError !== null ? { backupError } : {}),
    migratedAt: new Date(now).toISOString(),
    sourceRevision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
    sourceVersion: Number.isInteger(parsed.version) ? parsed.version : 0,
    roles,
  };
}

/* ------------------------------------------------------------------ *
 * Mode normalization + validation (save/enable separation)
 * ------------------------------------------------------------------ */

/**
 * Normalize one mode config from an untrusted body. Returns the normalized mode
 * (or the matching preset when the body is unusable) — save is a draft write and
 * only rejects a structurally invalid modeId.
 */
export function normalizeMode(modeId, input) {
  if (!MODE_IDS.includes(modeId)) {
    throw Object.assign(new Error(`未知模式 ${modeId}`), { code: "UNKNOWN_MODE" });
  }
  const source =
    input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preset =
    modeId === "economy"
      ? economyPreset([])
      : modeId === "performance"
        ? performancePreset([])
        : modeId === "broke"
          ? brokePreset([])
          : normalPreset([]);
  const roles = normalizeRoles(source.roles);
  const mode = {
    modeId,
    label: MODE_LABELS[modeId],
    description: MODE_DESCRIPTIONS[modeId],
    interpretation: MODE_INTERPRETATIONS[modeId] ?? null,
    schemaVersion: MODE_SCHEMA_VERSION,
    revision: Number.isInteger(source.revision) ? source.revision : 0,
    updatedAt: new Date().toISOString(),
    source: typeof source.source === "string" ? source.source : "user",
    lead: cleanLead(source.lead, preset.lead),
    upgradeAdvisor: cleanAdvisor(source.upgradeAdvisor ?? source.advisor),
    roles: roles.length > 0 ? roles : normalizeRoles(preset.roles),
    team: cleanTeam(source.team, preset.team),
    taskTargets: cleanTaskTargets(source.taskTargets, preset.taskTargets),
    inheritance: {
      from: typeof source.inheritance?.from === "string" ? source.inheritance.from : "user",
      note: typeof source.inheritance?.note === "string" ? source.inheritance.note : "",
    },
  };
  return mode;
}

/**
 * Read-time display canonicalization: override only the mode's user-facing
 * label/description/interpretation with the canonical v2.6 values, WITHOUT
 * touching revision/updatedAt/routes/team/taskTargets or the stored record.
 * This lets GET /modes correct stale display text without a save.
 */
export function canonicalizeModeDisplay(mode) {
  if (mode === null || typeof mode !== "object") return mode;
  const modeId = mode.modeId;
  const out = {
    ...mode,
    label: MODE_LABELS[modeId] ?? mode.label,
    description: MODE_DESCRIPTIONS[modeId] ?? mode.description,
    interpretation: MODE_INTERPRETATIONS[modeId] ?? mode.interpretation ?? null,
  };
  // Read-only display normalization for the legacy advisor-condition sentinel.
  // Only the condition string changes; the advisor route (provider/model/
  // reasoning) and every other mode field are untouched.
  if (out.upgradeAdvisor !== null && typeof out.upgradeAdvisor === "object") {
    out.upgradeAdvisor = {
      ...out.upgradeAdvisor,
      condition: normalizeAdvisorCondition(out.upgradeAdvisor.condition),
    };
  }
  return out;
}

/** Collect every referenced route (lead, advisor, roles, team) from a mode. */
export function referencedRoutes(mode) {
  const routes = [];
  const seen = new Set();
  const push = (route) => {
    const clean = cleanRoute(route);
    if (clean === null) return;
    const key = routeKey(clean.provider, clean.model);
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(clean);
  };
  push(mode.lead);
  if (mode.upgradeAdvisor?.enabled !== false) push(mode.upgradeAdvisor);
  for (const role of mode.roles ?? []) {
    push(role.primary);
    push(role.backup);
    push(role.upgrade);
    for (const pairing of role.pairings ?? []) push(pairing.reviewer);
  }
  const team = mode.team ?? {};
  push(team.planner);
  push(team.executor);
  push(team.reviewer);
  push(team.advisor);
  return routes;
}

/**
 * Every reasoning-capable position in a mode, in traversal order, WITHOUT
 * deduplication. Enable-time capability validation must check each position's
 * own fixed/smart config against the route's declared efforts — deduplicating by
 * provider+model would skip a position that requests a different tier on the
 * same route.
 */
export function reasoningPositions(mode) {
  const positions = [];
  const push = (label, rawRoute) => {
    const route = cleanRoute(rawRoute);
    if (route === null) return;
    positions.push({
      label,
      provider: route.provider,
      model: route.model,
      reasoningPolicy: route.reasoningPolicy,
      reasoningEffort: route.reasoningEffort,
      smartMap: route.smartMap,
    });
  };
  push("Lead", mode?.lead);
  if (mode?.upgradeAdvisor?.enabled !== false) push("升级顾问", mode?.upgradeAdvisor);
  for (const role of mode?.roles ?? []) {
    push(`角色 ${role?.id} 主用`, role?.primary);
    push(`角色 ${role?.id} 备用`, role?.backup);
    push(`角色 ${role?.id} 升级`, role?.upgrade);
    for (const pairing of role?.pairings ?? []) push(`角色 ${role?.id} 配对`, pairing?.reviewer);
  }
  const team = mode?.team ?? {};
  push("团队 规划者", team.planner);
  push("团队 执行者", team.executor);
  push("团队 复核者", team.reviewer);
  push("团队 顾问", team.advisor);
  return positions;
}

/**
 * Enable-time validation. A mode must:
 *   - have a lead route and every referenced route be a subset of the authorized
 *     set (enabling a mode never expands authorization),
 *   - have a structurally consistent reasoning config per position (fixed needs
 *     an effort, smart needs a map),
 *   - have every fixed/smart position verify against that route's DECLARED
 *     efforts via the capability resolver; an unknown/stale capability blocks a
 *     fixed/smart position because its tier cannot be proven.
 *
 * `options` may be an array (legacy authorizedModels) or
 * `{ authorizedModels, capabilityFor }`, where `capabilityFor(provider, model)`
 * returns `{ status, efforts }` (`status === "ok"` and `efforts: [{id}]` are
 * required to verify a fixed/smart position).
 */
export function validateModeForEnable(mode, options = {}) {
  const authorizedModels = Array.isArray(options) ? options : (options?.authorizedModels ?? []);
  const capabilityFor =
    typeof options?.capabilityFor === "function" ? options.capabilityFor : () => undefined;
  const errors = [];

  const authorizedKeys = new Set(
    (authorizedModels ?? []).map((row) => routeKey(row?.provider, row?.model)),
  );
  const lead = cleanRoute(mode?.lead);
  if (lead === null) errors.push("Lead 模型未配置");
  else if (!authorizedKeys.has(routeKey(lead.provider, lead.model))) {
    errors.push(`Lead 路线 ${lead.provider}/${lead.model} 未获授权`);
  }
  for (const route of referencedRoutes(mode)) {
    if (!authorizedKeys.has(routeKey(route.provider, route.model))) {
      errors.push(`被引用路线 ${route.provider}/${route.model} 未获授权`);
    }
  }
  for (const position of reasoningPositions(mode)) {
    if (position.reasoningPolicy === "fixed" && position.reasoningEffort === null) {
      errors.push(`${position.label} 推理政策为 fixed 但未提供固定档位`);
    }
    if (
      position.reasoningPolicy === "smart" &&
      (position.smartMap === null ||
        (position.smartMap.low === null &&
          position.smartMap.medium === null &&
          position.smartMap.high === null))
    ) {
      errors.push(`${position.label} 推理政策为 smart 但未提供档位映射`);
    }
  }
  for (const position of reasoningPositions(mode)) {
    if (position.reasoningPolicy === "default") continue;
    const capability = capabilityFor(position.provider, position.model);
    const declaredIds =
      capability?.status === "ok" && Array.isArray(capability?.efforts)
        ? capability.efforts.map((entry) => entry.id)
        : null;
    if (declaredIds === null) {
      errors.push(
        `${position.label} 路线 ${position.provider}/${position.model} 的能力未检测或已过期，无法验证推理档位`,
      );
      continue;
    }
    if (position.reasoningPolicy === "fixed") {
      if (position.reasoningEffort === null || !declaredIds.includes(position.reasoningEffort)) {
        errors.push(
          `${position.label} 固定档位 ${position.reasoningEffort ?? "(未设置)"} 不在 ${position.provider}/${position.model} 的已声明档位中`,
        );
      }
    } else if (position.reasoningPolicy === "smart") {
      for (const tier of ["low", "medium", "high"]) {
        const mapped = position.smartMap?.[tier];
        if (mapped !== null && mapped !== undefined && mapped !== "" && !declaredIds.includes(mapped)) {
          errors.push(
            `${position.label} smart 映射 ${tier}→${mapped} 不在 ${position.provider}/${position.model} 的已声明档位中`,
          );
        }
      }
    }
  }
  const enabledRoles = (mode?.roles ?? []).filter(
    (role) => role.enabled !== false && role.kind === "standard",
  );
  for (const role of enabledRoles) {
    if (role.primary === null) {
      errors.push(`启用角色 ${role.id} 缺少主用路线`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Persistence — atomic tmp + rename
 * ------------------------------------------------------------------ */

export async function readModesFile(file) {
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

export async function writeModesFile(file, payload) {
  if (file === "") return false;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, "utf8");
  await fs.rename(temporary, file);
  return true;
}
