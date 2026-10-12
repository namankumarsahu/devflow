import 'dotenv/config';

const get = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';
const DEV_JWT = 'dev-secret-change-me';
const DEV_KEY = '0'.repeat(64);

export const config = {
  isProd,
  port: Number(get('PORT', '4000')),
  jwtSecret: get('JWT_SECRET', DEV_JWT),
  encryptionKey: get('ENCRYPTION_KEY', DEV_KEY), // 32 bytes, hex encoded
  redisUrl: get('REDIS_URL', 'redis://localhost:6379'),
  publicHost: get('PUBLIC_HOST', 'localhost'),
  workDir: get('WORK_DIR', '/tmp/devflow-builds'),
  corsOrigin: get('CORS_ORIGIN', 'http://localhost:5173'),
  buildTimeoutMs: Number(get('BUILD_TIMEOUT_MS', String(15 * 60 * 1000))),
};

if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
  throw new Error('ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)');
}
if (isProd && (config.jwtSecret === DEV_JWT || config.encryptionKey === DEV_KEY)) {
  throw new Error('Refusing to start in production with default secrets');
}
