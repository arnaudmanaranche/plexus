'use strict';

const { execFileSync } = require('child_process');
const semver = require('semver');

function queryNpm(pkg) {
  try {
    const out = execFileSync('npm', ['info', pkg, '--json'], {
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
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

/** Smaller/faster packument for semver resolution (full version list, slim per-version docs). */
async function fetchResolvedPackageManifest(name, range) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const versions = Object.keys(data.versions || {});
  const best = semver.maxSatisfying(versions, range, { includePrerelease: true });
  if (!best) return null;
  return data.versions[best];
}

/** Latest dist manifest only — used by --fix (avoids full `npm info` + huge JSON per package). */
async function fetchLatestPackageManifest(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  return res.json();
}

function registryFetchConcurrency() {
  const n = Number(process.env.PLEXUS_REGISTRY_CONCURRENCY || 10);
  return Math.max(1, Math.min(50, n > 0 ? n : 10));
}

async function createRegistryContext(directDeps) {
  const pkgs = new Map();
  const names = Object.keys(directDeps);
  const limit = registryFetchConcurrency();
  for (let i = 0; i < names.length; i += limit) {
    const batch = names.slice(i, i + limit);
    await Promise.all(
      batch.map(async name => {
        try {
          const manifest = await fetchResolvedPackageManifest(name, directDeps[name]);
          pkgs.set(name, manifest);
        } catch {
          pkgs.set(name, null);
        }
      }),
    );
  }

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

module.exports = {
  queryNpm,
  getBundleSize,
  fetchResolvedPackageManifest,
  fetchLatestPackageManifest,
  createRegistryContext,
  registryFetchConcurrency,
};
