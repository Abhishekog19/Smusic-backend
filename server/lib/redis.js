import Redis from 'ioredis';

let redisClient = null;
let redisAvailable = false;

export function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisAvailable ? redisClient : null;

  try {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,        // fail fast per request
      enableReadyCheck: true,
      enableOfflineQueue: false,      // don't queue commands when disconnected
      lazyConnect: true,              // don't auto-connect on creation
      connectTimeout: 3000,
      // Stop retrying after 3 attempts (~6s total)
      retryStrategy: (times) => {
        if (times >= 3) {
          redisAvailable = false;
          return null; // stop retrying
        }
        return Math.min(times * 500, 2000);
      },
    });

    redisClient.on('error', () => {
      // Silently mark as unavailable — don't crash the process
      redisAvailable = false;
    });

    redisClient.on('ready', () => {
      redisAvailable = true;
      console.log('✅ Redis connected');
    });

    // Try connecting once — if it fails, we silently skip caching
    redisClient.connect().catch(() => {
      redisAvailable = false;
      console.log('ℹ️  Redis not available — caching disabled');
    });

    return null; // Return null until 'ready' fires
  } catch (err) {
    console.error('Failed to create Redis client:', err.message);
    return null;
  }
}

export async function closeRedis() {
  if (redisClient) {
    await redisClient.quit().catch(() => {});
    redisClient = null;
    redisAvailable = false;
  }
}
