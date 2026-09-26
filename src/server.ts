import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env, hasInventory } from './config/env';
import apiRoutes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

/**
 * ScaleEzy POS -- the till's server.
 *
 * It owns the sale. Inventory owns the goods. A sale is made here and lands in Inventory already
 * made, which is why this service has its own database and never writes to Inventory's.
 */

const app = express();

// Behind Render's proxy. Without this, express-rate-limit sees one IP for every shop in the country
// and rate-limits them as a single client.
app.set('trust proxy', 1);

app.use(helmet());

app.use(cors({
  origin: env.FRONTEND_URL.split(',').map(s => s.trim()),
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

/**
 * The rate limit is generous on purpose.
 *
 * A busy Saturday counter with a barcode scanner produces bursts that would look like abuse to a
 * default limit, and a till that refuses to scan because it hit a rate limit is worse than no rate
 * limit at all. The health path is exempt so a monitor cannot lock itself out.
 */
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path === '/v1/health',
  message: { success: false, message: 'Too many requests in one minute. Wait a moment and try again.' }
}));

app.use('/api/v1', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  console.log(`🧾 ScaleEzy POS running on port ${env.PORT}`);
  console.log(`   mode: ${hasInventory() ? 'with Inventory' : 'STANDALONE (own item and customer lists)'}`);
  console.log(`   auth: ${env.AUTH_MODE}`);

  if (env.DISABLE_BACKGROUND_JOBS) {
    console.log('   background jobs disabled for this instance (DISABLE_BACKGROUND_JOBS)');
  }
  // The webhook dispatcher starts here once it exists, inside that same switch: two instances
  // against one database must serve requests without both running the clock, or two dispatchers
  // claim the same deliveries. Inventory learned this one the hard way.
});

/**
 * Finish what is in flight before dying.
 *
 * Render sends SIGTERM on every deploy. A sale is one transaction, so it cannot be left half
 * written -- but a request that has been accepted and not yet answered leaves a cashier looking at a
 * spinner, not knowing whether the customer has been charged. Draining first turns that into a
 * clean answer.
 */
const shutdown = (signal: string) => {
  console.log(`\n${signal} received -- finishing in-flight requests, then closing.`);
  server.close(() => process.exit(0));
  // If something is wedged, do not hang the deploy forever.
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
