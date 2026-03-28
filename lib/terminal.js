'use strict';

const { color } = require('./ansi');

function printGraph(graph, directDeps, options = {}) {
  const { conflictsOnly = false, focusPkg = null } = options;
  const allConflicts = [];

  const entries = focusPkg
    ? Object.entries(graph).filter(
        ([name]) => name === focusPkg || graph[focusPkg]?.peerDeps?.some(p => p.name === name),
      )
    : Object.entries(graph);

  const directSet = new Set(Object.keys(directDeps));

  for (const [pkgName, info] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (conflictsOnly && info.peerDeps.every(p => p.ok)) continue;

    const isDirect = directSet.has(pkgName);
    const vTrim =
      info.version != null && String(info.version).trim() !== '' ? String(info.version).trim() : '';
    const versionStr = info.missing
      ? color('NOT INSTALLED', 'red', 'bold')
      : vTrim !== ''
        ? color(`v${vTrim}`, 'gray')
        : color('—', 'gray');

    const tag = isDirect ? color(' [direct]', 'blue') : '';
    console.log(`\n${color(pkgName, 'bold', 'cyan')}${tag} ${versionStr}`);

    if (info.requiredBy.length > 0) {
      console.log(
        `  ${color('←', 'gray')} required as peer by: ${info.requiredBy.map(r => color(r, 'magenta')).join(', ')}`,
      );
    }

    if (info.peerDeps.length === 0) {
      if (!conflictsOnly) console.log(`  ${color('no peer dependencies', 'gray')}`);
      continue;
    }

    console.log(`  ${color('peer dependencies:', 'bold')}`);
    for (const { name, range, installed, ok } of info.peerDeps) {
      const status = ok
        ? color('✓', 'green')
        : installed
          ? color('✗', 'red', 'bold')
          : color('?', 'yellow');

      const installedStr = installed
        ? ok
          ? color(`(installed: v${installed})`, 'gray')
          : color(`(installed: v${installed} — MISMATCH)`, 'red')
        : color('(not installed)', 'yellow');

      console.log(`    ${status} ${color(name, 'cyan')} ${color(range, 'gray')} ${installedStr}`);

      if (!ok) {
        allConflicts.push({ pkg: pkgName, peer: name, required: range, installed });
      }
    }
  }

  return allConflicts;
}

function printSummary(conflicts, directDeps, graph) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(color('SUMMARY', 'bold'));
  console.log('─'.repeat(60));

  const total = Object.keys(graph).length;
  const directCount = Object.keys(directDeps).length;
  console.log(
    `  Direct deps: ${color(directCount, 'cyan')}  |  Total in graph: ${color(total, 'cyan')}`,
  );

  if (conflicts.length === 0) {
    console.log(color('\n  ✓ No peer dependency conflicts detected!', 'green', 'bold'));
  } else {
    console.log(
      color(`\n  ✗ ${conflicts.length} peer dependency conflict(s) found:`, 'red', 'bold'),
    );
    for (const { pkg, peer, required, installed } of conflicts) {
      const installedStr = installed ? `v${installed}` : 'not installed';
      console.log(
        `    • ${color(pkg, 'cyan')} requires ${color(peer, 'cyan')} ${color(required, 'gray')} — got ${color(installedStr, 'red')}`,
      );
    }
    console.log(color('\n  Run `npm outdated` or `yarn upgrade-interactive` to update.', 'yellow'));
  }
}

module.exports = { printGraph, printSummary };
