/**
 * A real Postgres on this machine, for development and for the verification suites.
 *
 *     node src/scripts/local-db.mjs start     # starts it, prints the URL, stays running
 *     node src/scripts/local-db.mjs stop
 *
 * Why this exists: the POS's real database is a Supabase project in Singapore, and pointing local
 * work at it is wrong twice over -- a developer machine is ~100 ms away, which makes every local
 * measurement a lie, and a verification suite that loops over shops has no business touching a
 * real one. Docker is the usual answer and is not always running here.
 *
 * This is the official PostgreSQL binary, run from node_modules against a data directory in
 * .localdb. It is a REAL server: real migrations, real transactions, real unique constraints and
 * real row locks. Nothing about the sale path is stubbed when it runs against this.
 *
 * The data directory is gitignored. Deleting it and starting again is the reset.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const PORT = 55432;
export const USER = 'pos';
export const PASSWORD = 'pos';
export const DATABASE = 'pos';
export const URL = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}?schema=public`;

const DATA_DIR = path.join(ROOT, '.localdb');

export async function makeServer() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true
  });
}

/** Start it, creating the cluster and the database the first time. Safe to call when it is
 * already initialised; not safe to call twice at once. */
export async function start({ quiet = false } = {}) {
  const fs = await import('fs');
  const pg = await makeServer();

  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    if (!quiet) console.log('initialising a new cluster in .localdb ...');
    await pg.initialise();
  }

  await pg.start();

  try {
    await pg.createDatabase(DATABASE);
  } catch (error) {
    // Already there, which is the normal case on every run after the first.
    if (!/already exists/i.test(String(error?.message))) throw error;
  }

  if (!quiet) {
    console.log(`postgres up on ${PORT}`);
    console.log(URL);
  }
  return pg;
}

const command = process.argv[2];

if (command === 'start') {
  const pg = await start();
  console.log('\nleaving it running. ctrl-c to stop.');
  const shutdown = async () => { await pg.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Hold the process open.
  setInterval(() => {}, 1 << 30);
} else if (command === 'stop') {
  const pg = await makeServer();
  await pg.stop();
  console.log('stopped');
} else if (command) {
  console.error(`unknown command: ${command}. Use start or stop.`);
  process.exit(1);
}
