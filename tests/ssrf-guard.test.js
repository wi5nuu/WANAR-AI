/**
 * Test Suite: security/ssrf-guard.js
 *
 * SSRF is the highest-signal class of bug in an agent platform, because the
 * agent fetches URLs supplied by a model that may itself be steered by
 * untrusted content. These tests pin the bypasses that naive filters miss.
 */

import { describe, it, expect } from 'vitest';
import {
  checkUrlShape,
  checkOutboundUrl,
  classifyUnsafeIp,
  SsrfBlockedError,
} from '../src/security/ssrf-guard.js';

describe('ssrf-guard: IP classification', () => {
  it('flags loopback, private, link-local and metadata space', () => {
    expect(classifyUnsafeIp('127.0.0.1')).toBe('loopback');
    expect(classifyUnsafeIp('127.1.2.3')).toBe('loopback');
    expect(classifyUnsafeIp('10.0.0.1')).toBe('private');
    expect(classifyUnsafeIp('172.16.0.1')).toBe('private');
    expect(classifyUnsafeIp('172.31.255.255')).toBe('private');
    expect(classifyUnsafeIp('192.168.1.1')).toBe('private');
    expect(classifyUnsafeIp('169.254.169.254')).toBe('link-local');
    expect(classifyUnsafeIp('0.0.0.0')).toBe('unspecified');
    expect(classifyUnsafeIp('100.64.0.1')).toBe('carrier-grade-nat');
    expect(classifyUnsafeIp('::1')).toBe('loopback');
    expect(classifyUnsafeIp('fd00::1')).toBe('unique-local');
    expect(classifyUnsafeIp('fe80::1')).toBe('link-local');
  });

  it('treats public addresses as safe', () => {
    expect(classifyUnsafeIp('8.8.8.8')).toBeNull();
    expect(classifyUnsafeIp('1.1.1.1')).toBeNull();
    expect(classifyUnsafeIp('172.32.0.1')).toBeNull(); // just outside 172.16/12
    expect(classifyUnsafeIp('2606:4700::1111')).toBeNull();
  });

  it('sees through IPv4-mapped IPv6 in BOTH notations', () => {
    // Dotted form. A filter that only greps for "127.0.0.1" would catch this.
    expect(classifyUnsafeIp('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyUnsafeIp('::ffff:169.254.169.254')).toBe('link-local');
    // Hex form — this is what `new URL()` normalizes [::ffff:127.0.0.1] into,
    // and what a naive dotted-quad check silently misses.
    expect(classifyUnsafeIp('::ffff:7f00:1')).toBe('loopback');
    expect(classifyUnsafeIp('::ffff:a9fe:a9fe')).toBe('link-local');
    expect(classifyUnsafeIp('::ffff:a00:1')).toBe('private');
  });

  it('handles a zone index', () => {
    expect(classifyUnsafeIp('fe80::1%eth0')).toBe('link-local');
  });

  it('rejects malformed input', () => {
    expect(classifyUnsafeIp('not-an-ip')).toBe('invalid_address');
    expect(classifyUnsafeIp('')).toBe('invalid_address');
    expect(classifyUnsafeIp(null)).toBe('invalid_address');
  });
});

describe('ssrf-guard: URL shape', () => {
  it('only permits http and https', () => {
    expect(checkUrlShape('https://example.com').ok).toBe(true);
    expect(checkUrlShape('http://example.com').ok).toBe(true);
    for (const bad of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/html,x', 'javascript:alert(1)']) {
      expect(checkUrlShape(bad).ok, bad).toBe(false);
    }
  });

  it('only checks syntax/scheme; destination judgment belongs to checkOutboundUrl', () => {
    // checkUrlShape must not reject private IPs on its own, because the caller
    // may legitimately have opted into private-network access. Confirming this
    // prevents the allowPrivate escape hatch from being silently dead.
    expect(checkUrlShape('http://127.0.0.1:9222/json').ok).toBe(true);
    expect(checkUrlShape('http://169.254.169.254/').ok).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(checkUrlShape('not a url').ok).toBe(false);
    expect(checkUrlShape('').ok).toBe(false);
  });
});

describe('ssrf-guard: end-to-end checks', () => {
  it('blocks the AWS/GCP metadata endpoint', async () => {
    const r = await checkOutboundUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    expect(r.allowed).toBe(false);
  });

  it('blocks the internal CDP debug port', async () => {
    const r = await checkOutboundUrl('http://127.0.0.1:9222/json/version');
    expect(r.allowed).toBe(false);
  });

  it('blocks a userinfo-smuggled metadata address', async () => {
    // The host is 169.254.169.254; "example.com" is merely the username.
    const r = await checkOutboundUrl('http://example.com@169.254.169.254/');
    expect(r.allowed).toBe(false);
  });

  it('allows a public host whose username merely looks like an IP', async () => {
    // Here the real host IS example.com, so this is not an SSRF.
    const r = await checkOutboundUrl('http://169.254.169.254@example.com/');
    expect(r.allowed).toBe(true);
  });

  it('blocks every IPv4-mapped IPv6 smuggling variant', async () => {
    for (const u of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::ffff:10.0.0.1]/',
    ]) {
      const r = await checkOutboundUrl(u);
      expect(r.allowed, u).toBe(false);
    }
  });

  it('blocks localhost written in several ways', async () => {
    for (const u of ['http://localhost/', 'http://LOCALHOST/', 'http://localhost./', 'http://127.1/']) {
      const r = await checkOutboundUrl(u);
      expect(r.allowed, u).toBe(false);
    }
  });

  it('catches a literal private IP without needing DNS', async () => {
    expect((await checkOutboundUrl('http://127.0.0.1:9222/json')).allowed).toBe(false);
    expect((await checkOutboundUrl('http://169.254.169.254/latest/meta-data/')).allowed).toBe(false);
  });

  it('blocks cloud metadata hostnames unconditionally', async () => {
    for (const u of ['http://metadata.google.internal/', 'http://metadata.goog/']) {
      expect((await checkOutboundUrl(u)).allowed, u).toBe(false);
    }
  });

  it('honours the allowPrivate escape hatch for operators who need it', async () => {
    const r = await checkOutboundUrl('http://127.0.0.1:9222/json', { allowPrivate: true });
    expect(r.allowed).toBe(true);
  });

  it('still blocks metadata even when allowPrivate is set', async () => {
    // Private-network access must never become a route to cloud credentials.
    const r = await checkOutboundUrl('http://metadata.google.internal/', { allowPrivate: true });
    expect(r.allowed).toBe(false);
  });
});

describe('ssrf-guard: error type', () => {
  it('exposes a distinguishable error code', () => {
    const err = new SsrfBlockedError('loopback', 'http://127.0.0.1/');
    expect(err.code).toBe('SSRF_BLOCKED');
    expect(err.reason).toBe('loopback');
    expect(err).toBeInstanceOf(Error);
  });
});
