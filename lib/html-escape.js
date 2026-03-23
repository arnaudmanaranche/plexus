'use strict';

function escapeHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function npmPackageUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(String(name))}`;
}

/** Safe `id` / fragment slug for package names (not HTML-escaped — use only in id/href fragments). */
function pkgSlugForDom(name) {
  return String(name).replace(/[@/]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
}

module.exports = { escapeHtml, npmPackageUrl, pkgSlugForDom };
