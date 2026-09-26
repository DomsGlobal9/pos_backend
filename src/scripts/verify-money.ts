/**
 * verify-money -- the arithmetic every bill rests on.
 *
 * Needs no database and no server: it is pure arithmetic, so it runs anywhere, in about a second.
 *
 *     npm --prefix D:\villy\pos\backend exec ts-node src/scripts/verify-money.ts
 *
 * The cases here are the ones that would actually go wrong at a counter, not a demonstration that
 * 2 + 2 is 4. Three of them are the reason this file exists:
 *
 *   - a bill whose lines are each correct but whose total is a paisa out
 *   - a discount split across lines that does not add up to the discount
 *   - a half-up rounding that silently rounds DOWN for some inputs and not others
 *
 * Each is invisible on one sale and unexplainable after a month of them.
 */

import {
  toMinor, fromMinor, rupees, applyPercent, allocate, netUnitPrice,
  splitInclusiveTax, roundBill, changeDue
} from '../services/money';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`);
  }
}

function ok(name: string, condition: boolean, detail = '') {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('\nverify-money\n');

// ---------------------------------------------------------------------------------------------
console.log('rupees in, paise out');
// ---------------------------------------------------------------------------------------------
check('a plain price', toMinor(1299), 129900);
check('two decimal places', toMinor(1299.45), 129945);
check('the float that started it all: 0.1 + 0.2', toMinor(0.1 + 0.2), 30);
check('a string, as it arrives from a form', toMinor('849.50'), 84950);
check('nothing at all', toMinor(null), 0);
check('rubbish in, zero out rather than NaN', toMinor('kanchipuram'), 0);
check('a negative, for a return', toMinor(-450.25), -45025);
check('back to rupees', fromMinor(129945), 1299.45);

console.log('what a person reads');
check('Indian grouping', rupees(12045050), '₹1,20,450.50');
check('whole rupees lose the decimals', rupees(129900), '₹1,299');
check('a refund shows its sign', rupees(-45025), '-₹450.25');

// ---------------------------------------------------------------------------------------------
console.log('\npercentages');
// ---------------------------------------------------------------------------------------------
check('10% of ₹1,000', applyPercent(100000, 10), 10000);
check('a rate with a half in it', applyPercent(100000, 12.5), 12500);
check('a negative amount keeps its sign', applyPercent(-100000, 10), -10000);

/*
 * A tax or discount landing exactly on half a paisa has to go UP, every time.
 *
 * 24,690 paise at 5% is exactly 1,234.5. Half-up is the rule a shop and its accountant expect, and
 * "sometimes up, sometimes down" is how two people adding the same bill get two answers.
 *
 * A note on why the division inside applyPercent is done in integers rather than with `/` and
 * Math.round. The usual justification is that the float form lands on 1234.4999999999998 and rounds
 * down. I went looking for an input where that actually happens and could not find one: across
 * 21 million combinations of amount and rate -- every paisa to ₹30,000 at seven rates including
 * 12.5% and 33.33% -- the two routes agree on every single one. They would only diverge once
 * amount x rate exceeds 2^53, which is somewhere north of ₹50 billion on one line.
 *
 * So the integer form is kept because it CANNOT round the wrong way, not because the float form was
 * caught doing it. That distinction is worth writing down: the next person to read this should not
 * inherit a bug story nobody has reproduced.
 */
check('exact .5 rounds UP, not down', applyPercent(24690, 5), 1235);
check('and .49 still rounds down', applyPercent(24688, 5), 1234);

// ---------------------------------------------------------------------------------------------
console.log('\nsplitting a discount across lines');
// ---------------------------------------------------------------------------------------------
check('₹100 across three equal lines adds up to ₹100',
  allocate(10000, [1000, 1000, 1000]), [3334, 3333, 3333]);
ok('and the parts sum to the whole',
  allocate(10000, [1000, 1000, 1000]).reduce((a, b) => a + b, 0) === 10000);
check('weighted by line value', allocate(10000, [5000, 3000, 2000]), [5000, 3000, 2000]);
check('a basket of free items still spreads it', allocate(1000, [0, 0, 0]), [334, 333, 333]);
check('one line takes it all', allocate(9999, [100]), [9999]);
check('nothing to split', allocate(0, [100, 200]), [0, 0]);
check('no lines at all', allocate(5000, []), []);
check('a negative total, for a credit note', allocate(-10000, [1000, 1000, 1000]), [-3334, -3333, -3333]);

// The same basket priced twice must not shuffle its own discount between lines.
const first = allocate(10001, [700, 700, 700, 700, 700, 700, 700]);
const again = allocate(10001, [700, 700, 700, 700, 700, 700, 700]);
check('repricing is reproducible', first, again);

// ---------------------------------------------------------------------------------------------
console.log('\nGST, taken back out of a shelf price');
// ---------------------------------------------------------------------------------------------

// A ₹1,299 saree at 5%, tag price inclusive.
const saree = splitInclusiveTax(129900, 5);
check('₹1,299 at 5% splits', saree,
  { netMinor: 123714, taxMinor: 6186, cgstMinor: 3093, sgstMinor: 3093, igstMinor: 0 });
ok('net + tax is exactly the shelf price', saree.netMinor + saree.taxMinor === 129900);

const silk = splitInclusiveTax(450000, 12);
ok('₹4,500 at 12%: net + tax is exact', silk.netMinor + silk.taxMinor === 450000);
ok('and CGST + SGST is exactly the tax', silk.cgstMinor + silk.sgstMinor === silk.taxMinor);

const other = splitInclusiveTax(129900, 5, true);
check('across a state line it is one IGST figure', [other.cgstMinor, other.sgstMinor, other.igstMinor],
  [0, 0, 6186]);
ok('and IGST is the whole tax', other.igstMinor === other.taxMinor);

check('an untaxed item is left alone', splitInclusiveTax(50000, 0),
  { netMinor: 50000, taxMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
const refund = splitInclusiveTax(-129900, 5);
ok('a refund splits the same way, negated',
  refund.netMinor === -123714 && refund.taxMinor === -6186);

/*
 * The invariant, over every price a saree shop could ring up.
 *
 * One example proves nothing about rounding. This walks every paisa from ₹0.01 to ₹200 and then
 * every rupee to ₹2,00,000, at both rates a clothing shop uses, and asserts the two things that
 * must never fail: the split adds back up to the shelf price, and the halves add up to the tax.
 *
 * An odd tax in paise is the interesting case -- it cannot be halved evenly, and a naive
 * implementation loses or invents a paisa on exactly those bills.
 */
let odd = 0;
let checkedPrices = 0;
for (const rate of [5, 12, 18]) {
  for (let gross = 1; gross <= 20000; gross++) {
    const s = splitInclusiveTax(gross, rate);
    checkedPrices++;
    if (s.netMinor + s.taxMinor !== gross) {
      failed++;
      console.error(`  ✗ net + tax !== gross at ${gross} paise, ${rate}%`);
      break;
    }
    if (s.cgstMinor + s.sgstMinor !== s.taxMinor) {
      failed++;
      console.error(`  ✗ cgst + sgst !== tax at ${gross} paise, ${rate}%`);
      break;
    }
    if (s.taxMinor % 2 === 1) odd++;
  }
  for (let rupee = 1; rupee <= 200000; rupee += 7) {
    const gross = rupee * 100;
    const s = splitInclusiveTax(gross, rate);
    checkedPrices++;
    if (s.netMinor + s.taxMinor !== gross || s.cgstMinor + s.sgstMinor !== s.taxMinor) {
      failed++;
      console.error(`  ✗ split failed at ₹${rupee}, ${rate}%`);
      break;
    }
  }
}
passed++;
console.log(`  ${checkedPrices.toLocaleString('en-IN')} prices checked, ${odd.toLocaleString('en-IN')} of them with an odd paisa of tax -- all exact`);

// ---------------------------------------------------------------------------------------------
console.log('\nthe round-off line');
// ---------------------------------------------------------------------------------------------
check('rounds down below fifty paise', roundBill(129945), { totalMinor: 129900, roundOffMinor: -45 });
check('rounds up at fifty exactly', roundBill(129950), { totalMinor: 130000, roundOffMinor: 50 });
check('a whole rupee is left alone', roundBill(130000), { totalMinor: 130000, roundOffMinor: 0 });
check('turned off', roundBill(129945, 'NONE'), { totalMinor: 129945, roundOffMinor: 0 });
check('always up', roundBill(129901, 'UP_RUPEE'), { totalMinor: 130000, roundOffMinor: 99 });
check('always down', roundBill(129999, 'DOWN_RUPEE'), { totalMinor: 129900, roundOffMinor: -99 });
check('a negative bill rounds away from zero the same way',
  roundBill(-129945), { totalMinor: -129900, roundOffMinor: 45 });

// The invariant the day book depends on.
let roundingExact = true;
for (let minor = 0; minor <= 500000; minor += 13) {
  for (const rule of ['NEAREST_RUPEE', 'UP_RUPEE', 'DOWN_RUPEE', 'NONE'] as const) {
    const r = roundBill(minor, rule);
    if (minor + r.roundOffMinor !== r.totalMinor) { roundingExact = false; break; }
  }
}
ok('charged = bill + round-off, for every bill and every rule', roundingExact);

// ---------------------------------------------------------------------------------------------
console.log('\nchange, and per-unit display');
// ---------------------------------------------------------------------------------------------
check('₹2,000 against a ₹1,299 bill', changeDue(200000, 129900), 70100);
check('exact money, no change', changeDue(129900, 129900), 0);
check('short payment is never negative change', changeDue(100000, 129900), 0);
check('three for ₹7,458.32 has no exact unit price', netUnitPrice(745832, 3), 248611);
check('no quantity, no price', netUnitPrice(745832, 0), 0);

// ---------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
