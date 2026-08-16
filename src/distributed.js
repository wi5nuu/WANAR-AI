import crypto from 'crypto';
import config from '../config/config.js';

const REDIS_URL = process.env.REDIS_URL || '';
const INSTANCE_ID = `wanar_${crypto.randomBytes(4).toString('hex')}`;
const HEARTBEAT_INTERVAL = 10000;
const INSTANCE_TTL = 30;

let redis = null;
let redisAvailable = false;
let pubClient = null;
let subClient = null;
let heartbeatTimer = null;
let messageHandlers = new Map();
let instances = new Map();

const localRateLimiters = new Map();
const localCache = new Map();
const localPubSub = new Map();

async function connectRedis() {
  if (!REDIS_URL) {
    console.log('[DISTRIBUTED] No REDIS_URL set, running in standalone mode');
    return false;
  }

  try {
    const { default: IORedis } = await import('ioredis');
    redis = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    pubClient = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });

    subClient = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });

    await Promise.all([redis.connect(), pubClient.connect(), subClient.connect()]);
    await redis.ping();

    redisAvailable = true;
    console.log(`[DISTRIBUTED] Connected to Redis: ${REDIS_URL.replace(/\/\/.*@/, '//***@')}`);
    return true;
  } catch (error) {
    console.log(`[DISTRIBUTED] Redis unavailable (${error.message}), running standalone`);
    redis = null;
    pubClient = null;
    subClient = null;
    redisAvailable = false;
    return false;
  }
}

async function setupPubSub() {
  if (!redisAvailable || !subClient) return;

  try {
    await subClient.subscribe('wanar:cache:invalidate', 'wanar:instances', 'wanar:notify');

    subClient.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        const handlers = messageHandlers.get(channel) || [];

        if (data.target && data.target !== INSTANCE_ID) {
          for (const handler of handlers) handler(data);
        } else if (!data.target) {
          for (const handler of handlers) handler(data);
        }
      } catch { }
    });

    console.log('[DISTRIBUTED] Pub/sub channels subscribed');
  } catch (error) {
    console.error(`[DISTRIBUTED] Pub/sub setup failed: ${error.message}`);
  }
}

async function startHeartbeat() {
  if (!redisAvailable || !redis) return;

  const instanceInfo = {
    id: INSTANCE_ID,
    host: config.server?.host || 'localhost',
    port: config.server?.port || 3000,
    started: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    pid: process.pid,
  };

  const updateHeartbeat = async () => {
    try {
      instanceInfo.lastHeartbeat = new Date().toISOString();
      await redis.setex(`wanar:instance:${INSTANCE_ID}`, INSTANCE_TTL, JSON.stringify(instanceInfo));

      const keys = await redis.keys('wanar:instance:*');
      instances.clear();
      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          const inst = JSON.parse(data);
          if (inst.id !== INSTANCE_ID) instances.set(inst.id, inst);
        }
      }

      const instanceCount = instances.size + 1;
      await redis.setex('wanar:cluster:stats', INSTANCE_TTL, JSON.stringify({
        totalInstances: instanceCount,
        updatedAt: new Date().toISOString(),
      }));
    } catch { }
  };

  await updateHeartbeat();
  heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL);
}

async function publish(channel, data) {
  if (!redisAvailable || !pubClient) return;
  try {
    await pubClient.publish(channel, JSON.stringify({ ...data, source: INSTANCE_ID }));
  } catch { }
}

function onMessage(channel, handler) {
  if (!messageHandlers.has(channel)) messageHandlers.set(channel, []);
  messageHandlers.get(channel).push(handler);

  if (!redisAvailable) {
    localPubSub.set(channel, handler);
  }
}

function notifyLocal(channel, data) {
  const handlers = messageHandlers.get(channel) || [];
  for (const handler of handlers) handler(data);
}

export class DistributedCoordinator {
  constructor() {
    this.instanceId = INSTANCE_ID;
    this.redisAvailable = false;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;

    const connected = await connectRedis();
    this.redisAvailable = redisAvailable;

    if (connected) {
      await setupPubSub();
      await startHeartbeat();
      console.log(`[DISTRIBUTED] Instance ${INSTANCE_ID} initialized with Redis`);
    } else {
      console.log(`[DISTRIBUTED] Instance ${INSTANCE_ID} in standalone mode`);
    }

    return { instanceId: INSTANCE_ID, redisAvailable: connected };
  }

  invalidateCache(key) {
    if (this.redisAvailable) {
      publish('wanar:cache:invalidate', { key, target: 'all' });
    }
    localCache.delete(key);
  }

  broadcast(message) {
    if (this.redisAvailable) {
      publish('wanar:notify', { message, target: 'all' });
    }
    notifyLocal('wanar:notify', { message });
  }

  onCacheInvalidate(handler) {
    onMessage('wanar:cache:invalidate', handler);
  }

  onNotify(handler) {
    onMessage('wanar:notify', handler);
  }

  getInstances() {
    const result = [];
    for (const [id, info] of instances) {
      result.push(info);
    }
    return result;
  }

  getInstanceCount() {
    return instances.size + 1;
  }

  async checkRateLimit(key, maxRequests, windowMs = 60000) {
    if (this.redisAvailable && redis) {
      try {
        const redisKey = `wanar:ratelimit:${key}`;
        const current = await redis.incr(redisKey);
        if (current === 1) await redis.pexpire(redisKey, windowMs);
        const ttl = await redis.pttl(redisKey);
        return {
          allowed: current <= maxRequests,
          current,
          remaining: Math.max(0, maxRequests - current),
          resetIn: ttl,
          distributed: true,
        };
      } catch {
        return this._localRateLimit(key, maxRequests, windowMs);
      }
    }
    return this._localRateLimit(key, maxRequests, windowMs);
  }

  _localRateLimit(key, maxRequests, windowMs) {
    const now = Date.now();
    const entry = localRateLimiters.get(key);

    if (!entry || now - entry.windowStart > windowMs) {
      localRateLimiters.set(key, { windowStart: now, count: 1 });
      return { allowed: true, current: 1, remaining: maxRequests - 1, resetIn: windowMs, distributed: false };
    }

    entry.count++;
    if (entry.count > maxRequests) {
      const elapsed = now - entry.windowStart;
      return { allowed: false, current: entry.count, remaining: 0, resetIn: windowMs - elapsed, distributed: false };
    }

    return { allowed: true, current: entry.count, remaining: maxRequests - entry.count, resetIn: windowMs - (now - entry.windowStart), distributed: false };
  }

  async acquireLock(resource, ttlMs = 10000) {
    if (this.redisAvailable && redis) {
      try {
        const lockKey = `wanar:lock:${resource}`;
        const acquired = await redis.set(lockKey, INSTANCE_ID, 'PX', ttlMs, 'NX');
        return acquired === 'OK';
      } catch {
        return true;
      }
    }
    return true;
  }

  async releaseLock(resource) {
    if (this.redisAvailable && redis) {
      try {
        const lockKey = `wanar:lock:${resource}`;
        await redis.del(lockKey);
      } catch { }
    }
  }

  async shutdown() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    if (redis) {
      try {
        await redis.del(`wanar:instance:${INSTANCE_ID}`);
      } catch { }
    }

    for (const client of [pubClient, subClient, redis]) {
      if (client) {
        try { await client.quit(); } catch { }
      }
    }

    redisAvailable = false;
    console.log('[DISTRIBUTED] Shut down');
  }

  getStats() {
    return {
      instanceId: INSTANCE_ID,
      redisAvailable: this.redisAvailable,
      instances: this.getInstanceCount(),
      instanceList: this.getInstances(),
      redisUrl: REDIS_URL ? 'configured' : 'not set',
    };
  }
}

const coordinator = new DistributedCoordinator();
export default coordinator;
