/**
 * 設定値（環境変数から読み込み）
 */

export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // DEV-ONLY defaults — all secrets come from env vars in any real deployment.
  const jwtSecret = env.JWT_SECRET ?? 'dev-insecure-secret-change-me';
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  return {
    port,
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/employee_management',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '30m', // session TTL (basic design §9)
  };
}
