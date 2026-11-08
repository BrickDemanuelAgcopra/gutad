import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_WEB_URL: z.string().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  ADMIN_EMAIL: z.string().default('admin@gutad.io'),
  ADMIN_PASSWORD: z.string().default('admin12345'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
  DELIVERY_PROVIDER: z.enum(['mock', 'doordash', 'uber']).default('mock'),
  DOORDASH_DEVELOPER_ID: z.string().optional().default(''),
  DOORDASH_KEY_ID: z.string().optional().default(''),
  DOORDASH_SIGNING_SECRET: z.string().optional().default(''),
  UBER_CUSTOMER_ID: z.string().optional().default(''),
  UBER_CLIENT_ID: z.string().optional().default(''),
  UBER_CLIENT_SECRET: z.string().optional().default(''),
  SMS_PROVIDER: z.enum(['log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_FROM: z.string().optional().default(''),
  EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('no-reply@gutad.io'),
  EXPO_ACCESS_TOKEN: z.string().optional().default(''),
  GEOCODER_PROVIDER: z.enum(['mock', 'google']).default('mock'),
  GOOGLE_MAPS_API_KEY: z.string().optional().default(''),
  DEFAULT_MARKETPLACE_COMMISSION_BPS: z.coerce.number().default(1500),
  DEFAULT_DIRECT_PROCESSING_BPS: z.coerce.number().default(295),
  DEFAULT_DIRECT_PROCESSING_FIXED_CENTS: z.coerce.number().default(29),
  DEFAULT_COVER_FEE_CENTS: z.coerce.number().default(150),
  DEFAULT_PREPAID_EXPERIENCE_FEE_BPS: z.coerce.number().default(200),
  DEFAULT_CURRENCY: z.string().default('USD'),
  DEFAULT_TIMEZONE: z.string().default('America/New_York'),
  CREDENTIALS_KEY: z.string().optional().default(''),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
  }
  cached = parsed.data;
  return cached;
}

export const config = () => loadConfig();
