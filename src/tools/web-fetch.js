import axios from 'axios';
import { convert } from 'html-to-text';

// ============================================
// WANAR AI - WEB FETCH TOOL
// by Wisnu Alfian Nur Ashar
// ============================================
// Fetch content from URLs for research and external data

export const webFetchTools = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetches content from a specified URL. Takes a URL and optional format as input. Fetches the URL content, converts to requested format (markdown by default). Returns the content in the specified format. Use this tool when you need to retrieve and analyze web content.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch content from (must be fully-formed valid URL)'
          },
          format: {
            type: 'string',
            enum: ['text', 'markdown', 'html'],
            description: 'The format to return the content in (text, markdown, or html). Defaults to text.',
            default: 'text'
          },
          timeout: {
            type: 'number',
            description: 'Optional timeout in seconds (max 120)',
            maximum: 120,
            minimum: 1
          },
          follow_redirects: {
            type: 'boolean',
            description: 'Whether to follow redirects (default: true)',
            default: true
          }
        },
        required: ['url']
      }
    }
  }
];

export async function executeWebFetchTool(toolName, args) {
  if (toolName === 'web_fetch') {
    return await webFetch(args);
  }
  return { error: `Unknown web fetch tool: ${toolName}` };
}

// ── WebFetch Implementation ──
async function webFetch(args) {
  const { 
    url, 
    format = 'text', 
    timeout = 30, 
    follow_redirects = true 
  } = args;

  // Validate URL
  let validUrl;
  try {
    validUrl = new URL(url);
    // Upgrade HTTP to HTTPS
    if (validUrl.protocol === 'http:') {
      validUrl.protocol = 'https:';
    }
  } catch (error) {
    return { 
      error: 'Invalid URL provided',
      details: error.message 
    };
  }

  try {
    // Fetch content
    const response = await axios({
      method: 'GET',
      url: validUrl.toString(),
      timeout: timeout * 1000,
      maxRedirects: follow_redirects ? 5 : 0,
      validateStatus: (status) => status < 500, // Accept redirects and client errors
      headers: {
        'User-Agent': 'Wanar-AI/1.0.1 (Research Bot)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive'
      }
    });

    // Handle redirects to different hosts
    if (response.status >= 300 && response.status < 400) {
      const redirectUrl = response.headers.location;
      if (redirectUrl) {
        try {
          const redirectHost = new URL(redirectUrl, validUrl).host;
          if (redirectHost !== validUrl.host) {
            return {
              status: 'redirect',
              message: `Content redirected to different host: ${redirectUrl}`,
              redirect_url: redirectUrl,
              suggestion: `Make a new web_fetch request with URL: ${redirectUrl}`
            };
          }
        } catch (e) {
          // Continue with current response
        }
      }
    }

    // Check status
    if (response.status >= 400) {
      return {
        error: `HTTP ${response.status}: ${response.statusText}`,
        url: validUrl.toString(),
        status: response.status
      };
    }

    const contentType = response.headers['content-type'] || '';
    let content = response.data;

    // Process based on format
    if (format === 'html') {
      return {
        success: true,
        url: validUrl.toString(),
        content: content,
        content_type: contentType,
        status: response.status,
        size: content.length
      };
    }

    if (format === 'text' || format === 'markdown') {
      // Convert HTML to text
      if (contentType.includes('text/html')) {
        const textOptions = {
          wordwrap: 130,
          preserveNewlines: true,
          selectors: [
            { selector: 'a', options: { ignoreHref: false } },
            { selector: 'img', format: 'skip' },
            { selector: 'script', format: 'skip' },
            { selector: 'style', format: 'skip' },
            { selector: 'nav', format: 'skip' },
            { selector: 'footer', format: 'skip' }
          ]
        };

        try {
          content = convert(content, textOptions);
        } catch (conversionError) {
          console.error('HTML conversion error:', conversionError);
          // Fallback: strip basic HTML tags
          content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
          content = content.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
          content = content.replace(/<[^>]+>/g, '');
        }
      }

      // Trim excessive whitespace
      content = content.replace(/\n{3,}/g, '\n\n').trim();

      // Check if content is too large
      const maxSize = 100000; // 100KB
      let truncated = false;
      if (content.length > maxSize) {
        content = content.substring(0, maxSize);
        truncated = true;
      }

      return {
        success: true,
        url: validUrl.toString(),
        content: content,
        content_type: contentType,
        status: response.status,
        size: content.length,
        truncated,
        note: truncated ? 'Content was truncated due to size limits' : undefined
      };
    }

    return {
      error: 'Invalid format specified',
      valid_formats: ['text', 'markdown', 'html']
    };

  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      return {
        error: 'Request timeout',
        details: `Request exceeded ${timeout} seconds`,
        url: validUrl.toString()
      };
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return {
        error: 'Connection failed',
        details: 'Could not connect to the server. Check if the URL is correct.',
        url: validUrl.toString()
      };
    }

    if (error.response) {
      return {
        error: `HTTP ${error.response.status}: ${error.response.statusText}`,
        url: validUrl.toString(),
        status: error.response.status
      };
    }

    return {
      error: 'Web fetch failed',
      details: error.message,
      url: validUrl.toString()
    };
  }
}

export default {
  webFetchTools,
  executeWebFetchTool
};
