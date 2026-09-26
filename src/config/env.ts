import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Boot-time environment validation.
 *
 * The rule this file exists to enforce: a misconfigured deployment must fail HERE, loudly, with the
 * variable named -- never boot quietly and then throw on a cashier's first sale. Inventory learned
 * this the expensive way, with a service that passed its health check and then failed the moment
 * anyone onboarded a client.
 *
 * It matters more at a till than anywhere else. A web app that 500s sends someone away annoyed; a
 * till that 500s has a queue of people at the counter and a shop owner on the phone.
 *
 * Dev stays frictionless: the strict requirements apply only when NODE_ENV=production.
 */

const isProd = process.env.NODE_ENV === 'production';

// A variable left blank in a hosting dashboard arrives as "" rather than undefined, which fails a
// format check AND a required check, reporting one missing value twice under two reasons. Normalise
// blank to absent so the message is the single actionable one.
const optionalStr = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Render injects PORT at runtime; the default is for local only. 4007 because Inventory is on
  // 4006 and both run side by side during the cut-over.
  PORT: z.string().transform(Number).default('4007'),

  /**
   * Turns off the webhook dispatcher and any scheduled work in THIS process.
   *
   * Needed to run a second copy against the same database -- local work against real data, or a
   * debugging instance. Without it two dispatchers claim the same deliveries. Serving requests is
   * safe to duplicate; running the clock is not.
   */
  DISABLE_BACKGROUND_JOBS: z.preprocess(
    (v) => v === 'true' || v === true,
    z.boolean().default(false)
  ),

  // The POS's OWN database. It never points at Inventory's.
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  // Declared as directUrl in prisma/schema.prisma. Only migrations use it, so it is not needed to
  // boot -- but without it `prisma migrate deploy` fails on the deploy host, which is a confusing
  // place to find out.
  DIRECT_URL: optionalStr(z.string().url('DIRECT_URL must be a valid URL')),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),

  // The CORS allow-list for the till. The localhost default is right for dev and actively wrong in
  // production, where it silently rejects the deployed till and shows up as inexplicable browser
  // CORS errors while curl works fine.
  FRONTEND_URL: z.string().default('http://localhost:5175'),

  AUTH_MODE: z.enum(['local', 'gateway']).default('local'),
  GATEWAY_PUBLIC_KEY_PATH: z.string().optional(),
  POS_PRIVATE_KEY_PATH: z.string().optional(),

  /**
   * Where Inventory is reached for this deployment.
   *
   * Absent is a legitimate configuration, not an error: it means STANDALONE MODE. The POS uses its
   * own item and customer lists, takes no holds, and emits no events to Inventory. A client who has
   * bought both modules has this set.
   */
  INVENTORY_BASE_URL: optionalStr(z.string().url('INVENTORY_BASE_URL must be a valid URL'))
}).superRefine((val, ctx) => {
  const require = (name: string, why: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: why });

  if (val.AUTH_MODE === 'gateway' && !val.GATEWAY_PUBLIC_KEY_PATH) {
    require('GATEWAY_PUBLIC_KEY_PATH',
      'required when AUTH_MODE=gateway -- without it every request is rejected as unauthorised');
  }

  if (isProd) {
    if (!val.DIRECT_URL) {
      require('DIRECT_URL',
        'required in production -- prisma/schema.prisma declares directUrl, and migrations fail without it');
    }
    if (val.FRONTEND_URL.includes('localhost')) {
      require('FRONTEND_URL',
        'still points at localhost in production -- the deployed till would be blocked by CORS');
    }
  }
}).safeParse(process.env);

if (!envSchema.success) {
  console.error('\n❌ Invalid environment configuration -- refusing to start.\n');
  for (const issue of envSchema.error.issues) {
    console.error(`   • ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error(
    '\n   These are checked at boot on purpose: a missing value here would otherwise surface\n' +
    '   as a failure at the counter, with a queue waiting.\n'
  );
  process.exit(1);
}

export const env = envSchema.data;

/** Whether this deployment has Inventory behind it, or is a standalone till. */
export const hasInventory = () => Boolean(env.INVENTORY_BASE_URL);
