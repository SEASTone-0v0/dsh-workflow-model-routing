#!/usr/bin/env node
/** Metadata-only deployment migration. Default dry-run; --apply uses fresh CAS. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runDeploymentMigration({ base, args = [], print = console.log }) {
  const endpoint = base + '/plugins/dsh-workflow-model-routing/migrate-deployment-routes';
  async function request(body) {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: expected migration JSON, received ${text.slice(0, 160)}`); }
    if (!r.ok || !data.ok) throw new Error(JSON.stringify({ status: r.status, ...data }, null, 2));
    return data;
  }
  const dry = await request({ apply: false });
  const counts = { authorized: dry.plan.authorized.migrated.length, roles: dry.plan.roles.migrated.length, modesStore: dry.plan.modesStore.migrated.length };
  print(JSON.stringify({ dryRun: true, counts, warnings: dry.warnings, expected: dry.expected }, null, 2));
  const out = args.find(a => a.startsWith('--output='))?.slice(9);
  if (out) await fs.writeFile(out, JSON.stringify(dry, null, 2) + '\n', { flag: 'wx' });
  if (args.includes('--apply')) {
    if (!['storeHash', 'modesHash', 'policyHash'].every(k => /^[a-f0-9]{64}$/.test(dry.expected?.[k] || '')) || !Number.isInteger(dry.expected?.policyRevision)) {
      throw new Error('STALE_RUNTIME: full hash CAS handler is not active; restart DSH before applying. No configuration was written.');
    }
    const result = await request({ apply: true, expected: dry.expected });
    if (out) await fs.writeFile(out + '.applied.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    print(JSON.stringify(result, null, 2));
  }
  return { dry, counts };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const base = (args.find(a => a.startsWith('--base='))?.slice(7) || process.env.DSH_TEST_BASE || '').replace(/\/$/, '');
  try {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('Supply the existing local Host URL via --base=http://127.0.0.1:PORT');
    await runDeploymentMigration({ base, args });
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  }
}
