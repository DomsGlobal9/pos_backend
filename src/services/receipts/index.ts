/**
 * Digital receipts: one document built from the saved bill, drawn as a PDF, and served at a random
 * link the paper receipt carries as a QR code. See receipts.service.
 */
export { receiptLink, ensureToken, pdfFor, publicReceipt, publicPdf, receiptUrl, newToken } from './receipts.service';
export { receiptDocument, money, ascii } from './document';
export type { DocLine } from './document';
export { renderPdf } from './pdf';
