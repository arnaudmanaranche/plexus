'use strict';

const { formatBytes, sizeClass } = require('./format');
const { escapeHtml: esc, npmPackageUrl, pkgSlugForDom: slug } = require('./html-escape');

function renderHtml(graph, directDeps, rootPkg, resolutions = {}, bundleSizes = {}, meta = {}) {
  const sourceNote =
    meta.source === 'registry'
      ? ' — versions resolved from npm registry (no local node_modules)'
      : '';
  const directSet = new Set(Object.keys(directDeps));

  const entries = Object.entries(graph).sort(([a], [b]) => a.localeCompare(b));

  const conflictCount = entries.reduce((acc, [, info]) => {
    return acc + info.peerDeps.filter(p => !p.ok && p.installed).length;
  }, 0);
  const missingOptionalCount = entries.reduce((acc, [, info]) => {
    return acc + info.peerDeps.filter(p => !p.ok && !p.installed).length;
  }, 0);
  const okCount = entries.reduce((acc, [, info]) => {
    return acc + info.peerDeps.filter(p => p.ok).length;
  }, 0);

  // Size stats (registry / upload paths have no disk data — omit stat instead of "0 B")
  const totalDiskSize = entries.reduce((acc, [, info]) => acc + (info.diskSize ?? 0), 0);
  const showDiskTotalStat = totalDiskSize > 0;

  // Abbreviate long semver ranges for compact display
  function shortRange(range) {
    // "^10.0.8 || ^11.0 || ^12.0 || ^13.0" → "^10 | ^11 | ^12 | ^13"
    return range.replace(/(\d+)\.\d+(\.\d+)?/g, '$1').replace(/\s*\|\|\s*/g, ' | ');
  }

  const cardUid = (() => {
    let n = 0;
    return () => ++n;
  })();

  const cards = entries
    .map(([pkgName, info]) => {
      const isDirect = directSet.has(pkgName);
      const conflictPeers = info.peerDeps.filter(p => !p.ok && p.installed);
      const optionalPeers = info.peerDeps.filter(p => !p.ok && !p.installed);
      const okPeers = info.peerDeps.filter(p => p.ok);

      const statusClass = info.missing
        ? 'card-missing'
        : conflictPeers.length > 0
          ? 'card-conflict'
          : optionalPeers.length > 0 && okPeers.length === 0
            ? 'card-warning'
            : 'card-ok';

      const uid = cardUid();

      // Conflict rows — most important, always visible
      const conflictRows = conflictPeers
        .map(
          p => `
        <div class="peer-row peer-conflict">
          <span class="peer-icon">✗</span>
          <a href="${esc(npmPackageUrl(p.name))}" target="_blank" class="peer-name">${esc(p.name)}</a>
          <span class="peer-detail">have <strong>v${esc(p.installed)}</strong> · needs <span class="needs-range" title="${esc(p.range)}">${esc(shortRange(p.range))}</span></span>
        </div>`,
        )
        .join('');

      // OK rows — compact, secondary
      const okRows = okPeers
        .map(
          p => `
        <div class="peer-row peer-ok">
          <span class="peer-icon">✓</span>
          <a href="${esc(npmPackageUrl(p.name))}" target="_blank" class="peer-name">${esc(p.name)}</a>
          <span class="peer-version-ok">v${esc(p.installed)}</span>
        </div>`,
        )
        .join('');

      // Optional peers — collapsed by default
      const optionalRows = optionalPeers
        .map(
          p => `
        <div class="peer-row peer-missing">
          <span class="peer-icon">·</span>
          <a href="${esc(npmPackageUrl(p.name))}" target="_blank" class="peer-name">${esc(p.name)}</a>
          <span class="peer-optional-label">optional · not installed</span>
        </div>`,
        )
        .join('');

      const optionalToggle =
        optionalPeers.length > 0
          ? `
        <div class="optional-toggle" onclick="toggleOptional(${uid})">
          <span id="opt-arrow-${uid}">▸</span> ${optionalPeers.length} optional peer${optionalPeers.length > 1 ? 's' : ''}
        </div>
        <div id="opt-rows-${uid}" class="optional-rows hidden">${optionalRows}</div>`
          : '';

      const noPeers =
        info.peerDeps.length === 0 ? '<div class="no-peers">no peer dependencies</div>' : '';

      // Header meta
      const sizeStr = formatBytes(info.diskSize);
      const sizeCls = sizeClass(info.diskSize);
      const bundleInfo = bundleSizes[pkgName];

      const requiredByHtml =
        info.requiredBy.length > 0
          ? `<div class="required-by">peer of: ${info.requiredBy.map(r => `<a href="#pkg-${slug(r)}">${esc(r)}</a>`).join(', ')}</div>`
          : '';

      return `<div class="card ${statusClass}" id="pkg-${slug(pkgName)}" data-conflicts="${conflictPeers.length}" data-pkg="${esc(pkgName)}" data-size="${info.diskSize ?? 0}" data-bundle-gzip="${bundleInfo ? bundleInfo.gzip : 0}">
      <div class="card-header">
        <a href="${esc(npmPackageUrl(pkgName))}" target="_blank" class="pkg-name">${esc(pkgName)}</a>
        <span class="pkg-meta">
          <span class="pkg-version">v${info.missing ? '?' : esc(info.version)}</span>
          ${sizeStr ? `<span class="size-badge ${sizeCls}">${esc(sizeStr)}</span>` : ''}
          ${bundleInfo ? `<span class="size-badge size-bundle" title="Bundle size (gzip)">gzip ${esc(formatBytes(bundleInfo.gzip))}</span>` : ''}
        </span>
        <div class="badges">
          ${isDirect ? '<span class="badge badge-direct">direct</span>' : ''}
          ${conflictPeers.length > 0 ? `<span class="badge badge-conflict">⚠ ${conflictPeers.length}</span>` : ''}
        </div>
      </div>
      ${requiredByHtml}
      ${conflictRows}${okRows}${optionalToggle}${noPeers}
    </div>`;
    })
    .join('\n');

  const hasConflictCards = entries.some(([, info]) =>
    info.peerDeps.some(p => !p.ok && p.installed),
  );
  /** Show "No issues" only when there is at least one conflict (otherwise redundant with "All"). */
  const showNoIssuesFilter = conflictCount > 0;

  const toolbarRows = [
    '<input type="text" id="search" placeholder="Search packages…">',
    '<button type="button" class="filter-btn active" data-filter="all">All</button>',
  ];
  if (hasConflictCards) {
    toolbarRows.push(
      '<button type="button" class="filter-btn" data-filter="conflicts" id="plexus-filter-conflicts">Conflicts only</button>',
    );
  }
  toolbarRows.push('<button type="button" class="filter-btn" data-filter="direct">Direct only</button>');
  if (showNoIssuesFilter) {
    toolbarRows.push('<button type="button" class="filter-btn" data-filter="ok">No issues</button>');
  }
  toolbarRows.push(
    '<button type="button" class="filter-btn" id="sort-size-btn" style="margin-left:auto">Sort by size ↕</button>',
  );
  const toolbarHtml = `<div class="toolbar">\n  ${toolbarRows.join('\n  ')}\n</div>`;

  const conflictSummaryRows = entries
    .flatMap(([pkgName, info]) =>
      info.peerDeps
        .filter(p => !p.ok && p.installed)
        .map(
          p => `<tr>
        <td><a href="#pkg-${slug(pkgName)}" class="pkg-link">${esc(pkgName)}</a></td>
        <td><a href="${esc(npmPackageUrl(p.name))}" target="_blank" class="pkg-link">${esc(p.name)}</a></td>
        <td><code>${esc(p.range)}</code></td>
        <td><span class="version-mismatch">v${esc(p.installed)}</span></td>
      </tr>`,
        ),
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Plexus — ${esc(rootPkg.name ?? 'package')}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0a;
    --surface: #111111;
    --surface2: #171717;
    --code: #1c1c1c;
    --border: #27272a;
    --border-hover: #3f3f46;
    --text: #d4d4d8;
    --text-bright: #fafafa;
    --muted: #71717a;
    --muted2: #52525b;
    --green: #86efac;
    --green-bg: #14532d;
    --red: #f87171;
    --red-bg: #1c1010;
    --red-border: #7f1d1d;
    --yellow: #fbbf24;
    --yellow-bg: #1c1810;
    --yellow-border: #78350f;
    --accent: #e4e4e7;
    --link: #d4d4d8;
    --link-hover: #ffffff;
  }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  .shell { max-width: 1120px; margin: 0 auto; padding: 28px 20px 56px; }
  a { color: var(--link); text-decoration: none; }
  a:hover { color: var(--link-hover); text-decoration: underline; }
  code { font-family: ui-monospace, 'Cascadia Code', monospace; font-size: 12px; background: var(--code); padding: 2px 6px; border-radius: 4px; color: var(--muted); }

  .hero { text-align: center; padding: 20px 0 32px; border-bottom: 1px solid var(--border); }
  .hero h1 { font-size: clamp(2rem, 5vw, 3rem); font-weight: 600; letter-spacing: -0.03em; color: var(--text-bright); margin-bottom: 12px; }
  .hero-meta { font-size: 1rem; color: var(--muted); }
  .hero-meta strong { color: var(--text); font-weight: 600; }
  .hero-ver { font-family: ui-monospace, monospace; color: var(--muted2); }
  .hero-sub { font-size: 0.875rem; color: var(--muted2); margin-top: 10px; max-width: 40rem; margin-left: auto; margin-right: auto; line-height: 1.55; }
  .generated { font-size: 12px; color: var(--muted2); margin-top: 18px; }

  .stats { display: flex; gap: 12px; padding: 24px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; justify-content: center; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 20px; text-align: center; min-width: 104px; box-shadow: 0 0 0 1px rgba(255,255,255,0.02); }
  .stat-num { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 6px; }
  .num-conflict { color: var(--red); }
  .num-warning { color: var(--yellow); }
  .num-ok { color: var(--green); }
  .num-neutral { color: var(--text-bright); }

  .toolbar { padding: 20px 0; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .toolbar input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 8px; font-size: 13px; width: min(260px, 100%); }
  .toolbar input:focus { outline: none; border-color: var(--border-hover); }
  .toolbar input::placeholder { color: var(--muted2); }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
  .filter-btn:hover, .filter-btn.active { border-color: var(--border-hover); color: var(--text-bright); }
  .filter-btn.active { background: var(--surface2); }

  .grid-wrap { padding: 20px 0 36px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
  .grid-heading { font-size: 0.9375rem; font-weight: 600; color: var(--text-bright); margin-bottom: 14px; letter-spacing: -0.02em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; transition: border-color .15s; box-shadow: 0 0 0 1px rgba(255,255,255,0.02); }
  .card:hover { border-color: var(--border-hover); }
  .card-conflict { border-left: 3px solid var(--red); background: var(--red-bg); border-color: var(--red-border); }
  .card-warning { border-left: 3px solid var(--yellow); background: var(--yellow-bg); border-color: var(--yellow-border); }
  .card-ok { border-left: 3px solid var(--border-hover); }
  .card-missing { border-left: 3px solid var(--red); opacity: 0.55; }

  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .pkg-name { font-weight: 600; font-size: 13px; color: var(--text-bright); flex-shrink: 0; }
  .pkg-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pkg-version { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
  .badges { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
  .badge { font-size: 10px; padding: 2px 7px; border-radius: 6px; font-weight: 600; letter-spacing: 0.02em; }
  .badge-direct { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
  .badge-conflict { background: #450a0a; color: #fca5a5; border: 1px solid var(--red-border); }

  .required-by { font-size: 11px; color: var(--muted); margin: 4px 0 6px; }
  .required-by a { color: var(--accent); }
  .no-peers { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 6px; }

  .peer-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
  .peer-row:last-of-type { border-bottom: none; }
  .peer-icon { width: 14px; text-align: center; flex-shrink: 0; font-size: 11px; }
  .peer-name { min-width: 0; flex: 0 0 auto; color: var(--text); }
  .peer-name:hover { color: var(--text-bright); }

  .peer-ok .peer-icon { color: var(--green); }
  .peer-version-ok { margin-left: auto; color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }

  .peer-conflict .peer-icon { color: var(--red); }
  .peer-detail { margin-left: auto; font-size: 11px; color: var(--red); white-space: nowrap; }
  .peer-detail strong { color: #fca5a5; }
  .needs-range { color: var(--muted); font-family: ui-monospace, monospace; cursor: help; border-bottom: 1px dashed var(--muted2); }

  .peer-missing .peer-icon { color: var(--border-hover); }
  .peer-optional-label { margin-left: auto; font-size: 10px; color: var(--muted); font-style: italic; }

  .optional-toggle { font-size: 11px; color: var(--muted); cursor: pointer; margin-top: 6px; user-select: none; padding: 2px 0; }
  .optional-toggle:hover { color: var(--text-bright); }
  .optional-rows { margin-top: 4px; }

  .conflict-table-section { margin: 0 0 36px; }
  .conflict-table-section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 14px; color: var(--text-bright); }
  .conflict-table-section h2.h2-danger { color: var(--red); }
  .conflict-table-section h2.h2-fix { color: var(--text-bright); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
  th { background: var(--surface2); padding: 12px 14px; text-align: left; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--border); }
  td { padding: 12px 14px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface2); }
  .pkg-link { font-weight: 500; }
  .badge-fix { background: var(--green-bg); color: var(--green); border: 1px solid #166534; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-right: 4px; display: inline-block; margin-top: 2px; }
  .no-cascade { color: var(--green); font-size: 12px; }
  .cascade-list { margin: 0; padding: 0 0 0 18px; font-size: 12px; color: var(--yellow); }
  .cascade-list li { margin-bottom: 4px; }
  .json-block-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .json-block-header .h2-fix { margin-bottom: 0; }
  .copy-json-btn {
    flex-shrink: 0;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text-bright);
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    font-family: system-ui, sans-serif;
    cursor: pointer;
    transition: border-color .15s, background .15s, color .15s;
  }
  .copy-json-btn:hover { border-color: var(--border-hover); background: var(--border); }
  .copy-json-btn.copied { color: var(--green); border-color: rgba(134,239,172,0.35); }
  .json-block-wrap { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--code); }
  .json-block { margin: 0; background: transparent; border: none; border-radius: 0; padding: 20px 22px; font-size: 12px; font-family: ui-monospace, monospace; overflow-x: auto; white-space: pre; color: var(--text); line-height: 1.65; }
  .json-block.json-block-suggested { line-height: 1.42; }
  .json-block-header-text { min-width: 0; flex: 1; }
  .json-block .json-line-changed {
    display: inline;
    padding: 0 6px 0 9px;
    border-left: 3px solid var(--green);
    border-radius: 0 2px 2px 0;
    margin: 0 0 0 -12px;
    background: linear-gradient(90deg, rgba(20,83,45,0.4) 0%, rgba(20,83,45,0.07) 62%, transparent 100%);
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    color: var(--text-bright);
  }
  .version-ok { color: var(--green); }
  .size-badge { font-size: 10px; padding: 2px 7px; border-radius: 6px; font-family: ui-monospace, monospace; }
  .size-bundle { background: rgba(63,63,70,0.45); color: var(--muted); border: 1px solid var(--border); }
  .size-large { background: rgba(127,29,29,0.35); color: #fca5a5; }
  .size-medium { background: rgba(120,53,15,0.35); color: var(--yellow); }
  .size-small { background: rgba(20,83,45,0.35); color: var(--green); }
  .size-rank-table td:nth-child(3) { font-family: ui-monospace, monospace; }
  .gzip-col { color: var(--muted); font-size: 12px; }

  .hidden { display: none !important; }
</style>
</head>
<body>

<div class="shell">
<header class="hero">
  <h1>Plexus</h1>
  <p class="hero-meta"><strong>${esc(rootPkg.name ?? '(unnamed)')}</strong> <span class="hero-ver">v${esc(rootPkg.version ?? '?')}</span></p>
  <p class="hero-sub">Peer dependency analysis${sourceNote}</p>
  <p class="generated">Generated ${esc(new Date().toLocaleString())}</p>
</header>

<div class="stats">
  <div class="stat"><div class="stat-num num-neutral">${Object.keys(directDeps).length}</div><div class="stat-label">Direct deps</div></div>
  <div class="stat"><div class="stat-num num-neutral">${entries.length}</div><div class="stat-label">Total in graph</div></div>
  <div class="stat"><div class="stat-num num-ok">${okCount}</div><div class="stat-label">Satisfied peers</div></div>
  <div class="stat"><div class="stat-num num-conflict">${conflictCount}</div><div class="stat-label">Conflicts</div></div>
  <div class="stat"><div class="stat-num num-warning">${missingOptionalCount}</div><div class="stat-label">Missing optional</div></div>
${
  showDiskTotalStat
    ? `  <div class="stat"><div class="stat-num num-neutral" style="font-size:17px">${esc(formatBytes(totalDiskSize))}</div><div class="stat-label">Total disk (node_modules)</div></div>`
    : ''
}
</div>

${toolbarHtml}

<div class="grid-wrap">
  <h2 class="grid-heading">Packages</h2>
  <div class="grid" id="grid">
${cards}
  </div>
</div>

${
  conflictCount > 0
    ? `
<div class="conflict-table-section">
  <h2 class="h2-danger">✗ ${conflictCount} Version Conflict${conflictCount > 1 ? 's' : ''}</h2>
  <table>
    <thead><tr><th>Package</th><th>Requires peer</th><th>Required range</th><th>Installed</th></tr></thead>
    <tbody>${conflictSummaryRows}</tbody>
  </table>
</div>`
    : ''
}

${
  Object.keys(resolutions).length > 0
    ? (() => {
        const rows = Object.entries(resolutions)
          .map(([pkg, r]) => {
            const cascadeHtml =
              r.cascades.length > 0
                ? `<ul class="cascade-list">${r.cascades.map(c => `<li>⚠ <b>${esc(c.peerName)}</b>: needs <code>${esc(c.peerRange)}</code>, have v${esc(c.installedVer)}</li>`).join('')}</ul>`
                : '<span class="no-cascade">No new cascades</span>';
            const fixesHtml =
              r.fixes.length > 0
                ? r.fixes.map(f => `<span class="badge badge-fix">${esc(f)}</span>`).join(' ')
                : '<span style="color:var(--muted)">none</span>';
            const stillHtml =
              r.stillConflicts.length > 0
                ? r.stillConflicts
                    .map(f => `<span class="badge badge-conflict">${esc(f)}</span>`)
                    .join(' ')
                : '';
            return `<tr>
      <td><a href="${esc(npmPackageUrl(pkg))}" target="_blank" class="pkg-link">${esc(pkg)}</a></td>
      <td><code>${esc(r.current)}</code> → <code class="version-ok">^${esc(r.latest)}</code></td>
      <td>${fixesHtml}${stillHtml}</td>
      <td>${cascadeHtml}</td>
    </tr>`;
          })
          .join('\n');

        return `<div class="conflict-table-section">
  <h2 class="h2-fix">Resolution plan (--fix)</h2>
  <table>
    <thead><tr><th>Package</th><th>Upgrade</th><th>Fixes / Still broken</th><th>Cascade risks</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
      })()
    : ''
}

${
  Object.keys(resolutions).length > 0
    ? (() => {
        const suggested = JSON.parse(JSON.stringify(rootPkg));
        for (const [pkg, r] of Object.entries(resolutions)) {
          if (suggested.dependencies?.[pkg]) suggested.dependencies[pkg] = `^${r.latest}`;
          if (suggested.devDependencies?.[pkg]) suggested.devDependencies[pkg] = `^${r.latest}`;
        }
        const changedSet = new Set(Object.keys(resolutions));
        const depLineRe = /^(\s*)("([^"]+)":\s*"[^"]*")(,?)$/;
        let depsJson = JSON.stringify(
          { dependencies: suggested.dependencies, devDependencies: suggested.devDependencies },
          null,
          2,
        );
        depsJson = depsJson
          .split('\n')
          .map(line => {
            const m = line.match(depLineRe);
            if (m && changedSet.has(m[3])) {
              return `<span class="json-line-changed">${esc(m[1] + m[2] + (m[4] || ''))}</span>`;
            }
            return esc(line);
          })
          .join('\n');
        return `<div class="conflict-table-section">
  <div class="json-block-header">
    <div class="json-block-header-text">
      <h2 class="h2-fix">Suggested package.json</h2>
    </div>
    <button type="button" class="copy-json-btn" id="copy-suggested-json" aria-label="Copy JSON to clipboard">Copy JSON</button>
  </div>
  <div class="json-block-wrap">
    <pre class="json-block json-block-suggested" id="suggested-json-pre">${depsJson}</pre>
  </div>
</div>`;
      })()
    : ''
}

</div>

<script>
  function toggleOptional(uid) {
    var rows = document.getElementById('opt-rows-' + uid);
    var arrow = document.getElementById('opt-arrow-' + uid);
    if (!rows) return;
    rows.classList.toggle('hidden');
    arrow.textContent = rows.classList.contains('hidden') ? '▸' : '▾';
  }

  function fallbackCopyJson(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* Run immediately: DOMContentLoaded often does not fire after document.write() / blob report. */
  (function () {
    var currentFilter = 'all';
    var sortedBySize = false;
    var searchInput = document.getElementById('search');
    var grid = document.getElementById('grid');
    if (!grid) return;

    var conflictsBtn = document.getElementById('plexus-filter-conflicts');
    if (conflictsBtn && !grid.querySelector('.card-conflict')) {
      conflictsBtn.remove();
    }

    function effectiveSize(card) {
      var disk = parseInt(card.getAttribute('data-size') || '0', 10) || 0;
      var gzip = parseInt(card.getAttribute('data-bundle-gzip') || '0', 10) || 0;
      return disk > 0 ? disk : gzip;
    }

    function getGridCards() {
      var g = document.getElementById('grid');
      if (!g) return [];
      return Array.from(g.children).filter(function (el) {
        return el.nodeType === 1 && el.classList.contains('card');
      });
    }

    function filterCards() {
      var search = (searchInput && searchInput.value) ? searchInput.value.toLowerCase() : '';
      getGridCards().forEach(function (card) {
        var pkg = (card.getAttribute('data-pkg') || '').toLowerCase();
        var hasConflict = card.classList.contains('card-conflict');
        var hasWarning = card.classList.contains('card-warning');
        var hasDirect = card.querySelector('.badge-direct');

        var matchesSearch = !search || pkg.indexOf(search) !== -1;
        var matchesFilter =
          currentFilter === 'all' ||
          (currentFilter === 'conflicts' && hasConflict) ||
          (currentFilter === 'direct' && !!hasDirect) ||
          (currentFilter === 'ok' && !hasConflict && !hasWarning);

        card.classList.toggle('hidden', !matchesSearch || !matchesFilter);
      });
    }

    if (searchInput) searchInput.addEventListener('input', filterCards);

    document.querySelectorAll('.filter-btn[data-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentFilter = btn.getAttribute('data-filter');
        document.querySelectorAll('.filter-btn[data-filter]').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        filterCards();
      });
    });

    /* Delegated click: survives edge cases where target is a text node; always use live #grid. */
    document.addEventListener(
      'click',
      function (e) {
        var t = e.target;
        while (t && t.nodeType !== 1) t = t.parentNode;
        var sortBtn = t && t.closest ? t.closest('#sort-size-btn') : null;
        if (!sortBtn) return;
        try {
          var gridEl = document.getElementById('grid');
          if (!gridEl) return;

          var nextBySize = !sortedBySize;
          var cards = Array.from(gridEl.children).filter(function (el) {
            return el.nodeType === 1 && el.classList.contains('card');
          });
          if (cards.length === 0) return;

          var pkgKey = function (c) {
            return (c.getAttribute('data-pkg') || '').toLowerCase();
          };
          var eff = cards.map(function (c) {
            return effectiveSize(c);
          });
          var allSameSizes =
            eff.length > 0 && eff.every(function (s) {
              return s === eff[0];
            });

          cards.sort(function (a, b) {
            if (nextBySize) {
              var sa = effectiveSize(a);
              var sb = effectiveSize(b);
              if (sb !== sa) return sb - sa;
              /* All sizes tied (often 0): reverse name vs initial report order so the grid visibly changes */
              if (allSameSizes) return pkgKey(b).localeCompare(pkgKey(a));
              return pkgKey(a).localeCompare(pkgKey(b));
            }
            return pkgKey(a).localeCompare(pkgKey(b));
          });

          while (gridEl.firstChild) gridEl.removeChild(gridEl.firstChild);
          var frag = document.createDocumentFragment();
          for (var i = 0; i < cards.length; i++) {
            frag.appendChild(cards[i]);
          }
          gridEl.appendChild(frag);
          void gridEl.offsetWidth;

          sortedBySize = nextBySize;
          sortBtn.classList.toggle('active', sortedBySize);
          sortBtn.textContent = sortedBySize ? 'Sort by name ↕' : 'Sort by size ↕';

          console.log('[plexus] sort applied', {
            mode: sortedBySize ? 'by_size' : 'by_name',
            cards: cards.length,
            allSameSizes: nextBySize ? allSameSizes : null,
            firstThree: Array.prototype.slice.call(gridEl.children, 0, 3).map(function (n) {
              return n.getAttribute('data-pkg');
            }),
          });

          filterCards();
        } catch (err) {
          console.error('[plexus] sort failed', err);
        }
      },
      false,
    );

    var copyJsonBtn = document.getElementById('copy-suggested-json');
    var suggestedJsonPre = document.getElementById('suggested-json-pre');
    if (copyJsonBtn && suggestedJsonPre) {
      copyJsonBtn.addEventListener('click', function () {
        var text = suggestedJsonPre.textContent || '';
        var label = copyJsonBtn.textContent;
        function done(ok) {
          copyJsonBtn.textContent = ok ? 'Copied!' : 'Copy failed';
          copyJsonBtn.classList.toggle('copied', ok);
          setTimeout(function () {
            copyJsonBtn.textContent = label;
            copyJsonBtn.classList.remove('copied');
          }, 2000);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(text)
            .then(function () {
              done(true);
            })
            .catch(function () {
              if (fallbackCopyJson(text)) done(true);
              else done(false);
            });
        } else {
          if (fallbackCopyJson(text)) done(true);
          else done(false);
        }
      });
    }
  })();
</script>
</body>
</html>`;
}

module.exports = { renderHtml };
