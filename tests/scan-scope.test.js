/**
 * Test Suite: security/scan-scope.js
 *
 * The scope file is the operator's recorded declaration of which hosts they are
 * authorized to test. These tests pin the properties that make it a meaningful
 * control: hostnames are normalized and validated, authorization is explicit,
 * and removals actually take effect.
 *
 * Tests use a temp scope file so they never touch the real config/scan-scope.json.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `wanar-scope-test-${process.pid}.json`);
process.env.SCAN_SCOPE_FILE = TMP;

const {
  loadScope,
  getAuthorizedHosts,
  authorizeHost,
  revokeHost,
  isAuthorizedInFile,
  isValidHost,
} = await import('../src/security/scan-scope.js');

beforeAll(() => {
  try { fs.unlinkSync(TMP); } catch { /* not present */ }
});

afterAll(() => {
  try { fs.unlinkSync(TMP); } catch { /* not present */ }
});

function reset() {
  try { fs.unlinkSync(TMP); } catch { /* not present */ }
}

describe('scan-scope: hostname validation', () => {
  it('accepts plausible DNS names and IPs', () => {
    for (const h of ['example.com', 'api.example.com', 'localhost', '192.168.1.5', 'a-b.example.co.id']) {
      expect(isValidHost(h), h).toBe(true);
    }
  });

  it('rejects junk, empty values and malformed labels', () => {
    for (const h of ['', '   ', 'not a host', '-bad.com', 'bad-.com', 'nodot', 'x'.repeat(300)]) {
      expect(isValidHost(h), h).toBe(false);
    }
  });
});

describe('scan-scope: authorization lifecycle', () => {
  it('starts empty', () => {
    reset();
    expect(getAuthorizedHosts()).toEqual([]);
  });

  it('adds a host and records who/when/why', () => {
    reset();
    const res = authorizeHost('Example.COM', { reason: 'my staging', addedBy: 'tester' });
    expect(res.success).toBe(true);
    expect(res.entry.host).toBe('example.com'); // normalized
    expect(res.entry.reason).toBe('my staging');
    expect(res.entry.addedBy).toBe('tester');
    expect(res.entry.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('normalizes URLs and ports down to a bare hostname', () => {
    reset();
    expect(authorizeHost('https://Example.com:8443/path?q=1').entry.host).toBe('example.com');
  });

  it('refuses duplicates rather than silently double-adding', () => {
    reset();
    authorizeHost('example.com');
    const again = authorizeHost('EXAMPLE.com');
    expect(again.success).toBe(false);
    expect(getAuthorizedHosts()).toEqual(['example.com']);
  });

  it('refuses invalid hostnames', () => {
    reset();
    const res = authorizeHost('not a host');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not a valid hostname/i);
    expect(getAuthorizedHosts()).toEqual([]);
  });

  it('persists across reloads', () => {
    reset();
    authorizeHost('a.example.com');
    authorizeHost('b.example.com');
    expect(loadScope().hosts).toHaveLength(2);
    expect(getAuthorizedHosts().sort()).toEqual(['a.example.com', 'b.example.com']);
  });

  it('revokes a host', () => {
    reset();
    authorizeHost('gone.example.com');
    expect(revokeHost('gone.example.com').success).toBe(true);
    expect(getAuthorizedHosts()).toEqual([]);
  });

  it('reports an error when revoking something not present', () => {
    reset();
    expect(revokeHost('never-added.example.com').success).toBe(false);
  });

  it('isAuthorizedInFile reflects the file exactly', () => {
    reset();
    authorizeHost('known.example.com');
    expect(isAuthorizedInFile('known.example.com')).toBe(true);
    expect(isAuthorizedInFile('unknown.example.com')).toBe(false);
  });

  it('a corrupt scope file fails closed (no hosts)', () => {
    fs.mkdirSync(path.dirname(TMP), { recursive: true });
    fs.writeFileSync(TMP, '{ this is not json');
    expect(getAuthorizedHosts()).toEqual([]);
  });
});
