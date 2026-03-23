'use strict';

const { color } = require('./ansi');
const { satisfies } = require('./graph');
const { queryNpm } = require('./npm');

/**
 * For each real conflict (version mismatch, not just missing optional):
 *  1. Query npm for the latest version of the conflicting package.
 *  2. Check if latest fixes the conflict (its new peer range accepts the installed version).
 *  3. Check if latest introduces NEW conflicts (cascade detection).
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

  const pkgsToCheck = [...new Set(conflicts.map(c => c.pkg))];

  log(color(`\nQuerying npm for ${pkgsToCheck.length} package(s)…`, 'gray'));

  const resolutions = {};

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

    const fixes = conflicts
      .filter(c => c.pkg === pkg)
      .filter(c => {
        const newRange = newPeerDeps[c.peer];
        if (!newRange) return true;
        return satisfies(c.installed, newRange);
      })
      .map(c => c.peer);

    const stillConflicts = conflicts
      .filter(c => c.pkg === pkg && !fixes.includes(c.peer))
      .map(c => c.peer);

    const cascades = Object.entries(newPeerDeps)
      .map(([peerName, peerRange]) => {
        const installedVer = getInstalledVersion(peerName);
        if (!installedVer) return null;
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

  const upgrades = Object.fromEntries(
    Object.entries(resolutions).map(([pkg, r]) => [pkg, r.latest]),
  );

  return { resolutions, upgrades };
}

module.exports = { resolveConflicts };
