#!/usr/bin/env node
/** Release hygiene audit: print locations and rule IDs, never matched values. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const findings = [];
const skippedDirectories = new Set(['.git', 'node_modules', 'coverage', 'output', '.npm-cache']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.tgz', '.pdf']);
const rules = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { id: 'api-key-shaped-value', pattern: /\bsk-[A-Za-z0-9_-]{12,}/g },
  { id: 'aws-access-key', pattern: /\bAKIA[A-Z0-9]{16}\b/g },
  { id: 'session-uuid', pattern: /\bsession-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi },
  { id: 'windows-absolute-path', pattern: /\b[A-Za-z]:[\\/]/g },
];
const forbiddenEntries = [
  'backups',
  'tmp-catalog.json',
  'tmp-modes.json',
  'tmp-roles.json',
  'tmp-rewrite-settings.mjs',
  '.dsh',
  'output',
  '.npm-cache',
  '.env',
];

function add(file, line, rule) {
  findings.push({ file: path.relative(root, file).replaceAll('\\', '/'), line, rule });
}

async function walk(directory) {
  let scanned = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      add(absolute, 0, 'symbolic-link');
      continue;
    }
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) scanned += await walk(absolute);
      continue;
    }
    if (!entry.isFile() || relative === 'scripts/audit-release.mjs' || binaryExtensions.has(path.extname(entry.name))) continue;
    const text = await fs.readFile(absolute, 'utf8');
    scanned += 1;
    for (const { id, pattern } of rules) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        add(absolute, text.slice(0, match.index).split('\n').length, id);
      }
    }
  }
  return scanned;
}

for (const relative of forbiddenEntries) {
  try {
    await fs.lstat(path.join(root, relative));
    findings.push({ file: relative, line: 0, rule: 'forbidden-release-entry' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const entry of [pkg.main, pkg.exports?.['.'], pkg.exports?.['./client']]) {
  if (!entry) {
    findings.push({ file: 'package.json', line: 0, rule: 'missing-package-entry-declaration' });
    continue;
  }
  try {
    await fs.access(path.resolve(root, entry));
  } catch {
    findings.push({ file: 'package.json', line: 0, rule: 'missing-package-entry-file' });
  }
}

const scannedFiles = await walk(root);
if (findings.length) {
  for (const finding of findings) console.error(`${finding.file}:${finding.line} [${finding.rule}]`);
  console.error(`AUDIT FAIL files=${scannedFiles} findings=${findings.length}`);
  process.exitCode = 1;
} else {
  console.log(`AUDIT PASS files=${scannedFiles} findings=0`);
}
