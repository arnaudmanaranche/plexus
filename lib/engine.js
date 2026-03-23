'use strict';

/**
 * Plexus engine — dependency graph + peer conflict detection (filesystem or registry).
 * Re-exports modular pieces; implementation lives in ./ansi, ./format, ./graph, etc.
 */

const { color } = require('./ansi');
const { formatBytes } = require('./format');
const { createFsContext, buildGraph } = require('./graph');
const { printGraph, printSummary } = require('./terminal');
const { resolveConflicts } = require('./fix');
const { queryNpm, getBundleSize } = require('./npm');
const { renderHtml } = require('./render-html');
const { openHtmlReport, runFilesystemAnalysis, runRegistryAnalysis } = require('./run-analysis');

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
