import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url().default('postgresql://localhost:5432/afrai'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_KEY_SALT: z.string().min(16).default('afrai-dev-salt-change-me-in-prod'),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    console.error('❌ Invalid environment configuration:', formatted);
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}

export const config: EnvConfig = loadConfig();
