import { Router } from 'express';
import { z } from 'zod';
import { listForManaging } from '../services/items';
import { saveItem } from '../services/item-import';
import { moveStock, stockHistory, setLowStockAt } from '../services/stock';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * The owner's item list. POS-STAND-003.
 *
 * A shop that does not use Inventory had no way to put an item in the till but a spreadsheet. These
 * two routes are the screen behind that: see what is there, and type one in. The checks and the
 * save are the import's own, so a price typed here and a price uploaded cannot disagree.
 *
 * Refused for a shop connected to Inventory -- its list comes from there, and two sources for one
 * list is how a price changes in one place and not the other.
 */
const router = Router();
// The same gate every till route uses: it is the signed-in person who manages the list.
router.use(devActor);
const actor = (req: any) => req.actor;

/** GET /api/v1/items -- every item, including the ones switched off. `?q=` to find one. */
router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await listForManaging(actor(req), req.query) });
  } catch (error) { next(error); }
});

/**
 * POST /api/v1/items -- add one, or correct one that is already there.
 *
 * Upsert by code, as the import is: typing a code that exists is how a price gets corrected, and
 * refusing it would send the owner to a spreadsheet to fix a typo.
 */
router.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      price: z.union([z.string(), z.number()]),
      gst: z.union([z.string(), z.number()]),
      hsn: z.union([z.string(), z.number()]).optional().nullable(),
      barcode: z.union([z.string(), z.number()]).optional().nullable(),
      qty: z.union([z.string(), z.number()]).optional().nullable(),
      colour: z.string().optional().nullable(),
      size: z.string().optional().nullable(),
      group: z.string().optional().nullable(),
      active: z.boolean().optional()
    }).safeParse(req.body);
    // The field-level sentences come from the import's own checks; this only catches an empty form.
    if (!body.success) throw badRequest('An item needs at least a code, a name, a price and a GST rate.');
    const saved = await saveItem(actor(req), body.data as Record<string, unknown>);
    res.status(saved.added ? 201 : 200).json({ success: true, data: saved });
  } catch (error) { next(error); }
});

/** PUT /api/v1/items/low-stock-at -- an item with this many or fewer left is "low" (28 Oct). */
router.put('/low-stock-at', async (req, res, next) => {
  try {
    const body = z.object({ lowStockAt: z.number().int() }).safeParse(req.body);
    if (!body.success) throw badRequest('Type a number of pieces.');
    res.json({ success: true, data: await setLowStockAt(actor(req), body.data.lowStockAt) });
  } catch (error) { next(error); }
});

/** GET /api/v1/items/:code/stock -- the item's stock book: who changed the count, when and why. */
router.get('/:code/stock', async (req, res, next) => {
  try {
    res.json({ success: true, data: await stockHistory(actor(req), req.params.code) });
  } catch (error) { next(error); }
});

/** POST /api/v1/items/:code/stock -- received, adjusted (with a reason) or counted. Standalone shops only. */
router.post('/:code/stock', async (req, res, next) => {
  try {
    const body = z.object({
      kind: z.string().max(20), qty: z.number().int(),
      reason: z.string().max(20).optional().nullable(), note: z.string().max(200).optional().nullable()
    }).safeParse(req.body);
    if (!body.success) throw badRequest('Say what happened and how many pieces.');
    res.json({ success: true, data: await moveStock(actor(req), req.params.code, body.data) });
  } catch (error) { next(error); }
});

export default router;
