/**
 * What a bill IS under GST, by the shop's registration. The words are Inventory's own
 * (services/invoicing/document.ts), copied verbatim so a customer reads the same sentence on a bill
 * from the till and one from Inventory.
 *
 *   REGULAR       TAX INVOICE      tax worked out of the price and shown, CGST/SGST or IGST
 *   COMPOSITION   BILL OF SUPPLY   no GST charged at all, and the declaration below printed
 *   UNREGISTERED  RECEIPT          no GST, and no GSTIN line
 */
export const REGISTRATIONS = ['REGULAR', 'COMPOSITION', 'UNREGISTERED'] as const;
export type Registration = typeof REGISTRATIONS[number];
export type DocumentKind = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'RECEIPT';

/*
 * GST IS OPTIONAL (the owner of the Inventory side, 7 Oct): a shop may have no GSTIN, no registration
 * chosen and no rates, and must still sell and print normally. Only a GSTIN holder may charge GST or
 * issue a tax invoice or a Bill of Supply, so with no GSTIN a bill is a plain receipt -- whatever the
 * registration says, including the REGULAR the column defaults to for a shop that never chose.
 */
export const documentKindFor = (registration: string | null | undefined, gstin: string | null | undefined): DocumentKind =>
  !gstin?.trim() ? 'RECEIPT'
    : registration === 'COMPOSITION' ? 'BILL_OF_SUPPLY' : registration === 'UNREGISTERED' ? 'RECEIPT' : 'TAX_INVOICE';

export const HEADING: Record<DocumentKind, string> = {
  TAX_INVOICE: 'TAX INVOICE',
  BILL_OF_SUPPLY: 'BILL OF SUPPLY',
  RECEIPT: 'RECEIPT'
};
export const COMPOSITION_DECLARATION = 'Composition taxable person, not eligible to collect tax on supplies.';

/** Only a tax invoice charges GST. A Bill of Supply and a receipt charge none on anything. */
export const chargesGst = (kind: DocumentKind) => kind === 'TAX_INVOICE';
