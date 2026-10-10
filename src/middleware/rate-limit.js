import coordinator from '../distributed.js';

const localCounters = new Map();

/**
 * Derives the rate-limit bucket key.
 *
 * Deliberately uses `req.ip`, NOT the raw `x-forwarded-for` header. A client can
 * send any value it likes in that header, so trusting it directly lets an
 * attacker rotate the value per request and bypass every limit. `req.ip`
 * honours the `trust proxy` setting, so it is only influenced by a proxy we
 * have explicitly declared as trusted.
 */
function defaultKeyGenerator(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function distributedRateLimit(options = {}) {
  const {
    windowMs = 60000,
    max = 100,
    keyGenerator = defaultKeyGenerator,
    message = 'Too many requests. Please slow down.',
    statusCode = 429,
    skip = () => false,
    standardHeaders = true,
  } = options;

  return async (req, res, next) => {
    if (skip(req, res)) return next();

    const key = `${options.name || 'global'}:${keyGenerator(req)}`;
    const result = await coordinator.checkRateLimit(key, max, windowMs);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetIn / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.ceil(result.resetIn / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(statusCode).json({
        success: false,
        error: message,
        retryAfter,
        distributed: result.distributed,
      });
    }

    next();
  };
}

export function createRateLimiters() {
  return {
    global: distributedRateLimit({
      name: 'global',
      windowMs: 60 * 1000,
      max: 120,
      message: 'Terlalu banyak request. Silakan tunggu.',
    }),

    chat: distributedRateLimit({
      name: 'chat',
      windowMs: 60 * 1000,
      max: 40,
      message: 'Rate limit chat tercapai. Maks 40 request/menit.',
    }),

    rag: distributedRateLimit({
      name: 'rag',
      windowMs: 60 * 1000,
      max: 30,
      message: 'Rate limit RAG tercapai. Maks 30 query/menit.',
    }),

    auth: distributedRateLimit({
      name: 'auth',
      windowMs: 60 * 1000,
      max: 10,
      message: 'Rate limit auth tercapai. Maks 10 percobaan/menit.',
    }),

    strict: distributedRateLimit({
      name: 'strict',
      windowMs: 60 * 1000,
      max: 5,
      message: 'Too many attempts. Please try again later.',
    }),
  };
}

export function clearRateLimiters() {
  localCounters.clear();
}
