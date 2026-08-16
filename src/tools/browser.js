import { chromium } from 'playwright';
import { convert } from 'html-to-text';

// ============================================
// WANAR AI - BROWSER AGENT TOOL
// by Wisnu Alfian Nur Ashar
// ============================================
// Deep browser automation for scraping & research
// Uses Playwright Chromium for full JS rendering

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
  }
];

export async function executeBrowserTool(toolName, args) {
  switch (toolName) {
    case 'browser_open': return await browserOpen(args);
    case 'browser_search_page': return await browserSearchPage(args);
    case 'browser_extract_links': return await browserExtractLinks(args);
    case 'browser_crawl': return await browserCrawl(args);
    default: return { error: `Unknown browser tool: ${toolName}` };
  }
}

// ── Shared browser launcher ──
async function launchBrowser() {
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
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return { valid: true, url: u.toString() };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
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

// ── browser_open ──
async function browserOpen(args) {
  const { url, extract = 'text', wait_for, timeout = 30, scroll = false } = args;

  const norm = normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'id-ID,id;q=0.9,en-US;q=0.8',
    });
    const page = await context.newPage();

    // Navigate
    await page.goto(norm.url, {
      timeout: timeout * 1000,
      waitUntil: 'domcontentloaded',
    });

    // Wait for selector or networkidle
    if (wait_for) {
      if (wait_for === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout: timeout * 1000 }).catch(() => {});
      } else {
        await page.waitForSelector(wait_for, { timeout: 10000 }).catch(() => {});
      }
    } else {
      // Default: wait a bit for JS to render
      await page.waitForTimeout(1500);
    }

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
      }).catch(() => {});
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => '');

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
      };
    }

    await browser.close();
    return result;

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
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

  const norm = normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };
  if (!query) return { error: 'query is required' };

  // Get page text via browserOpen
  const page = await browserOpen({ url: norm.url, extract: 'text', timeout: 30 });
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

  const norm = normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  const page = await browserOpen({ url: norm.url, extract: 'links', timeout: 30 });
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

  const norm = normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  const maxVisit = Math.min(max_links, 50);

  // Step 1: Open main page and get all links
  const mainPage = await browserOpen({ url: norm.url, extract: 'links', timeout: 30, scroll: true });
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
        const subPage = await browserOpen({ url: link.href, extract: 'text', timeout: 20 });
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

export default {
  browserTools,
  executeBrowserTool,
};
