'use strict';

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

module.exports = { formatBytes, sizeClass };
