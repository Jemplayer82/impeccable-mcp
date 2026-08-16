/**
 * Shapes impeccable findings into MCP-friendly output.
 *
 * Every engine (detectUrl, detectHtml, the hand-rolled auth path) returns
 * findings in impeccable's stable shape:
 *   { antipattern, name, description, severity, category, file, line, snippet, advisory? }
 * (see impeccable's cli/engine/findings.mjs). `category` is 'slop' (AI design
 * tells) or 'quality' (real design/a11y issues) — grouping by that split is
 * what makes the output actionable instead of just a flat list.
 */

function groupFindings(findings) {
  const slop = [];
  const quality = [];
  const other = [];

  for (const f of findings) {
    if (f.category === 'slop') slop.push(f);
    else if (f.category === 'quality') quality.push(f);
    else other.push(f);
  }

  return {
    summary: {
      total: findings.length,
      slop: slop.length,
      quality: quality.length,
      ...(other.length ? { other: other.length } : {}),
    },
    slop,
    quality,
    ...(other.length ? { other } : {}),
  };
}

function findingsToToolResult(findings, { reducedFidelity } = {}) {
  const grouped = groupFindings(findings);
  const payload = reducedFidelity
    ? { ...grouped, note: 'Scanned with custom headers/cookies — the content-hidden-at-rest sweep, visual-contrast fallback, and script-error capture that the default (unauthenticated) path runs are skipped. Findings are a valid subset, not an undercount of the same set.' }
    : grouped;

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

function errorToolResult(err) {
  return {
    content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
    isError: true,
  };
}

export { groupFindings, findingsToToolResult, errorToolResult };
