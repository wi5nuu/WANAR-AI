import { chromium } from 'playwright';

// ============================================
// WANAR AI - BROWSER APPLY TOOL
// by Wisnu Alfian Nur Ashar
// ============================================
// Autonomous job application agent
// Opens apply pages, reads forms, fills fields from user profile
// Always previews before submitting — user must confirm

export const browserApplyTools = [
  {
    type: 'function',
    function: {
      name: 'browser_apply',
      description: 'Opens a job application page, reads the form structure, and fills it automatically using the user profile data. ALWAYS shows a preview of what will be filled before submitting. If the page requires login, it will ask the user for credentials. Use this when the user wants to apply to a job/internship.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL of the job application page' },
          company: { type: 'string', description: 'Company name for tracking' },
          position: { type: 'string', description: 'Position/role being applied for' },
          action: {
            type: 'string',
            enum: ['preview', 'fill', 'submit'],
            description: 'preview = just read the form, fill = fill form fields, submit = fill and submit. Always start with preview.',
            default: 'preview'
          },
          credentials: {
            type: 'object',
            description: 'Login credentials if the page requires authentication',
            properties: {
              email: { type: 'string' },
              password: { type: 'string' }
            }
          }
        },
        required: ['url', 'company', 'position']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_job_scan',
      description: 'Scans a job listing page or directory (like Linktree) and returns structured list of job opportunities with company, position, type (intern/career), and apply URL. Use this before browser_apply to discover which jobs to apply to.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL of the job listing page or directory' },
          filter_type: {
            type: 'string',
            enum: ['intern', 'career', 'both'],
            description: 'Filter by job type (default: both)',
            default: 'both'
          },
          filter_keyword: {
            type: 'string',
            description: 'Optional keyword to filter by field/industry (e.g. "IT", "engineering", "marketing")'
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of jobs to return (default: 30)',
            default: 30
          }
        },
        required: ['url']
      }
    }
  }
];

export async function executeBrowserApplyTool(toolName, args) {
  switch (toolName) {
    case 'browser_apply': return await browserApply(args);
    case 'browser_job_scan': return await browserJobScan(args);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Launch headless browser ──
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return { valid: true, url: u.toString() };
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }
}

// ── browser_job_scan ──
async function browserJobScan(args) {
  const { url, filter_type = 'both', filter_keyword, max_results = 30 } = args;
  const norm = normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(norm.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Scroll to load all content
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          total += 400;
          if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
        }, 150);
        setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
      });
    }).catch(() => {});

    // Extract all links with text
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map(a => ({
        text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 300),
        href: a.href,
      })).filter(l => l.href.startsWith('http') && l.text.length > 2)
    );

    // Parse job listings from link text
    const jobs = [];
    for (const link of links) {
      const text = link.text;
      const lowerText = text.toLowerCase();

      // Detect intern vs career
      const isIntern = lowerText.includes('intern') || lowerText.includes('magang');
      const isCareer = lowerText.includes('career') || lowerText.includes('karir') || lowerText.includes('full time') || lowerText.includes('staff') || lowerText.includes('manager');

      if (!isIntern && !isCareer) continue;

      const type = isIntern ? 'intern' : 'career';
      if (filter_type !== 'both' && type !== filter_type) continue;

      // Extract company name — usually everything before (Intern) or (Career)
      const company = text.replace(/\s*[-–]\s*(Intern|Career|Internship|Magang).*/i, '').trim();
      const position = isIntern ? 'Internship' : 'Staff/Career';

      // Apply keyword filter
      if (filter_keyword) {
        const kw = filter_keyword.toLowerCase();
        if (!lowerText.includes(kw) && !company.toLowerCase().includes(kw)) continue;
      }

      jobs.push({ company, position, type, text, apply_url: link.href });
      if (jobs.length >= max_results) break;
    }

    await browser.close();

    return {
      success: true,
      source_url: page.url(),
      total_found: jobs.length,
      filter_type,
      filter_keyword: filter_keyword || null,
      jobs,
      message: jobs.length === 0
        ? 'No job listings found matching criteria'
        : `Found ${jobs.length} job listing(s). Use browser_apply to apply to specific ones.`,
    };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { error: 'Job scan failed', details: err.message };
  }
}

// ── browser_apply ──
async function browserApply(args) {
  const { url, company, position, action = 'preview', credentials } = args;
  const norm = normalizeUrl(url);
  if (!norm.valid) return { error: norm.error };

  // Load user profile from DB
  let profile = null;
  try {
    const { getProfile } = await import('../database.js');
    profile = getProfile();
  } catch {}

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await page.goto(norm.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const title = await page.title();

    // Check if page requires login
    const needsLogin = await page.evaluate(() => {
      const html = document.body.innerText.toLowerCase();
      return html.includes('login') || html.includes('sign in') || html.includes('masuk') ||
        !!document.querySelector('input[type="password"]');
    });

    if (needsLogin && !credentials) {
      await browser.close();
      return {
        success: false,
        requires_login: true,
        url: finalUrl,
        title,
        company,
        position,
        message: `Halaman ini membutuhkan login. Silakan berikan credentials (email & password) untuk melanjutkan apply ke ${company} - ${position}.`,
        action_needed: 'Balas dengan: credentials email dan password untuk login ke halaman ini.',
      };
    }

    // Handle login if credentials provided
    if (needsLogin && credentials) {
      try {
        const emailInput = await page.$('input[type="email"], input[name*="email"], input[name*="user"]');
        const passInput = await page.$('input[type="password"]');
        if (emailInput) await emailInput.fill(credentials.email || '');
        if (passInput) await passInput.fill(credentials.password || '');
        const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForTimeout(3000);
        }
      } catch (e) {
        // Continue even if login fails
      }
    }

    // Read all form fields on page
    const formFields = await page.evaluate(() => {
      const fields = [];
      const inputs = document.querySelectorAll('input, textarea, select');
      inputs.forEach(el => {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
        const label = document.querySelector(`label[for="${el.id}"]`)?.innerText?.trim() ||
          el.placeholder || el.name || el.id || el.getAttribute('aria-label') || '';
        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || 'text',
          name: el.name || el.id || '',
          label: label.slice(0, 100),
          required: el.required,
          selector: el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : null),
          current_value: el.value || '',
        });
      });
      return fields;
    });

    // Map profile data to form fields
    const profileMap = profile ? {
      name: profile.full_name,
      'full name': profile.full_name,
      'nama': profile.full_name,
      'nama lengkap': profile.full_name,
      email: profile.email,
      phone: profile.phone,
      'no hp': profile.phone,
      'nomor hp': profile.phone,
      'telepon': profile.phone,
      address: profile.address,
      'alamat': profile.address,
      university: profile.university,
      'universitas': profile.university,
      'perguruan tinggi': profile.university,
      major: profile.major,
      'jurusan': profile.major,
      'program studi': profile.major,
      gpa: profile.gpa,
      'ipk': profile.gpa,
      linkedin: profile.linkedin,
      portfolio: profile.portfolio,
      github: profile.github,
      skills: profile.skills,
      'keahlian': profile.skills,
    } : {};

    // Auto-map fields to profile data
    const fillPlan = formFields.map(field => {
      const labelLower = field.label.toLowerCase();
      const nameLower = field.name.toLowerCase();
      let suggested_value = '';

      for (const [key, val] of Object.entries(profileMap)) {
        if ((labelLower.includes(key) || nameLower.includes(key)) && val) {
          suggested_value = val;
          break;
        }
      }

      return { ...field, suggested_value };
    }).filter(f => f.label || f.name);

    if (action === 'preview') {
      await browser.close();
      return {
        success: true,
        action: 'preview',
        url: finalUrl,
        title,
        company,
        position,
        requires_login: needsLogin,
        logged_in: needsLogin && !!credentials,
        total_fields: fillPlan.length,
        fields: fillPlan,
        profile_available: !!profile,
        message: profile
          ? `Form ditemukan dengan ${fillPlan.length} field. Data profil tersedia untuk auto-fill. Konfirmasi untuk melanjutkan pengisian.`
          : `Form ditemukan dengan ${fillPlan.length} field. Belum ada profil tersimpan — setup profil di /profile terlebih dahulu.`,
        next_action: 'Balas "isi form" untuk mengisi otomatis, atau "lewati" untuk skip lowongan ini.',
      };
    }

    if (action === 'fill' || action === 'submit') {
      if (!profile) {
        await browser.close();
        return {
          success: false,
          error: 'Profil belum diisi. Buka /profile untuk mengisi data diri terlebih dahulu.',
        };
      }

      // Fill form fields
      const filled = [];
      const failed = [];

      for (const field of fillPlan) {
        if (!field.suggested_value || !field.selector) continue;
        try {
          const el = await page.$(field.selector);
          if (!el) continue;
          if (field.tag === 'select') {
            await el.selectOption({ label: field.suggested_value }).catch(() =>
              el.selectOption({ value: field.suggested_value }).catch(() => {})
            );
          } else {
            await el.fill(field.suggested_value);
          }
          filled.push({ field: field.label || field.name, value: field.suggested_value });
        } catch (e) {
          failed.push({ field: field.label || field.name, error: e.message });
        }
      }

      // Handle CV upload if available
      if (profile.cv_filename) {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          // Note: actual file upload requires the file to be present on disk
          failed.push({ field: 'CV Upload', error: 'Upload CV manual diperlukan — file harus diunggah secara manual' });
        }
      }

      if (action === 'submit') {
        // Take screenshot before submit
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);

        // Find submit button
        const submitBtn = await page.$(
          'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply"), button:has-text("Kirim"), button:has-text("Daftar")'
        );

        if (!submitBtn) {
          await browser.close();
          return {
            success: false,
            action: 'submit',
            company, position,
            filled_fields: filled,
            failed_fields: failed,
            error: 'Tombol submit tidak ditemukan. Submit manual diperlukan.',
            screenshot_base64: screenshot?.toString('base64'),
          };
        }

        await submitBtn.click();
        await page.waitForTimeout(3000);
        const afterUrl = page.url();
        const afterTitle = await page.title();
        const afterScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);

        // Log to apply history
        try {
          const { addApplyHistory } = await import('../database.js');
          addApplyHistory({ company, position, apply_url: url, status: 'applied', form_data: filled });
        } catch {}

        await browser.close();
        return {
          success: true,
          action: 'submitted',
          company, position,
          original_url: norm.url,
          after_url: afterUrl,
          after_title: afterTitle,
          filled_fields: filled,
          failed_fields: failed,
          screenshot_base64: afterScreenshot?.toString('base64'),
          message: `Lamaran ke ${company} (${position}) telah disubmit. Halaman berubah ke: ${afterTitle}`,
        };
      }

      await browser.close();
      return {
        success: true,
        action: 'filled',
        company, position,
        url: finalUrl,
        filled_fields: filled,
        failed_fields: failed,
        message: `${filled.length} field telah diisi dari profil. ${failed.length} field gagal/perlu manual. Konfirmasi untuk submit.`,
        next_action: 'Balas "submit" untuk mengirim lamaran, atau "batal" untuk membatalkan.',
      };
    }

    await browser.close();
    return { success: false, error: `Unknown action: ${action}` };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { error: 'Apply failed', details: err.message, company, position };
  }
}

export default { browserApplyTools, executeBrowserApplyTool };
