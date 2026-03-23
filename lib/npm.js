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

module.exports = {
  queryNpm,
  getBundleSize,
  fetchResolvedPackageManifest,
  createRegistryContext,
};
