'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const semver = require('semver');

function getDiskSize(pkgName, nodeModulesPath) {
  const pkgPath = path.join(nodeModulesPath, pkgName);
  try {
    const out = execSync(`du -sk "${pkgPath}" 2>/dev/null`, { timeout: 8000 }).toString();
    const kb = parseInt(out.split(/\s/)[0], 10);
    return isNaN(kb) ? null : kb * 1024;
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

function satisfies(installedVersion, requiredRange) {
  if (!installedVersion) return false;
  try {
    const coerced = semver.coerce(installedVersion);
    if (!coerced) return false;
    return semver.satisfies(coerced, requiredRange, { includePrerelease: true });
  } catch {
    return false;
  }
}

function buildGraph(directDeps, ctx) {
  const { readPkg, getDiskSize, getInstalledVersion } = ctx;
  const graph = {};

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

module.exports = { createFsContext, buildGraph, satisfies };
