/**
 * verify-variants -- one row and a picker, instead of five near-identical rows. POS-SELL-006/007.
 *
 *     npm run verify:variants
 *
 * The problem this solves is specific to clothing. A search for "kanchipuram" in a saree shop
 * returns the same saree three times in three colours, and the cashier then reads three almost
 * identical lines to find the one in the customer's hand. That is slow at a counter and hopeless
 * on a phone.
 */

import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { search, variantsOf, sizeRank } from '../services/items';
import { seed } from './seed-dev';

const actor: Actor = {
  kind: 'USER', clientId: DEV_CLIENT_ID, id: 'dev-cashier', name: 'Dev cashier',
  roles: ['OWNER'], permissions: Object.values(PERMISSIONS)
};

let passed = 0;
let failed = 0;

const ok = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function main() {
  console.log('\nverify-variants\n');
  await seed();

  // ----------------------------------------------------------------------------------------
  console.log('a search knows when there is a choice to make');
  // ----------------------------------------------------------------------------------------
  /*
   * The bug this asserts against, found by looking at the screen rather than at the code: the
   * first version counted the variants but never COLLAPSED them, so a search for "kanchipuram"
   * returned three near-identical rows that each said "3 colours". Worse than no grouping at all.
   */
  const found = await search(actor, 'kanchipuram');
  ok('three colours collapse to ONE row', found.items.length === 1, `got ${found.items.length}`);
  eq('which knows its group', found.items[0]?.variantGroup, 'kanchipuram-silk');
  eq('and how many colours are behind it', found.items[0]?.variantCount, 3);
  eq('and shows the cheapest as a "from" price', found.items[0]?.priceFromPaise, 1299900);
  eq('and claims no stock figure, because it stands for three different pieces',
    found.items[0]?.availableQty, null);

  // One match inside a group means the cashier already chose. Making them choose again is a tap
  // for nothing.
  const narrowed = await search(actor, 'kanchipuram maroon');
  eq('naming the colour gives the piece itself, not a picker', narrowed.items.length, 1);
  eq('the maroon one', narrowed.items[0]?.colour, 'Maroon');
  eq('with no "from" price, because it is a specific piece', narrowed.items[0]?.priceFromPaise, null);
  eq('and its real stock figure', narrowed.items[0]?.availableQty, 4);

  const dupatta = await search(actor, 'dupatta');
  eq('a one-off piece has no group', dupatta.items[0]?.variantGroup, null);
  eq('and a count of one, so the screen adds it straight to the basket',
    dupatta.items[0]?.variantCount, 1);

  // ----------------------------------------------------------------------------------------
  console.log('\nthe picker');
  // ----------------------------------------------------------------------------------------
  const kanchi = await variantsOf(actor, 'kanchipuram-silk');
  eq('every colour of the saree', kanchi.length, 3);
  // All three sarees are size "Free", so colour decides: Bottle green, Maroon, Peacock blue.
  eq('in a stable order, so the picker does not shuffle between searches',
    kanchi.map(v => v.colour), ['Bottle green', 'Maroon', 'Peacock blue']);

  /*
   * The out-of-stock one is INCLUDED on purpose. "We have it in green but not in blue" is
   * something an assistant needs to be able to say; a picker that silently drops blue makes them
   * say "we do not have it" instead, and the customer walks.
   */
  const blue = kanchi.find(v => v.code === 'KAN-003')!;
  eq('including the colour that has run out', blue.availableQty, 0);
  ok('which the screen can say honestly rather than hiding', blue.colour === 'Peacock blue');

  ok('each variant carries its own price -- they are not all the same',
    new Set(kanchi.map(v => v.pricePaise)).size > 1,
    JSON.stringify(kanchi.map(v => v.pricePaise)));

  const empty = await variantsOf(actor, 'no-such-group');
  eq('an unknown group is empty, not an error', empty.length, 0);

  const otherShop = await variantsOf({ ...actor, clientId: 'some-other-shop' }, 'kanchipuram-silk');
  eq('and another shop sees none of it', otherShop.length, 0);

  // ----------------------------------------------------------------------------------------
  console.log('\nsizes come out in the order a person expects');
  // ----------------------------------------------------------------------------------------
  /*
   * Found by a failing expectation above: SQL sorts sizes as text, which gives L, M, S, XL for
   * letters and 10, 38, 8 for numbers. Neither is how a shop assistant reads a size run, and it is
   * the sort of thing nobody reports -- they just find the till annoying.
   */
  const rank = (size: string | null) => sizeRank(size);
  const sorted = (sizes: (string | null)[]) =>
    [...sizes].sort((a, b) => {
      const [ag, av, at] = rank(a);
      const [bg, bv, bt] = rank(b);
      return ag - bg || av - bv || (at < bt ? -1 : at > bt ? 1 : 0);
    });

  eq('letters run small to large, not alphabetically',
    sorted(['XL', 'M', 'S', 'L', 'XS']), ['XS', 'S', 'M', 'L', 'XL']);
  eq('numbers sort as numbers, not as text',
    sorted(['38', '8', '40', '10']), ['8', '10', '38', '40']);
  eq('letters come before numbers, and unknowns go last',
    sorted(['Free', '38', 'M']), ['M', '38', 'Free']);
  eq('a missing size sorts last rather than first',
    sorted([null, 'M']), ['M', null]);

  // ----------------------------------------------------------------------------------------
  console.log('\na scan still goes straight through');
  // ----------------------------------------------------------------------------------------
  /*
   * A scanned barcode is one specific piece -- the maroon saree in the customer's hand, not "a
   * saree in some colour". Opening a picker there would add a tap to every scan, on the path with
   * the 150 ms budget.
   */
  const scanned = await search(actor, '8901234500011');
  ok('a barcode is still exact', scanned.exact === true);
  eq('and it is the maroon one, not a choice', scanned.items[0]?.code, 'KAN-001');

  // ----------------------------------------------------------------------------------------
  console.log('\npictures');
  // ----------------------------------------------------------------------------------------
  ok('items that have one carry it', kanchi.every(v => (v.imageUrl ?? '').startsWith('data:image/svg')));
  const retired = await prisma.item.findFirst({
    where: { clientId: DEV_CLIENT_ID, code: 'RET-900' }, select: { imageUrl: true }
  });
  eq('and an item without a picture says null, not an empty string',
    retired?.imageUrl, null);

  // ----------------------------------------------------------------------------------------
  console.log('\nthe count is one query, not one per row');
  // ----------------------------------------------------------------------------------------
  /*
   * Guarding the thing that would quietly make search slow: a count per result row would be 25
   * extra round trips on a full page, on the screen with the tightest latency budget in the
   * product. Measured rather than assumed.
   */
  const started = Date.now();
  await search(actor, 'saree');
  const elapsed = Date.now() - started;
  ok(`a multi-group search stays quick (${elapsed} ms locally)`, elapsed < 500,
    'if this fails, check that countVariants is still one groupBy for the whole page');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
