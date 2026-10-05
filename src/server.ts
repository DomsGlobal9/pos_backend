// The shop's time zone, before anything reads the clock. Keep this import first.
import './config/timezone';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env, hasInventory } from './config/env';
import apiRoutes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { startDeliveryLoop, startCatalogueLoop } from './services/inventory-link';
import { startWebhookLoop } from './services/webhooks';

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

// 1 MB for everything but the item import, which carries a spreadsheet (up to 5 MB, base64).
const smallJson = express.json({ limit: '1mb' });
const importJson = express.json({ limit: '8mb' });
app.use((req, res, next) => (req.path === '/api/v1/connections/items/import' ? importJson : smallJson)(req, res, next));

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
  } else {
    // Sends each connected shop's sales, returns and exchanges to Inventory, in order. Off the
    // path of every sale; a sale only ever writes its event and is done.
    startDeliveryLoop();
    // Pulls what changed in Inventory into each connected till's own item list, so the shelf count
    // the sell screen shows does not drift until a manager thinks to press Refresh.
    startCatalogueLoop();
    // A shop's own software, told about each sale, return, exchange and day close. Leased rows, so
    // even two instances with jobs on never send one notice twice at once.
    startWebhookLoop();
  }
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
