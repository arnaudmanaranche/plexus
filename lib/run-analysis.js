'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { color } = require('./ansi');
const { formatBytes } = require('./format');
const { createFsContext, buildGraph } = require('./graph');
const { resolveConflicts } = require('./fix');
const { getBundleSize, createRegistryContext } = require('./npm');
const { renderHtml } = require('./render-html');
const { printGraph, printSummary } = require('./terminal');

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
  openHtmlReport,
  runFilesystemAnalysis,
  runRegistryAnalysis,
};
