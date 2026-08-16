#!/usr/bin/env node

/**
 * impeccable-mcp — MCP server wrapping impeccable's design-lint engine.
 *
 * Transport shape is cloned from gsd-browser-mcp (native StreamableHTTP over
 * raw node:http, stateless — a fresh McpServer + transport per request, no
 * session bookkeeping). See CONTRIBUTING.md for why that pattern, and for the
 * two deliberate deviations here: a timing-safe token compare, and no
 * `chromium-wrapper` shim (puppeteer takes launch args directly, so it's
 * unneeded — see scan.mjs).
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { scanUrl, screenshotUrl, scanHtml, listRules, closeBrowser } from './scan.mjs';
import { findingsToToolResult, errorToolResult } from './format.mjs';

const TOKEN = process.env.IMPECCABLE_MCP_TOKEN; // pragma: allowlist secret — env read, not a literal
const PORT = Number(process.env.PORT ?? 8000);

if (!TOKEN) {
  console.error('[impeccable-mcp] IMPECCABLE_MCP_TOKEN is required');
  process.exit(1);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function timingSafeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  // timingSafeEqual throws on length mismatch instead of returning false —
  // compare against a same-length buffer first so a wrong-length token
  // still takes the constant-time path rather than short-circuiting.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const COOKIE_SCHEMA = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
});

const HEADERS_DESCRIPTION =
  'Extra HTTP headers to send with the request (e.g. a session token for a gated page). ' +
  'WARNING: these values will appear in this conversation/transcript — do not pass anything ' +
  'you would not want logged.';
const COOKIES_DESCRIPTION =
  'Cookies to set before loading the page. Same transcript-visibility warning as headers.';

function registerTools(server) {
  server.registerTool(
    'scan_url',
    {
      description:
        "Load a URL in headless Chrome and run impeccable's full anti-pattern detector against it. " +
        'Returns findings grouped by category: "slop" (AI-generated design tells — overused fonts, ' +
        'gradient headings, nested cards, etc.) and "quality" (accessibility/design issues — low ' +
        'contrast, cramped padding, skipped heading levels, etc.). Refuses private/loopback/LAN ' +
        'targets by default. Pass headers or cookies only for pages that require them — doing so ' +
        'trades some scan fidelity (see the response note) for reaching authenticated content.',
      inputSchema: {
        url: z.string().url().describe('The page to scan.'),
        headers: z.record(z.string(), z.string()).optional().describe(HEADERS_DESCRIPTION),
        cookies: z.array(COOKIE_SCHEMA).optional().describe(COOKIES_DESCRIPTION),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
          .optional()
          .describe('Puppeteer navigation-wait strategy. Default networkidle0.'),
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .optional()
          .describe('Default 1280x800.'),
      },
    },
    async ({ url, headers, cookies, waitUntil, viewport }) => {
      try {
        const { findings, reducedFidelity } = await scanUrl(url, { headers, cookies, waitUntil, viewport });
        return findingsToToolResult(findings, { reducedFidelity });
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'scan_html',
    {
      description:
        "Run impeccable's static detector against a raw HTML string (with any inline <style> " +
        'blocks). No browser is launched — use this to check generated markup before writing it ' +
        'to disk. Findings use the same shape and category grouping as scan_url.',
      inputSchema: {
        html: z.string().describe('The HTML to scan.'),
      },
    },
    async ({ html }) => {
      try {
        const findings = await scanHtml(html);
        return findingsToToolResult(findings);
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'screenshot',
    {
      description:
        'Load a URL in headless Chrome and return a PNG screenshot as image content. Same ' +
        'private-target refusal and header/cookie transcript warning as scan_url.',
      inputSchema: {
        url: z.string().url().describe('The page to screenshot.'),
        headers: z.record(z.string(), z.string()).optional().describe(HEADERS_DESCRIPTION),
        cookies: z.array(COOKIE_SCHEMA).optional().describe(COOKIES_DESCRIPTION),
        fullPage: z.boolean().optional().describe('Capture the full scrollable page, not just the viewport. Default false.'),
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .optional(),
      },
    },
    async ({ url, headers, cookies, fullPage, viewport }) => {
      try {
        const base64 = await screenshotUrl(url, { headers, cookies, fullPage, viewport });
        return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }], isError: false };
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'list_rules',
    {
      description:
        "Return impeccable's full anti-pattern rule registry: id, name, category, and description " +
        'for every rule the detector checks. Useful for an agent deciding which findings to act on, ' +
        'or explaining a finding\'s rule to a human.',
      inputSchema: {
        category: z.enum(['slop', 'quality']).optional().describe('Filter to one category; omit for all rules.'),
      },
    },
    async ({ category }) => {
      try {
        const rules = listRules(category);
        return { content: [{ type: 'text', text: JSON.stringify(rules, null, 2) }], isError: false };
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );
}

async function createMcpServer() {
  const server = new McpServer(
    { name: 'impeccable-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  return server;
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    if (!req.url?.startsWith('/mcp')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    const token = extractBearerToken(req.headers.authorization); // pragma: allowlist secret — parsed value, not a literal
    if (!timingSafeTokenEqual(token, TOKEN)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const mcpServer = await createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);

    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        body = undefined;
      }
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[impeccable-mcp] request error:', err?.message || err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[impeccable-mcp] listening on port ${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[impeccable-mcp] ${sig} received, closing browser and exiting`);
    await closeBrowser();
    httpServer.close(() => process.exit(0));
    // Don't hang forever waiting for keep-alive connections to drain.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
