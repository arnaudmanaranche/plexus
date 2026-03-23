/**
 * Plexus engine — dependency graph + peer conflict detection (filesystem or registry).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const semver = require('semver');

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

function color(str, ...codes) {
  return codes.map(code => c[code]).join('') + str + c.reset;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDiskSize(pkgName, nodeModulesPath) {
  const pkgPath = path.join(nodeModulesPath, pkgName);
  try {
    const out = execSync(`du -sk "${pkgPath}" 2>/dev/null`, { timeout: 8000 }).toString();
    const kb = parseInt(out.split(/\s/)[0], 10);
    return isNaN(kb) ? null : kb * 1024; // bytes
  } catch {
    return null;
  }
}

function createFsContext(rootDir) {
  const nodeModulesPath = path.join(rootDir, 'node_modules');
  function readPkg(pkgName) {
    const pkgPath = path.join(nodeModulesPath, pkgName, 'package.json');
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      return null;
    }
  }
  function getInstalledVersion(pkgName) {
    return readPkg(pkgName)?.version ?? null;
  }
  return {
    nodeModulesPath,
    readPkg,
    getDiskSize: pkgName => getDiskSize(pkgName, nodeModulesPath),
    getInstalledVersion,
  };
}

async function getBundleSize(pkgName, version) {
  try {
    const url = `https://bundlephobia.com/api/size?package=${encodeURIComponent(pkgName)}@${version}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    return { size: data.size, gzip: data.gzip };
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sizeClass(bytes) {
  if (!bytes) return '';
  if (bytes > 5 * 1024 * 1024) return 'size-large';
  if (bytes > 1 * 1024 * 1024) return 'size-medium';
  return 'size-small';
}

function satisfies(installedVersion, requiredRange) {
  if (!installedVersion) return false;
  try {
    // semver.satisfies is strict; coerce handles odd formats like "19" → "19.0.0"
    const coerced = semver.coerce(installedVersion);
    if (!coerced) return false;
    return semver.satisfies(coerced, requiredRange, { includePrerelease: true });
  } catch {
    return false;
  }
}

// ─── Build graph ──────────────────────────────────────────────────────────────

function buildGraph(directDeps, ctx) {
  const { readPkg, getDiskSize, getInstalledVersion } = ctx;
  const graph = {}; // pkgName → { version, peerDeps: [{ name, range, installed, ok }], requiredBy: [] }

  const toProcess = [...Object.keys(directDeps)];
  const visited = new Set();

  while (toProcess.length > 0) {
    const pkgName = toProcess.shift();
    if (visited.has(pkgName)) continue;
    visited.add(pkgName);

    const pkg = readPkg(pkgName);
    if (!pkg) {
      graph[pkgName] = { version: null, missing: true, peerDeps: [], requiredBy: [] };
      continue;
    }

    const peerDeps = pkg.peerDependencies ?? {};
    const peerEntries = Object.entries(peerDeps).map(([name, range]) => {
      const installed = getInstalledVersion(name);
      const ok = satisfies(installed, range);
      return { name, range, installed, ok };
    });

    graph[pkgName] = {
      version: pkg.version,
      missing: false,
      diskSize: getDiskSize(pkgName),
      peerDeps: peerEntries,
      requiredBy: [],
    };

    // Track who requires whom via peerDeps
    for (const { name } of peerEntries) {
      if (!graph[name])
        graph[name] = { version: null, missing: false, peerDeps: [], requiredBy: [] };
      if (!graph[name].requiredBy.includes(pkgName)) {
        graph[name].requiredBy.push(pkgName);
      }
    }
  }

  return graph;
}

// ─── Output ───────────────────────────────────────────────────────────────────

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
    const versionStr = info.missing
      ? color('NOT INSTALLED', 'red', 'bold')
      : color(`v${info.version}`, 'gray');

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

// ─── Resolution engine ────────────────────────────────────────────────────────

function queryNpm(pkg) {
  try {
    const out = execSync(`npm info "${pkg}" --json 2>/dev/null`, { timeout: 12000 })
      .toString()
      .trim();
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

/**
 * For each real conflict (version mismatch, not just missing optional):
 *  1. Query npm for the latest version of the conflicting package.
 *  2. Check if latest fixes the conflict (its new peer range accepts the installed version).
 *  3. Check if latest introduces NEW conflicts (cascade detection).
 * Returns { resolutions, cascades, suggestedDeps }
 */
function resolveConflicts(graph, directDeps, getInstalledVersion, options = {}) {
  const silent = options.silent === true;
  const log = (...args) => {
    if (!silent) console.log(...args);
  };
  const write = (...args) => {
    if (!silent) process.stdout.write(...args);
  };

  const directSet = new Set(Object.keys(directDeps));

  // Gather only real version-mismatch conflicts on direct deps
  const conflicts = [];
  for (const [pkgName, info] of Object.entries(graph)) {
    if (!directSet.has(pkgName)) continue;
    for (const peer of info.peerDeps) {
      if (!peer.ok && peer.installed) {
        conflicts.push({
          pkg: pkgName,
          peer: peer.name,
          range: peer.range,
          installed: peer.installed,
        });
      }
    }
  }

  if (conflicts.length === 0) return { resolutions: {}, cascades: [], suggestedDeps: null };

  // Unique packages that have conflicts
  const pkgsToCheck = [...new Set(conflicts.map(c => c.pkg))];

  log(color(`\nQuerying npm for ${pkgsToCheck.length} package(s)…`, 'gray'));

  const resolutions = {}; // pkg → { current, latest, fixes, newPeerDeps, stillConflicts }

  for (const pkg of pkgsToCheck) {
    write(`  ${color(pkg, 'cyan')} … `);
    const info = queryNpm(pkg);
    if (!info) {
      log(color('not found on npm', 'yellow'));
      continue;
    }

    const latest = info['dist-tags']?.latest;
    if (!latest) {
      log(color('no dist-tags.latest', 'yellow'));
      continue;
    }

    const newPeerDeps = info.peerDependencies ?? {};
    const currentVersion = directDeps[pkg];

    // Which conflicts does upgrading this package fix?
    const fixes = conflicts
      .filter(c => c.pkg === pkg)
      .filter(c => {
        const newRange = newPeerDeps[c.peer];
        // If latest version no longer has this peer requirement, conflict disappears
        if (!newRange) return true;
        // If latest version's peer range accepts our installed version, conflict is fixed
        return satisfies(c.installed, newRange);
      })
      .map(c => c.peer);

    // Which NEW conflicts does upgrading this package introduce?
    const stillConflicts = conflicts
      .filter(c => c.pkg === pkg && !fixes.includes(c.peer))
      .map(c => c.peer);

    // Cascade: new peer deps from latest version that conflict with what we have installed
    const cascades = Object.entries(newPeerDeps)
      .map(([peerName, peerRange]) => {
        const installedVer = getInstalledVersion(peerName);
        if (!installedVer) return null; // optional, skip
        const ok = satisfies(installedVer, peerRange);
        return ok ? null : { peerName, peerRange, installedVer };
      })
      .filter(Boolean);

    log(
      latest === currentVersion.replace(/[\^~>=<]/g, '')
        ? color(`already latest (v${latest})`, 'gray')
        : color(`v${currentVersion} → v${latest}`, 'green'),
    );

    resolutions[pkg] = {
      current: currentVersion,
      latest,
      fixes,
      stillConflicts,
      cascades,
      newPeerDeps,
    };
  }

  // Re-split into dev/non-dev (we merged them earlier for convenience)
  // We'll use the original rootPkg structure — pass it in via closure via suggestedDeps marker
  const upgrades = Object.fromEntries(
    Object.entries(resolutions).map(([pkg, r]) => [pkg, r.latest]),
  );

  return { resolutions, upgrades };
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

function renderHtml(graph, directDeps, rootPkg, resolutions = {}, bundleSizes = {}, meta = {}) {
  const sourceNote =
    meta.source === 'registry'
      ? ' — versions resolved from npm registry (no local node_modules)'
      : '';
  const directSet = new Set(Object.keys(directDeps));
  const allConflicts = [];

  // Collect conflicts
  for (const [, info] of Object.entries(graph)) {
    for (const peer of info.peerDeps) {
      if (!peer.ok) allConflicts.push({ pkg: peer.name, ...peer });
    }
  }

  const entries = Object.entries(graph).sort(([a], [b]) => a.localeCompare(b));

  const conflictCount = entries.reduce((acc, [, info]) => {
    return acc + info.peerDeps.filter(p => !p.ok && p.installed).length;
  }, 0);
  const missingOptionalCount = entries.reduce((acc, [, info]) => {
    return acc + info.peerDeps.filter(p => !p.ok && !p.installed).length;
  }, 0);
  const okCount = entries.reduce((acc, [, info]) => {
    return acc + info.peerDeps.filter(p => p.ok).length;
  }, 0);

  // Size stats
  const totalDiskSize = entries.reduce((acc, [, info]) => acc + (info.diskSize ?? 0), 0);

  const npmUrl = name => `https://www.npmjs.com/package/${name}`;

  // Abbreviate long semver ranges for compact display
  function shortRange(range) {
    // "^10.0.8 || ^11.0 || ^12.0 || ^13.0" → "^10 | ^11 | ^12 | ^13"
    return range.replace(/(\d+)\.\d+(\.\d+)?/g, '$1').replace(/\s*\|\|\s*/g, ' | ');
  }

  const cardUid = (() => {
    let n = 0;
    return () => ++n;
  })();

  const cards = entries
    .map(([pkgName, info]) => {
      const isDirect = directSet.has(pkgName);
      const conflictPeers = info.peerDeps.filter(p => !p.ok && p.installed);
      const optionalPeers = info.peerDeps.filter(p => !p.ok && !p.installed);
      const okPeers = info.peerDeps.filter(p => p.ok);

      const statusClass = info.missing
        ? 'card-missing'
        : conflictPeers.length > 0
          ? 'card-conflict'
          : optionalPeers.length > 0 && okPeers.length === 0
            ? 'card-warning'
            : 'card-ok';

      const uid = cardUid();

      // Conflict rows — most important, always visible
      const conflictRows = conflictPeers
        .map(
          p => `
        <div class="peer-row peer-conflict">
          <span class="peer-icon">✗</span>
          <a href="${npmUrl(p.name)}" target="_blank" class="peer-name">${p.name}</a>
          <span class="peer-detail">have <strong>v${p.installed}</strong> · needs <span class="needs-range" title="${p.range}">${shortRange(p.range)}</span></span>
        </div>`,
        )
        .join('');

      // OK rows — compact, secondary
      const okRows = okPeers
        .map(
          p => `
        <div class="peer-row peer-ok">
          <span class="peer-icon">✓</span>
          <a href="${npmUrl(p.name)}" target="_blank" class="peer-name">${p.name}</a>
          <span class="peer-version-ok">v${p.installed}</span>
        </div>`,
        )
        .join('');

      // Optional peers — collapsed by default
      const optionalRows = optionalPeers
        .map(
          p => `
        <div class="peer-row peer-missing">
          <span class="peer-icon">·</span>
          <a href="${npmUrl(p.name)}" target="_blank" class="peer-name">${p.name}</a>
          <span class="peer-optional-label">optional · not installed</span>
        </div>`,
        )
        .join('');

      const optionalToggle =
        optionalPeers.length > 0
          ? `
        <div class="optional-toggle" onclick="toggleOptional(${uid})">
          <span id="opt-arrow-${uid}">▸</span> ${optionalPeers.length} optional peer${optionalPeers.length > 1 ? 's' : ''}
        </div>
        <div id="opt-rows-${uid}" class="optional-rows hidden">${optionalRows}</div>`
          : '';

      const noPeers =
        info.peerDeps.length === 0 ? '<div class="no-peers">no peer dependencies</div>' : '';

      // Header meta
      const sizeStr = formatBytes(info.diskSize);
      const sizeCls = sizeClass(info.diskSize);
      const bundleInfo = bundleSizes[pkgName];

      const requiredByHtml =
        info.requiredBy.length > 0
          ? `<div class="required-by">peer of: ${info.requiredBy.map(r => `<a href="#pkg-${r.replace(/[@/]/g, '-')}">${r}</a>`).join(', ')}</div>`
          : '';

      return `<div class="card ${statusClass}" id="pkg-${pkgName.replace(/[@/]/g, '-')}" data-conflicts="${conflictPeers.length}" data-pkg="${pkgName}" data-size="${info.diskSize ?? 0}">
      <div class="card-header">
        <a href="${npmUrl(pkgName)}" target="_blank" class="pkg-name">${pkgName}</a>
        <span class="pkg-meta">
          <span class="pkg-version">v${info.missing ? '?' : info.version}</span>
          ${sizeStr ? `<span class="size-badge ${sizeCls}">${sizeStr}</span>` : ''}
          ${bundleInfo ? `<span class="size-badge size-bundle" title="bundle size">⚡ ${formatBytes(bundleInfo.gzip)}</span>` : ''}
        </span>
        <div class="badges">
          ${isDirect ? '<span class="badge badge-direct">direct</span>' : ''}
          ${conflictPeers.length > 0 ? `<span class="badge badge-conflict">⚠ ${conflictPeers.length}</span>` : ''}
        </div>
      </div>
      ${requiredByHtml}
      ${conflictRows}${okRows}${optionalToggle}${noPeers}
    </div>`;
    })
    .join('\n');

  const conflictSummaryRows = entries
    .flatMap(([pkgName, info]) =>
      info.peerDeps
        .filter(p => !p.ok && p.installed)
        .map(
          p => `<tr>
        <td><a href="#pkg-${pkgName.replace(/[@/]/g, '-')}" class="pkg-link">${pkgName}</a></td>
        <td><a href="${npmUrl(p.name)}" target="_blank" class="pkg-link">${p.name}</a></td>
        <td><code>${p.range}</code></td>
        <td><span class="version-mismatch">v${p.installed}</span></td>
      </tr>`,
        ),
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Plexus — ${rootPkg.name ?? 'package'}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #22263a;
    --border: #2e3248; --text: #e2e8f0; --muted: #64748b;
    --green: #22c55e; --red: #ef4444; --yellow: #f59e0b;
    --blue: #60a5fa; --cyan: #22d3ee; --purple: #a78bfa;
    --conflict: #3b1a1a; --conflict-border: #7f1d1d;
    --warning: #2d2412; --warning-border: #78350f;
    --ok: #0f2b1a; --ok-border: #14532d;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 14px; line-height: 1.6; }
  a { color: var(--cyan); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 12px; background: var(--surface2); padding: 1px 5px; border-radius: 3px; color: var(--muted); }

  header { padding: 24px 32px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 20px; font-weight: 700; color: var(--cyan); }
  header .meta { color: var(--muted); font-size: 13px; }
  .generated { margin-left: auto; color: var(--muted); font-size: 12px; }

  .stats { display: flex; gap: 16px; padding: 16px 32px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 20px; text-align: center; }
  .stat-num { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .num-conflict { color: var(--red); }
  .num-warning { color: var(--yellow); }
  .num-ok { color: var(--green); }
  .num-blue { color: var(--blue); }

  .toolbar { padding: 12px 32px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .toolbar input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 13px; width: 240px; }
  .toolbar input:focus { outline: none; border-color: var(--cyan); }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; transition: all .15s; }
  .filter-btn:hover, .filter-btn.active { border-color: var(--cyan); color: var(--cyan); }
  .filter-btn.active { background: #0e2a2e; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; padding: 20px 32px; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; transition: border-color .15s; }
  .card:hover { border-color: var(--muted); }
  .card-conflict { border-left: 3px solid var(--red); background: var(--conflict); border-color: var(--conflict-border); }
  .card-warning { border-left: 3px solid var(--yellow); background: var(--warning); border-color: var(--warning-border); }
  .card-ok { border-left: 3px solid #2e3248; }
  .card-missing { border-left: 3px solid var(--red); opacity: 0.5; }

  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .pkg-name { font-weight: 600; font-size: 13px; color: var(--cyan); flex-shrink: 0; }
  .pkg-meta { display: flex; align-items: center; gap: 5px; }
  .pkg-version { color: var(--muted); font-size: 11px; font-family: monospace; }
  .badges { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 700; }
  .badge-direct { background: #1e3a5f; color: var(--blue); }
  .badge-conflict { background: #4a1a1a; color: #ff8080; }

  .required-by { font-size: 11px; color: var(--muted); margin: 2px 0 4px; }
  .required-by a { color: var(--purple); }
  .no-peers { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 4px; }

  /* Peer rows — compact single-line */
  .peer-row { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
  .peer-row:last-of-type { border-bottom: none; }
  .peer-icon { width: 12px; text-align: center; flex-shrink: 0; font-size: 11px; }
  .peer-name { min-width: 0; flex: 0 0 auto; color: var(--text); }
  .peer-name:hover { color: var(--cyan); }

  .peer-ok .peer-icon { color: var(--green); }
  .peer-version-ok { margin-left: auto; color: var(--muted); font-family: monospace; font-size: 11px; }

  .peer-conflict { }
  .peer-conflict .peer-icon { color: var(--red); }
  .peer-detail { margin-left: auto; font-size: 11px; color: var(--red); white-space: nowrap; }
  .peer-detail strong { color: #ff8080; }
  .needs-range { color: var(--muted); font-family: monospace; cursor: help; border-bottom: 1px dashed var(--muted); }

  .peer-missing .peer-icon { color: var(--border); }
  .peer-optional-label { margin-left: auto; font-size: 10px; color: var(--muted); font-style: italic; }

  .optional-toggle { font-size: 11px; color: var(--muted); cursor: pointer; margin-top: 5px; user-select: none; padding: 2px 0; }
  .optional-toggle:hover { color: var(--text); }
  .optional-rows { margin-top: 2px; }

  .conflict-table-section { margin: 0 32px 32px; }
  .conflict-table-section h2 { font-size: 16px; font-weight: 600; color: var(--red); margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 8px; overflow: hidden; }
  th { background: var(--surface2); padding: 10px 14px; text-align: left; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface2); }
  .badge-fix { background: #0f2b1a; color: var(--green); }
  .no-cascade { color: var(--green); font-size: 12px; }
  .cascade-list { margin: 0; padding: 0 0 0 16px; font-size: 12px; color: var(--yellow); }
  .cascade-list li { margin-bottom: 2px; }
  .json-block { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; font-size: 12px; font-family: 'JetBrains Mono', monospace; overflow-x: auto; white-space: pre; color: var(--text); line-height: 1.7; }
  .json-block mark { background: rgba(34,211,238,.15); color: var(--cyan); border-radius: 2px; }
  .version-ok { color: var(--green); }
  .size-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-family: monospace; }
  .size-bundle { background: rgba(34,211,238,.1); color: var(--cyan); }
  .size-large { background: rgba(239,68,68,.15); color: var(--red); }
  .size-medium { background: rgba(245,158,11,.15); color: var(--yellow); }
  .size-small { background: rgba(34,197,94,.12); color: var(--green); }
  .size-rank-table td:nth-child(3) { font-family: monospace; }
  .gzip-col { color: var(--cyan); font-size: 12px; }

  .hidden { display: none !important; }
</style>
</head>
<body>

<header>
  <h1>★ Plexus</h1>
  <span class="meta">${rootPkg.name ?? '(unnamed)'} v${rootPkg.version ?? '?'} — peer dependency analysis${sourceNote}</span>
  <span class="generated">Generated ${new Date().toLocaleString()}</span>
</header>

<div class="stats">
  <div class="stat"><div class="stat-num num-blue">${Object.keys(directDeps).length}</div><div class="stat-label">Direct deps</div></div>
  <div class="stat"><div class="stat-num num-blue">${entries.length}</div><div class="stat-label">Total in graph</div></div>
  <div class="stat"><div class="stat-num num-ok">${okCount}</div><div class="stat-label">Satisfied peers</div></div>
  <div class="stat"><div class="stat-num num-conflict">${conflictCount}</div><div class="stat-label">Conflicts</div></div>
  <div class="stat"><div class="stat-num num-warning">${missingOptionalCount}</div><div class="stat-label">Missing optional</div></div>
  <div class="stat"><div class="stat-num num-blue" style="font-size:18px">${formatBytes(totalDiskSize)}</div><div class="stat-label">Total disk (node_modules)</div></div>
</div>

<div class="toolbar">
  <input type="text" id="search" placeholder="Search packages…">
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="conflicts">Conflicts only</button>
  <button class="filter-btn" data-filter="direct">Direct only</button>
  <button class="filter-btn" data-filter="ok">No issues</button>
  <button class="filter-btn" id="sort-size-btn" style="margin-left:auto">Sort by size ↕</button>
</div>


${
  conflictCount > 0
    ? `
<div class="conflict-table-section">
  <h2>✗ ${conflictCount} Version Conflict${conflictCount > 1 ? 's' : ''}</h2>
  <table>
    <thead><tr><th>Package</th><th>Requires peer</th><th>Required range</th><th>Installed</th></tr></thead>
    <tbody>${conflictSummaryRows}</tbody>
  </table>
</div>`
    : ''
}

${
  Object.keys(resolutions).length > 0
    ? (() => {
        const rows = Object.entries(resolutions)
          .map(([pkg, r]) => {
            const cascadeHtml =
              r.cascades.length > 0
                ? `<ul class="cascade-list">${r.cascades.map(c => `<li>⚠ <b>${c.peerName}</b>: needs <code>${c.peerRange}</code>, have v${c.installedVer}</li>`).join('')}</ul>`
                : '<span class="no-cascade">No new cascades</span>';
            const fixesHtml =
              r.fixes.length > 0
                ? r.fixes.map(f => `<span class="badge badge-fix">${f}</span>`).join(' ')
                : '<span style="color:var(--muted)">none</span>';
            const stillHtml =
              r.stillConflicts.length > 0
                ? r.stillConflicts
                    .map(f => `<span class="badge badge-conflict">${f}</span>`)
                    .join(' ')
                : '';
            return `<tr>
      <td><a href="https://www.npmjs.com/package/${pkg}" target="_blank" class="pkg-link">${pkg}</a></td>
      <td><code>${r.current}</code> → <code class="version-ok">^${r.latest}</code></td>
      <td>${fixesHtml}${stillHtml}</td>
      <td>${cascadeHtml}</td>
    </tr>`;
          })
          .join('\n');

        return `<div class="conflict-table-section">
  <h2>🔧 Resolution Plan (--fix)</h2>
  <table>
    <thead><tr><th>Package</th><th>Upgrade</th><th>Fixes / Still broken</th><th>Cascade risks</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
      })()
    : ''
}

${
  Object.keys(resolutions).length > 0
    ? (() => {
        const suggested = JSON.parse(JSON.stringify(rootPkg));
        for (const [pkg, r] of Object.entries(resolutions)) {
          if (suggested.dependencies?.[pkg]) suggested.dependencies[pkg] = `^${r.latest}`;
          if (suggested.devDependencies?.[pkg]) suggested.devDependencies[pkg] = `^${r.latest}`;
        }
        const changed = Object.keys(resolutions);
        const depsJson = JSON.stringify(
          { dependencies: suggested.dependencies, devDependencies: suggested.devDependencies },
          null,
          2,
        ).replace(
          new RegExp(
            `"(${changed.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})"`,
            'g',
          ),
          '<mark>"$1"</mark>',
        );
        return `<div class="conflict-table-section">
  <h2>📋 Suggested package.json (highlighted = changed)</h2>
  <pre class="json-block">${depsJson}</pre>
</div>`;
      })()
    : ''
}

<div class="grid" id="grid">
${cards}
</div>

<script>
  function toggleOptional(uid) {
    var rows = document.getElementById('opt-rows-' + uid);
    var arrow = document.getElementById('opt-arrow-' + uid);
    if (!rows) return;
    rows.classList.toggle('hidden');
    arrow.textContent = rows.classList.contains('hidden') ? '▸' : '▾';
  }

  document.addEventListener('DOMContentLoaded', function() {
    var currentFilter = 'all';
    var sortedBySize = false;
    var searchInput = document.getElementById('search');
    var grid = document.getElementById('grid');

    searchInput.addEventListener('input', filterCards);

    document.querySelectorAll('.filter-btn[data-filter]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        currentFilter = btn.getAttribute('data-filter');
        document.querySelectorAll('.filter-btn[data-filter]').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        filterCards();
      });
    });

    var sortBtn = document.getElementById('sort-size-btn');
    if (sortBtn) {
      sortBtn.addEventListener('click', function() {
        sortedBySize = !sortedBySize;
        sortBtn.classList.toggle('active', sortedBySize);
        sortBtn.textContent = sortedBySize ? 'Sort by name ↕' : 'Sort by size ↕';
        var cards = Array.from(grid.querySelectorAll('.card'));
        cards.sort(function(a, b) {
          if (sortedBySize) {
            return parseInt(b.getAttribute('data-size') || 0) - parseInt(a.getAttribute('data-size') || 0);
          }
          return (a.getAttribute('data-pkg') || '').localeCompare(b.getAttribute('data-pkg') || '');
        });
        cards.forEach(function(card) { grid.appendChild(card); });
      });
    }

    function filterCards() {
      var search = searchInput.value.toLowerCase();
      document.querySelectorAll('.card').forEach(function(card) {
        var pkg = (card.getAttribute('data-pkg') || '').toLowerCase();
        var hasConflict = card.classList.contains('card-conflict');
        var hasWarning = card.classList.contains('card-warning');
        var hasDirect = card.querySelector('.badge-direct');

        var matchesSearch = !search || pkg.indexOf(search) !== -1;
        var matchesFilter =
          currentFilter === 'all' ||
          (currentFilter === 'conflicts' && hasConflict) ||
          (currentFilter === 'direct' && !!hasDirect) ||
          (currentFilter === 'ok' && !hasConflict && !hasWarning);

        card.classList.toggle('hidden', !matchesSearch || !matchesFilter);
      });
    }
  });
</script>
</body>
</html>`;
}

function openHtmlReport(outPath) {
  const opts = { stdio: 'ignore' };
  try {
    if (process.platform === 'darwin') execSync(`open "${outPath}"`, opts);
    else if (process.platform === 'win32') execSync(`cmd /c start "" "${outPath}"`, opts);
    else execSync(`xdg-open "${outPath}"`, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.rootDir - directory containing package.json + node_modules
 * @param {object} opts.flags
 * @param {boolean} [opts.flags.conflictsOnly]
 * @param {boolean} [opts.flags.html]
 * @param {boolean} [opts.flags.fix]
 * @param {boolean} [opts.flags.bundleSize]
 * @param {string|null} [opts.flags.focusPkg]
 * @param {string} [opts.flags.outFile] - HTML output path (default: rootDir/dep-graph.html)
 */
async function runFilesystemAnalysis(opts) {
  const rootDir = path.resolve(opts.rootDir);
  const {
    conflictsOnly = false,
    html: htmlMode = false,
    fix: fixMode = false,
    bundleSize: bundleSizeMode = false,
    focusPkg = null,
    outFile,
  } = opts.flags ?? {};

  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const directDeps = {
    ...(rootPkg.dependencies ?? {}),
    ...(rootPkg.devDependencies ?? {}),
  };

  if (focusPkg && !directDeps[focusPkg]) {
    console.log(color(`Package "${focusPkg}" not found in dependencies.`, 'red'));
    process.exitCode = 1;
    return;
  }

  const ctx = createFsContext(rootDir);
  const graph = buildGraph(directDeps, ctx);

  const resolutions = fixMode
    ? resolveConflicts(graph, directDeps, ctx.getInstalledVersion).resolutions
    : {};

  if (fixMode && !htmlMode) {
    if (Object.keys(resolutions).length === 0) {
      console.log(color('\n✓ No conflicts to resolve.', 'green'));
    } else {
      console.log(color('\n── Resolution Plan ──────────────────────────────────', 'bold'));
      for (const [pkg, r] of Object.entries(resolutions)) {
        console.log(
          `\n  ${color(pkg, 'cyan')} ${color(r.current, 'gray')} → ${color(`^${r.latest}`, 'green')}`,
        );
        if (r.fixes.length)
          console.log(`    fixes:    ${r.fixes.map(f => color(f, 'green')).join(', ')}`);
        if (r.stillConflicts.length)
          console.log(`    still ✗:  ${r.stillConflicts.map(f => color(f, 'red')).join(', ')}`);
        if (r.cascades.length) {
          console.log(color(`    cascades (${r.cascades.length}):`, 'yellow'));
          for (const c of r.cascades)
            console.log(
              `      ⚠ ${color(c.peerName, 'cyan')} needs ${color(c.peerRange, 'gray')}, have v${c.installedVer}`,
            );
        }
      }
      console.log(color('\n── Suggested package.json changes ───────────────────', 'bold'));
      for (const [pkg, r] of Object.entries(resolutions)) {
        console.log(
          `  "${color(pkg, 'cyan')}": "${color(r.current, 'gray')}" → "${color(`^${r.latest}`, 'green')}"`,
        );
      }
    }
    return;
  }

  if (htmlMode) {
    let bundleSizes = {};
    if (bundleSizeMode) {
      const directKeys = Object.keys(directDeps);
      console.log(color(`\nQuerying bundlephobia for ${directKeys.length} packages…`, 'gray'));
      for (const pkg of directKeys) {
        const ver = ctx.getInstalledVersion(pkg);
        if (!ver) continue;
        process.stdout.write(`  ${color(pkg, 'cyan')} … `);
        const result = await getBundleSize(pkg, ver);
        if (result) {
          bundleSizes[pkg] = result;
          console.log(`${formatBytes(result.size)} (gzip: ${formatBytes(result.gzip)})`);
        } else {
          console.log(color('n/a', 'gray'));
        }
      }
    }

    const html = renderHtml(graph, directDeps, rootPkg, resolutions, bundleSizes, {
      source: 'filesystem',
    });
    const outPath = outFile ? path.resolve(outFile) : path.join(rootDir, 'dep-graph.html');
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(color(`✓ Report written to ${outPath}`, 'green'));
    if (!openHtmlReport(outPath)) {
      console.log(color('  Open the HTML file in your browser to view it.', 'gray'));
    }
    return;
  }

  console.log(
    color('★ Plexus', 'bold', 'cyan') + color(' — peer dependency analysis', 'gray'),
  );
  console.log(
    color(`  Project: ${rootPkg.name ?? '(unnamed)'} v${rootPkg.version ?? '?'}`, 'gray'),
  );
  if (focusPkg) console.log(color(`  Focused on: ${focusPkg}`, 'yellow'));
  if (conflictsOnly) console.log(color('  Showing conflicts only', 'yellow'));

  const conflicts = printGraph(graph, directDeps, { conflictsOnly, focusPkg });
  printSummary(conflicts, directDeps, graph);
}

async function fetchResolvedPackageManifest(name, range) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const data = await res.json();
  const versions = Object.keys(data.versions || {});
  const best = semver.maxSatisfying(versions, range, { includePrerelease: true });
  if (!best) return null;
  return data.versions[best];
}

async function createRegistryContext(directDeps) {
  const pkgs = new Map();
  const names = Object.keys(directDeps);
  await Promise.all(
    names.map(async name => {
      try {
        const manifest = await fetchResolvedPackageManifest(name, directDeps[name]);
        pkgs.set(name, manifest);
      } catch {
        pkgs.set(name, null);
      }
    }),
  );

  function readPkg(pkgName) {
    return pkgs.get(pkgName) ?? null;
  }
  function getInstalledVersion(pkgName) {
    return readPkg(pkgName)?.version ?? null;
  }
  return {
    readPkg,
    getDiskSize: () => null,
    getInstalledVersion,
  };
}

/**
 * Analyze an in-memory package.json using npm registry (no node_modules).
 */
async function runRegistryAnalysis(rootPkg, flags = {}) {
  const directDeps = {
    ...(rootPkg.dependencies ?? {}),
    ...(rootPkg.devDependencies ?? {}),
  };
  const ctx = await createRegistryContext(directDeps);
  const graph = buildGraph(directDeps, ctx);
  const fixMode = flags.fix === true;
  const resolutions = fixMode
    ? resolveConflicts(graph, directDeps, ctx.getInstalledVersion, { silent: true }).resolutions
    : {};
  let bundleSizes = {};
  if (flags.bundleSize) {
    for (const pkg of Object.keys(directDeps)) {
      const ver = ctx.getInstalledVersion(pkg);
      if (!ver) continue;
      const result = await getBundleSize(pkg, ver);
      if (result) bundleSizes[pkg] = result;
    }
  }
  const html = renderHtml(graph, directDeps, rootPkg, resolutions, bundleSizes, {
    source: 'registry',
  });
  return { graph, directDeps, resolutions, bundleSizes, html };
}

module.exports = {
  color,
  formatBytes,
  buildGraph,
  createFsContext,
  printGraph,
  printSummary,
  resolveConflicts,
  queryNpm,
  renderHtml,
  getBundleSize,
  runFilesystemAnalysis,
  runRegistryAnalysis,
  openHtmlReport,
};
