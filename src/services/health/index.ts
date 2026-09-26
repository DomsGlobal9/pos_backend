/**
 * Health: can this service take a sale right now.
 *
 * Callers import this folder, never the files inside it, so the split below can change without
 * every caller changing with it. Every service in src/services/ is a folder with a barrel like
 * this one -- there are no loose files in src/services/, by design.
 */
export { health } from './health.service';
export type { Health } from './health.service';
