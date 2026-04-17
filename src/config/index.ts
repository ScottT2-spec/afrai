import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url().default('postgresql://localhost:5432/afrai'),
  REDIS_URL: z.string().default('memory'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_KEY_SALT: z.string().min(16).default('afrai-dev-salt-change-me-in-prod'),
  // Provider API keys (all optional — only configured providers are registered)
  GROQ_API_KEY: z.string().optional(),
  SAMBANOVA_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  // MTN MoMo (optional — payment system only active when configured)
  MOMO_SUBSCRIPTION_KEY: z.string().optional(),
  MOMO_API_USER_ID: z.string().optional(),
  MOMO_API_KEY: z.string().optional(),
  MOMO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  MOMO_CURRENCY: z.string().default('GHS'),
  MOMO_CALLBACK_URL: z.string().optional(),
  // Google OAuth2 (optional — Google sign-in only active when configured)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  FRONTEND_URL: z.string().default('https://afrai.vercel.app'),
  // SMTP Email (Gmail) — for OTP verification emails
  SMTP_EMAIL: z.string().optional(),
  SMTP_APP_PASSWORD: z.string().optional(),
  // Connection pool tuning
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
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

/** Alias used by server.ts and other modules */
export function getConfig(): EnvConfig {
  return config;
}
