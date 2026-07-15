'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const semver = require('semver');

const execFileAsync = promisify(execFile);

async function getDiskSize(pkgName, nodeModulesPath) {
  const pkgPath = path.join(nodeModulesPath, pkgName);
  try {
    const { stdout } = await execFileAsync('du', ['-sk', pkgPath], {
      timeout: 8000,
      maxBuffer: 256 * 1024,
    });
    const kb = parseInt(stdout.split(/\s/)[0], 10);
    return isNaN(kb) ? null : kb * 1024;
  } catch {
    return null;
  }
}

/** `du` shells out per package; keep concurrency modest (`PLEXUS_DISK_SIZE_CONCURRENCY`, default 8). */
function diskSizeFetchConcurrency() {
  const n = Number(process.env.PLEXUS_DISK_SIZE_CONCURRENCY || 8);
  return Math.max(1, Math.min(32, n > 0 ? n : 8));
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
  const { readPkg, getInstalledVersion } = ctx;
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

/**
 * Populates `diskSize` on each graph entry. Only worth calling for the HTML report
 * (the terminal output never reads `diskSize`) — done as a separate, parallel pass
 * so a plain `plexus analyze` never shells out to `du` at all.
 */
async function attachDiskSizes(graph, ctx) {
  const names = Object.keys(graph).filter(name => !graph[name].missing);
  const limit = diskSizeFetchConcurrency();
  for (let i = 0; i < names.length; i += limit) {
    const batch = names.slice(i, i + limit);
    await Promise.all(
      batch.map(async name => {
        graph[name].diskSize = await ctx.getDiskSize(name);
      }),
    );
  }
}

module.exports = { createFsContext, buildGraph, attachDiskSizes, satisfies };
