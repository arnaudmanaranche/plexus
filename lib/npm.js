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

/** Strip "v"; bundlejs needs a concrete version string. */
function normalizePkgVersionForBundleQuery(version) {
  if (version == null || version === '') return null;
  const v = String(version).trim().replace(/^v/i, '');
  return v || null;
}

const BUNDLE_API_UA = 'plexus-peers (+https://github.com/arnaudmanaranche/plexus; bundle gzip check)';

/**
 * [bundlejs](https://bundlejs.com/) — esbuild bundles `export * from 'pkg@ver'`, minifies, reports gzip.
 */
async function getBundleSize(pkgName, version) {
  const ver = normalizePkgVersionForBundleQuery(version);
  if (!ver) return null;
  const pkgSpec = `${pkgName}@${ver}`;
  const url = `https://deno.bundlejs.com/?q=${encodeURIComponent(pkgSpec)}`;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 900 * attempt));
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': BUNDLE_API_UA,
        },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) continue;
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return null;
      const data = await res.json();
      const s = data.size;
      if (!s || typeof s !== 'object') return null;
      const rawU = s.rawUncompressedSize;
      const rawC = s.rawCompressedSize;
      if (typeof rawU !== 'number' || typeof rawC !== 'number') return null;
      if (!Number.isFinite(rawU) || !Number.isFinite(rawC)) return null;
      return { size: rawU, gzip: rawC };
    } catch {
      if (attempt === maxAttempts - 1) return null;
    }
  }
  return null;
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

/** bundlejs.com builds are slow; keep concurrency low (`PLEXUS_BUNDLE_SIZE_CONCURRENCY`, default 3). */
function bundleSizeFetchConcurrency() {
  const n = Number(process.env.PLEXUS_BUNDLE_SIZE_CONCURRENCY || 3);
  return Math.max(1, Math.min(8, n > 0 ? n : 3));
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
  bundleSizeFetchConcurrency,
};
