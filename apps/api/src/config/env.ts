import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1')
  .default(false);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4300),
  /** Public origin of the web app (the browser only talks to this origin). */
  WEB_ORIGIN: z.string().url().default('http://localhost:3300'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/exatech'),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),
  /** Prefix for BullMQ queues and Redis keys (lets several environments share one Redis). */
  REDIS_PREFIX: z.string().default('exa'),
  AUTH_SECRET: z.string().min(32).default('dev-only-secret-change-me-0123456789abcdef'),
  /** Enables demo accounts on the sign-in page and the dev outbox. Never in production. */
  DEMO_MODE: bool,
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default('exatech'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: bool.default(true),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Exatech <no-reply@exatech.test>'),
  RESEND_API_KEY: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Used by the built-in sandbox gateway when Razorpay is not configured. */
  SANDBOX_WEBHOOK_SECRET: z.string().default('sandbox-webhook-secret'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.output<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.issues);
    throw new Error('Invalid environment configuration');
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.DEMO_MODE) throw new Error('DEMO_MODE must be off in production');
    if (parsed.data.AUTH_SECRET.startsWith('dev-only')) throw new Error('Set AUTH_SECRET in production');
  }
  cached = parsed.data;
  return cached;
}
