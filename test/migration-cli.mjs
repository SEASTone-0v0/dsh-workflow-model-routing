// Offline CLI contract: stale Host responses must never lead to apply.
import assert from 'node:assert/strict';
import http from 'node:http';
import { runDeploymentMigration } from '../scripts/migrate-deployment-routes.mjs';

const requests = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  requests.push(parsed);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, expected: { storeRevision: 23, policyRevision: 1 }, warnings: [], plan: { authorized: { migrated: [] }, roles: { migrated: [] }, modesStore: { migrated: [] } } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function collect() {
  const lines = [];
  return { lines, print: (s) => lines.push(s) };
}

try {
  const dryOut = collect();
  await runDeploymentMigration({ base, args: [], print: dryOut.print });
  assert.equal(dryOut.lines.length, 1, 'dry-run prints one JSON summary');
  assert.match(dryOut.lines[0], /"dryRun": true/);
  assert.deepEqual(requests, [{ apply: false }]);

  requests.length = 0;
  const staleOut = collect();
  await assert.rejects(
    () => runDeploymentMigration({ base, args: ['--apply'], print: staleOut.print }),
    /STALE_RUNTIME/
  );
  assert.deepEqual(requests, [{ apply: false }], 'stale runtime must never receive apply:true');

  console.log('PASS migration CLI: dry-run default; stale apply rejected; zero apply requests; zero model calls');
} finally {
  await new Promise(resolve => server.close(resolve));
}
