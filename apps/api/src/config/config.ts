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
  /** 18.9-S publishable key for Stripe Elements / hosted fields (optional; without it clients use the hosted setup page) */
  STRIPE_PUBLISHABLE_KEY: z.string().optional().default(''),
  DELIVERY_PROVIDER: z.enum(['mock', 'doordash', 'uber']).default('mock'),
  DOORDASH_DEVELOPER_ID: z.string().optional().default(''),
  DOORDASH_KEY_ID: z.string().optional().default(''),
  DOORDASH_SIGNING_SECRET: z.string().optional().default(''),
  /** Courier R2: value DoorDash sends in the webhook Authorization header (set in the Developer Portal) */
  DOORDASH_WEBHOOK_SECRET: z.string().optional().default(''),
  UBER_CUSTOMER_ID: z.string().optional().default(''),
  UBER_CLIENT_ID: z.string().optional().default(''),
  UBER_CLIENT_SECRET: z.string().optional().default(''),
  SMS_PROVIDER: z.enum(['log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_FROM: z.string().optional().default(''),
  /** Optional Twilio Messaging Service (MG…); when set it is used instead of TWILIO_FROM (alphanumeric sender IDs, A2P 10DLC pools). */
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional().default(''),
  /** log (write to app log only) | brevo (Brevo transactional API) | smtp (HTTP relay at SMTP_URL accepting {from,to,subject,text}) */
  EMAIL_PROVIDER: z.enum(['log', 'smtp', 'brevo']).default('log'),
  SMTP_URL: z.string().optional().default(''),
  BREVO_API_KEY: z.string().optional().default(''),
  /** Brevo SMTP login (Brevo > SMTP & API > SMTP, e.g. 9a1b2c001@smtp-brevo.com). Used when BREVO_API_KEY is an SMTP key (xsmtpsib-…). */
  BREVO_SMTP_LOGIN: z.string().optional().default(''),
  BREVO_SMTP_HOST: z.string().optional().default('smtp-relay.brevo.com'),
  BREVO_SMTP_PORT: z.coerce.number().optional().default(587),
  EMAIL_FROM: z.string().default('no-reply@gutad.io'),
  EMAIL_FROM_NAME: z.string().default('Gutad'),
  /** Where customer replies go (empty = no Reply-To header). */
  EMAIL_REPLY_TO: z.string().optional().default('support@gutad.io'),
  EXPO_ACCESS_TOKEN: z.string().optional().default(''),
  /** CN.3 free-text dish requests → option selections: 'rules' (keyword matching, no external calls) or 'anthropic' (Claude) */
  AI_PROVIDER: z.enum(['rules', 'anthropic']).default('rules'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().optional().default('claude-opus-5-5'),
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
  // 15.3-R road travel times: straight (default, no network) | osrm (ROUTING_URL) | google | mapbox (ROUTING_API_KEY)
  ROUTING_PROVIDER: z.enum(['straight', 'osrm', 'google', 'mapbox']).default('straight'),
  ROUTING_API_KEY: z.string().optional().default(''),
  ROUTING_URL: z.string().optional().default(''),
  // 16.2-U file storage: local disk (default) or an S3-compatible bucket
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().optional().default(''),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().optional().default('us-east-1'),
  S3_BUCKET: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
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
