#!/usr/bin/env node
'use strict';

const path = require('path');
const { runFilesystemAnalysis } = require('../lib/engine');
const { startServer } = require('../lib/server');

function printHelp() {
  console.log(`
Plexus — peer dependencies, sizes, resolution hints

Usage:
  npx @arnaudmanaranche/plexus [options]              Analyze package.json in current directory
  npx @arnaudmanaranche/plexus serve [options]        Start upload UI + API

Options:
  --dir, -C <path>     Project root (contains package.json and node_modules)
  --file, -f <path>    Path to package.json (root = its directory)
  --html               Write HTML report (dep-graph.html in project root)
  --out <path>         HTML output path (with --html)
  --conflicts-only     Terminal: only packages with peer issues
  --fix                Query npm for upgrade / cascade hints (noisy on CI)
  --bundlesize         With --html: fetch gzip sizes from BundlePhobia (slow)
  --pkg <name>         Focus on one direct dependency and its peers

Serve:
  --port <n>           Port (default: 3847)

Examples:
  npx @arnaudmanaranche/plexus --html --dir ./my-app
  npx @arnaudmanaranche/plexus serve --port 3847
`);
}

function parseArgv(argv) {
  const out = {
    command: 'analyze',
    rootDir: null,
    packageJsonPath: null,
    port: 3847,
    flags: {
      conflictsOnly: false,
      html: false,
      fix: false,
      bundleSize: false,
      focusPkg: null,
      outFile: null,
    },
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'serve' || a === 'web') {
      out.command = 'serve';
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--dir' || a === '-C') {
      out.rootDir = path.resolve(argv[++i] ?? '');
      continue;
    }
    if (a === '--file' || a === '-f') {
      out.packageJsonPath = path.resolve(argv[++i] ?? '');
      continue;
    }
    if (a === '--port') {
      out.port = Number(argv[++i]) || 3847;
      continue;
    }
    if (a === '--out') {
      out.flags.outFile = path.resolve(argv[++i] ?? '');
      continue;
    }
    if (a === '--pkg') {
      out.flags.focusPkg = argv[++i] ?? null;
      continue;
    }
    if (a === '--conflicts-only') {
      out.flags.conflictsOnly = true;
      continue;
    }
    if (a === '--html') {
      out.flags.html = true;
      continue;
    }
    if (a === '--fix') {
      out.flags.fix = true;
      continue;
    }
    if (a === '--bundlesize') {
      out.flags.bundleSize = true;
      continue;
    }
    if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}\nRun npx @arnaudmanaranche/plexus --help`);
      process.exitCode = 1;
      return null;
    }
  }

  if (out.packageJsonPath) {
    out.rootDir = path.dirname(out.packageJsonPath);
  }
  if (!out.rootDir) {
    out.rootDir = process.cwd();
  }

  return out;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed) return;
  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.command === 'serve') {
    startServer({ port: parsed.port });
    return;
  }

  await runFilesystemAnalysis({ rootDir: parsed.rootDir, flags: parsed.flags });
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
