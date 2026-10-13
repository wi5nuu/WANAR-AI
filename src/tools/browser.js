import { getChromium } from './lazy-playwright.js';
import { convert } from 'html-to-text';
import { acquirePage, releasePage, fastGoto, warmPool, closePool } from './browser-pool.js';
import { checkOutboundUrl } from '../security/ssrf-guard.js';
import { installCursor, moveCursor, glideCursor, cursorLabel, rippleClick } from './browser-cursor.js';

// ============================================
// WANAR AI - BROWSER AGENT TOOL
// by Wisnu Alfian Nur Ashar
// ============================================
// Deep browser automation for scraping & research
// Uses Playwright Chromium for full JS rendering
// Pooled + warm for very fast navigation; virtual in-page cursor on visible mode.

// Re-export agar server bisa pre-warm pool.
export { warmPool, closePool };

export const browserTools = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Opens a URL in a real browser (Chromium) and returns the fully rendered page content including JavaScript-rendered content. Use this when web_fetch fails or when the page requires JavaScript to load content. Can extract text, links, or take screenshots.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to open (must be a fully-formed valid URL)'
          },
          extract: {
            type: 'string',
            enum: ['text', 'links', 'html', 'screenshot'],
            description: 'What to extract: text (default), links, full html, or screenshot description',
            default: 'text'
          },
          wait_for: {
            type: 'string',
            description: 'CSS selector or keyword to wait for before extracting (e.g. ".content", "networkidle")',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (default: 30, max: 60)',
            default: 30,
            maximum: 60
          },
          scroll: {
            type: 'boolean',
            description: 'Whether to scroll to bottom to load lazy content (default: false)',
            default: false
          },
          visible: {
            type: 'boolean',
            description: 'Open a REAL on-screen browser window the user can watch (default follows BROWSER_VISIBLE). Use this when the user says "buka browsernya biar aku lihat" / "show me".',
            default: false
          },
          cursor_label: {
            type: 'string',
            description: 'Optional short label to show next to the in-page virtual cursor (e.g. "mencari lowongan"). Visible mode only.'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_search_page',
      description: 'Opens a URL and searches for specific text or content within the page. Returns matching sections with context.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to open and search within'
          },
          query: {
            type: 'string',
            description: 'Text or keyword to search for within the page'
          },
          context_chars: {
            type: 'number',
            description: 'Number of characters of context to return around each match (default: 300)',
            default: 300
          }
        },
        required: ['url', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract_links',
      description: 'Opens a URL and extracts all links found on the page with their text labels. Useful for discovering related pages, navigation structure, or finding specific links.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to extract links from'
          },
          filter: {
            type: 'string',
            description: 'Optional keyword to filter links by text or href'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_crawl',
      description: 'Autonomously crawls a webpage AND all links found on it. Opens the main URL, extracts all links, then visits each link to read its content. Perfect for exploring job listings, directories, linktrees, or any page with many sub-links. Use this when user asks to "browse and find", "explore all links", "check each page", or wants comprehensive research across multiple pages from one starting URL.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The starting URL to crawl'
          },
          link_filter: {
            type: 'string',
            description: 'Optional keyword to filter which links to visit (e.g. "intern", "career", "IT"). Only links containing this keyword in text or href will be visited.'
          },
          max_links: {
            type: 'number',
            description: 'Maximum number of sub-links to visit (default: 20, max: 50)',
            default: 20,
            maximum: 50
          },
          summarize_each: {
            type: 'boolean',
            description: 'Whether to include full text from each sub-page (true) or just title + URL (false, default: false)',
            default: false
          },
          same_domain_only: {
            type: 'boolean',
            description: 'Only follow links to the same domain (default: false)',
            default: false
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_interact',
      description: 'Interact with a VISIBLE on-screen browser (real Chromium window the user can watch). Perform human-like actions: click, type into fields, scroll, hover, screenshot, press keys, and wait. The virtual cursor glides smoothly and shows labels so the user sees exactly what the AI is doing. Use this for testing a website hands-on: fill forms, click buttons, verify pages load, take screenshots. Keep the browser window open so the user can observe. For deep site testing, take a screenshot after each key action and describe findings.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open first (optional if a page is already open). A new visible browser window is used.' },
          action: {
            type: 'string',
            enum: ['click', 'type', 'scroll', 'hover', 'screenshot', 'press', 'wait', 'navigate', 'read', 'extract_links', 'snapshot', 'audit'],
            description: 'The interaction to perform. navigate=open URL; click/hover=use selector or text; type=enter text into selector/label/placeholder; press=keyboard key; scroll=up/down; screenshot=return image; read=return page text; extract_links=list links; snapshot=daftar elemen interaktif yang terlihat (untuk memutuskan aksi berikutnya); audit=uji mendalam website (console error, request gagal, gambar rusak, aksesibilitas form, SEO, responsif, waktu muat).'
          },
          selector: { type: 'string', description: 'CSS selector atau text= matcher untuk elemen target (click/hover/snapshot), mis. "text=Log in", "#email", "button[type=submit]".' },
          label: { type: 'string', description: 'Untuk type: label/aria-label field (lebih andal daripada selector untuk form)' },
          placeholder: { type: 'string', description: 'Untuk type: placeholder field, mis. "Email address"' },
          text: { type: 'string', description: 'Untuk type: teks yang diketik. Untuk click: teks yang terlihat pada elemen (bila selector kosong). Untuk wait: teks yang ditunggu.' },
          submit: { type: 'boolean', description: 'For type: press Enter after typing (default false)', default: false },
          key: { type: 'string', description: 'For press: a keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowDown")' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'For scroll (default down)', default: 'down' },
          pixels: { type: 'number', description: 'For scroll: pixels to move (default 600)', default: 600 },
          cursor_label: { type: 'string', description: 'Optional label shown next to the cursor (e.g. "mengklik Login")' },
          timeout: { type: 'number', description: 'Timeout in seconds for the action (default 20, max 60)', default: 20, maximum: 60 },
          force_visible: { type: 'boolean', description: 'Force a real on-screen window even if BROWSER_VISIBLE is off (default true for this tool)', default: true }
        },
        required: ['action']
      }
    }
  }
];

export async function executeBrowserTool(toolName, args) {
  switch (toolName) {
    case 'browser_open': return await browserOpen(args);
    case 'browser_search_page': return await browserSearchPage(args);
    case 'browser_extract_links': return await browserExtractLinks(args);
    case 'browser_crawl': return await browserCrawl(args);
    case 'browser_interact': return await browserInteract(args);
    default: return { error: `Unknown browser tool: ${toolName}` };
  }
}

// ── Visible ("watch") browser ──
// When BROWSER_VISIBLE=true, the agent opens a real, on-screen Chromium window
// that the user can watch while the AI browses. The window persists between
// tool calls and is closed on demand or when the server exits.
const VISIBLE = String(process.env.BROWSER_VISIBLE || 'false').toLowerCase() === 'true';
const KEEP_OPEN_MS = parseInt(process.env.BROWSER_KEEP_OPEN_MS || '6000', 10);

let watchBrowser = null;
let watchContext = null;
let watchPage = null;

async function getWatchPage() {
  if (watchBrowser && watchBrowser.isConnected?.() && watchPage) {
    try { await watchPage.bringToFront(); } catch { /* noop */ }
    return watchPage;
  }
  // FULLSCREEN: window dimaksimalkan dan viewport mengikuti ukuran window
  // (viewport: null) agar user melihat halaman penuh dengan jelas.
  const chromium = await getChromium();
  watchBrowser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--start-maximized',
      '--window-position=0,0',
    ],
  });
  watchContext = await watchBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: null, // ikuti ukuran window yang dimaksimalkan (tampilan penuh)
    locale: 'id-ID,id;q=0.9,en-US;q=0.8',
    ignoreHTTPSErrors: true,
  });
  watchPage = await watchContext.newPage();
  await installCursor(watchPage);
  try { await watchPage.bringToFront(); } catch { /* noop */ }
  watchBrowser.on('disconnected', () => {
    watchBrowser = null; watchContext = null; watchPage = null;
  });
  return watchPage;
}

/** Closes the persistent visible browser, if any. */
export async function closeVisibleBrowser() {
  if (watchBrowser) {
    try { await watchBrowser.close(); } catch { /* noop */ }
  }
  watchBrowser = null; watchContext = null; watchPage = null;
}

/** Live state of the visible browser for the voice split-screen panel. */
export async function getLiveBrowserState() {
  if (!watchPage || !watchBrowser?.isConnected?.()) {
    return { open: false };
  }
  try {
    const url = watchPage.url();
    if (!url || url === 'about:blank') return { open: false };
    const title = await watchPage.title().catch(() => '');
    let screenshot_base64 = null;
    try {
      const buf = await watchPage.screenshot({ type: 'jpeg', quality: 45, fullPage: false, timeout: 5000 });
      screenshot_base64 = buf.toString('base64');
    } catch { /* screenshot optional */ }
    return { open: true, url, title, screenshot_base64 };
  } catch {
    return { open: false };
  }
}

process.on('exit', () => { try { watchBrowser?.close(); } catch { /* noop */ } });
process.on('SIGINT', () => { try { watchBrowser?.close(); } catch { /* noop */ } });

// ── Shared browser launcher (headless, per-call) ──
async function launchBrowser() {
  const chromium = await getChromium();
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ]
  });
}

// ── Validate & normalize URL ──
/**
 * Validates, normalizes and SSRF-screens a navigation target.
 *
 * A real browser will happily open http://169.254.169.254/, http://127.0.0.1:*
 * or a file:// path, and whatever it renders is then fed back to the model —
 * making navigation an SSRF and local-file-disclosure primitive. Screening here
 * (rather than at each call site) means every navigation path is covered.
 *
 * @returns {Promise<{valid: boolean, url?: string, error?: string, blocked?: boolean}>}
 */
async function normalizeUrl(url) {
  let u;
  try {
    u = new URL(url);
    if (u.protocol === 'http:') u.protocol = 'https:';
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  const normalized = u.toString();
  const safety = await checkOutboundUrl(normalized);
  if (!safety.allowed) {
    return {
      valid: false,
      blocked: true,
      error: `Navigation blocked by SSRF guard: ${safety.reason}. Only public http(s) hosts may be browsed.`,
    };
  }

  return { valid: true, url: normalized };
}

// ── Convert HTML to clean text ──
function htmlToText(html) {
  try {
    return convert(html, {
      wordwrap: 130,
      preserveNewlines: true,
      selectors: [
        { selector: 'a', options: { ignoreHref: false } },
        { selector: 'img', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'noscript', format: 'skip' },
      ]
    });
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// ── Visible browser_open ──
// Navigates the persistent on-screen browser, animates the in-page ghost
// cursor, captures a fast screenshot (so the UI can show what the user sees)
// plus the text, and leaves the window open.
async function browserOpenVisible(args) {
  const { url, wait_for, timeout = 30, scroll = false, cursor_label } = args;

  const norm = await normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  const start = Date.now();

  try {
    const page = await getWatchPage();

    // Pastikan overlay cursor ada di halaman baru.
    await installCursor(page);
    await cursorLabel(page, `membuka ${new URL(norm.url).hostname}…`);

    // Animasi cepat cursor ke tengah layar saat halaman dibuka.
    await moveCursor(page, 160, 140).catch(() => {});

    await page.goto(norm.url, { timeout: timeout * 1000, waitUntil: 'domcontentloaded' });

    if (wait_for) {
      if (wait_for === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout: timeout * 1000 }).catch(() => {});
      } else {
        await page.waitForSelector(wait_for, { timeout: 8000 }).catch(() => {});
      }
    }

    // Ghost cursor bergerak menyusuri halaman seperti manusia supaya
    // user benar-benar melihat "tangan AI" bekerja — glide halus + label.
    try {
      const vp = await page.evaluate(() => ({ width: window.innerWidth || 1366, height: window.innerHeight || 850 })).catch(() => ({ width: 1366, height: 850 }));
      const points = [
        [Math.round(vp.width * 0.5), Math.round(vp.height * 0.35)],
        [Math.round(vp.width * 0.35), Math.round(vp.height * 0.55)],
        [Math.round(vp.width * 0.62), Math.round(vp.height * 0.6)],
      ];
      for (const [px, py] of points) {
        await glideCursor(page, px, py);
        await new Promise(r => setTimeout(r, 120 + Math.random() * 160));
      }
      await cursorLabel(page, `${(await page.title().catch(() => '') || 'halaman').slice(0, 60)}`);
    } catch { /* cursor opsional */ }

    if (scroll) {
      await humanScroll(page, 'down', 6);
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => '');

    // A public URL may redirect into private space after the pre-flight check
    // passed. Re-validate where we actually landed, and refuse to read content
    // if the request was redirected somewhere it should not have gone.
    const landed = await checkOutboundUrl(finalUrl).catch(() => ({ allowed: false, reason: 'check_failed' }));
    if (!landed.allowed) {
      return {
        error: `Navigation ended on a blocked destination (${landed.reason}). Content was not read.`,
        requested_url: norm.url,
        blocked: true,
      };
    }

    const html = await page.content();
    let text = htmlToText(html).replace(/\n{3,}/g, '\n\n').trim();
    const truncated = text.length > 40000;
    if (truncated) text = text.slice(0, 40000) + '\n...[truncated]';

    let screenshot_base64 = null;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
      screenshot_base64 = buf.toString('base64');
    } catch { /* screenshot optional */ }

    // Beri waktu singkat agar user sempat melihat halaman tampil.
    if (KEEP_OPEN_MS > 0) await new Promise(r => setTimeout(r, Math.min(KEEP_OPEN_MS, 2000)));

    return {
      success: true,
      url: finalUrl,
      title,
      content: text,
      size: text.length,
      truncated,
      visible: true,
      screenshot_base64,
      elapsed_ms: Date.now() - start,
      note: 'Opened a real browser window the user can see.',
    };
  } catch (err) {
    return { error: 'Visible browser error', details: err.message, url: norm.url };
  }
}

// ── browser_open ──
async function browserOpen(args) {
  const { url, extract = 'text', wait_for, timeout = 30, scroll = false } = args;

  const norm = await normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  // Visible mode: real on-screen window the user can watch.
  if (args.visible === true || (args.visible !== false && VISIBLE)) {
    const visibleResult = await browserOpenVisible(args);
    if (visibleResult.success && extract !== 'text' && extract !== 'screenshot') {
      // The visible path already produced text; re-shape for other extract modes.
      return { ...visibleResult, note: 'Visible browser returned text.' };
    }
    return visibleResult;
  }

  let page;
  let lastGotoMs = 0;
  try {
    page = await acquirePage();

    const { gotoMs } = await fastGoto(page, norm.url, {
      timeout: timeout * 1000,
      wait_for,
    });
    lastGotoMs = gotoMs;

    // Scroll to load lazy content
    if (scroll) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let totalHeight = 0;
          const distance = 300;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
          setTimeout(() => { clearInterval(timer); resolve(); }, 5000);
        });
      }).catch((err) => {
        console.warn('[BROWSER] Auto-scroll failed:', err.message);
      });
    }

    const finalUrl = page.url();
    const title = await page.title().catch((err) => {
      console.warn('[BROWSER] Failed to get page title:', err.message);
      return '';
    });

    let result;

    if (extract === 'html') {
      const html = await page.content();
      result = {
        success: true,
        url: finalUrl,
        title,
        content: html.length > 200000 ? html.slice(0, 200000) + '\n...[truncated]' : html,
        size: html.length,
        truncated: html.length > 200000,
      };
    } else if (extract === 'links') {
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.innerText.trim().slice(0, 200),
          href: a.href,
        })).filter(l => l.href && l.href.startsWith('http'))
      );
      result = {
        success: true,
        url: finalUrl,
        title,
        links: links.slice(0, 200),
        total_links: links.length,
      };
    } else if (extract === 'screenshot') {
      const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      result = {
        success: true,
        url: finalUrl,
        title,
        screenshot_base64: screenshotBuf.toString('base64'),
        note: 'Screenshot taken (JPEG). Use browser_open with extract=text for text content.',
      };
    } else {
      // Default: text
      const html = await page.content();
      let text = htmlToText(html);
      text = text.replace(/\n{3,}/g, '\n\n').trim();
      const maxSize = 80000;
      const truncated = text.length > maxSize;
      if (truncated) text = text.slice(0, maxSize) + '\n...[truncated]';
      result = {
        success: true,
        url: finalUrl,
        title,
        content: text,
        size: text.length,
        truncated,
        goto_ms: lastGotoMs,
        pooled: true,
      };
    }

    await releasePage(page);
    return result;

  } catch (err) {
    await releasePage(page).catch(() => {});
    if (err.message?.includes('net::ERR_')) {
      return { error: 'Could not connect to URL', details: err.message, url: norm.url };
    }
    if (err.message?.includes('Timeout')) {
      return { error: 'Page load timeout', details: `Exceeded ${timeout}s`, url: norm.url };
    }
    return { error: 'Browser error', details: err.message, url: norm.url };
  }
}

// ── browser_search_page ──
async function browserSearchPage(args) {
  const { url, query, context_chars = 300 } = args;

  const norm = await normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };
  if (!query) return { error: 'query is required' };

  // Get page text via browserOpen (headless; visible mode is only for explicit opens)
  const page = await browserOpen({ url: norm.url, extract: 'text', timeout: 30, visible: false });
  if (!page.success) return page;

  const text = page.content;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  const matches = [];
  let pos = 0;
  while (pos < lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, pos);
    if (idx === -1) break;
    const start = Math.max(0, idx - context_chars);
    const end = Math.min(text.length, idx + query.length + context_chars);
    matches.push({
      position: idx,
      context: text.slice(start, end).replace(/\n{3,}/g, '\n\n'),
    });
    pos = idx + query.length;
    if (matches.length >= 10) break; // max 10 matches
  }

  return {
    success: true,
    url: page.url,
    title: page.title,
    query,
    total_matches: matches.length,
    matches,
    note: matches.length === 0 ? `"${query}" not found on this page` : undefined,
  };
}

// ── browser_extract_links ──
async function browserExtractLinks(args) {
  const { url, filter } = args;

  const norm = await normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  const page = await browserOpen({ url: norm.url, extract: 'links', timeout: 30, visible: false });
  if (!page.success) return page;

  let links = page.links || [];

  if (filter) {
    const f = filter.toLowerCase();
    links = links.filter(l =>
      l.text.toLowerCase().includes(f) || l.href.toLowerCase().includes(f)
    );
  }

  return {
    success: true,
    url: page.url,
    title: page.title,
    filter: filter || null,
    total_links: links.length,
    links,
  };
}

// ── browser_crawl ──
async function browserCrawl(args) {
  const {
    url,
    link_filter,
    max_links = 20,
    summarize_each = false,
    same_domain_only = false,
  } = args;

  const norm = await normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  const maxVisit = Math.min(max_links, 50);

  // Step 1: Open main page and get all links
  const mainPage = await browserOpen({ url: norm.url, extract: 'links', timeout: 30, scroll: true, visible: false });
  if (!mainPage.success) return mainPage;

  let links = mainPage.links || [];

  // Filter by same domain if requested
  if (same_domain_only) {
    const mainHost = new URL(norm.url).hostname;
    links = links.filter(l => {
      try { return new URL(l.href).hostname === mainHost; } catch { return false; }
    });
  }

  // Filter by keyword if provided
  if (link_filter) {
    const f = link_filter.toLowerCase();
    links = links.filter(l =>
      l.text.toLowerCase().includes(f) || l.href.toLowerCase().includes(f)
    );
  }

  // Deduplicate by href
  const seen = new Set();
  links = links.filter(l => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });

  const toVisit = links.slice(0, maxVisit);

  // Step 2: Visit each link
  const results = [];
  let visited = 0;

  for (const link of toVisit) {
    try {
      if (summarize_each) {
        const subPage = await browserOpen({ url: link.href, extract: 'text', timeout: 20, visible: false });
        results.push({
          title: subPage.title || link.text,
          url: link.href,
          text: subPage.success
            ? (subPage.content || '').slice(0, 3000)
            : `[Error: ${subPage.error}]`,
        });
      } else {
        // Just title + URL — faster, uses browser only for main page
        results.push({
          title: link.text || link.href,
          url: link.href,
        });
      }
      visited++;
    } catch (e) {
      results.push({ title: link.text, url: link.href, error: e.message });
    }
  }

  return {
    success: true,
    start_url: mainPage.url,
    main_title: mainPage.title,
    link_filter: link_filter || null,
    total_links_found: links.length,
    total_visited: visited,
    max_links,
    pages: results,
    summary: `Crawled ${mainPage.title} — found ${links.length} links${link_filter ? ` matching "${link_filter}"` : ''}, visited ${visited}.`,
  };
}

// ── Human-like scroll di dalam halaman (untuk mode visible) ──
// Gerak roda mouse bertahap dengan easing + jeda acak, terlihat alami,
// bukan lompatan instan.
async function humanScroll(page, direction = 'down', notches = 5) {
  const sign = direction === 'up' ? -1 : 1;
  try {
    const vp = await page.evaluate(() => ({
      width: window.innerWidth || 1366,
      height: window.innerHeight || 850,
    })).catch(() => ({ width: 1366, height: 850 }));
    const cx = vp.width * 0.5;
    const cy = vp.height * 0.5;
    await moveCursor(page, cx, cy).catch(() => {});
    for (let i = 0; i < notches; i++) {
      await page.mouse.wheel(0, 120 * sign);
      await new Promise(r => setTimeout(r, 80 + Math.random() * 180));
    }
    // settling agar lazy-load sempat termuat
    await page.waitForTimeout(400);
  } catch { /* noop */ }
}

// ── browser_interact: kendalikan browser visible seperti manusia ──
async function browserInteract(args) {
  const {
    url, action, selector, text, submit = false, key,
    direction = 'down', pixels = 600, cursor_label,
    timeout = 20, wait_for_text, label, placeholder,
  } = args;

  const page = await getWatchPage();
  await installCursor(page);

  // Navigasi awal bila URL diberikan dan halaman belum di URL itu.
  if (url) {
    const norm = await normalizeUrl(url);
    if (!norm.valid) return { error: norm.error };
    const here = page.url();
    if (here === 'about:blank' || !here.startsWith(new URL(norm.url).origin)) {
      await cursorLabel(page, `membuka ${new URL(norm.url).hostname}…`);
      try {
        await page.goto(norm.url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 60) * 1000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      } catch (e) {
        return { error: `Gagal membuka ${norm.url}: ${e.message}`, url: norm.url };
      }
    }
  }

  const info = { url: page.url(), title: (await page.title().catch(() => '')) || '' };

  // Helper: cari locator dari selector ATAU teks, sambil glide cursor ke sana.
  const resolveLocator = async () => {
    if (selector) return page.locator(selector).first();
    if (text) return page.getByText(text, { exact: false }).first();
    return null;
  };
  const glideTo = async (locator) => {
    try {
      await locator.hover({ timeout: 8000 });
      return true;
    } catch { return false; }
  };

  switch (action) {
    case 'click': {
      const loc = await resolveLocator();
      if (!loc) return { error: 'click butuh selector atau text' };
      await cursorLabel(page, cursor_label || `klik ${(selector || text || '').slice(0, 40)}`);
      const reached = await glideTo(loc);
      try {
        const bb = await loc.boundingBox({ timeout: 3000 }).catch(() => null);
        if (bb) await glideCursor(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
        await rippleClick(page, bb ? bb.x + bb.width / 2 : 0, bb ? bb.y + bb.height / 2 : 0).catch(() => {});
        await loc.click({ timeout: Math.min(timeout, 60) * 1000 });
        await page.waitForTimeout(500);
        return {
          success: true, action: 'click',
          clicked: selector || text,
          hover_ok: reached,
          page_after: { url: page.url(), title: (await page.title().catch(() => '')) || '' },
        };
      } catch (e) {
        return { error: `Klik "${selector || text}" gagal: ${e.message}` };
      }
    }
    case 'type': {
      let loc = null;
      if (selector) {
        loc = page.locator(selector).first();
      } else if (label) {
        loc = page.getByLabel(label, { exact: false }).first();
      } else if (placeholder) {
        loc = page.getByPlaceholder(placeholder, { exact: false }).first();
      }
      if (!loc) return { error: 'type butuh selector, label, atau placeholder sebagai penanda field' };
      const value = typeof text === 'string' ? text : '';
      await cursorLabel(page, cursor_label || `mengetik di ${(selector || label || placeholder || '').slice(0, 40)}`);
      const reached = await glideTo(loc);
      try {
        await loc.click({ timeout: 5000 });
        await loc.fill(value).catch(async () => {
          await page.keyboard.type(value, { delay: 45 + Math.random() * 55 });
        });
        if (submit) {
          await page.waitForTimeout(250);
          await rippleClick(page, 0, 0).catch(() => {});
          await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(400);
        return { success: true, action: 'type', into: selector || label || placeholder, chars: value.length, submitted: !!submit, hover_ok: reached, page_after: { url: page.url() } };
      } catch (e) {
        return { error: `Gagal mengetik di "${selector || label || placeholder}": ${e.message}` };
      }
    }
    case 'scroll': {
      await humanScroll(page, direction, Math.max(1, Math.min(20, Math.round(pixels / 120))));
      const y = await page.evaluate(() => window.scrollY || 0).catch(() => 0);
      return { success: true, action: 'scroll', direction, scroll_y: y };
    }
    case 'hover': {
      const loc = await resolveLocator();
      if (!loc) return { error: 'hover butuh selector atau text' };
      await cursorLabel(page, cursor_label || `mengarah ke ${(selector || text || '').slice(0, 40)}`);
      const ok = await glideTo(loc);
      return { success: ok, action: 'hover', hovered: selector || text };
    }
    case 'press': {
      const k = key || 'Enter';
      await page.keyboard.press(k);
      await page.waitForTimeout(400);
      return { success: true, action: 'press', key: k, page_after: { url: page.url() } };
    }
    case 'screenshot': {
      await cursorLabel(page, cursor_label || 'mengambil screenshot');
      const b64 = await page.screenshot({ type: 'jpeg', quality: 72 }).then(buf => buf.toString('base64'));
      return { success: true, action: 'screenshot', screenshot_base64: b64, page: info };
    }
    case 'read': {
      const content = await htmlToText(await page.content());
      return {
        success: true, action: 'read', page: info,
        content: (content || '').slice(0, 15000),
        truncated: (content || '').length > 15000,
      };
    }
    case 'extract_links': {
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
        .filter(l => l.href.startsWith('http'))
        .slice(0, 200));
      return { success: true, action: 'extract_links', page: info, count: links.length, links };
    }
    case 'wait': {
      const waitText = wait_for_text || text;
      if (waitText) {
        try {
          await page.getByText(waitText, { exact: false }).first().waitFor({ state: 'visible', timeout: Math.min(timeout, 60) * 1000 });
          return { success: true, action: 'wait', found: waitText, page: info };
        } catch {
          return { error: `Teks "${waitText}" tidak muncul dalam ${timeout}s`, page: info };
        }
      }
      await page.waitForTimeout(500);
      return { success: true, action: 'wait', page: info };
    }
    case 'navigate': {
      return await browserOpenVisible(args);
    }
    case 'snapshot': {
      const els = await page.evaluate(() => {
        const out = [];
        const sel = 'a[href],button,[role="button"],input,select,textarea,[onclick]';
        document.querySelectorAll(sel).forEach((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') return;
          if (r.bottom < 0 || r.top > window.innerHeight + 200) return;
          const txt = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim().slice(0, 70);
          const id = el.id ? `#${el.id}` : '';
          out.push({
            i: out.length,
            tag: el.tagName.toLowerCase(),
            id,
            type: el.type || '',
            text: txt,
            visible: r.top >= 0 && r.bottom <= window.innerHeight,
          });
        });
        return { elements: out.slice(0, 60), scroll_y: window.scrollY, doc_height: document.body.scrollHeight };
      });
      return { success: true, action: 'snapshot', page: info, ...els };
    }
    case 'audit': {
      const navUrl = info.url;
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];
      const onConsole = (m) => { if (m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 200)); };
      const onPageError = (e) => pageErrors.push(String(e.message).slice(0, 200));
      const onRequestFailed = (rq) => failedRequests.push({ url: rq.url().slice(0, 160), error: rq.failure()?.errorText || 'failed' });
      const onResponse = (res) => { if (res.status() >= 400) failedRequests.push({ url: res.url().slice(0, 160), status: res.status() }); };
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      page.on('requestfailed', onRequestFailed);
      page.on('response', onResponse);

      const cleanupAudit = () => {
        try { page.off('console', onConsole); } catch { /* noop */ }
        try { page.off('pageerror', onPageError); } catch { /* noop */ }
        try { page.off('requestfailed', onRequestFailed); } catch { /* noop */ }
        try { page.off('response', onResponse); } catch { /* noop */ }
      };

      const t0 = Date.now();
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 60) * 1000 });
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      } catch (e) {
        cleanupAudit();
        return { error: `Reload gagal saat audit: ${e.message}`, url: navUrl };
      }
      const loadMs = Date.now() - t0;

      const diag = await page.evaluate(() => {
        const imgsBroken = Array.from(document.images).filter(i => !i.complete || (i.naturalWidth === 0 && i.src)).length;
        const totalImgs = document.images.length;
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const badAnchors = anchors.filter(a => {
          const h = (a.getAttribute('href') || '').trim();
          return h === '' || h === '#' || h.toLowerCase().startsWith('javascript:');
        }).length;
        const inputs = Array.from(document.querySelectorAll('input,select,textarea'));
        const noLabel = inputs.filter((el) => {
          if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false;
          if (el.getAttribute('aria-label')) return false;
          if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
          if (el.closest('label')) return false;
          return !el.placeholder && !el.name;
        }).length;
        const pw = document.querySelectorAll('input[type=password]').length;
        const hasHttp = window.location.protocol === 'http:';
        const title = (document.title || '').trim();
        const desc = document.querySelector('meta[name="description"]')?.content || '';
        const h1 = document.querySelectorAll('h1').length;
        const htmlLang = document.documentElement.lang || '';
        return {
          title, desc_len: desc.length, h1_count: h1, html_lang: htmlLang,
          images_total: totalImgs, images_broken: imgsBroken,
          links_total: anchors.length, links_invalid: badAnchors,
          form_inputs: inputs.length, form_inputs_no_label: noLabel, password_fields: pw,
          http_insecure: hasHttp,
          scroll_width: document.documentElement.scrollWidth, viewport_width: window.innerWidth,
        };
      }).catch(e => ({ evaluate_error: e.message }));

      page.off('response', onResponse);
      const mixedContent = [];
      if (navUrl.startsWith('https:')) {
        try {
          const html = await page.content();
          const m = html.match(/(?:src|href)\s*=\s*["']http:\/\/[^"'\s>]+/gi) || [];
          mixedContent.push(...Array.from(new Set(m.map(s => s.slice(s.indexOf('http'))))).slice(0, 5));
        } catch { /* noop */ }
      }

      const findings = [];
      if (consoleErrors.length) findings.push(`${consoleErrors.length} console error(s): "${consoleErrors[0]}"${consoleErrors.length > 1 ? ', dll.' : ''}`);
      if (pageErrors.length) findings.push(`${pageErrors.length} JavaScript error(s) (page crushes): "${pageErrors[0]}"`);
      if (failedRequests.length) findings.push(`${failedRequests.length} request gagal/4xx-5xx (URL pertama: ${failedRequests[0].url})`);
      if (diag.images_broken > 0) findings.push(`${diag.images_broken}/${diag.images_total} gambar rusak`);
      if (diag.links_invalid > 0) findings.push(`${diag.links_invalid} link mati/tanpa tujuan (#, kosong, javascript:)`);
      if (diag.form_inputs_no_label > 0) findings.push(`${diag.form_inputs_no_label} input tanpa label/aria-label (masalah aksesibilitas & autofill)${diag.password_fields ? `, ${diag.password_fields} field password` : ''}`);
      if (diag.http_insecure) findings.push('Situs dijalankan via HTTP tanpa enkripsi');
      if (mixedContent.length) findings.push('Mixed content: sumber http dimuat di halaman https');
      if (loadMs > 5000) findings.push(`Waktu muat lambat: ${(loadMs / 1000).toFixed(1)}s`);
      if (!diag.title) findings.push('Halaman tidak punya <title>');
      if (diag.title && diag.title.length < 15) findings.push(`Title terlalu pendek (${diag.title.length} char): "${diag.title}"`);
      if (diag.h1_count === 0) findings.push('Tidak ada <h1> di halaman (SEO)');
      if (diag.h1_count > 1) findings.push(`${diag.h1_count} <h1> ganda (SEO)`);
      if (!diag.html_lang) findings.push('<html> tanpa atribut lang (SEO/a11y)');
      if (diag.scroll_width > diag.viewport_width + 4) findings.push(`Overflow horizontal: konten ${diag.scroll_width}px > viewport ${diag.viewport_width}px (layout tidak responsif)`);

      return {
        success: true, action: 'audit', url: navUrl, load_ms: loadMs,
        diagnostics: diag,
        console_errors: consoleErrors.slice(0, 10),
        page_errors: pageErrors.slice(0, 5),
        failed_requests: failedRequests.slice(0, 10),
        mixed_content: mixedContent,
        findings,
        summary: `Audit ${diag.title || navUrl}: ${findings.length} temuan — ${findings.slice(0, 3).join('; ') || 'tidak ada masalah berarti terdeteksi'}`,
      };
    }
    default:
      return { error: `Aksi tidak dikenal: ${action}` };
  }
}

export default {
  browserTools,
  executeBrowserTool,
};