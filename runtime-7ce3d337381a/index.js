/**
 * @local/dsh-workflow-model-routing — host half (v2.2.0, role-first + reasoningEffort).
 *
 * What changed from v1.x
 * ----------------------
 * v1 was model-first: the official `subagent-model-selection-settings` entry
 * (enabled + allowedModels) was the only state, and roles were decorations
 * inferred from a free-form description. This version is role-first:
 *
 *   roles (persisted, versioned)  ─┬─ primary / backup / upgrade route
 *   extra allowed models          ─┘
 *              │
 *              ▼  derived, never edited directly
 *   official allowedModels = union(referenced role routes, extra models)
 *
 * The official entry stays the single authorization authority (the Host policy
 * the subagent tool enforces). This plugin never invents a second permission
 * system: it derives that entry from the role configuration and refuses to save
 * a configuration whose referenced routes are not authorized.
 *
 * Routes (all under /plugins/dsh-workflow-model-routing/):
 *   GET  state           → official policy view (diagnostics; kept from v1)
 *   GET  catalog         → every provider/model the LLM service knows
 *   GET  roles           → role configuration + derived authorization + status
 *   POST roles/validate  → probe every referenced route once; returns a token
 *   POST roles/save      → verify the draft against a passing token, then write
 *   GET  subagents       → dispatch/run ledger (observation only)
 *
 * Disciplines
 * -----------
 *   1. `apply()` never throws.
 *   2. Only `webServer` is a hard injection; settings/llm/subagents/sessions are
 *      resolved lazily so a lighter profile answers 503 instead of hanging.
 *   3. Observation hooks (`llm/stream`, `tools/post-execute`, `subagent/end`)
 *      never mutate the run they observe.
 *   4. Nothing is reported as verified unless a real model stream completed.
 *
 * Zero runtime dependencies: `node:*` builtins only.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import * as capabilities from "./capabilities.js";
import * as modes from "./modes.js";
import * as execution from "./execution.js";
import * as tiers from "./tiers.js";
import * as aiAssistant from "./ai-assistant.js";
import * as aiJobs from "./ai-jobs.js";
import * as routePolicy from "./route-policy.js";

const PACKAGE_ID = "@local/dsh-workflow-model-routing";
const ROUTE_BASE = "/plugins/dsh-workflow-model-routing";
const STATE_ROUTE = `${ROUTE_BASE}/state`;
const CATALOG_ROUTE = `${ROUTE_BASE}/catalog`;
const ROLES_ROUTE = `${ROUTE_BASE}/roles`;
const VALIDATE_ROUTE = `${ROUTE_BASE}/roles/validate`;
const ROLES_SAVE_ROUTE = `${ROUTE_BASE}/roles/save`;
const SUBAGENTS_ROUTE = `${ROUTE_BASE}/subagents`;
const MODES_ROUTE = `${ROUTE_BASE}/modes`;
const MODE_SAVE_ROUTE = `${ROUTE_BASE}/modes/save`;
const MODE_ENABLE_ROUTE = `${ROUTE_BASE}/modes/enable`;
const CAPABILITIES_ROUTE = `${ROUTE_BASE}/capabilities`;
const CAPABILITIES_REFRESH_ROUTE = `${ROUTE_BASE}/capabilities/refresh`;
const EXECUTION_INTEGRATION_ROUTE = `${ROUTE_BASE}/execution-integration`;
const TIERS_ROUTE = `${ROUTE_BASE}/tiers`;
const TIERS_REFRESH_ROUTE = `${ROUTE_BASE}/tiers/refresh`;
const AI_CONFIGURE_ROUTE = `${ROUTE_BASE}/ai/configure`;
const AI_RECOMMEND_ROUTE = `${ROUTE_BASE}/ai/recommend`;
const AI_JOBS_ROUTE = `${ROUTE_BASE}/ai/jobs`;
const RELEASE_NOTES_ROUTE = `${ROUTE_BASE}/release-notes`;
const MIGRATE_ROUTE = `${ROUTE_BASE}/migrate-deployment-routes`;

const PACKAGE_VERSION = "2.6.4";
const CHANGELOG = Object.freeze([
  {
    version: "v2.6.4",
    date: "2026-11-17",
    summary: "配置入口归位：主会话与派工控制；角色中心高级协作身份覆盖与顾问协作建议。只调整呈现，不修改保存的路线和执行语义；协作网络新增阶段、职责、任务层级区域。",
  },
  {
    version: "v2.6.3",
    date: "2026-11-17",
    summary: "非 vision 部署目录与优先分组策略：共享纯 route policy（过滤 -vision alias，非 input image 能力），catalog/UI/AI/recommended 全入口同政策；专用迁移端点 POST /migrate-deployment-routes（dry-run/apply，backup+CAS+fail-stop，零 llm.stream）；同名模型优先 kimi-subscription/antigravity，跨 provider 换 route 后推理档位按目标真实 metadata 降级；详见包根 release-notes.json。",
  },
  {
    version: "v2.6.2",
    date: "2026-11-16",
    summary: "一键 AI 改为异步任务 + 短轮询：POST /ai/jobs 立即 202 返回 jobId，后台仍串行执行四模式（maxActive=1），GET /ai/jobs?id= 查询状态；消除长连接导致的浏览器 Failed to fetch；详见包根 release-notes.json。",
  },
  {
    version: "v2.6.1",
    date: "2026-11-16",
    summary: "一键 AI 网络/嵌套错误诊断：保留 cause/code/status 的错误格式化与分类、HTTP 处理器按类型回传、前端区分网络失败/中止/HTTP 错误并给出可操作中文提示；详见包根 release-notes.json。",
  },
  {
    version: "v2.6.0",
    date: "2026-11-16",
    summary: "四模式自由选择：移除穷鬼硬禁用、模式解读中性化、目录精确去重、AI 配置/推荐串行与流式文本防御性兼容；详见包根 release-notes.json。",
  },
  {
    version: "v2.5.0",
    date: "2026-11-15",
    summary: "适配 DSH 0.2.2-rc.3：四模式完整主/备/升级预设、12 条默认授权、团队页派工策略精简；详见包根 release-notes.json。",
  },
  {
    version: "v2.4.0",
    date: "2026-11-15",
    summary: "模型配置页 AI 一键配置/一键推荐与两级版本历史；详见包根 release-notes.json。",
  },
  {
    version: "v2.3.0",
    date: "2026-11-15",
    summary: "四模式穷鬼档硬约束、模型分层接口（/tiers）、角色保存与验证解耦（免 validationToken 直接保存）。",
  },
  {
    version: "v2.2.0",
    date: "2026-11-14",
    summary: "三模式（经济/普通/性能）配置与能力缓存、保存/启用分离、角色派工快照与团队覆盖接线。",
  },
  {
    version: "v2.1.0",
    date: "2026-11-13",
    summary: "授权白名单与角色派工工具、spawn 限定与负向测试补齐。",
  },
  {
    version: "v1.0.0",
    date: "2026-11-13",
    summary: "子代理模型授权与角色分配初版（subagent-model-selection-settings）。",
  },
]);

const SETTINGS_HINT = "subagent-model-selection";
const MAX_ROUTES = 60;
const CATALOG_TTL_MS = 60_000;
const CATALOG_CALL_TIMEOUT_MS = 6_000;
const MAX_BODY_BYTES = 256 * 1024;
const STORE_FILE = "dsh-workflow-model-routing.state.json";
const STORE_VERSION = 3;
const LEDGER_CAP = 400;
const PROBE_TIMEOUT_MS = 25_000;
const PROBE_TOTAL_BUDGET_MS = 120_000;
const PROBE_PARALLEL = 3;
const TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_CAP = 8;
const TOOL_NAME = "role_subagent";

/* ------------------------------------------------------------------ *
 * Role defaults (mirrors model-routing-2026-11-13/roles.json)
 * ------------------------------------------------------------------ */

/**
 * The 14 roles from the plan. `primary` is the planned route; `backup` and
 * `upgrade` default to null because no plan line verifies them (work-spec rule:
 * do not fill in unverified fallbacks).
 */
const DEFAULT_ROLES = Object.freeze(modes.recommendedRoles("economy"));

/** The curated default authorized set (v2.6.3) — 10 non-vision routes. */
const DEFAULT_AUTHORIZED = Object.freeze([
  { provider: "deepseek-account", model: "deepseek-flash" },
  { provider: "deepseek-account", model: "deepseek-v4-pro" },
  { provider: "openai", model: "gpt-6.1-sol" },
  { provider: "openai", model: "gpt-6-astra" },
  { provider: "openai", model: "gpt-5.6-sol" },
  { provider: "openai", model: "gpt-5.3-codex" },
  { provider: "kimi-subscription", model: "k3" },
  { provider: "kimi-subscription", model: "k3.1-pro" },
  { provider: "google", model: "gemini-3.1-pro-preview" },
  { provider: "google", model: "gemini-4-argon" },
]);

/** The curated routes are also the plan list (v2.5). */
const PLAN_MODELS = DEFAULT_AUTHORIZED;
const TIER_LABELS = Object.freeze({ primary: "主用", backup: "备用", upgrade: "升级" });

/**
 * Task complexity per role drives the default reasoning tier. Only tiers the
 * model actually declares via llm.resolveModelInfo(provider, model).reasoning
 * .supportedEfforts are ever sent; unknown complexity or an undeclared tier falls
 * back to the model's own default (no reasoningEffort field) — never a guess.
 */
const ROLE_COMPLEXITY = Object.freeze({
  lead: "high",
  architect: "high",
  "architecture-challenger": "high",
  coder: "high",
  researcher: "medium",
  analyst: "medium",
  reviewer: "medium",
  "long-document": "medium",
  "multimodal-researcher": "medium",
  secretary: "low",
  editor: "low",
  "creative-writer": "low",
  vision: "low",
  "privacy-memory": undefined,
});

/** Complexity class → preferred reasoning tier name (DSH tier vocabulary). */
const COMPLEXITY_TIER = Object.freeze({ low: "low", medium: "medium", high: "high" });

/** Keyword hints for best-effort recognition of the official tool's `description`. */
const ROLE_KEYWORDS = {
  lead: ["lead", "coordinate", "协调", "拆解", "聚合", "aggregate"],
  secretary: ["secretary", "秘书", "summar", "摘要", "分类", "计划"],
  architect: ["architect", "架构", "design", "设计", "契约", "验收", "依赖"],
  researcher: ["researcher", "research", "检索", "研究", "来源", "反证", "资料", "search"],
  "long-document": ["long-document", "长文", "整理", "文档", "document", "文稿"],
  analyst: ["analyst", "分析", "数据", "data", "口径"],
  editor: ["editor", "编辑", "office", "办公", "校对"],
  "creative-writer": ["creative", "writer", "撰稿", "创作", "文案", "写作"],
  coder: ["coder", "code", "代码", "编程", "implement", "实现", "开发", "coding"],
  "multimodal-researcher": ["multimodal", "图文", "视觉分析"],
  vision: ["image", "图片", "解读", "看图", "ocr", "图像"],
  "architecture-challenger": ["challenger", "质疑", "挑战", "challenge"],
  reviewer: ["reviewer", "审查", "审阅", "review", "独立复核"],
  "privacy-memory": ["privacy", "memory", "隐私", "记忆"],
};

const UNKNOWN_ROLE = Object.freeze({ id: "", name: "未指定角色", purpose: "" });

/* ------------------------------------------------------------------ *
 * In-memory state
 * ------------------------------------------------------------------ */

/** childId → dispatch entry. Observation record only. */
const identityLedger = new Map();
/** sessionId → { provider, model, at } — the route the stream call used. */
const sessionModelLedger = new Map();
/** childId → stop reason string (from subagent/end). */
const sessionStatusLedger = new Map();
/** token → { hash, results, at } — a completed validation of one exact draft. */
const validationTokens = new Map();
/** cached catalogue `{ at, data }`. */
let catalogCache = null;
/** cached store `{ data, at }`. */
let storeCache = null;
/** last save attempt summary, shown by the page. */
let lastSave = null;
/** cached three-mode store `{ file, at, data }`. */
let modesCache = null;
/** cached capability store `{ file, at, data }`. */
let capabilitiesCache = null;
/** Authoritative in-memory capability generation; null until first sync from disk. */
let capabilityGeneration = null;
/** Serial capability write lock (refresh + invalidate share one queue). */
let capabilityWriteLock = Promise.resolve();
/** Test-only fault counters (zero in production). */
const __faults = { modesWrite: 0, capabilitiesWrite: 0 };

function ledgerSet(map, key, value) {
  map.set(key, value);
  if (map.size > LEDGER_CAP) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

function tokenSet(token, record) {
  validationTokens.set(token, record);
  while (validationTokens.size > TOKEN_CAP) {
    const first = validationTokens.keys().next().value;
    if (first === undefined) break;
    validationTokens.delete(first);
  }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function json(response, status, body) {
  try {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    response.end(payload);
  } catch {
    try {
      response.destroy();
    } catch {
      /* the socket is already gone */
    }
  }
}

function hostTrusted(request) {
  const header = request?.headers?.host;
  if (typeof header !== "string" || header.trim() === "") return false;
  let hostname = "";
  try {
    hostname = new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isLocalHostname(hostname)) return true;
  const local = String(request?.socket?.localAddress ?? "").toLowerCase();
  if (local === "") return false;
  return stripBrackets(hostname) === stripBrackets(local);
}

function originTrusted(request) {
  const origin = request?.headers?.origin;
  if (typeof origin !== "string" || origin.trim() === "") return true;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (isLocalHostname(hostname)) return true;
    const local = String(request?.socket?.localAddress ?? "").toLowerCase();
    return local !== "" && stripBrackets(hostname) === stripBrackets(local);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    hostname === "[::1]"
  );
}

function stripBrackets(value) {
  const text = String(value ?? "");
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

function guard(request, response) {
  if (!hostTrusted(request)) {
    json(response, 403, { error: "host-not-trusted" });
    return false;
  }
  if (!originTrusted(request)) {
    json(response, 403, { error: "origin-not-trusted" });
    return false;
  }
  return true;
}

function readJsonBody(request, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        chunks.length = 0;
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        request.pause();
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(Object.assign(new Error("request body must be a JSON object"), { code: "BAD_BODY" }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("request body is not valid JSON"), { code: "BAD_BODY" }));
      }
    });
    request.on("error", reject);
  });
}

/* ------------------------------------------------------------------ *
 * Lazy services
 * ------------------------------------------------------------------ */

function serviceOf(scopes, name) {
  for (const scope of scopes) {
    try {
      const found = scope?.get?.(name);
      if (found !== null && found !== undefined) return found;
    } catch {
      /* a context without that service is a normal composition */
    }
  }
  return null;
}

function findPolicyRow(settings) {
  const rows = settings.describe();
  const exact = rows.find((row) => String(row?.ns ?? "") === "subagent-model-selection-settings");
  const byHint = rows.find((row) => String(row?.ns ?? "").includes(SETTINGS_HINT));
  const byShape = rows.find(
    (row) =>
      row?.value !== null &&
      typeof row?.value === "object" &&
      Object.hasOwn(row.value, "enabled") &&
      Object.hasOwn(row.value, "allowedModels"),
  );
  return { row: exact ?? byHint ?? byShape ?? null, names: rows.map((row) => String(row?.ns ?? "")) };
}

/* ------------------------------------------------------------------ *
 * Route helpers
 * ------------------------------------------------------------------ */

function routeKey(provider, model) {
  return `${String(provider ?? "")}\u0000${String(model ?? "")}`;
}

function cleanRoute(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (provider === "" || model === "") return null;
  const reasoningEffort =
    typeof value.reasoningEffort === "string" && value.reasoningEffort.trim() !== ""
      ? value.reasoningEffort.trim()
      : undefined;
  return reasoningEffort === undefined
    ? { provider, model }
    : { provider, model, reasoningEffort };
}

/**
 * Resolve the reasoning tier to send. The request is the route's explicit
 * reasoningEffort when present, otherwise the complexity-based default. The tier
 * is sent only when llm.resolveModelInfo(provider, model) confirms it is listed
 * in reasoning.efforts (the runtime contract's `{id,name}[]`, with the legacy
 * `supportedEfforts` string-array shape tolerated); unknown complexity, an
 * unavailable lookup, or an undeclared tier all resolve to undefined (the model's
 * own default).
 */
async function resolveReasoningEffort(llm, route, complexity) {
  if (llm === null || typeof llm.resolveModelInfo !== "function") return undefined;
  const requested =
    typeof route?.reasoningEffort === "string" && route.reasoningEffort.trim() !== ""
      ? route.reasoningEffort.trim()
      : COMPLEXITY_TIER[complexity];
  if (requested === undefined || requested === "") return undefined;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const supported = capabilities.declaredEfforts(info);
    if (supported.length === 0) return undefined;
    return supported.includes(requested) ? requested : undefined;
  } catch {
    return undefined;
  }
}

function distinctRoutes(roles) {
  const seen = new Set();
  const out = [];
  for (const item of roles) {
    for (const route of [item?.primary, item?.backup, item?.upgrade]) {
      const clean = cleanRoute(route);
      if (clean === null) continue;
      const key = routeKey(clean.provider, clean.model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Validate a reviewer pairing list. Each pairing has authorProviders (a non-empty
 * string array) and a reviewer route that must be clean and authorized. Returns
 * the normalized list, or the fallback when the input is missing or has nothing
 * usable.
 */
function normalizeReviewerPairings(input, fallback, allowedKeys) {
  if (!Array.isArray(input)) return Array.isArray(fallback) ? fallback : [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const providers = Array.isArray(item.authorProviders)
      ? item.authorProviders.map((value) => String(value ?? "").trim()).filter((value) => value !== "")
      : [];
    const reviewer = cleanRoute(item.reviewer);
    if (providers.length === 0 || reviewer === null) continue;
    if (!allowedKeys.has(routeKey(reviewer.provider, reviewer.model))) continue;
    const key = providers.slice().sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ authorProviders: providers, reviewer });
  }
  return out.length > 0 ? out : Array.isArray(fallback) ? fallback : [];
}

function plainRoutes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const clean = cleanRoute(item);
    if (clean === null) continue;
    const key = routeKey(clean.provider, clean.model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Turn a UI draft into the stored configuration. Throws a `{ code }` error on
 * anything the page must fix before a save can be attempted.
 */
function normalizeRoles(input, authorized) {
  const allowedKeys = new Set(
    (Array.isArray(authorized) ? authorized : []).map((row) => routeKey(row.provider, row.model)),
  );
  if (!Array.isArray(input)) {
    throw bad("roles 必须是角色数组", "BAD_ROLES");
  }
  if (input.length === 0) {
    throw bad("至少保留一个角色", "BAD_ROLES");
  }
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw bad("每个角色必须是对象", "BAD_ROLES");
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id === "") throw bad("角色 id 不能为空", "BAD_ROLES");
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(id)) {
      throw bad(`角色 id 只能是小写字母、数字、点、下划线或连字符：${id}`, "BAD_ROLES");
    }
    if (seen.has(id)) throw bad(`角色 id 重复：${id}`, "BAD_ROLES");
    seen.add(id);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name === "") throw bad(`角色 ${id} 缺少名称`, "BAD_ROLES");
    const purpose = typeof item.purpose === "string" ? item.purpose.trim() : "";
    const defaults = DEFAULT_ROLES.find((entry) => entry.id === id);
    // Only the shipped role ids may be rule-driven; a custom id is always a
    // plain role, so nobody can forge a "reviewer" that bypasses the pairing rule.
    const kind = defaults ? defaults.kind : "standard";
    const row = {
      id,
      name: name.slice(0, 40),
      purpose: purpose.slice(0, 240),
      kind,
      enabled: item.enabled !== false,
      primary: cleanRoute(item.primary),
      backup: cleanRoute(item.backup),
      upgrade: cleanRoute(item.upgrade),
      switchRule: item.switchRule === "auto" ? "confirm" : "confirm",
    };
    if (kind !== "standard") {
      // A rule-driven role never carries a fixed route: the whole point of
      // reviewer/privacy is that a plain edit cannot pin them to one model.
      row.primary = null;
      row.backup = null;
      row.upgrade = null;
    }
    if (kind === "reviewer") {
      // Pairings are plan data, but an explicit draft may override the shipped
      // default. Keep the submitted pairings only when they are valid; otherwise
      // fall back to the shipped default (DeepSeek Pro). This fixes the v2.2.0
      // bug where every save silently reverted reviewer pairings to Sol.
      row.pairings = normalizeReviewerPairings(item.pairings, defaults?.pairings, allowedKeys);
    }
    if (kind === "privacy") {
      row.status = "manual-or-verified-local-only";
    }
    if (kind === "standard" && row.enabled !== false && row.primary === null) {
      throw bad(`角色 ${name} 已启用但没有主用模型，请为它选择主用模型或停用该角色`, "BAD_ROLES");
    }
    if (kind === "standard") {
      for (const tier of ["primary", "backup", "upgrade"]) {
        const route = row[tier];
        if (route === null) continue;
        if (!allowedKeys.has(routeKey(route.provider, route.model))) {
          throw bad(
            `角色 ${name} 的${TIER_LABELS[tier]}路线 ${route.provider}/${route.model} 尚未授权。请先在「模型授权」中添加该模型。`,
            "UNAUTHORIZED_ROUTE",
          );
        }
      }
    }
    out.push(row);
  }
  for (const required of ["reviewer", "privacy"]) {
    if (!out.some((row) => row.kind === required)) {
      throw bad(
        `内置特殊角色（${required === "reviewer" ? "独立审查员" : "隐私与记忆管理员"}）不能被删除，只能停用`,
        "BAD_ROLES",
      );
    }
  }
  return out;
}

function normalizeAuthorizedModels(input) {
  const routes = plainRoutes(input);
  if (routes.length > MAX_ROUTES) throw bad(`授权模型最多 ${MAX_ROUTES} 个`, "BAD_AUTHORIZED");
  return routes;
}

function bad(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Legacy v2 derivation (enabled role routes + extra models). Kept only so an
 * old store can be migrated to the explicit authorization set; it is never the
 * authority for a new save.
 */
function deriveAllowedModels(roles, extraModels) {
  const all = [...distinctRoutes(roles.filter((item) => item.enabled !== false)), ...extraModels];
  const seen = new Set();
  const out = [];
  for (const route of all) {
    const key = routeKey(route.provider, route.model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

function routeSetOf(routes) {
  return new Set((Array.isArray(routes) ? routes : []).map((row) => routeKey(row.provider, row.model)));
}

/** Every non-empty route a role pins, with the role and tier that reference it. */
function roleRouteRefs(roles) {
  const out = [];
  for (const row of Array.isArray(roles) ? roles : []) {
    if (row?.kind !== "standard") continue;
    for (const tier of ["primary", "backup", "upgrade"]) {
      const route = row[tier];
      if (route === null || route === undefined) continue;
      out.push({ roleId: row.id, roleName: row.name, tier, provider: route.provider, model: route.model });
    }
  }
  return out;
}

/** Role routes the authorized set does not cover: a configuration anomaly. */
function roleConflicts(roles, authorized) {
  const allowed = routeSetOf(authorized);
  return roleRouteRefs(roles).filter((row) => !allowed.has(routeKey(row.provider, row.model)));
}

/** Authorized routes grouped with the roles/tiers that currently reference them. */
function authorizedReferences(roles, authorized) {
  const refs = roleRouteRefs(roles);
  return (Array.isArray(authorized) ? authorized : []).map((route) => ({
    provider: route.provider,
    model: route.model,
    roles: refs
      .filter((row) => row.provider === route.provider && row.model === route.model)
      .map((row) => ({ roleId: row.roleId, roleName: row.roleName, tier: row.tier })),
  }));
}

/* ------------------------------------------------------------------ *
 * Store (roles + extra models), versioned and durable
 * ------------------------------------------------------------------ */

function storeDirectory(scopes) {
  const fromEnv = String(process.env.DSH_PROFILE_DIR ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const settings = serviceOf(scopes, "settings");
  if (settings !== null) {
    try {
      const documentPath = String(settings.documentPath ?? "");
      if (documentPath !== "") return path.dirname(documentPath);
    } catch {
      /* fall through */
    }
  }
  return "";
}

function storePath(scopes) {
  const dir = storeDirectory(scopes);
  return dir === "" ? "" : path.join(dir, STORE_FILE);
}

function validateStoredRole(row) {
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
    ...(Array.isArray(row.pairings) ? { pairings: row.pairings } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
  };
}

/** Read the store; falls back to defaults (never throws). */
/** The official policy's current allowed set — the baseline for a one-time migration. */
function officialAuthorizedBaseline(scopes) {
  const settings = serviceOf(scopes, "settings");
  if (settings === null) return null;
  try {
    const found = findPolicyRow(settings);
    const value = found.row?.value;
    if (value === null || typeof value !== "object") return null;
    const rows = plainRoutes(value.allowedModels);
    return rows.length === 0 ? null : rows;
  } catch {
    return null;
  }
}

async function loadStore(scopes) {
  const file = storePath(scopes);
  if (file === "") {
    return {
      revision: 0,
      roles: clone(DEFAULT_ROLES),
      authorizedModels: clone(DEFAULT_AUTHORIZED),
      migrated: false,
      persistent: false,
      file: "",
      consistency: null,
    };
  }
  try {
    if (storeCache !== null && storeCache.file === file && Date.now() - storeCache.at < 2_000) {
      return storeCache.data;
    }
  } catch {
    /* ignore a broken cache */
  }
  let raw = null;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    raw = null;
  }
  if (raw === null) {
    const data = {
      revision: 0,
      roles: clone(DEFAULT_ROLES),
      authorizedModels: clone(DEFAULT_AUTHORIZED),
      migrated: false,
      persistent: true,
      file,
      consistency: null,
      source: "defaults",
    };
    storeCache = { file, at: Date.now(), data };
    return data;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const roles = Array.isArray(parsed?.roles)
    ? parsed.roles.map(validateStoredRole).filter((row) => row !== null)
    : [];
  const rows = roles.length > 0 ? roles : clone(DEFAULT_ROLES);
  const explicit = Array.isArray(parsed?.authorizedModels);
  // A v2 store has no explicit authorization set. Migrate from what the user
  // actually had authorized (the official policy) — never from "whatever the
  // roles happen to reference", because that would auto-grant on upgrade.
  const baseline = explicit ? null : officialAuthorizedBaseline(scopes);
  let authorizedModels = explicit
    ? plainRoutes(parsed.authorizedModels)
    : (baseline ?? deriveAllowedModels(rows, plainRoutes(parsed?.extraModels)));
  const migrated = explicit !== true;
  if (migrated && authorizedModels.length === 0) {
    authorizedModels = clone(DEFAULT_AUTHORIZED);
  }
  const data = {
    revision: Number.isInteger(parsed?.revision) ? parsed.revision : 0,
    roles: rows,
    authorizedModels,
    migrated,
    storeVersion: Number.isInteger(parsed?.version) ? parsed.version : 0,
    persistent: true,
    file,
    consistency: parsed?.consistency ?? null,
    source: roles.length > 0 ? "store" : "defaults",
    updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : "",
  };
  storeCache = { file, at: Date.now(), data };
  return data;
}

async function writeStore(file, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, "utf8");
  await fs.rename(temporary, file);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * Model probing — the only thing that may call a route "verified"
 * ------------------------------------------------------------------ */

function probeTimeout() {
  return new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS));
}

/**
 * Run one minimal, private-free request against a route and report whether the
 * stream completed. Nothing here proves capability (tools/images) or quality.
 */
async function probeRoute(llm, route, signal) {
  const at = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onOuterAbort, { once: true });
  let text = "";
  let finish = null;
  let failure = null;
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }],
      maxTokens: 32,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk && typeof chunk === "object") {
        if (typeof chunk.text === "string") text += chunk.text;
        if (chunk.type === "text-delta" && typeof chunk.delta === "string") text += chunk.delta;
        if (chunk.finish !== undefined) finish = chunk.finish;
        if (typeof chunk.type === "string" && chunk.type === "finish") finish = chunk;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onOuterAbort);
  }
  const reason = typeof finish === "string" ? finish : String(finish?.reason ?? finish?.type ?? "");
  if (failure !== null) {
    const status = Number.isInteger(failure?.status) ? failure.status : null;
    return {
      provider: route.provider,
      model: route.model,
      ok: false,
      code: typeof failure?.code === "string" ? failure.code : "error",
      status,
      error: String(failure?.message ?? failure),
      transient: status === 429 || status === 408 || status === 503 || status === 500,
      at,
    };
  }
  if (reason === "error" || reason === "aborted") {
    return {
      provider: route.provider,
      model: route.model,
      ok: false,
      code: reason,
      status: null,
      error: `stream finished with ${reason}`,
      transient: reason === "aborted",
      at,
    };
  }
  return {
    provider: route.provider,
    model: route.model,
    ok: true,
    code: "ok",
    status: 200,
    error: "",
    transient: false,
    at,
    sample: text.slice(0, 40),
  };
}

async function probeAll(llm, routes, signal) {
  const results = [];
  const queue = [...routes];
  const started = Date.now();
  const worker = async () => {
    while (queue.length > 0) {
      const route = queue.shift();
      if (route === undefined) return;
      if (Date.now() - started > PROBE_TOTAL_BUDGET_MS) {
        results.push({
          provider: route.provider,
          model: route.model,
          ok: false,
          code: "budget",
          status: null,
          error: "整体验证超时，未能完成这次调用",
          transient: true,
          at: Date.now(),
        });
        continue;
      }
      results.push(await probeRoute(llm, route, signal));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_PARALLEL, routes.length) }, worker));
  return results.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
}

/* ------------------------------------------------------------------ *
 * Draft hashing — the token binds one exact draft to one validation
 * ------------------------------------------------------------------ */

function draftHash(enabled, roles, authorizedModels) {
  const canonical = JSON.stringify({
    enabled: enabled === true,
    roles: roles.map((row) => ({
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      kind: row.kind,
      enabled: row.enabled !== false,
      primary: row.primary,
      backup: row.backup,
      upgrade: row.upgrade,
      switchRule: "confirm",
    })),
    authorizedModels: authorizedModels.map((row) => ({ provider: row.provider, model: row.model })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function publicRoute(row) {
  return row === null ? null : { provider: row.provider, model: row.model };
}

function describeRoute(route) {
  return route === null || route === undefined ? "" : `${route.provider}/${route.model}`;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

function stateHandler(scopes) {
  return (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const settings = serviceOf(scopes, "settings");
    if (settings === null) {
      json(response, 503, { error: "settings-unavailable", message: "settings 服务尚未就绪，稍后重试。" });
      return;
    }
    try {
      const found = findPolicyRow(settings);
      if (found.row === null) {
        json(response, 503, {
          error: "policy-unavailable",
          message: "没有找到 subagent-model-selection-settings 配置项。",
          namespaces: found.names.filter((name) => name.toLowerCase().includes("subagent")),
        });
        return;
      }
      const value = found.row?.value !== null && typeof found.row?.value === "object" ? found.row.value : {};
      json(response, 200, {
        ok: true,
        ns: String(found.row?.ns ?? ""),
        revision: Number.isInteger(found.row?.revision) ? found.row.revision : 0,
        enabled: value.enabled === true,
        allowedModels: plainRoutes(value.allowedModels),
        plan: { source: "model-routing-2026-11-13", models: PLAN_MODELS },
      });
    } catch (error) {
      json(response, 500, { error: "state-failed", message: String(error?.message ?? error) });
    }
  };
}

/**
 * Merge two catalog rows sharing the SAME (provider, model) key. Prefer the more
 * complete metadata (non-empty name/description, longer modalities/efforts
 * lists, non-empty badge/defaultEffort). Never merges across providers — callers
 * key on provider id + model id.
 */
function mergeRowMeta(a, b) {
  const out = { ...a };
  if (out.name === undefined || out.name === "") out.name = b.name;
  if (out.description === undefined || out.description === "") out.description = b.description;
  const aLen = Array.isArray(out.inputModalities) ? out.inputModalities.length : 0;
  const bLen = Array.isArray(b.inputModalities) ? b.inputModalities.length : 0;
  if (bLen > aLen) {
    out.inputModalities = b.inputModalities.slice();
    out.modalities = b.inputModalities.slice();
  }
  if (out.badge === undefined || out.badge === "") out.badge = b.badge;
  const aEfforts = Array.isArray(out.reasoningEfforts) ? out.reasoningEfforts.length : 0;
  const bEfforts = Array.isArray(b.reasoningEfforts) ? b.reasoningEfforts.length : 0;
  if (bEfforts > aEfforts) out.reasoningEfforts = b.reasoningEfforts.slice();
  if (out.defaultEffort === undefined || out.defaultEffort === "") out.defaultEffort = b.defaultEffort;
  if (out.canDisableThinking === undefined) out.canDisableThinking = b.canDisableThinking;
  return out;
}

/**
 * Enumerate the full local catalog. This is the SINGLE source of truth shared
 * by GET /catalog and the AI assistant. The real runtime contract keeps
 * reasoning OFF `llm.listModels` rows and exposes it on
 * `llm.resolveModelInfo(provider, model)` as `reasoning.efforts[].id` +
 * `reasoning.defaultEffort`. Per-model resolution failures degrade that model
 * (reasoning left undeclared) without dropping it, and are recorded as
 * warnings. Providers are never truncated.
 */
export async function buildCatalog(llm) {
  if (catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.data;
  }
  const warnings = [];
  const providers = llm.listProviders();
  const list = Array.isArray(providers) ? providers : [];
  const entries = await Promise.all(
    list.map(async (provider) => {
      const id = typeof provider === "string" ? provider : String(provider?.id ?? "");
      if (id === "") return null;
      const name = typeof provider?.name === "string" && provider.name !== "" ? provider.name : id;
      let models = [];
      try {
        models = await withTimeout(llm.listModels(id), CATALOG_CALL_TIMEOUT_MS);
      } catch (error) {
        warnings.push(`provider ${id} 枚举失败：${String(error?.message ?? error)}`);
        models = [];
      }
      const rows = await Promise.all(
        (Array.isArray(models) ? models : []).map(async (model) => {
          const mid = String(model?.id ?? "");
          if (mid === "") return null;
          const row = {
            id: mid,
            name: typeof model?.name === "string" && model.name !== "" ? model.name : mid,
          };
          if (typeof model?.description === "string") row.description = model.description;
          const listModalities = Array.isArray(model?.inputModalities)
            ? model.inputModalities
            : Array.isArray(model?.modalities) ? model.modalities : null;
          if (listModalities !== null) {
            row.inputModalities = listModalities.slice();
            row.modalities = listModalities.slice();
          }
          if (typeof model?.badge === "string") row.badge = model.badge;
          // Reasoning lives on resolveModelInfo, not listModels. Resolve per
          // model so smart / low / medium / high are never wrongly degraded by a
          // missing declared-efforts list.
          let info = null;
          try {
            if (typeof llm.resolveModelInfo === "function") {
              info = await withTimeout(llm.resolveModelInfo(id, mid), CATALOG_CALL_TIMEOUT_MS);
            }
          } catch (error) {
            warnings.push(`${id}/${mid} 能力读取失败：${String(error?.message ?? error)}`);
          }
          if (info !== null && typeof info === "object") {
            if (typeof info.description === "string") row.description = info.description;
            const infoModalities = Array.isArray(info.inputModalities)
              ? info.inputModalities
              : Array.isArray(info.modalities) ? info.modalities : null;
            if (infoModalities !== null) {
              row.inputModalities = infoModalities.slice();
              row.modalities = infoModalities.slice();
            }
            if (typeof info.badge === "string") row.badge = info.badge;
            const reasoning = info.reasoning;
            if (reasoning !== null && typeof reasoning === "object") {
              const efforts = Array.isArray(reasoning.efforts)
                ? reasoning.efforts
                : Array.isArray(reasoning.supportedEfforts)
                  ? reasoning.supportedEfforts.map((s) => ({ id: s }))
                  : null;
              if (efforts !== null) {
                row.reasoningEfforts = efforts
                  .map((e) => (typeof e === "string" ? e : String(e?.id ?? "")))
                  .filter((s) => s !== "");
              }
              if (typeof reasoning.defaultEffort === "string") row.defaultEffort = reasoning.defaultEffort;
              if (typeof reasoning.canDisableThinking === "boolean") row.canDisableThinking = reasoning.canDisableThinking;
            }
          }
          return row;
        }),
      );
      const dedupedModels = [];
      const seenModels = new Map();
      for (const row of rows) {
        if (row === null || row.id === "") continue;
        const prev = seenModels.get(row.id);
        if (prev === undefined) {
          seenModels.set(row.id, row);
          dedupedModels.push(row);
        } else {
          warnings.push(`provider ${id} 模型 ${row.id} 重复，已合并元数据`);
          const merged = mergeRowMeta(prev, row);
          seenModels.set(row.id, merged);
          dedupedModels[dedupedModels.indexOf(prev)] = merged;
        }
      }
      return { id, name, models: dedupedModels };
    }),
  );
  const dedupedProviders = [];
  const seenProviders = new Map();
  for (const entry of entries) {
    if (entry === null || entry.models.length === 0) continue;
    const prev = seenProviders.get(entry.id);
    if (prev === undefined) {
      seenProviders.set(entry.id, entry);
      dedupedProviders.push(entry);
    } else {
      warnings.push(`provider ${entry.id} 重复出现，已合并模型列表`);
      const mergedModels = new Map();
      for (const m of prev.models) mergedModels.set(m.id, m);
      for (const m of entry.models) {
        const existing = mergedModels.get(m.id);
        mergedModels.set(m.id, existing === undefined ? m : mergeRowMeta(existing, m));
      }
      const merged = { ...prev, models: Array.from(mergedModels.values()) };
      seenProviders.set(entry.id, merged);
      dedupedProviders[dedupedProviders.indexOf(prev)] = merged;
    }
  }
  const data = { ok: true, providers: dedupedProviders };
  if (warnings.length > 0) data.warnings = warnings;
  catalogCache = { at: Date.now(), data };
  return data;
}

function catalogHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const llm = serviceOf(scopes, "llm");
    if (llm === null || typeof llm.listProviders !== "function") {
      json(response, 503, { error: "llm-unavailable", message: "LLM 服务尚未就绪，无法枚举可用模型。" });
      return;
    }
    try {
      const data = await buildCatalog(llm);
      // Client-facing catalog hides the -vision alias providers. Raw vision
      // metadata stays available internally (migration endpoint reads
      // buildCatalog directly) so cross-id display-name matching still works.
      json(response, 200, {
        ...data,
        providers: routePolicy.filterVisionProviders(data.providers),
      });
    } catch (error) {
      json(response, 500, { error: "catalog-failed", message: String(error?.message ?? error) });
    }
  };
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), milliseconds);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** GET /roles — the role-first view the page renders. */
function rolesHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const settings = serviceOf(scopes, "settings");
    if (settings === null) {
      json(response, 503, { error: "settings-unavailable", message: "settings 服务尚未就绪，稍后重试。" });
      return;
    }
    try {
      const found = findPolicyRow(settings);
      const store = await loadStore(scopes);
      const official = found.row?.value !== null && typeof found.row?.value === "object" ? found.row.value : {};
      const allowed = plainRoutes(official.allowedModels);
      const authorized = store.authorizedModels;
      json(response, 200, {
        ok: true,
        revision: store.revision,
        enabled: official.enabled === true,
        roles: store.roles,
        authorizedModels: authorized,
        references: authorizedReferences(store.roles, authorized),
        conflicts: roleConflicts(store.roles, authorized),
        defaults: clone(DEFAULT_ROLES),
        defaultAuthorizedModels: clone(DEFAULT_AUTHORIZED),
        planModels: PLAN_MODELS,
        allowedModels: allowed,
        drifted: !sameRoutes(allowed, authorized),
        migrated: store.migrated === true,
        storeVersion: store.storeVersion ?? STORE_VERSION,
        persistent: store.persistent === true,
        storeFile: store.file,
        consistency: store.consistency,
        policyRevision: Number.isInteger(found.row?.revision) ? found.row.revision : 0,
        policyAvailable: found.row !== null,
        lastSave,
        note: "授权模型由你在这里明确选择；角色只能从已授权模型里取路线。新开的顶层会话才携带新授权。",
      });
    } catch (error) {
      json(response, 500, { error: "roles-failed", message: String(error?.message ?? error) });
    }
  };
}

function sameRoutes(left, right) {
  const key = (rows) => rows.map((row) => routeKey(row.provider, row.model)).sort().join("|");
  return key(left) === key(right);
}

/** POST /roles/validate — probe every referenced route once, hand back a token. */
function validateHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const llm = serviceOf(scopes, "llm");
    if (llm === null || typeof llm.stream !== "function") {
      json(response, 503, { error: "llm-unavailable", message: "LLM 服务尚未就绪，无法验证模型。" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, {
        error: "bad-body",
        message: String(error?.message ?? error),
      });
      return;
    }
    let roles;
    let authorizedModels;
    try {
      authorizedModels = normalizeAuthorizedModels(body.authorizedModels);
      roles = normalizeRoles(body.roles, authorizedModels);
    } catch (error) {
      json(response, 400, { error: String(error?.code ?? "BAD_DRAFT").toLowerCase(), message: String(error?.message ?? error) });
      return;
    }
    const enabled = body.enabled === true;
    const routes = authorizedModels;
    if (enabled && routes.length === 0) {
      json(response, 400, { error: "empty-selection", message: "启用子代理模型选择时，至少需要授权一个模型。" });
      return;
    }
    try {
      const started = Date.now();
      const results = await probeAll(llm, routes, request.signal);
      const hash = draftHash(enabled, roles, authorizedModels);
      const token = createHash("sha256").update(`${hash}:${started}:${process.pid}`).digest("hex").slice(0, 32);
      tokenSet(token, { hash, results, at: started });
      const failed = results.filter((row) => row.ok !== true);
      json(response, 200, {
        ok: failed.length === 0,
        token,
        hash,
        checked: routes.length,
        durationMs: Date.now() - started,
        results,
        failed: failed.map((row) => ({
          provider: row.provider,
          model: row.model,
          code: row.code,
          status: row.status,
          message: row.error,
          transient: row.transient === true,
        })),
        note: "验证只说明此刻这条路线能完成一次最小请求，不代表模型身份、质量或未来可用性。",
      });
    } catch (error) {
      json(response, 500, { error: "validate-failed", message: String(error?.message ?? error) });
    }
  };
}

/**
 * POST /roles/save — the only write path.
 *
 * Two documents change (the role store and the official allowedModels). There
 * is no cross-document transaction, so this writes the store first, then the
 * official entry, and restores the store if the second write fails. A failed
 * restore leaves a consistency marker the page and the dispatch tool refuse to
 * ignore.
 */
function saveHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const settings = serviceOf(scopes, "settings");
    if (settings === null) {
      json(response, 503, { error: "settings-unavailable", message: "settings 服务尚未就绪，稍后重试。" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, {
        error: "bad-body",
        message: String(error?.message ?? error),
      });
      return;
    }
    return withModeWriteLock(async () => {
    storeCache = null;
    let roles;
    let authorizedModels;
    try {
      authorizedModels = normalizeAuthorizedModels(body.authorizedModels);
      roles = normalizeRoles(body.roles, authorizedModels);
    } catch (error) {
      json(response, 400, { error: String(error?.code ?? "BAD_DRAFT").toLowerCase(), message: String(error?.message ?? error) });
      return;
    }
    const enabled = body.enabled === true;
    const routes = authorizedModels;
    if (enabled && routes.length === 0) {
      json(response, 400, { error: "empty-selection", message: "启用子代理模型选择时，至少需要授权一个模型。" });
      return;
    }
    const hash = draftHash(enabled, roles, authorizedModels);
    const token = typeof body.validationToken === "string" ? body.validationToken.trim() : "";
    const skipValidation = body.skipValidation === true || token === "";
    let checkedCount = 0;
    if (!skipValidation) {
      const record = validationTokens.get(token);
      if (record === undefined || record.hash !== hash || Date.now() - record.at > TOKEN_TTL_MS) {
        json(response, 400, {
          error: "validation-required",
          message: "这份配置还没有完成本次验证（或验证后又被改动）。请先点「验证并保存」重新验证。",
        });
        return;
      }
      const failed = record.results.filter((row) => row.ok !== true);
      if (failed.length > 0) {
        json(response, 400, {
          error: "validation-failed",
          message: "有模型未通过验证，配置未保存。",
          failed: failed.map((row) => ({ provider: row.provider, model: row.model, code: row.code, message: row.error })),
        });
        return;
      }
      checkedCount = record.results.length;
    }

    let found;
    try {
      found = findPolicyRow(settings);
    } catch (error) {
      json(response, 500, { error: "settings-failed", message: String(error?.message ?? error) });
      return;
    }
    if (found.row === null) {
      json(response, 503, { error: "policy-unavailable", message: "没有找到 subagent-model-selection-settings 配置项，无法写入授权。" });
      return;
    }
    const store = await loadStore(scopes);
    if (Number.isInteger(body.expectedRevision) && body.expectedRevision !== store.revision) {
      json(response, 409, {
        error: "conflict",
        message: "角色配置已被其他窗口或文件修改，请重新载入后再保存。",
        expected: body.expectedRevision,
        actual: store.revision,
      });
      return;
    }
    const expected = Number.isInteger(found.row?.revision) ? found.row.revision : undefined;
    const nextRevision = (Number.isInteger(store.revision) ? store.revision : 0) + 1;
    const file = store.file;
    const payload = {
      version: STORE_VERSION,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
      authorizedModels,
      roles,
      consistency: null,
    };
    const previous = file === "" ? null : await readRawFile(file);
    if (file === "") {
      json(response, 503, {
        error: "store-unavailable",
        message: "找不到可写入的 profile 目录，角色配置无法持久保存。",
      });
      return;
    }
    try {
      await writeStore(file, payload);
    } catch (error) {
      json(response, 500, { error: "store-write-failed", message: `角色配置写入失败：${String(error?.message ?? error)}` });
      return;
    }
    try {
      await settings.replace(found.row.ns, { enabled, allowedModels: routes }, expected);
    } catch (error) {
      const restored = await restoreRawFile(file, previous);
      const detail = String(error?.message ?? error);
      lastSave = { at: Date.now(), ok: false, error: "policy-write-failed", detail };
      if (restored) {
        json(response, error?.code === "SETTINGS_CONFLICT" ? 409 : 500, {
          error: error?.code === "SETTINGS_CONFLICT" ? "conflict" : "policy-write-failed",
          message:
            error?.code === "SETTINGS_CONFLICT"
              ? "配置已被其他窗口或文件修改，请重新载入后再保存（角色配置已回滚）。"
              : `官方授权写入失败，角色配置已回滚：${detail}`,
        });
        return;
      }
      await writeStore(file, {
        ...payload,
        consistency: {
          ok: false,
          at: new Date().toISOString(),
          reason: "policy-write-failed",
          detail,
          pendingAllowedModels: routes,
          pendingEnabled: enabled,
        },
      }).catch(() => undefined);
      json(response, 500, {
        error: "inconsistent",
        message:
          "官方授权写入失败，角色配置未能回滚。当前配置可能不一致，派发已被阻止；请重新载入并再次保存，或手工核对 profile 补丁。",
      });
      return;
    }
    storeCache = null;
    lastSave = { at: Date.now(), ok: true, revision: nextRevision, checked: checkedCount };
    try {
      const next = findPolicyRow(settings);
      const official = next.row?.value !== null && typeof next.row?.value === "object" ? next.row.value : {};
      json(response, 200, {
        ok: true,
        revision: nextRevision,
        enabled: official.enabled === true,
        roles,
        authorizedModels,
        allowedModels: plainRoutes(official.allowedModels),
        references: authorizedReferences(roles, authorizedModels),
        conflicts: roleConflicts(roles, authorizedModels),
        defaults: clone(DEFAULT_ROLES),
        defaultAuthorizedModels: clone(DEFAULT_AUTHORIZED),
        planModels: PLAN_MODELS,
        migrated: false,
        storeVersion: STORE_VERSION,
        persistent: true,
        storeFile: file,
        consistency: null,
        drifted: false,
        policyAvailable: true,
        checked: checkedCount,
        policyRevision: Number.isInteger(next.row?.revision) ? next.row.revision : 0,
        note: "已保存。新开的顶层会话才携带新授权；已打开的会话保留原策略。",
      });
    } catch (error) {
      json(response, 200, {
        ok: true,
        revision: nextRevision,
        enabled,
        roles,
        authorizedModels,
        allowedModels: routes,
        references: authorizedReferences(roles, authorizedModels),
        conflicts: roleConflicts(roles, authorizedModels),
        defaults: clone(DEFAULT_ROLES),
        defaultAuthorizedModels: clone(DEFAULT_AUTHORIZED),
        planModels: PLAN_MODELS,
        migrated: false,
        storeVersion: STORE_VERSION,
        persistent: true,
        storeFile: file,
        consistency: null,
        drifted: false,
        policyAvailable: true,
        checked: checkedCount,
        note: `已保存，但回读官方配置失败：${String(error?.message ?? error)}`,
      });
    }
    });
  };
}

async function readRawFile(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function restoreRawFile(file, previous) {
  try {
    if (previous === null) {
      await fs.rm(file, { force: true });
      return true;
    }
    const temporary = `${file}.${process.pid}.restore.tmp`;
    await fs.writeFile(temporary, previous, "utf8");
    await fs.rename(temporary, file);
    return true;
  } catch {
    return false;
  }
}

function subagentsHandler(scopes) {
  return (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    let parentFilter = "";
    try {
      parentFilter = new URL(request.url ?? "", "http://localhost").searchParams.get("parentSessionId") ?? "";
    } catch {
      parentFilter = "";
    }
    const sessions = serviceOf(scopes, "sessions");
    const rows = [...identityLedger.values()]
      .filter((entry) => parentFilter === "" || entry.parentSessionId === parentFilter)
      .map((entry) => enrichEntry(entry, sessions))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    json(response, 200, { ok: true, count: rows.length, subagents: rows });
  };
}

/* ------------------------------------------------------------------ *
 * Identity helpers
 * ------------------------------------------------------------------ */

function inferRole(description) {
  const text = String(description ?? "").toLowerCase();
  if (text === "") return UNKNOWN_ROLE;
  const hits = DEFAULT_ROLES.filter((role) => {
    const keywords = ROLE_KEYWORDS[role.id] ?? [];
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  });
  return hits.length === 1 ? hits[0] : UNKNOWN_ROLE;
}

function extractTask(prompt) {
  if (typeof prompt !== "string") return "";
  const first = prompt.split(/\r?\n/).find((line) => line.trim() !== "");
  if (!first) return "";
  const trimmed = first.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

function extractChildId(info) {
  if (info === null || typeof info !== "object") return "";
  const direct = [
    info.childId, info.id, info.sessionId, info.subagentId, info.childSessionId,
    info.session?.id, info.child?.id, info.agent?.id,
  ];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
    if (candidate && typeof candidate === "object" && typeof candidate.id === "string" && candidate.id !== "") return candidate.id;
  }
  return "";
}

function extractStopReason(info) {
  if (info === null || typeof info !== "object") return "";
  const direct = [info.reason, info.stopReason, info.status, info.endReason, info.kind, info.result?.reason, info.result?.status];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return "";
}

function enrichEntry(entry, sessions) {
  const out = { ...entry };
  const model = sessionModelLedger.get(entry.childId);
  if (model) {
    if (!out.actualProvider && model.provider) out.actualProvider = model.provider;
    if (!out.actualModel && model.model) out.actualModel = model.model;
  }
  const status = sessionStatusLedger.get(entry.childId);
  if (status && out.status === "running") out.status = status;
  if (sessions && typeof sessions.get === "function") {
    try {
      const session = sessions.get(entry.childId);
      if (session) {
        let events = [];
        try {
          events = session.snapshotEvents?.() ?? [];
        } catch {
          events = [];
        }
        for (const event of events) {
          const type = String(event?.type ?? "");
          const data = event?.data ?? {};
          if (type === "assistant/message") {
            const source = data?.message?.source ?? {};
            if (!out.actualProvider && source.provider) out.actualProvider = source.provider;
            if (!out.actualModel && source.model) out.actualModel = source.model;
          } else if (type === "turn/end") {
            const reason = data?.reason ?? {};
            const kind = typeof reason === "string" ? reason : reason?.kind;
            if (typeof kind === "string" && kind !== "" && out.status === "running") out.status = kind;
          } else if (type === "request/header") {
            const config = data?.header?.config ?? {};
            if (!out.requestedProvider && config.provider) out.requestedProvider = config.provider;
            if (!out.requestedModel && config.model) out.requestedModel = config.model;
          }
        }
      }
    } catch {
      /* a cold session is not an error */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Session authorization (never bypassed)
 * ------------------------------------------------------------------ */

/**
 * The routes the official policy snapshot authorized for this Session, or null
 * when the Session carries no snapshot at all. A new configuration never
 * re-authorizes an old Session.
 */
function sessionAllowedRoutes(sessions, sessionId) {
  if (!sessions || typeof sessions.get !== "function") return null;
  let session = null;
  try {
    session = sessions.get(sessionId);
  } catch {
    return null;
  }
  if (!session) return null;
  let events = [];
  try {
    events = session.snapshotEvents?.() ?? [];
  } catch {
    return null;
  }
  for (const event of events) {
    if (String(event?.type ?? "") !== "subagent/model-selection-policy") continue;
    const data = event?.data ?? {};
    const list = data.allowedModels ?? data.routes ?? data.models;
    if (!Array.isArray(list)) continue;
    return plainRoutes(list);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Runtime observation hooks
 * ------------------------------------------------------------------ */

function attachRuntimeHooks(ctx) {
  try {
    ctx.on("llm/stream", (options, next) => {
      try {
        const sid = options?.sessionId;
        if (sid !== null && sid !== undefined) {
          const key = String(sid);
          const previous = sessionModelLedger.get(key) ?? {};
          sessionModelLedger.set(key, {
            provider: typeof options?.provider === "string" ? options.provider : previous.provider ?? "",
            model: typeof options?.model === "string" ? options.model : previous.model ?? "",
            at: Date.now(),
          });
        }
      } catch {
        /* observation must never break the stream */
      }
      return typeof next === "function" ? next() : undefined;
    });

    ctx.on("tools/post-execute", (exec, result, next) => {
      try {
        if (result?.isError) return typeof next === "function" ? next() : undefined;
        const value = result?.value;
        if (!value || typeof value !== "object" || value.kind !== "activation") {
          return typeof next === "function" ? next() : undefined;
        }
        const childId = typeof value.subagentId === "string" ? value.subagentId : "";
        if (childId === "") return typeof next === "function" ? next() : undefined;
        const args = exec?.arguments ?? {};
        const name = String(exec?.name ?? "");
        const explicitRole = name === TOOL_NAME && typeof args.roleId === "string" ? args.roleId : "";
        const role = explicitRole === ""
          ? inferRole(typeof args.description === "string" ? args.description : "")
          : { id: explicitRole, name: typeof value.roleName === "string" ? value.roleName : explicitRole, purpose: "" };
        ledgerSet(identityLedger, childId, {
          childId,
          parentSessionId: typeof exec?.agent?.id === "string" ? exec.agent.id : "",
          roleId: role.id,
          roleName: role.name,
          rolePurpose: role.purpose ?? "",
          tier: typeof value.tier === "string" ? value.tier : "",
          description: typeof args.description === "string" ? args.description : "",
          task: extractTask(args.prompt),
          requestedProvider: typeof value.routeProvider === "string" ? value.routeProvider : typeof args.provider === "string" ? args.provider : "",
          requestedModel: typeof value.routeModel === "string" ? value.routeModel : typeof args.model === "string" ? args.model : "",
          actualProvider: "",
          actualModel: "",
          status: "running",
          createdAt: Date.now(),
        });
      } catch {
        /* observation must never break the tool result */
      }
      return typeof next === "function" ? next() : undefined;
    });

    ctx.on("subagent/end", (info) => {
      try {
        const childId = extractChildId(info);
        if (childId === "") return;
        const reason = extractStopReason(info);
        if (reason !== "") sessionStatusLedger.set(childId, reason);
        const entry = identityLedger.get(childId);
        if (entry) entry.settledAt = Date.now();
        execution.untrackDispatch(childId);
      } catch {
        /* observation must never break settlement */
      }
    });

    // Phase-C: freeze the active mode snapshot for a new session. This is
    // async so a cold-start session still loads the modes store before freezing
    // (the cache may not be loaded yet); freezing from a stale cache would let
    // a later mode switch silently re-freeze an old session.
    ctx.on("agent/created", async (payload) => {
      try {
        const sessionId = typeof payload?.agent?.id === "string" ? payload.agent.id : "";
        if (sessionId === "") return;
        const store = await loadModesStore([ctx]);
        const active = store?.activeSnapshot ?? null;
        if (active !== null && active !== undefined) {
          execution.freezeSessionSnapshot(sessionId, active);
        }
      } catch {
        /* never break session creation */
      }
    });

    // Phase-C: config/endpoint/model changes make the local capability cache
    // stale. Persist a generation bump (real invalidation), not just a memory
    // clear: the fingerprint is directory-declared, so a memory-only clear would
    // reload identical records and report them "ok" again.
    ctx.on("settings/document-updated", (ns) => {
      // Exclude the model-selection namespaces this plugin (and the host's
      // agent-default-model) write: those change the *default model*, not a
      // model's declared reasoning efforts, and saveSelection emits such events.
      const selfNs =
        typeof ns === "string" &&
        (ns.includes("model-selection") || ns.includes("agent-default-model"));
      if (selfNs) return undefined;
      return invalidateCapabilityCache([ctx]);
    });
    ctx.on("llm/adapters-updated", () => invalidateCapabilityCache([ctx]));
    ctx.on("llm/models-updated", () => invalidateCapabilityCache([ctx]));
  } catch (error) {
    warnOnce(ctx, `[${PACKAGE_ID}] could not attach runtime hooks: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Child-context injection — the same record the UI shows
 * ------------------------------------------------------------------ */

function attachSystemPrompt(ctx) {
  try {
    const sp = serviceOf([ctx], "systemPrompt");
    if (sp !== null && typeof sp.context === "function") {
      sp.context({
        name: `${PACKAGE_ID}.identity`,
        order: 900,
        required: false,
        text: (assembleContext) => {
          try {
            const sid = assembleContext?.scope?.id;
            if (sid === null || sid === undefined) return "";
            const entry = identityLedger.get(String(sid));
            if (!entry) return "";
            const lines = ["【子代理身份】", `角色：${entry.roleName}`];
            if (entry.rolePurpose) lines.push(`职责：${entry.rolePurpose}`);
            if (entry.task) lines.push(`任务：${entry.task}`);
            if (entry.requestedModel) lines.push(`指定路线：${entry.requestedProvider}/${entry.requestedModel}`);
            if (entry.tier && entry.tier !== "primary") lines.push(`档位：${entry.tier}`);
            const actual = sessionModelLedger.get(String(sid));
            if (actual?.model) lines.push(`调用路线：${actual.provider}/${actual.model}`);
            return lines.join("\n");
          } catch {
            return "";
          }
        },
      });
    }
  } catch (error) {
    warnOnce(ctx, `[${PACKAGE_ID}] could not attach systemPrompt context: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Role dispatch tool — the explicit roleId entry point
 * ------------------------------------------------------------------ */

function pickSubagentProvider(subagents) {
  try {
    if (typeof subagents?.getProvider !== "function") return undefined;
    // Explicit model routing (agentOptions) is a spawn-provider feature. Never
    // silently fall back to fork/acp: those inherit the parent's context/model
    // and would silently widen the inherited context. Missing spawn or a spawn
    // without agentOptions must fail explicitly in the caller.
    const provider = subagents.getProvider("spawn");
    if (provider && typeof provider?.capabilities?.agentOptions === "boolean") return provider;
    return undefined;
  } catch {
    return undefined;
  }
}

function attachRoleTool(ctx) {
  try {
    const tools = serviceOf([ctx], "tools");
    if (tools === null || typeof tools.register !== "function") return;
    const definition = {
      name: TOOL_NAME,
      description:
        "Dispatch a subagent under an explicit configured role. The role resolves its own primary/backup/upgrade model route, so the caller does not choose a model name directly. Use this instead of the plain subagent tool when the task belongs to a configured role.",
      parameters: {
        type: "object",
        properties: {
          roleId: { type: "string", description: "Configured role id, e.g. coder, researcher, secretary." },
          prompt: { type: "string", description: "The complete task for the child agent." },
          description: { type: "string", description: "Short 3-5 word display label." },
          tier: {
            type: "string",
            enum: ["primary", "backup", "upgrade"],
            description: "Which configured route to use. Defaults to primary; no silent switching.",
          },
          cwd: { type: "string", description: "Optional working directory for the child." },
          override: {
            type: "object",
            description:
              "Optional single-task explicit override. When provided with provider+model it takes precedence over the team role and the role tier. Still subject to authorization.",
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              reasoningPolicy: { type: "string", enum: ["default", "fixed", "smart"] },
              reasoningEffort: { type: "string" },
              smartMap: { type: "object" },
            },
            additionalProperties: false,
          },
          teamRole: {
            type: "string",
            enum: ["planner", "executor", "reviewer", "advisor"],
            description: "Optional team role whose configured route overrides the role tier.",
          },
        },
        required: ["roleId", "prompt"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            kind: { type: "string" },
            subagentId: { type: "string" },
            roleId: { type: "string" },
            roleName: { type: "string" },
            routeProvider: { type: "string" },
            routeModel: { type: "string" },
            routeReasoningEffort: { type: "string" },
            tier: { type: "string" },
            modeId: { type: "string" },
            modeRevision: { type: "number" },
            routeSource: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        render: (args, value) => [
          {
            type: "text",
            text: `已按角色派发：${value?.roleName ?? args?.roleId ?? ""}（${value?.routeProvider ?? ""}/${value?.routeModel ?? ""}${value?.routeReasoningEffort ? `，推理 ${value.routeReasoningEffort}` : ""}${value?.tier && value.tier !== "primary" ? `，${value.tier}` : ""}）→ 子代理 ${value?.subagentId ?? ""}`,
          },
        ],
      },
      async execute(args, exec) {
        const roleId = typeof args?.roleId === "string" ? args.roleId.trim() : "";
        const prompt = typeof args?.prompt === "string" ? args.prompt : "";
        if (roleId === "") throw new Error("roleId 不能为空");
        if (prompt.trim() === "") throw new Error("prompt 不能为空");
        const tier = args?.tier === "backup" || args?.tier === "upgrade" ? args.tier : "primary";
        const teamRole = ["planner", "executor", "reviewer", "advisor"].includes(args?.teamRole)
          ? args.teamRole
          : null;
        if (args?.target === "taskBoard") {
          throw new Error(
            "任务板独立会话执行目标不受支持（无可用业务服务）。agentTeams.createTask 仅是共享待办账本，不启动独立会话、不含模型路由。",
          );
        }
        const override = args?.override !== null && typeof args?.override === "object" ? args.override : null;
        const parentId = typeof exec?.agent?.id === "string" ? exec.agent.id : "";

        const store = await loadStore([ctx]);
        if (store.consistency && store.consistency.ok === false) {
          throw new Error("角色配置处于不一致状态（上次保存未完成回滚）。请先在设置页重新载入并保存，再派发。");
        }

        // The role store remains the global enable/disable and special-role
        // authority, even when the frozen mode snapshot supplies the route.
        // This keeps the legacy role API authoritative for disabling roles.
        const storeRole = store.roles.find((row) => row.id === roleId);
        if (storeRole) {
          if (storeRole.enabled === false) {
            throw new Error(`角色 ${storeRole.name} 已停用`);
          }
          if (storeRole.kind === "privacy") {
            throw new Error(`角色 ${storeRole.name} 不允许自动云端派发`);
          }
        }

        // Phase-C: dispatch from the frozen mode snapshot + team/single-task
        // override, with per-position effort validation. Falls back to the legacy
        // role-store dispatch when no mode snapshot is available yet.
        const modesStore = await loadModesStore([ctx]);
        const snapshot = execution.ensureSessionSnapshot(parentId, modesStore?.activeSnapshot ?? null);
        const capStore = await loadCapabilitiesStore([ctx]);
        const fingerprints = await currentProviderFingerprints(serviceOf([ctx], "llm"));
        const capabilityFor = capabilityResolver(capStore, fingerprints, Date.now());

        let resolved = null;
        if (snapshot !== null) {
          resolved = execution.resolveRoleDispatch({
            snapshotConfig: snapshot.config,
            modeId: snapshot.modeId,
            modeRevision: snapshot.modeRevision,
            roleId,
            tier,
            complexity: ROLE_COMPLEXITY[roleId],
            override,
            teamRole,
            capabilityFor,
            authorizedModels: store.authorizedModels,
          });
          if (!resolved.ok) throw new Error(resolved.error);
        }

        let routeProvider;
        let routeModel;
        let routeReasoningEffort;
        let routeSource;
        let modeId;
        let modeRevision;
        let roleName;
        let roleKind;
        let rolePurpose;

        if (resolved !== null) {
          routeProvider = resolved.route.provider;
          routeModel = resolved.route.model;
          routeReasoningEffort = resolved.reasoningEffort;
          routeSource = resolved.routeSource;
          modeId = resolved.modeId;
          modeRevision = resolved.modeRevision;
          roleName = resolved.roleName;
          roleKind = resolved.roleKind;
          rolePurpose = resolved.rolePurpose ?? "";
        } else {
          // Legacy role-store dispatch (no mode snapshot).
          const role = store.roles.find((row) => row.id === roleId);
          if (!role) throw new Error(`没有配置角色 ${roleId}`);
          if (role.enabled === false) throw new Error(`角色 ${role.name} 已停用`);
          if (role.kind === "privacy") throw new Error(`角色 ${role.name} 不允许自动云端派发`);
          const route = role[tier];
          if (!route) throw new Error(`角色 ${role.name} 没有配置 ${tier} 路线`);
          const authorizedKeys = routeSetOf(store.authorizedModels ?? []);
          if (!authorizedKeys.has(routeKey(route.provider, route.model))) {
            throw new Error(
              `角色 ${role.name} 的${TIER_LABELS[tier] ?? tier}路线 ${route.provider}/${route.model} 未获授权。请先在设置页「模型授权」中授权该模型，再新建会话派发。`,
            );
          }
          routeProvider = route.provider;
          routeModel = route.model;
          routeReasoningEffort = await resolveReasoningEffort(serviceOf([ctx], "llm"), route, ROLE_COMPLEXITY[role.id]);
          routeSource = "legacy-role";
          modeId = "";
          modeRevision = 0;
          roleName = role.name;
          roleKind = role.kind;
          rolePurpose = role.purpose ?? "";
        }

        // Official per-session policy snapshot still constrains the resolved
        // route, for both snapshot and legacy dispatch. A session without a
        // policy snapshot is rejected (unchanged authorization semantics).
        const sessions = serviceOf([ctx], "sessions");
        const allowed = sessionAllowedRoutes(sessions, parentId);
        if (allowed === null) {
          throw new Error("当前会话没有模型授权快照（可能是旧会话或模型选择未启用）。请在设置中启用并新建会话后再派发。");
        }
        const permitted = allowed.some(
          (row) => row.provider === routeProvider && row.model === routeModel,
        );
        if (!permitted) {
          throw new Error(
            `路线 ${routeProvider}/${routeModel} 不在本会话授权范围内。请在设置中保存该路线并新建会话，或为该角色选择已授权路线。`,
          );
        }

        // Native same-tree subagent dispatch (the only supported execution target).
        // Cross-session task-board execution was removed: agentTeams.createTask is a
        // shared TODO ledger (no independent session, no model in its request), so it
        // cannot route a model and must not be presented as a running dispatch.
        const mode = snapshot?.config ?? null;
        if (mode !== null && mode?.taskTargets?.native?.enabled !== true) {
          throw new Error("当前模式未启用原生执行目标");
        }

        const subagents = serviceOf([ctx], "subagents");
        if (subagents === null || typeof subagents.startActivation !== "function") {
          throw new Error("subagents 服务尚未就绪");
        }
        const provider = pickSubagentProvider(subagents);
        if (!provider) throw new Error("没有已注册的子代理 provider");
        if (provider.capabilities?.agentOptions !== true) {
          throw new Error(`子代理 provider ${provider.name} 不支持显式模型路由（agentOptions）`);
        }

        // Plugin-scoped concurrency limit (the only scope we can enforce).
        // Reserve the slot atomically BEFORE the await below; checking then
        // awaiting would let Promise.all run N starts past the limit.
        const maxConcurrentWorkers = snapshot?.config?.team?.maxConcurrentWorkers;
        const reservation = execution.reserveDispatch(maxConcurrentWorkers, { roleId, roleName, modeId });
        if (reservation === null) {
          throw new Error(
            `团队并发上限（maxConcurrentWorkers=${maxConcurrentWorkers}）已达，请等待进行中的派工完成`,
          );
        }

        const agentOptions = {
          provider: routeProvider,
          model: routeModel,
          ...(routeReasoningEffort ? { reasoningEffort: routeReasoningEffort } : {}),
        };
        let activation;
        try {
          activation = await subagents.startActivation({
            provider: provider.name,
            label: typeof args.description === "string" && args.description !== "" ? args.description : roleName,
            prompt: [{ type: "text", text: prompt }],
            parent: exec.agent,
            agentOptions,
            ...(typeof args.cwd === "string" && args.cwd !== "" ? { cwd: args.cwd } : {}),
            signal: exec.signal,
            delivery: "parent",
          });
        } catch (error) {
          execution.releaseReservation(reservation);
          throw error;
        }
        const subagentId = String(activation?.childId ?? "");
        if (subagentId === "") {
          execution.releaseReservation(reservation);
          throw new Error("子代理启动未返回 childId");
        }
        execution.settleReservation(reservation, subagentId);

        const result = {
          kind: "activation",
          subagentId,
          roleId,
          roleName,
          routeProvider,
          routeModel,
          routeReasoningEffort: routeReasoningEffort ?? "",
          tier,
          modeId,
          modeRevision,
          routeSource,
        };
        ledgerSet(identityLedger, result.subagentId, {
          childId: result.subagentId,
          parentSessionId: parentId,
          roleId,
          roleName,
          rolePurpose,
          tier,
          description: String(args.description ?? ""),
          task: extractTask(prompt),
          requestedProvider: routeProvider,
          requestedModel: routeModel,
          actualProvider: "",
          actualModel: "",
          modeId,
          modeRevision,
          routeSource,
          status: "running",
          createdAt: Date.now(),
        });
        return result;
      },
    };
    tools.register(definition);
  } catch (error) {
    warnOnce(ctx, `[${PACKAGE_ID}] could not register ${TOOL_NAME}: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

function warnOnce(ctx, message) {
  try {
    const logger = ctx?.logger;
    if (logger !== null && typeof logger?.warn === "function") logger.warn(message);
  } catch {
    /* logging is never worth failing over */
  }
}

/* ------------------------------------------------------------------ *
 * Three-mode data layer (phase A) — schema, migration, capability cache
 *
 * These handlers are pure additive data endpoints. They read/write two NEW store
 * files (`dsh-economy-mode.state.json`, `dsh-economy-capabilities.json`) and
 * never touch the existing `dsh-workflow-model-routing.state.json` or the
 * official `subagent-model-selection-settings` entry, so the existing role store
 * and the live policy (revision 4+) stay intact. "normal" inherits the existing
 * roles on first seed; migration backs up the existing store before seeding.
 * ------------------------------------------------------------------ */

async function loadModesStore(scopes) {
  const dir = storeDirectory(scopes);
  const file = dir === "" ? "" : path.join(dir, modes.MODES_FILE);
  if (file === "") {
    return { ...modes.seedModesStore({ roles: [] }), persistent: false, file: "" };
  }
  if (modesCache !== null && modesCache.file === file && Date.now() - modesCache.at < 2_000) {
    return modesCache.data;
  }
  let payload = await modes.readModesFile(file);
  if (payload === null || typeof payload !== "object" || typeof payload.modes !== "object") {
    // First access: seed from the existing role store. The existing store is read
    // only, backed up to .bak-<ts>, and never modified.
    const existing = await loadStore(scopes);
    const existingFile = typeof existing?.file === "string" && existing.file !== "" ? existing.file : "";
    const backup = existingFile !== "" ? await modes.backupExistingStore(existingFile) : null;
    payload = modes.seedModesStore({ roles: existing?.roles ?? [], migration: backup });
    let wrote = false;
    try {
      wrote = await modes.writeModesFile(file, payload);
    } catch {
      wrote = false;
    }
    payload.persistent = wrote;
    payload.file = file;
  } else {
    payload = modes.ensureAllModes(payload);
    const filled = Array.isArray(payload.filledModes) ? payload.filledModes : [];
    payload.persistent = true;
    payload.file = file;
    if (filled.length > 0) {
      // Persist the backfill so the next read is stable; strip the transient
      // filledModes marker before writing (it is only for this response).
      const toPersist = { ...payload };
      delete toPersist.filledModes;
      try {
        await modes.writeModesFile(file, toPersist);
      } catch {
        /* best-effort backfill; the next read re-synthesizes */
      }
    }
  }
  modesCache = { file, at: Date.now(), data: payload };
  return payload;
}

async function loadCapabilitiesStore(scopes) {
  const dir = storeDirectory(scopes);
  const file = dir === "" ? "" : path.join(dir, capabilities.CAPABILITIES_FILE);
  if (file === "") {
    return {
      schemaVersion: capabilities.CAPABILITIES_SCHEMA_VERSION,
      records: [],
      persistent: false,
      file: "",
      empty: true,
    };
  }
  if (capabilitiesCache !== null && capabilitiesCache.file === file && Date.now() - capabilitiesCache.at < 2_000) {
    return capabilitiesCache.data;
  }
  const payload = await capabilities.readCapabilitiesFile(file);
  const data =
    payload !== null && typeof payload === "object"
      ? { ...payload, persistent: true, file }
      : {
          schemaVersion: capabilities.CAPABILITIES_SCHEMA_VERSION,
          records: [],
          persistent: true,
          file,
          empty: true,
        };
  // Adopt the on-disk generation, but never step below the authoritative
  // in-memory value: after a failed invalidation the in-memory barrier stays
  // higher than disk, so stale records cannot be reloaded and read "ok".
  const diskGen = typeof data.generation === "number" ? data.generation : 0;
  if (capabilityGeneration === null || diskGen > capabilityGeneration) {
    capabilityGeneration = diskGen;
  }
  data.generation = capabilityGeneration;
  capabilitiesCache = { file, at: Date.now(), data };
  return data;
}

/** Current provider → config fingerprint map, recomputed from the llm service. */
async function currentProviderFingerprints(llm) {
  const map = new Map();
  if (llm === null || typeof llm.listProviders !== "function") return map;
  try {
    const providerList = (await llm.listProviders()) ?? [];
    const configurableByProvider = new Map();
    if (typeof llm.listConfigurableProviders === "function") {
      const entries = (await llm.listConfigurableProviders()) ?? [];
      for (const entry of entries) {
        if (entry !== null && typeof entry === "object" && typeof entry.provider === "string") {
          configurableByProvider.set(entry.provider, entry);
        }
      }
    }
    for (const providerInfo of providerList) {
      const providerId = providerInfo?.id;
      if (typeof providerId !== "string" || providerId === "") continue;
      map.set(
        providerId,
        capabilities.providerFingerprint(providerInfo, configurableByProvider.get(providerId)),
      );
    }
  } catch {
    /* best effort; a partial map just skips the fingerprint check */
  }
  return map;
}

/**
 * Persist an explicit capability-cache invalidation by bumping the store
 * generation. A memory-only clear is insufficient: the next read would reload
 * the same records with the same directory-declared fingerprint and report them
 * "ok" again. We bump the authoritative in-memory generation FIRST, then try to
 * persist it; if persistence fails the in-memory barrier remains higher than the
 * on-disk generation, so every older record reads "stale" (fail closed).
 */
async function invalidateCapabilityCache(scopes) {
  let persisted = false;
  await withCapabilityWriteLock(async () => {
    try {
      const dir = storeDirectory(scopes);
      const file = dir === "" ? "" : path.join(dir, capabilities.CAPABILITIES_FILE);
      let existing = null;
      if (file !== "") {
        existing = await capabilities.readCapabilitiesFile(file);
      }
      const diskGen = existing !== null && typeof existing?.generation === "number" ? existing.generation : 0;
      const current = capabilityGeneration === null ? diskGen : Math.max(capabilityGeneration, diskGen);
      capabilityGeneration = current + 1; // memory barrier FIRST: fail closed even if persist fails
      if (file === "") {
        persisted = true; // nothing durable to write; the in-memory barrier is authoritative
        return;
      }
      if (__maybeFault("capabilitiesWrite")) {
        throw new Error("capabilities write fault (test)");
      }
      const base =
        existing !== null && typeof existing === "object"
          ? existing
          : { schemaVersion: capabilities.CAPABILITIES_SCHEMA_VERSION, records: [] };
      const next = {
        ...base,
        generation: capabilityGeneration,
        updatedAt: new Date().toISOString(),
      };
      await capabilities.writeCapabilitiesFile(file, next);
      persisted = true;
    } catch {
      persisted = false; // memory barrier already bumped above diskGen → fail closed
    }
  });
  capabilitiesCache = null;
  return persisted;
}

function modesHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    try {
      const store = await loadModesStore(scopes);
      const roleStore = await loadStore(scopes);
      const base = {
        ok: true,
        currentModeId: store.currentModeId,
        migration: store.migration ?? null,
        activeSnapshot: store.activeSnapshot ?? null,
        authorizedModels: roleStore.authorizedModels ?? [],
        persistent: store.persistent === true,
        file: store.file ?? "",
        interpretations: modes.MODE_INTERPRETATIONS,
        version: PACKAGE_VERSION,
        changelog: CHANGELOG,
        recommendedPresets: modes.recommendedPresets(),
        recommendedAuthorizedModels: clone(DEFAULT_AUTHORIZED),
      };
      const single = new URL(request.url ?? "", "http://localhost").searchParams.get("mode");
      if (single !== null && single !== "") {
        const mode = store.modes?.[single];
        if (mode === undefined) {
          json(response, 404, { error: "unknown-mode", message: `未知模式 ${single}` });
          return;
        }
        json(response, 200, { ...base, mode: modes.canonicalizeModeDisplay(mode) });
        return;
      }
      const storedModes = store.modes ?? {};
      const displayed = {};
      for (const key of Object.keys(storedModes)) {
        displayed[key] = modes.canonicalizeModeDisplay(storedModes[key]);
      }
      json(response, 200, { ...base, modes: displayed });
    } catch (error) {
      json(response, 500, { error: "modes-failed", message: String(error?.message ?? error) });
    }
  };
}

/** POST /modes/save — draft save. Separated from enable: save never activates. */
/* ------------------------------------------------------------------ *
 * Serial mode write lock — save and enable share ONE queue, so a
 * check-then-write CAS cannot be raced by two concurrent HTTP requests.
 * ------------------------------------------------------------------ */

let modeWriteLock = Promise.resolve();

function withModeWriteLock(task) {
  const run = modeWriteLock.then(task, task);
  modeWriteLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function withCapabilityWriteLock(task) {
  const run = capabilityWriteLock.then(task, task);
  capabilityWriteLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test-only: clear the catalog cache so buildCatalog re-enumerates. */
export function __resetCatalogCache() {
  catalogCache = null;
}

/** Test-only fault injection (production: always zero). Pass null to clear. */
export function __setTestFaults(next) {
  if (next === null || typeof next !== "object") {
    __faults.modesWrite = 0;
    __faults.capabilitiesWrite = 0;
    return;
  }
  if (Number.isInteger(next.modesWrite) && next.modesWrite >= 0) __faults.modesWrite = next.modesWrite;
  if (Number.isInteger(next.capabilitiesWrite) && next.capabilitiesWrite >= 0) {
    __faults.capabilitiesWrite = next.capabilitiesWrite;
  }
}

function __maybeFault(kind) {
  if (kind === "modesWrite" && __faults.modesWrite > 0) {
    __faults.modesWrite -= 1;
    return true;
  }
  if (kind === "capabilitiesWrite" && __faults.capabilitiesWrite > 0) {
    __faults.capabilitiesWrite -= 1;
    return true;
  }
  return false;
}

/** Persist a non-recoverable enable inconsistency for manual review. */
const RECOVERY_FILE = "dsh-economy-mode.recovery.json";

async function writeRecoveryLog(scopes, entry) {
  try {
    const dir = storeDirectory(scopes);
    if (dir === "") return false;
    const file = path.join(dir, RECOVERY_FILE);
    const text = `${JSON.stringify(entry, null, 2)}\n`;
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, text, "utf8");
    await fs.rename(temporary, file);
    return true;
  } catch {
    return false;
  }
}

function modeSaveHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, 400, { error: error?.code ?? "BAD_BODY", message: String(error?.message ?? error) });
      return;
    }
    await withModeWriteLock(async () => {
      try {
        const modeId = typeof body?.modeId === "string" ? body.modeId.trim() : "";
        const store = await loadModesStore(scopes);
        if (store.persistent === false || store.file === "") {
          json(response, 503, { error: "store-unavailable", message: "无法定位配置目录，无法保存。" });
          return;
        }
        let normalized;
        try {
          normalized = modes.normalizeMode(modeId, body?.mode);
        } catch (error) {
          json(response, 400, { error: error?.code ?? "UNKNOWN_MODE", message: String(error?.message ?? error) });
          return;
        }
        const next = clone(store);
        const prior = Number.isInteger(next.modes?.[modeId]?.revision) ? next.modes[modeId].revision : 0;
        if (
          body?.expectedRevision !== undefined &&
          body?.expectedRevision !== null &&
          Number(body.expectedRevision) !== prior
        ) {
          json(response, 409, {
            error: "mode-save-conflict",
            message: `模式 ${modeId} 已被并发修改，当前 revision=${prior}，请基于最新版本重试。`,
            revision: prior,
          });
          return;
        }
        normalized.revision = prior + 1;
        next.modes[modeId] = normalized;
        next.updatedAt = normalized.updatedAt;
        await modes.writeModesFile(next.file, next);
        modesCache = { file: next.file, at: Date.now(), data: next };
        json(response, 200, { ok: true, mode: normalized, revision: normalized.revision, saved: true, enabled: false });
      } catch (error) {
        json(response, 500, { error: "mode-save-failed", message: String(error?.message ?? error) });
      }
    });
  };
}

/** Build a capabilityFor resolver from a loaded capability store + fingerprints. */
function capabilityResolver(capStore, fingerprints, now = Date.now()) {
  const records = Array.isArray(capStore?.records) ? capStore.records : [];
  const generation = typeof capStore?.generation === "number" ? capStore.generation : 0;
  return (provider, model) => {
    const record = records.find((entry) => entry?.provider === provider && entry?.model === model);
    if (record === undefined) return undefined;
    return {
      ...record,
      status: capabilities.effectiveStatus(record, {
        now,
        generation,
        fingerprint: typeof fingerprints?.get === "function" ? fingerprints.get(provider) : undefined,
      }),
    };
  };
}

/**
 * POST /modes/enable — validate then activate. Enable is a configuration
 * transaction: it never expands authorization, and a failed validation (or a
 * failed write) leaves both disk and the in-memory cache unchanged (rollback).
 */
function modeEnableHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, 400, { error: error?.code ?? "BAD_BODY", message: String(error?.message ?? error) });
      return;
    }
    await withModeWriteLock(async () => {
      try {
        const modeId = typeof body?.modeId === "string" ? body.modeId.trim() : "";
        const store = await loadModesStore(scopes);
        const mode = store.modes?.[modeId];
        if (mode === undefined) {
          json(response, 404, { error: "unknown-mode", message: `未知模式 ${modeId}` });
          return;
        }
        if (
          body?.expectedRevision !== undefined &&
          body?.expectedRevision !== null &&
          Number(body.expectedRevision) !== Number(mode.revision)
        ) {
          json(response, 409, {
            error: "mode-enable-conflict",
            message: `模式 ${modeId} 已被并发修改，当前 revision=${mode.revision}，请基于最新版本重试。`,
            revision: mode.revision,
          });
          return;
        }
        const roleStore = await loadStore(scopes);
        const capStore = await loadCapabilitiesStore(scopes);
        const now = Date.now();
        const fingerprints = await currentProviderFingerprints(serviceOf(scopes, "llm"));
        const capabilityFor = capabilityResolver(capStore, fingerprints, now);
        const validation = modes.validateModeForEnable(mode, {
          authorizedModels: roleStore.authorizedModels,
          capabilityFor,
        });
        if (!validation.ok) {
          json(response, 422, {
            ok: false,
            errors: validation.errors,
            enabled: false,
            note: "启用失败，未写入任何变更（已回滚）。",
          });
          return;
        }
        const next = clone(store);
        const previous = next.currentModeId;
        const enabledAt = new Date().toISOString();
        next.currentModeId = modeId;
        next.updatedAt = enabledAt;
        next.activeSnapshot = { modeId, config: clone(mode), enabledAt };

        // Phase-C execution wiring: an explicit enable action persists the
        // mode's lead as the future default model (OUTSIDE apply/HMR, so
        // saveSelection is safe). The transaction is: read prior selection →
        // saveSelection → write modes file. If the modes write does not commit,
        // compensate by restoring the prior selection; if compensation also
        // fails, persist a recovery log and report inconsistency (never claim a
        // rollback that may not have happened).
        const agentDefaultModel = serviceOf(scopes, "agentDefaultModel");

        // Read the prior Lead default BEFORE any mutation. If the read throws we
        // reject before changing anything — without a compensation baseline we
        // cannot safely roll back.
        let priorSelection = null;
        let priorReadFailed = false;
        if (agentDefaultModel !== null && typeof agentDefaultModel?.currentSelection === "function") {
          try {
            const sel = await agentDefaultModel.currentSelection();
            priorSelection = sel !== null && typeof sel === "object" ? sel : null;
          } catch {
            priorReadFailed = true;
          }
        }
        if (priorReadFailed) {
          json(response, 500, {
            ok: false,
            enabled: false,
            error: "lead-read-failed",
            message: "无法读取先前 Lead 默认选择，已拒绝启用（未做任何变更）。",
            note: "未调用 saveSelection、未写入模式文件。",
          });
          return;
        }

        const applied = await execution.applyLeadDefault(agentDefaultModel, mode);

        let modesWrote = false;
        let modesWriteError = null;
        if (applied.ok) {
          try {
            if (__maybeFault("modesWrite")) throw new Error("modes write fault (test)");
            await modes.writeModesFile(next.file, next);
            modesWrote = true;
          } catch (error) {
            modesWrote = false;
            modesWriteError = error;
          }
        }

        if (!applied.ok || !modesWrote) {
          // Roll the modes file back. Track its result separately from the Lead
          // restore so a failed rollback is never reported as a success.
          let modesRolledBack = true;
          let modesRollbackError = null;
          try {
            if (__maybeFault("modesWrite")) throw new Error("modes write fault (test)");
            await modes.writeModesFile(store.file, store);
          } catch (error) {
            modesRolledBack = false;
            modesRollbackError = error;
          }
          if (modesRolledBack) {
            modesCache = { file: store.file, at: Date.now(), data: store };
          } else {
            modesCache = null; // unknown disk state; force a reload on next read
          }
          const restored = await execution.restoreLeadDefault(agentDefaultModel, priorSelection);

          if (modesRolledBack && restored.ok) {
            json(response, 502, {
              ok: false,
              enabled: false,
              error: applied.ok ? "mode-write-failed" : "lead-default-failed",
              message: applied.ok ? "模式写盘失败，已恢复先前 Lead 默认选择。" : applied.error,
              note: "启用失败，已回滚模式快照并恢复先前 Lead 默认选择。",
            });
            return;
          }

          const logged = await writeRecoveryLog(scopes, {
            kind: "enable-inconsistent",
            modeId,
            attempted: applied.applied ?? null,
            priorSelection,
            saveSelectionFailed: !applied.ok,
            saveSelectionError: applied.ok ? null : applied.error,
            modesWriteFailed: !modesWrote,
            modesWriteError: modesWriteError ? String(modesWriteError?.message ?? modesWriteError) : null,
            modesRollbackFailed: !modesRolledBack,
            modesRollbackError: modesRollbackError ? String(modesRollbackError?.message ?? modesRollbackError) : null,
            restoreFailed: !restored.ok,
            restoreError: restored.ok ? null : restored.error,
            at: new Date().toISOString(),
          });
          const parts = [];
          if (!modesRolledBack) parts.push("模式文件回滚失败");
          if (!restored.ok) parts.push("Lead 默认恢复失败");
          json(response, 500, {
            ok: false,
            enabled: false,
            error: "inconsistent",
            message: `启用失败且补偿未完全成功：${parts.join("；") || "未知"}`,
            note: logged
              ? "不一致状态已写入恢复日志 dsh-economy-mode.recovery.json，请人工核对模式文件与 Lead 默认选择。"
              : "不一致状态未能持久化恢复日志，请人工核对模式文件与 Lead 默认选择。",
          });
          return;
        }

        modesCache = { file: next.file, at: Date.now(), data: next };
        json(response, 200, {
          ok: true,
          currentModeId: modeId,
          previousModeId: previous,
          enabled: true,
          appliedLead: applied.applied,
        });
      } catch (error) {
        json(response, 500, { error: "mode-enable-failed", message: String(error?.message ?? error) });
      }
    });
  };
}

/** GET /capabilities — read the local cache; never refreshes, never spends money. */
function capabilitiesHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    try {
      const store = await loadCapabilitiesStore(scopes);
      const now = Date.now();
      const fingerprints = await currentProviderFingerprints(serviceOf(scopes, "llm"));
      const generation = typeof store?.generation === "number" ? store.generation : 0;
      const records = (store.records ?? []).map((record) => ({
        ...record,
        effectiveStatus: capabilities.effectiveStatus(record, {
          now,
          generation,
          fingerprint: fingerprints.get(record.provider),
        }),
      }));
      json(response, 200, {
        ok: true,
        schemaVersion: store.schemaVersion ?? capabilities.CAPABILITIES_SCHEMA_VERSION,
        updatedAt: store.updatedAt ?? "",
        empty: store.empty === true,
        persistent: store.persistent === true,
        file: store.file ?? "",
        records,
      });
    } catch (error) {
      json(response, 500, { error: "capabilities-failed", message: String(error?.message ?? error) });
    }
  };
}

/** POST /capabilities/refresh — re-detect (read-only adapter metadata) + merge + write. */
function capabilitiesRefreshHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    try {
      const llm = serviceOf(scopes, "llm");
      if (llm === null || typeof llm.listProviders !== "function") {
        json(response, 503, { error: "llm-unavailable", message: "LLM 服务尚未就绪，无法检测能力。" });
        return;
      }
      await withCapabilityWriteLock(async () => {
        const existing = await loadCapabilitiesStore(scopes);
        const generation = typeof existing?.generation === "number" ? existing.generation : 0;
        const detected = await capabilities.detectCapabilities(llm, { generation });
        if (detected.error) {
          json(response, 502, { error: "detect-failed", message: String(detected.error) });
          return;
        }
        const merged = capabilities.mergeCapabilityCache(existing, detected.records, { generation });
        if (existing.file !== "") {
          try {
            if (__maybeFault("capabilitiesWrite")) throw new Error("capabilities write fault (test)");
            await capabilities.writeCapabilitiesFile(existing.file, merged);
          } catch (error) {
            // Fail closed: the merged records were NOT persisted. Bump the
            // authoritative generation so the stale on-disk records cannot be
            // reloaded and reported "ok"; do not cache the unpersisted merge.
            capabilityGeneration = (capabilityGeneration ?? 0) + 1;
            capabilitiesCache = null;
            json(response, 500, {
              error: "capabilities-refresh-write-failed",
              message: String(error?.message ?? error),
            });
            return;
          }
        }
        merged.persistent = existing.file !== "";
        merged.file = existing.file;
        capabilitiesCache = { file: existing.file, at: Date.now(), data: merged };
        json(response, 200, {
          ok: true,
          updatedAt: merged.updatedAt,
          providers: detected.providers,
          records: merged.records,
          invalidated: merged.invalidated ?? [],
          narrowed: merged.narrowed ?? [],
          dropped: merged.dropped ?? [],
          note: "刷新只读取本地适配器元数据（listProviders/listModels/resolveModelInfo），不发起付费模型请求。",
        });
      });
    } catch (error) {
      json(response, 500, { error: "capabilities-refresh-failed", message: String(error?.message ?? error) });
    }
  };
}

/** GET /execution-integration — report the phase-C wiring surface for the UI. */
function executionIntegrationHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    try {
      const agentDefaultModel = serviceOf(scopes, "agentDefaultModel");
      const agentTeams = serviceOf(scopes, "agentTeams");
      json(response, 200, {
        ok: true,
        ...execution.executionIntegration({ agentDefaultModel, agentTeams }),
      });
    } catch (error) {
      json(response, 500, { error: "execution-integration-failed", message: String(error?.message ?? error) });
    }
  };
}

/** GET /tiers — model tier display summary for the current authorized models. */
function tiersHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    try {
      const roleStore = await loadStore(scopes);
      const result = await tiers.loadModelTiers({ authorizedModels: roleStore.authorizedModels ?? [] });
      json(response, 200, { ok: true, ...result });
    } catch (error) {
      json(response, 500, { error: "tiers-failed", message: String(error?.message ?? error) });
    }
  };
}

/** POST /tiers/refresh — re-read the plan file and authorized models. */
function tiersRefreshHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    try {
      const roleStore = await loadStore(scopes);
      const result = await tiers.loadModelTiers({ authorizedModels: roleStore.authorizedModels ?? [] });
      json(response, 200, { ok: true, ...result });
    } catch (error) {
      json(response, 500, { error: "tiers-failed", message: String(error?.message ?? error) });
    }
  };
}

/* ------------------------------------------------------------------ *
 * AI assistant (v2.4.0)
 * ------------------------------------------------------------------ */

/** Enumerate the full local catalog (shared cache with GET /catalog). */
async function collectCatalog(llm) {
  if (llm === null || typeof llm.listProviders !== "function") return { ok: false, providers: [] };
  return buildCatalog(llm);
}

/** Catalog for the AI assistant: same policy as the client (no -vision alias). */
async function collectNonVisionCatalog(llm) {
  const catalog = await collectCatalog(llm);
  if (!catalog.ok) return catalog;
  return { ...catalog, providers: routePolicy.filterVisionProviders(catalog.providers) };
}

/** Verify the execution model is authorized; returns {provider,model,roleStore} or null. */
async function requireAuthorizedExecutionModel(scopes, body, response) {
  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (provider === "" || model === "") {
    json(response, 400, { error: "bad-request", message: "provider/model 不能为空。" });
    return null;
  }
  if (routePolicy.isVisionAliasProvider(provider)) {
    json(response,400,{error:"vision-executor-forbidden",message:"vision 衍生版本不参与一键配置，请选择非 vision 版本。"}); return null;
  }
  const roleStore = await loadStore(scopes);
  const authorized = Array.isArray(roleStore.authorizedModels) ? roleStore.authorizedModels : [];
  const allowed = authorized.some((route) => route?.provider === provider && route?.model === model);
  if (!allowed) {
    json(response, 403, { error: "unauthorized-model", message: `执行模型 ${provider}/${model} 未授权。` });
    return null;
  }
  return { provider, model, roleStore };
}

function aiConfigureHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const llm = serviceOf(scopes, "llm");
    if (llm === null || typeof llm.stream !== "function") {
      json(response, 503, { error: "llm-unavailable", message: "LLM 服务尚未就绪。" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, 400, { error: "bad-body", message: String(error?.message ?? error) });
      return;
    }
    try {
      const exec = await requireAuthorizedExecutionModel(scopes, body, response);
      if (exec === null) return;
      const modesStore = await loadModesStore(scopes);
      const catalog = await collectNonVisionCatalog(llm);
      const result = await aiAssistant.configureModes({
        llm,
        provider: exec.provider,
        model: exec.model,
        authorizedModels: exec.roleStore.authorizedModels ?? [],
        catalog,
        modesStore,
        roles: exec.roleStore.roles ?? [],
      });
      json(response, 200, result);
    } catch (error) {
      json(response, 500, { error: "ai-configure-failed", message: aiAssistant.formatError(error), kind: aiAssistant.errorKind(error) });
    }
  };
}

function aiRecommendHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const llm = serviceOf(scopes, "llm");
    if (llm === null || typeof llm.stream !== "function") {
      json(response, 503, { error: "llm-unavailable", message: "LLM 服务尚未就绪。" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, 400, { error: "bad-body", message: String(error?.message ?? error) });
      return;
    }
    try {
      const exec = await requireAuthorizedExecutionModel(scopes, body, response);
      if (exec === null) return;
      const modesStore = await loadModesStore(scopes);
      const catalog = await collectNonVisionCatalog(llm);
      const result = await aiAssistant.recommendModels({
        llm,
        provider: exec.provider,
        model: exec.model,
        authorizedModels: exec.roleStore.authorizedModels ?? [],
        catalog,
        modesStore,
        roles: exec.roleStore.roles ?? [],
      });
      json(response, 200, result);
    } catch (error) {
      json(response, 500, { error: "ai-recommend-failed", message: aiAssistant.formatError(error), kind: aiAssistant.errorKind(error) });
    }
  };
}

function queryParam(request, name) {
  try {
    const url = new URL(request?.url ?? "", "http://localhost");
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

function aiJobsHandler(scopes, manager) {
  return async (request, response) => {
    if (!guard(request, response)) return;
    const llm = serviceOf(scopes, "llm");

    if (request.method === "GET") {
      const id = queryParam(request, "id");
      if (id === null || id === "") {
        json(response, 400, { error: "bad-request", message: "缺少任务 id。" });
        return;
      }
      const job = manager.get(id);
      if (job === null) {
        json(response, 404, { error: "job-not-found", message: "任务不存在或已过期（可能是重启后内存任务丢失）。" });
        return;
      }
      json(response, 200, { ok: true, job });
      return;
    }

    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (llm === null || typeof llm.stream !== "function") {
      json(response, 503, { error: "llm-unavailable", message: "LLM 服务尚未就绪。" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, 400, { error: "bad-body", message: String(error?.message ?? error) });
      return;
    }
    const operation = typeof body?.operation === "string" ? body.operation.trim() : "";
    if (operation !== "configure" && operation !== "recommend") {
      json(response, 400, { error: "bad-request", message: "operation 必须是 configure 或 recommend。" });
      return;
    }
    try {
      // Authorization is checked BEFORE enqueue, with zero model calls.
      const exec = await requireAuthorizedExecutionModel(scopes, body, response);
      if (exec === null) return;
      const run = async () => {
        // The heavy work (loadModesStore + collectCatalog + the four-mode serial
        // stream) happens in the background, never inside the POST response.
        const modesStore = await loadModesStore(scopes);
        const catalog = await collectNonVisionCatalog(llm);
        if (operation === "configure") {
          return aiAssistant.configureModes({
            llm,
            provider: exec.provider,
            model: exec.model,
            authorizedModels: exec.roleStore.authorizedModels ?? [],
            catalog,
            modesStore,
            roles: exec.roleStore.roles ?? [],
          });
        }
        return aiAssistant.recommendModels({
          llm,
          provider: exec.provider,
          model: exec.model,
          authorizedModels: exec.roleStore.authorizedModels ?? [],
          catalog,
          modesStore,
          roles: exec.roleStore.roles ?? [],
        });
      };
      const enqueued = manager.enqueue({
        operation,
        provider: exec.provider,
        model: exec.model,
        requestId: typeof body?.requestId === "string" && body.requestId !== "" ? body.requestId : null,
        run,
      });
      if (!enqueued.ok) {
        if (enqueued.error === "request-id-conflict") {
          json(response, 409, { error: "request-id-conflict", jobId: enqueued.jobId, message: "该 requestId 已用于其他任务。" });
          return;
        }
        if (enqueued.error === "capacity-full") {
          json(response, 429, { error: "capacity-full", message: "并发任务已满（最多 4 个未完成），请稍后重试。" });
          return;
        }
        json(response, 500, { error: "job-enqueue-failed", message: enqueued.error || "入队失败。" });
        return;
      }
      json(response, 202, { ok: true, jobId: enqueued.job.jobId, status: enqueued.job.status });
    } catch (error) {
      json(response, 500, { error: "ai-job-failed", message: aiAssistant.formatError(error), kind: aiAssistant.errorKind(error) });
    }
  };
}

function releaseNotesHandler() {
  return async (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (!guard(request, response)) return;
    const result = await aiAssistant.readReleaseNotes();
    if (!result.ok) {
      json(response, 503, { error: "release-notes-unavailable", message: result.error });
      return;
    }
    json(response, 200, result.data);
  };
}

/** Back up one store file to `<file>.bak-<ts>` before a migration write. */
async function backupStoreFile(file, raw, ts) {
  if (file === "" || raw === null) return null;
  const target = `${file}.bak-${ts}`;
  try {
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, raw, "utf8");
    await fs.rename(temporary, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * POST /migrate-deployment-routes — v2.6.3 non-vision deployment migration.
 *
 * One serial write transaction across three persistence targets:
 *   1. the modes store (four modes + activeSnapshot.config),
 *   2. the role store (roles + authorizedModels),
 *   3. the official subagent-model-selection-settings policy row.
 *
 * The plan is computed from the RAW catalog (vision metadata retained so
 * cross-id display-name matching still resolves), so the endpoint never calls
 * a model and never streams/probes/enables: it only reads listProviders /
 * listModels / resolveModelInfo metadata.
 *
 * `{ apply: false }` (default) is a dry run: it returns the full plan plus the
 * exact revisions `apply` must present (CAS). `{ apply: true, expected: {...} }`
 * re-reads the three targets INSIDE the lock, verifies every presented
 * revision, then writes with backup + fail-stop rollback. NO_TARGET routes
 * reject the whole plan before anything is written (no blind deletion).
 */
function migrateDeploymentRoutesHandler(scopes) {
  return async (request, response) => {
    if (request.method !== "POST") return json(response,405,{error:"method not allowed"});
    if (!guard(request,response)) return;
    let body;
    try { body=await readJsonBody(request); } catch(error) { return json(response,400,{error:"bad-body",message:String(error.message)}); }
    await withModeWriteLock(async()=>{
      // This lock is also used by role-save and mode-save/enable handlers.
      storeCache=null; modesCache=null;
      const backupFiles={}, committed=[], restored=[];
      let rolesRaw, modesRaw, rolesFile, modesFile;
      const reset=()=>{ storeCache=null; modesCache=null; };
      try {
        const settings=serviceOf(scopes,"settings"), llm=serviceOf(scopes,"llm");
        if (!settings || !llm) return json(response,503,{error:"services-unavailable"});
        // Metadata enumeration only: no stream/probe/saveSelection.
        const catalog=await buildCatalog(llm);
        if (!catalog.ok) return json(response,503,{error:"catalog-failed"});
        const dir=storeDirectory(scopes);
        if (!dir) return json(response,503,{error:"store-unavailable"});
        rolesFile=path.join(dir,STORE_FILE);
        modesFile=path.join(dir,modes.MODES_FILE);
        rolesRaw=await fs.readFile(rolesFile,"utf8");
        modesRaw=await fs.readFile(modesFile,"utf8");
        const rawRoles=JSON.parse(rolesRaw), rawModes=JSON.parse(modesRaw);
        if (!Array.isArray(rawRoles.authorizedModels) || !Array.isArray(rawRoles.roles) || !rawModes.modes) return json(response,409,{error:"unsupported-store",message:"缺失持久化部署数据，未写入"});
        const found=findPolicyRow(settings);
        if (!found.row || !Number.isInteger(found.row.revision)) return json(response,503,{error:"policy-unavailable"});
        const digest=(v)=>createHash("sha256").update(v).digest("hex");
        const current={ storeHash:digest(rolesRaw), modesHash:digest(modesRaw), policyHash:digest(JSON.stringify(found.row.value)), policyRevision:found.row.revision };
        const index=routePolicy.buildCatalogIndex(catalog);
        const rr=routePolicy.migrateRoles(rawRoles,index,"roleStore");
        const mm=routePolicy.migrateModesStore(rawModes,index);
        const pp=routePolicy.migrateRole(found.row.value,index,"officialPolicy");
        const auth=routePolicy.migrateAuthorizedModels(rawRoles.authorizedModels,index);
        const errors=[...rr.errors,...mm.errors,...pp.errors,...auth.errors];
        if(errors.length) return json(response,409,{ok:false,error:"no-target",errors,current});
        rr.value.authorizedModels=auth.after;
        pp.value.allowedModels=auth.after;
        const warnings=[...rr.warnings,...mm.warnings,...pp.warnings];
        const plan={ authorized:{after:auth.after,migrated:auth.migrated}, roles:{value:rr.value.roles,migrated:rr.migrated}, modesStore:{value:mm.value,migrated:mm.migrated} };
        if(body.apply!==true) return json(response,200,{ok:true,dryRun:true,plan,warnings,current,expected:current,activeSnapshotRevisionPolicy:"frozen"});
        if(!body.expected || Object.keys(current).some(k=>body.expected[k]!==current[k])) return json(response,409,{ok:false,error:"conflict",current,message:"必须回传完整干跑指纹；数据已变化时请重新干跑"});
        const ts=Date.now();
        backupFiles.roles=await backupStoreFile(rolesFile,rolesRaw,ts);
        backupFiles.modes=await backupStoreFile(modesFile,modesRaw,ts);
        // Back up the exact settings row too, without tokens or provider config.
        if(!backupFiles.roles || !backupFiles.modes) throw new Error("backup-failed: no writes performed");
        backupFiles.policy=path.join(dir,`dsh-routing-policy.bak-${ts}.json`);
        await fs.writeFile(backupFiles.policy,JSON.stringify({ns:found.row.ns,revision:found.row.revision,value:found.row.value},null,2),{encoding:"utf8",flag:"wx"});
        // External file writers cannot take our in-process lock. Detect changes
        // since the initial read again immediately before committing.
        if(await fs.readFile(rolesFile,"utf8")!==rolesRaw || await fs.readFile(modesFile,"utf8")!==modesRaw) return json(response,409,{ok:false,error:"conflict",backupFiles});
        const stamp=new Date().toISOString();
        rr.value.revision=(rawRoles.revision??0)+1; rr.value.updatedAt=stamp;
        for(const id of modes.MODE_IDS) if(mm.value.modes[id]) mm.value.modes[id].revision=(rawModes.modes[id].revision??0)+1;
        mm.value.updatedAt=stamp;
        try {
          // Mark attempted files before writing so even a partial write rolls back.
          committed.push("modes"); await modes.writeModesFile(modesFile,mm.value);
          committed.push("roles"); await writeStore(rolesFile,rr.value);
          await settings.replace(found.row.ns,pp.value,found.row.revision);
          committed.push("settings");
        } catch(error) {
          if(committed.includes("roles") && await restoreRawFile(rolesFile,rolesRaw)) restored.push("roles");
          if(committed.includes("modes") && await restoreRawFile(modesFile,modesRaw)) restored.push("modes");
          reset();
          const recoveryPath=await writeRecoveryLog(scopes,{at:stamp,operation:"migrate-deployment-routes",error:String(error.message),committed,restored,backupFiles});
          return json(response,error.code==="SETTINGS_CONFLICT"?409:500,{ok:false,error:restored.length===committed.length?"rolled-back":"inconsistent",message:String(error.message),committed,restored,backupFiles,recoveryPath});
        }
        reset();
        return json(response,200,{ok:true,dryRun:false,committed,restored,backupFiles,warnings,migrated:{authorized:auth.migrated,roles:rr.migrated,modesStore:mm.migrated},activeSnapshotRevisionPolicy:"frozen",recoveryPath:""});
      } catch(error) { reset(); return json(response,500,{ok:false,error:"migrate-failed",message:String(error.message),committed,restored,backupFiles}); }
    });
  };
}

export function apply(ctx) {
  attachRuntimeHooks(ctx);
  attachSystemPrompt(ctx);
  attachRoleTool(ctx);
  try {
    ctx.inject(["webServer"], (scoped) => {
      const scopes = [scoped, ctx];
      const register = (path, handler) => {
        try {
          scoped.webServer.register({ kind: "exact", path, handler });
        } catch (error) {
          warnOnce(ctx, `[${PACKAGE_ID}] could not register ${path}: ${String(error)}`);
        }
      };
      const jobManager = aiJobs.createJobManager();
      register(STATE_ROUTE, stateHandler(scopes));
      register(CATALOG_ROUTE, catalogHandler(scopes));
      register(ROLES_ROUTE, rolesHandler(scopes));
      register(VALIDATE_ROUTE, validateHandler(scopes));
      register(ROLES_SAVE_ROUTE, saveHandler(scopes));
      register(SUBAGENTS_ROUTE, subagentsHandler(scopes));
      register(MODES_ROUTE, modesHandler(scopes));
      register(MODE_SAVE_ROUTE, modeSaveHandler(scopes));
      register(MODE_ENABLE_ROUTE, modeEnableHandler(scopes));
      register(CAPABILITIES_ROUTE, capabilitiesHandler(scopes));
      register(CAPABILITIES_REFRESH_ROUTE, capabilitiesRefreshHandler(scopes));
      register(EXECUTION_INTEGRATION_ROUTE, executionIntegrationHandler(scopes));
      register(TIERS_ROUTE, tiersHandler(scopes));
      register(TIERS_REFRESH_ROUTE, tiersRefreshHandler(scopes));
      register(AI_CONFIGURE_ROUTE, aiConfigureHandler(scopes));
      register(AI_RECOMMEND_ROUTE, aiRecommendHandler(scopes));
      register(AI_JOBS_ROUTE, aiJobsHandler(scopes, jobManager));
      register(RELEASE_NOTES_ROUTE, releaseNotesHandler());
      register(MIGRATE_ROUTE, migrateDeploymentRoutesHandler(scopes));
    });
  } catch (error) {
    warnOnce(ctx, `[${PACKAGE_ID}] could not inject webServer: ${String(error)}`);
  }
}

export const name = PACKAGE_ID;
export default { name: PACKAGE_ID, apply };
