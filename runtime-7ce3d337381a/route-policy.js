/** Pure deployment policy: filter derived vision providers, prefer equivalent
 * subscription routes, and migrate route objects without changing user policy. */
export const PROVIDER_PRIORITY = Object.freeze(["kimi-subscription", "antigravity"]);
export const isVisionAliasProvider = (provider) => /-vision$/i.test(String(provider ?? "").trim());
export const isVisionRoute = (route) => !!route && typeof route === "object" && isVisionAliasProvider(route.provider);
export const baseProviderOf = (provider) => String(provider ?? "").trim().replace(/-vision$/i, "");
export function canonicalModelName(name) {
  return String(name ?? "").normalize("NFKC").replace(/\s*·\s*x[\d.]+$/i, "").replace(/\s*自动识图\s*$/, "").trim().toLowerCase().replace(/\s+/g, " ");
}
export function buildCatalogIndex(catalog) {
  const providers = Array.isArray(catalog) ? catalog : catalog?.providers ?? [];
  const byProviderModel = new Map(), modelsById = new Map(), providersById = new Map();
  for (const p of providers) {
    if (!p?.id) continue;
    providersById.set(p.id, p);
    for (const m of p.models ?? []) {
      if (!m?.id) continue;
      const row = { ...m, provider: p.id, model: m.id, name: m.name ?? m.id };
      byProviderModel.set(`${p.id}\0${m.id}`, row);
    }
  }
  for (const row of byProviderModel.values()) {
    if (!modelsById.has(row.model)) modelsById.set(row.model, []);
    modelsById.get(row.model).push(row);
  }
  return { byProviderModel, modelsById, providersById, providerOrder: [...providersById.keys()] };
}
const rank = (provider, original) => {
  const n = PROVIDER_PRIORITY.indexOf(provider);
  return n < 0 ? (provider === original ? 10 : 20) : n;
};
function pick(rows, original) {
  return [...rows].sort((a,b) => rank(a.provider,original)-rank(b.provider,original) || a.provider.localeCompare(b.provider))[0] ?? null;
}
/** Exact ids first. Cross-id names must identify one model id (possibly exposed
 * by several providers), preserving version/highspeed/context distinctions. */
export function findNonVisionTarget(route, index) {
  const provider = String(route?.provider ?? ""), model = String(route?.model ?? "");
  if (!provider || !model) return null;
  const exact = (index.modelsById.get(model) ?? []).filter(r => !isVisionAliasProvider(r.provider));
  const preferredExact = exact.filter(r => PROVIDER_PRIORITY.includes(r.provider));
  if (preferredExact.length) return pick(preferredExact, baseProviderOf(provider));
  const original = index.byProviderModel.get(`${provider}\0${model}`);
  if (!original?.name) return pick(exact, baseProviderOf(provider));
  const name = canonicalModelName(original.name);
  const matches = [...index.byProviderModel.values()].filter(r => !isVisionAliasProvider(r.provider) && canonicalModelName(r.name) === name);
  const preferredNames = matches.filter(r => PROVIDER_PRIORITY.includes(r.provider));
  if (new Set(preferredNames.map(r => r.model)).size === 1) return pick(preferredNames, baseProviderOf(provider));
  if (exact.length) return pick(exact, baseProviderOf(provider));
  if (new Set(matches.map(r => r.model)).size !== 1) return null;
  return pick(matches, baseProviderOf(provider));
}
export function revalidateReasoning(route, declared) {
  if ((route.reasoningPolicy ?? "default") === "default") return { route, downgraded: false, warning: null };
  const ids = new Set((declared ?? []).map(e => typeof e === "string" ? e : e?.id));
  const valid = route.reasoningPolicy === "fixed"
    ? typeof route.reasoningEffort === "string" && ids.has(route.reasoningEffort)
    : route.reasoningPolicy === "smart" && ["low","medium","high"].every(k => typeof route.smartMap?.[k] === "string" && ids.has(route.smartMap[k]));
  if (valid) return { route, downgraded: false, warning: null };
  return { route: { ...route, reasoningPolicy: "default", reasoningEffort: null, smartMap: null }, downgraded: true, warning: "目标未声明原推理档位或映射不完整，降至 default" };
}
export function migrateRouteObject(obj, index, label = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || !obj.provider || !obj.model) return { value: obj, changed: false, error: null };
  const target = findNonVisionTarget(obj, index);
  if (!target) return { value: obj, changed: false, error: isVisionRoute(obj) ? { code: "NO_TARGET", message: `${label}: ${obj.provider}/${obj.model} 无对应非 vision 目标` } : null };
  if (target.provider === obj.provider && target.model === obj.model) return { value: obj, changed: false, error: null };
  const checked = revalidateReasoning({ ...obj, provider: target.provider, model: target.model }, target.reasoningEfforts);
  return { value: checked.route, changed: true, target: { provider: target.provider, model: target.model }, downgraded: checked.downgraded, warning: checked.warning ? `${label}: ${checked.warning}` : null, error: null };
}
/** Generic traversal covers defaults, pairings, team nesting and custom route
 * slots. Only actual {provider,model} values (and authorProviders) are changed. */
function migrateTree(value, index, path) {
  const migrated = [], errors = [], warnings = [];
  function visit(v, pos) {
    if (!v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x,i) => visit(x, `${pos}[${i}]`));
    const next = {};
    for (const [k,x] of Object.entries(v)) {
      if (k === "authorProviders" && Array.isArray(x)) {
        next[k] = [...new Set(x.map(p => isVisionAliasProvider(p) ? baseProviderOf(p) : p))];
      } else next[k] = visit(x, `${pos}.${k}`);
    }
    const r = migrateRouteObject(next, index, pos);
    if (r.error) errors.push({ ...r.error, position: pos });
    if (r.changed) migrated.push({ position: pos, from: { provider: v.provider, model: v.model }, to: r.target, downgraded: r.downgraded });
    if (r.warning) warnings.push(r.warning);
    return r.value;
  }
  return { value: visit(value,path), migrated, errors, warnings };
}
export const migrateRole = (v,i,p="role") => migrateTree(v,i,p);
export const migrateRoles = (v,i,p="roles") => migrateTree(v,i,p);
export const migrateMode = (v,i,p="mode") => migrateTree(v,i,p);
export const migrateModesStore = (v,i) => migrateTree(v,i,"modesStore");
export function migrateAuthorizedModels(routes,index) {
  const r = migrateTree(routes ?? [],index,"authorizedModels"), seen = new Set();
  return { ...r, after: r.value.filter(v => { const k=`${v.provider}\0${v.model}`; if(seen.has(k)) return false; seen.add(k); return true; }) };
}
export function planDeploymentMigration({catalog,authorizedModels,roles,modesStore}) {
  const index=buildCatalogIndex(catalog), auth=migrateAuthorizedModels(authorizedModels,index), rr=migrateRoles(roles,index), mm=migrateModesStore(modesStore,index);
  const errors=[...auth.errors,...rr.errors,...mm.errors];
  return { ok: errors.length===0, catalog: { providerCount:index.providerOrder.length, visionProviders:index.providerOrder.filter(isVisionAliasProvider), nonVisionProviders:index.providerOrder.filter(p=>!isVisionAliasProvider(p)) }, authorized:{after:auth.after,migrated:auth.migrated}, roles:{value:rr.value,migrated:rr.migrated}, modesStore:{value:mm.value,migrated:mm.migrated,activeSnapshotMigrated:mm.migrated.some(m=>m.position.includes("activeSnapshot"))}, warnings:[...auth.warnings,...rr.warnings,...mm.warnings], errors };
}
export const filterVisionProviders = (providers) => (providers ?? []).filter(p => !isVisionAliasProvider(p?.id));
export const filterVisionRoutes = (routes) => (routes ?? []).filter(r => !isVisionRoute(r));
/** Keep all nonvision providers but order automatic candidates by preference. */
export function preferredCatalog(catalog) {
  return { ...catalog, providers: filterVisionProviders(catalog?.providers).sort((a,b)=>rank(a.id,"")-rank(b.id,"") || a.id.localeCompare(b.id)) };
}
