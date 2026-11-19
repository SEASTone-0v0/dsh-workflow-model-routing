import * as capabilities from "./capabilities.js";
import * as modes from "./modes.js";

/*
 * Phase-C execution wiring (economy mode). This module holds the pieces that
 * turn an ENABLED mode's immutable snapshot into real behaviour, without ever
 * expanding authorization, touching DSH core, or intercepting the global LLM
 * stream:
 *
 *   - per-session snapshot freeze (a new session freezes the active mode;
 *     a mode switch only affects sessions created afterwards),
 *   - Lead default application via agentDefaultModel.saveSelection (an explicit
 *     enable-time action, never inside an apply/HMR transaction),
 *   - role dispatch resolution from the frozen snapshot + team-role override +
 *     single-task override, with per-position default/fixed/smart effort
 *     validation against the local capability cache,
 *   - plugin-scoped concurrency tracking (the only scope we can enforce),
 *   - cross-session task-board wiring via agentTeams (honest unsupported when
 *     the service is absent).
 *
 * Everything here is pure or takes explicit service references, so it is unit
 * testable offline without a running Host.
 */

/* ------------------------------------------------------------------ *
 * Session snapshot freeze
 * ------------------------------------------------------------------ */

const sessionSnapshots = new Map();

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Freeze the active mode snapshot for a session. Returns false when the id is
 * empty or the snapshot is unusable (never throws).
 */
export function freezeSessionSnapshot(sessionId, activeSnapshot) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const config = activeSnapshot?.config;
  const modeId = typeof activeSnapshot?.modeId === "string" ? activeSnapshot.modeId : "";
  if (modeId === "" || config === null || typeof config !== "object") return false;
  sessionSnapshots.set(sessionId, {
    modeId,
    modeRevision:
      typeof config.revision === "number" ? config.revision : 0,
    config: clone(config),
    frozenAt: Date.now(),
  });
  // No eviction: an unbounded snapshot map is intentional. Evicting the oldest
  // snapshot would let a long-lived session be re-frozen against a later mode
  // (silently switching its model), which violates "a mode switch only affects
  // sessions created afterwards". Fail-closed by never discarding.
  return true;
}

/** Read a frozen snapshot (or null when the session has none). */
export function readSessionSnapshot(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const record = sessionSnapshots.get(sessionId);
  return record === undefined ? null : record;
}

/**
 * Freeze a snapshot only when the session has none yet (lazy first-use freeze
 * for sessions created before this plugin observed agent/created). Returns the
 * now-frozen record.
 */
export function ensureSessionSnapshot(sessionId, activeSnapshot) {
  const existing = readSessionSnapshot(sessionId);
  if (existing !== null) return existing;
  if (freezeSessionSnapshot(sessionId, activeSnapshot)) return readSessionSnapshot(sessionId);
  return null;
}

/** Test-only helper to clear all frozen snapshots. */
export function clearSessionSnapshots() {
  sessionSnapshots.clear();
}

export function snapshotCount() {
  return sessionSnapshots.size;
}

/* ------------------------------------------------------------------ *
 * Lead default
 * ------------------------------------------------------------------ */

/**
 * Derive the ModelSelection to persist for a mode's lead. Only a "fixed" lead
 * carries a static reasoningEffort; "default" and "smart" resolve to null (the
 * adapter default) because a smart per-turn selection cannot be expressed as a
 * single static default without intercepting the stream (forbidden).
 */
export function leadSelectionFor(modeConfig) {
  const lead = modeConfig?.lead;
  if (lead === null || typeof lead !== "object") return null;
  const provider = typeof lead.provider === "string" ? lead.provider.trim() : "";
  const model = typeof lead.model === "string" ? lead.model.trim() : "";
  if (provider === "" || model === "") return null;
  const effort =
    lead.reasoningPolicy === "fixed" &&
    typeof lead.reasoningEffort === "string" &&
    lead.reasoningEffort.trim() !== ""
      ? lead.reasoningEffort.trim()
      : null;
  return { provider, model, reasoningEffort: effort };
}

/**
 * Persist a mode's lead as the future default model. This is an EXPLICIT action
 * (the mode-enable HTTP handler calls it, never apply/HMR); saveSelection
 * submits in order and rejects without corrupting the profile.
 *
 * Returns { ok, applied?, error? }.
 */
export async function applyLeadDefault(agentDefaultModel, modeConfig) {
  if (
    agentDefaultModel === null ||
    agentDefaultModel === undefined ||
    typeof agentDefaultModel.saveSelection !== "function"
  ) {
    return { ok: false, error: "agentDefaultModel.saveSelection 不可用（服务未注册）" };
  }
  const selection = leadSelectionFor(modeConfig);
  if (selection === null) {
    return { ok: false, error: "模式缺少有效的 Lead 路线" };
  }
  try {
    await agentDefaultModel.saveSelection(selection);
    return { ok: true, applied: selection };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Read the current Lead default selection, before applying a mode. This is the
 * compensation baseline: if the mode-enable transaction does not fully commit
 * (saveSelection succeeded but the modes file write failed), the previous
 * selection is what we restore.
 *
 * Returns the selection object, or null when the service/method is unavailable
 * or the read fails (null means "no known baseline to restore").
 */
export async function readCurrentSelection(agentDefaultModel) {
  if (
    agentDefaultModel === null ||
    agentDefaultModel === undefined ||
    typeof agentDefaultModel.currentSelection !== "function"
  ) {
    return null;
  }
  try {
    const selection = await agentDefaultModel.currentSelection();
    return selection !== null && typeof selection === "object" ? selection : null;
  } catch {
    return null;
  }
}

/**
 * Restore a previously-read Lead default selection. Honest about failure: a
 * failed restore returns { ok:false, error } so the caller can persist a
 * recovery log instead of claiming a rollback that may not have happened.
 */
export async function restoreLeadDefault(agentDefaultModel, selection) {
  if (
    agentDefaultModel === null ||
    agentDefaultModel === undefined ||
    typeof agentDefaultModel.saveSelection !== "function"
  ) {
    return { ok: false, error: "agentDefaultModel.saveSelection 不可用（服务未注册）" };
  }
  if (selection === null || selection === undefined) {
    return { ok: false, error: "无先前 Lead 默认选择可恢复" };
  }
  try {
    await agentDefaultModel.saveSelection(selection);
    return { ok: true, applied: selection };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ------------------------------------------------------------------ *
 * Effort resolution (strict per-position)
 * ------------------------------------------------------------------ */

/**
 * Resolve the reasoningEffort to send for ONE route position, distinguishing
 * "fixed is invalid → explicit failure" from "smart/default → adapter default".
 *
 * Returns { ok, reasoningEffort?, code?, error? }.
 */
export function resolveEffortStrict({ route, complexity = "medium", capabilityFor }) {
  const policy = route?.reasoningPolicy === "fixed" || route?.reasoningPolicy === "smart"
    ? route.reasoningPolicy
    : "default";
  if (policy === "default") return { ok: true, reasoningEffort: undefined };

  const capability =
    typeof capabilityFor === "function" ? capabilityFor(route.provider, route.model) : undefined;
  const status = capability?.status ?? "unknown";
  const declared =
    capability?.status === "ok" && Array.isArray(capability?.efforts)
      ? capability.efforts.map((entry) => entry.id)
      : [];

  if (policy === "fixed") {
    const effort = typeof route.reasoningEffort === "string" && route.reasoningEffort.trim() !== ""
      ? route.reasoningEffort.trim()
      : "";
    if (effort === "") {
      return { ok: false, code: "fixed-effort-missing", error: "固定推理档位未设置" };
    }
    if (status !== "ok" || declared.length === 0) {
      return {
        ok: false,
        code: "capability-unavailable",
        error: `路线 ${route.provider}/${route.model} 的能力未检测或已过期，无法验证固定档位`,
      };
    }
    if (!declared.includes(effort)) {
      return {
        ok: false,
        code: "fixed-effort-undeclared",
        error: `固定档位 ${effort} 不在 ${route.provider}/${route.model} 的已声明档位中`,
      };
    }
    return { ok: true, reasoningEffort: effort };
  }

  // smart: missing map / unknown capability / undeclared mapped tier → adapter default
  const tier = complexity === "low" || complexity === "high" ? complexity : "medium";
  const mapped = typeof route.smartMap?.[tier] === "string" && route.smartMap[tier] !== ""
    ? route.smartMap[tier]
    : "";
  if (mapped === "" || status !== "ok" || !declared.includes(mapped)) {
    return { ok: true, reasoningEffort: undefined };
  }
  return { ok: true, reasoningEffort: mapped };
}

/* ------------------------------------------------------------------ *
 * Role dispatch resolution
 * ------------------------------------------------------------------ */

const TEAM_ROLES = ["planner", "executor", "reviewer", "advisor"];
const TIERS = ["primary", "backup", "upgrade"];

function authorizedKeySet(authorizedModels) {
  const set = new Set();
  for (const row of authorizedModels ?? []) {
    const provider = typeof row?.provider === "string" ? row.provider.trim() : "";
    const model = typeof row?.model === "string" ? row.model.trim() : "";
    if (provider !== "" && model !== "") set.add(`${provider}\u0000${model}`);
  }
  return set;
}

/**
 * Resolve the route + effort for one role dispatch, from a frozen mode snapshot.
 *
 * Route source precedence: single-task `override` > `teamRole` route > role tier
 * route. Every chosen route is still re-checked against `authorizedModels` at
 * dispatch time (authorization is never expanded by a mode, and the snapshot may
 * have been frozen before a later authorization change).
 *
 * Returns { ok:true, modeId, modeRevision, roleId, roleName, roleKind, tier,
 *   route, routeSource, reasoningEffort } or { ok:false, code, error }.
 */
export function resolveRoleDispatch({
  snapshotConfig,
  modeId = "",
  modeRevision = 0,
  roleId,
  tier = "primary",
  complexity = "medium",
  override = null,
  teamRole = null,
  capabilityFor = () => undefined,
  authorizedModels = [],
}) {
  const config = snapshotConfig;
  if (config === null || typeof config !== "object") {
    return { ok: false, code: "no-snapshot", error: "当前会话没有冻结的模式快照" };
  }
  const roles = Array.isArray(config.roles) ? config.roles : [];
  const role = roles.find((row) => row?.id === roleId);
  if (!role) return { ok: false, code: "unknown-role", error: `模式中不存在角色 ${roleId}` };
  if (role.enabled === false) {
    return { ok: false, code: "role-disabled", error: `角色 ${role.name ?? roleId} 已停用` };
  }
  if (role.kind === "privacy") {
    return { ok: false, code: "privacy-role", error: `角色 ${role.name ?? roleId} 不允许自动云端派发` };
  }
  const normalizedTier = TIERS.includes(tier) ? tier : "primary";

  const overrideRoute = modes.cleanRoute(override);
  let route = null;
  let routeSource = "";
  if (overrideRoute !== null) {
    route = overrideRoute;
    routeSource = "task-override";
  } else if (TEAM_ROLES.includes(teamRole)) {
    const teamRoute = modes.cleanRoute(config.team?.[teamRole]);
    if (teamRoute !== null) {
      route = teamRoute;
      routeSource = `team-${teamRole}`;
    }
  }
  if (route === null) {
    route = modes.cleanRoute(role[normalizedTier]);
    routeSource = `role-${normalizedTier}`;
  }
  if (route === null) {
    return {
      ok: false,
      code: "no-route",
      error: `角色 ${role.name ?? roleId} 没有可用路线（tier=${normalizedTier}${teamRole ? `, teamRole=${teamRole}` : ""}）`,
    };
  }

  const authorizedKeys = authorizedKeySet(authorizedModels);
  if (!authorizedKeys.has(`${route.provider}\u0000${route.model}`)) {
    return {
      ok: false,
      code: "unauthorized",
      error: `路线 ${route.provider}/${route.model} 未获授权`,
    };
  }

  const effort = resolveEffortStrict({ route, complexity, capabilityFor });
  if (!effort.ok) {
    return {
      ok: false,
      code: effort.code,
      error: `角色 ${role.name ?? roleId} 的推理配置无效：${effort.error}`,
    };
  }

  return {
    ok: true,
    modeId,
    modeRevision,
    roleId: role.id,
    roleName: role.name ?? role.id,
    roleKind: role.kind ?? "standard",
    rolePurpose: role.purpose ?? "",
    tier: normalizedTier,
    route: {
      provider: route.provider,
      model: route.model,
      reasoningPolicy: route.reasoningPolicy ?? "default",
      reasoningEffort: route.reasoningEffort ?? null,
      smartMap: route.smartMap ?? null,
    },
    routeSource,
    reasoningEffort: effort.reasoningEffort,
  };
}

/* ------------------------------------------------------------------ *
 * Plugin-scoped concurrency tracking
 * ------------------------------------------------------------------ */

const activeDispatches = new Map();
const pendingReservations = new Map();
let reservationSeq = 0;

export function trackDispatch(key, info = {}) {
  if (typeof key !== "string" || key === "") return;
  activeDispatches.set(key, { ...info, startedAt: Date.now() });
}

export function untrackDispatch(key) {
  activeDispatches.delete(key);
}

export function activeDispatchCount() {
  return activeDispatches.size;
}

/**
 * Atomically reserve a dispatch slot BEFORE the async startActivation await.
 * This closes the Promise.all race where N concurrent calls all pass a
 * check-then-await guard and only increment the counter afterwards. The limit is
 * checked against active + pending reservations in one synchronous step.
 *
 * Returns an opaque token, or null when the limit is already reached (or `max`
 * is not a positive integer, meaning "no limit").
 */
export function reserveDispatch(max, info = {}) {
  if (typeof max === "number" && Number.isInteger(max) && max > 0) {
    if (activeDispatchCount() + pendingReservations.size >= max) return null;
  }
  const token = `resv-${++reservationSeq}`;
  pendingReservations.set(token, { info, reservedAt: Date.now() });
  return token;
}

/**
 * Promote a pending reservation to an active dispatch (on startActivation
 * success). The reservation token is consumed.
 */
export function settleReservation(token, key) {
  if (typeof token !== "string" || token === "") return;
  const reservation = pendingReservations.get(token);
  pendingReservations.delete(token);
  trackDispatch(key, reservation?.info ?? {});
}

/**
 * Release a pending reservation (on startActivation failure/cancel, or any
 * path that resolves without producing a tracked child id).
 */
export function releaseReservation(token) {
  if (typeof token !== "string" || token === "") return;
  pendingReservations.delete(token);
}

export function pendingReservationCount() {
  return pendingReservations.size;
}

export function clearDispatches() {
  activeDispatches.clear();
  pendingReservations.clear();
}

/* ------------------------------------------------------------------ *
 * Cross-session task board (agentTeams)
 * ------------------------------------------------------------------ */

/**
 * Create a cross-session team task. Honest: returns a structured failure (never
 * a fabricated success) when the service or its entry point is absent, when the
 * board is disabled, or when persistence is unconfirmed.
 */
export async function createTeamTask(agentTeams, caller, request, signal) {
  if (agentTeams === null || agentTeams === undefined || typeof agentTeams.createTask !== "function") {
    return { ok: false, code: "taskboard-unsupported", error: "任务板服务不可用（agentTeams.createTask 未注册）" };
  }
  try {
    if (typeof agentTeams.isEnabled === "function" && agentTeams.isEnabled(caller) !== true) {
      return { ok: false, code: "taskboard-disabled", error: "任务板未启用" };
    }
  } catch {
    /* isEnabled absent or threw → fall through and let createTask decide */
  }
  try {
    const view = await agentTeams.createTask(caller, request, signal);
    return { ok: true, task: view };
  } catch (error) {
    return {
      ok: false,
      code: "taskboard-failed",
      error: String(error?.message ?? error),
      persistenceUnconfirmed: String(error?.code ?? "") === "TEAM_TASK_PERSISTENCE_UNCONFIRMED",
    };
  }
}

/* ------------------------------------------------------------------ *
 * Execution integration status (for the phase-B UI)
 * ------------------------------------------------------------------ */

export function executionIntegration({ agentDefaultModel = null, agentTeams = null } = {}) {
  return {
    leadDefault: {
      wired:
        agentDefaultModel !== null &&
        agentDefaultModel !== undefined &&
        typeof agentDefaultModel.saveSelection === "function",
      entryPoint: "agentDefaultModel.saveSelection",
      note: "仅在显式启用动作（POST /modes/enable）中调用，不在 apply/HMR 事务中调用。",
    },
    nativeDispatch: {
      wired: true,
      entryPoint: "role_subagent tool",
      note: "原生同树子代理：读会话冻结快照 + 团队角色覆盖 + 单任务覆盖，逐位置校验 default/fixed/smart。",
    },
    sessionSnapshot: {
      wired: true,
      entryPoint: "agent/created",
      note: "新会话冻结当前活动模式快照；旧会话首次派发时惰性冻结。模式切换只影响后续新会话。",
    },
    taskBoard: {
      // agentTeams.createTask writes a shared team_task_create TODO ledger entry;
      // it does NOT open an independent task_board session and its request
      // carries no model, so it cannot execute a model-routed dispatch. There is
      // no real business service for independent task-board sessions, so the
      // execution target is honest-unsupported (never a fabricated running task).
      wired: false,
      entryPoint: "agentTeams.createTask (shared TODO ledger only)",
      note: "不接线为角色派工执行目标：createTask 只是共享待办账本，不启动独立会话、不含模型路由。",
    },
    advisory: {
      concurrency: "plugin-scoped hard limit（仅统计本插件 role_subagent 派工）",
      retry: "advisory — failureRetryLimit 只记录，不自动重试",
      budget: "advisory — 无计量",
      writeIsolation: "convention — 工作约定，非真实沙箱边界",
    },
    unsupported: [
      "Lead 级 smart 推理档位动态选择（需劫持 llm/stream，被禁止；saveSelection 仅设 provider/model/固定 effort）",
      "端点真实变更指纹（公开契约无不含密钥的实时端点值，指纹为目录声明身份）",
      "全局模型路由劫持（禁止；仅控制本插件 role_subagent 派工与启用 Lead 默认）",
      "任务板独立会话执行目标（无真实业务服务；agentTeams.createTask 仅为共享待办账本）",
    ],
  };
}
