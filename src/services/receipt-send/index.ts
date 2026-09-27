/**
 * Sending a bill to its customer on WhatsApp, through ScaleEzy's WhatsApp service: one message per
 * press, to the bill's own customer, never able to damage the sale. See receipt-send.service.
 */
export { sendReceipt, sendsFor, whatsappConfig } from './receipt-send.service';
