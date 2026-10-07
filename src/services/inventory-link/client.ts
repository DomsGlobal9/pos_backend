import { open } from '../../utils/credential';

/**
 * The one place the POS speaks HTTP to Inventory. Contract: docs/product/INVENTORY-CONTRACT.md.
 *
 * Returns what happened rather than throwing on a bad status, because every caller needs to tell
 * "Inventory said no" (a person must look) from "Inventory did not answer" (try again later) --
 * and a thrown error loses that difference.
 */

export type Reply =
  | { kind: 'ANSWERED'; status: number; body: any }
  | { kind: 'UNREACHABLE'; reason: string };

export interface LinkTarget {
  baseUrl: string;
  keyCipher: string;
}

export async function call(
  link: LinkTarget,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 10_000
): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${link.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-storefront-key': open(link.keyCipher)
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { kind: 'ANSWERED', status: res.status, body: parsed };
  } catch (error: any) {
    return {
      kind: 'UNREACHABLE',
      reason: error?.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : (error?.cause?.code ?? error?.message ?? 'unreachable')
    };
  } finally {
    clearTimeout(timer);
  }
}
