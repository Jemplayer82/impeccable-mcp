/**
 * Browser lifecycle, the private-target guard, and the two scan paths
 * (default vs. header/cookie-authenticated) for impeccable-mcp.
 *
 * Design notes (see PLAN.md / README for the fuller rationale):
 *
 * - One Chromium process is held long-lived (acquireBrowser), relaunched on
 *   crash and closed after BROWSER_IDLE_TIMEOUT_MS idle. Every scan gets its
 *   own incognito browser context (browser.createBrowserContext()) so headers
 *   and cookies from one call can never leak into another, without paying
 *   Chrome's ~1s boot time per scan.
 *
 * - The DEFAULT path calls impeccable's own exported `detectUrl(url, opts)`
 *   directly, passing our incognito context as `options.browser` (puppeteer's
 *   BrowserContext implements `.newPage()`, same as Browser, so this just
 *   works — detectUrl never calls anything else on it). This keeps full
 *   fidelity: the content-hidden-at-rest reveal sweep, the visual-contrast
 *   fallback, and pageerror capture that detectUrl does internally.
 *
 * - The AUTH path (headers/cookies present) can't use detectUrl directly —
 *   it has no headers/cookies option — so it hand-rolls the same contract
 *   detectUrl uses internally: inject the `impeccable/browser` bundle after
 *   navigation and call `window.impeccableDetect()`. This is a documented,
 *   intentional v1 gap: it skips the three extras above. Findings are a
 *   valid subset, not an undercount of the same set — see format.mjs's
 *   `reducedFidelity` note.
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer';
import {
  detectUrl as impeccableDetectUrl,
  detectHtml as impeccableDetectHtml,
  ANTIPATTERNS,
  getAntipattern,
  getRulesForCategory,
} from 'impeccable';

const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY) || 2);
const IDLE_TIMEOUT_MS = Number(process.env.BROWSER_IDLE_TIMEOUT_MS) || 300_000;
const NAV_TIMEOUT_MS = 30_000;
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

// ---------------------------------------------------------------------------
// Private-target guard
// ---------------------------------------------------------------------------
//
// This service's entire job is "fetch whatever URL an agent hands it." Without
// this guard a prompt-injected agent could turn it into a LAN port scanner or
// point it at Portainer/Home Assistant from inside the trusted network. This
// is best-effort defense in depth (it resolves DNS once, up front, to catch
// a public hostname pointed at an internal address) — it is not a complete
// defense against DNS rebinding between the check and puppeteer's own
// connection, which is why the deploy plan also keeps this service off any
// public DNS/proxy entry. Set IMPECCABLE_ALLOW_PRIVATE=1 to disable entirely.

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80:')) return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (net.isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

async function assertPublicTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) scheme: ${url.protocol}`);
  }
  if (process.env.IMPECCABLE_ALLOW_PRIVATE === '1') return url;

  // WHATWG URL wraps IPv6 literals in brackets (new URL('http://[::1]').hostname
  // === '[::1]'), which net.isIP() doesn't accept — strip them before checking,
  // or a literal IPv6 loopback/private address falls through to the (still
  // correct, but slower and DNS-dependent) resolve branch below.
  const hostname = url.hostname.toLowerCase();
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`Refusing private/loopback target: ${hostname}`);
  }

  const ipVersion = net.isIP(bareHost);
  if (ipVersion === 4 && isPrivateIPv4(bareHost)) {
    throw new Error(`Refusing private target: ${hostname}`);
  }
  if (ipVersion === 6 && isPrivateIPv6(bareHost)) {
    throw new Error(`Refusing private target: ${hostname}`);
  }

  if (!ipVersion) {
    let records;
    try {
      records = await lookup(bareHost, { all: true });
    } catch {
      throw new Error(`Could not resolve host: ${hostname}`);
    }
    for (const rec of records) {
      if (rec.family === 4 && isPrivateIPv4(rec.address)) {
        throw new Error(`Refusing target that resolves to a private address: ${hostname} -> ${rec.address}`);
      }
      if (rec.family === 6 && isPrivateIPv6(rec.address)) {
        throw new Error(`Refusing target that resolves to a private address: ${hostname} -> ${rec.address}`);
      }
    }
  }

  return url;
}

// ---------------------------------------------------------------------------
// Concurrency limiter — impeccable's own createBrowserDetector has none, and
// unbounded parallel Chromium scans will OOM the box. Gates browser-backed
// scans only; scan_html and list_rules never touch this.
// ---------------------------------------------------------------------------

let activeCount = 0;
const queue = [];

function dequeue() {
  if (activeCount < MAX_CONCURRENCY && queue.length) {
    const run = queue.shift();
    run();
  }
}

function withConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeCount++;
      fn().then(
        (v) => { activeCount--; dequeue(); resolve(v); },
        (e) => { activeCount--; dequeue(); reject(e); },
      );
    };
    if (activeCount < MAX_CONCURRENCY) run();
    else queue.push(run);
  });
}

// ---------------------------------------------------------------------------
// Browser lifecycle — long-lived, crash-relaunch, idle close
// ---------------------------------------------------------------------------

let browserInstance = null;
let launching = null;
let idleTimer = null;

function cancelIdleClose() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleClose() {
  cancelIdleClose();
  idleTimer = setTimeout(() => {
    if (activeCount > 0) return; // a scan started right as the timer fired; leave it
    const toClose = browserInstance;
    browserInstance = null;
    if (toClose) toClose.close().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

async function acquireBrowser() {
  cancelIdleClose();
  if (browserInstance && browserInstance.connected) return browserInstance;
  if (!launching) {
    launching = puppeteer
      .launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        headless: true,
        args: LAUNCH_ARGS,
      })
      .then((browser) => {
        browserInstance = browser;
        launching = null;
        browser.once('disconnected', () => {
          if (browserInstance === browser) browserInstance = null;
        });
        return browser;
      })
      .catch((err) => {
        launching = null;
        throw err;
      });
  }
  return launching;
}

// ---------------------------------------------------------------------------
// The impeccable/browser injectable bundle, for the auth path only
// ---------------------------------------------------------------------------

let bundleCache = null;
function loadBrowserBundle() {
  if (!bundleCache) {
    const resolved = import.meta.resolve('impeccable/browser');
    bundleCache = readFileSync(fileURLToPath(resolved), 'utf-8');
  }
  return bundleCache;
}

function hasAuth(opts) {
  return Boolean((opts.headers && Object.keys(opts.headers).length) || (opts.cookies && opts.cookies.length));
}

async function applyAuth(page, url, { headers, cookies }) {
  if (headers && Object.keys(headers).length) {
    await page.setExtraHTTPHeaders(headers);
  }
  if (cookies && cookies.length) {
    await page.setCookie(...cookies.map((c) => ({ url: c.domain ? undefined : url, ...c })));
  }
}

async function scanUrlAuthenticated(url, opts, context) {
  const page = await context.newPage();
  try {
    if (opts.viewport) await page.setViewport(opts.viewport);
    await applyAuth(page, url, opts);
    await page.goto(url, { waitUntil: opts.waitUntil || 'networkidle0', timeout: NAV_TIMEOUT_MS });
    const bundle = loadBrowserBundle();
    await page.evaluate(() => {
      window.__IMPECCABLE_CONFIG__ = { ...(window.__IMPECCABLE_CONFIG__ || {}), autoScan: false };
    });
    await page.evaluate(bundle);
    const groups = await page.evaluate(() =>
      window.impeccableDetect ? window.impeccableDetect({ decorate: false, serialize: true }) : [],
    );
    return groups.flatMap(({ findings }) =>
      findings.map((f) => {
        const rule = getAntipattern(f.type);
        return {
          antipattern: f.type,
          name: rule?.name,
          description: rule?.description,
          severity: f.severity || rule?.severity || 'warning',
          category: rule?.category || null,
          file: url,
          line: 0,
          snippet: f.detail,
        };
      }),
    );
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function scanUrl(url, opts = {}) {
  await assertPublicTarget(url);
  return withConcurrencyLimit(async () => {
    const browser = await acquireBrowser();
    const context = await browser.createBrowserContext();
    try {
      const auth = hasAuth(opts);
      const findings = auth
        ? await scanUrlAuthenticated(url, opts, context)
        : await impeccableDetectUrl(url, {
            waitUntil: opts.waitUntil,
            viewport: opts.viewport,
            browser: context,
          });
      return { findings, reducedFidelity: auth };
    } finally {
      await context.close().catch(() => {});
      scheduleIdleClose();
    }
  });
}

async function screenshotUrl(url, opts = {}) {
  await assertPublicTarget(url);
  return withConcurrencyLimit(async () => {
    const browser = await acquireBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      try {
        if (opts.viewport) await page.setViewport(opts.viewport);
        await applyAuth(page, url, opts);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
        const buf = await page.screenshot({ type: 'png', fullPage: Boolean(opts.fullPage) });
        return buf.toString('base64');
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
      scheduleIdleClose();
    }
  });
}

async function scanHtml(html) {
  // detectHtml reads from a real file path (it resolves linked local
  // stylesheets relative to it), so a raw HTML string has to land on disk
  // first — mirrors the temp-file pattern impeccable's own screenshot path
  // uses internally.
  const tmpFile = path.join(os.tmpdir(), `impeccable-mcp-${randomUUID()}.html`);
  await writeFile(tmpFile, html, 'utf-8');
  try {
    return await impeccableDetectHtml(tmpFile);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

function listRules(category) {
  const rules = category ? getRulesForCategory(category) : ANTIPATTERNS;
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category || 'quality',
    description: r.description,
  }));
}

async function closeBrowser() {
  cancelIdleClose();
  const toClose = browserInstance;
  browserInstance = null;
  if (toClose) await toClose.close().catch(() => {});
}

export { scanUrl, screenshotUrl, scanHtml, listRules, closeBrowser, assertPublicTarget };
