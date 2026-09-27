import QRCode from 'qrcode';
import { DocLine } from './document';

/**
 * A receipt as a PDF, 80 mm wide, as long as the bill. POS-RCPT-002.
 *
 * Written by hand rather than with a PDF library: a till receipt is lines of text in one fixed-width
 * font and a QR code, which is a few hundred bytes of PDF. The fonts are two of the fourteen every
 * PDF reader has built in (Courier and Courier-Bold), so nothing is embedded and the file stays
 * small enough to send on WhatsApp in a moment on a shop's connection.
 *
 * The QR code is drawn as filled squares, so it scans from the PDF as well as from paper.
 */

const PT_PER_MM = 72 / 25.4;
const FONT_SIZE = 8;
const CHAR_W = FONT_SIZE * 0.6; // Courier is 600/1000 em wide
const LEADING = 10.5;
const MARGIN = 10;

function escape(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function renderPdf(lines: DocLine[], opts: { widthMm?: number; qr?: string | null } = {}): Buffer {
  const widthPt = (opts.widthMm ?? 80) * PT_PER_MM;
  const cols = Math.floor((widthPt - 2 * MARGIN) / CHAR_W);

  // Lay the lines out as text rows first, so the page can be exactly as long as the bill.
  type Row = { text: string; bold: boolean; x: number } | { rule: true };
  const rows: Row[] = [];
  for (const l of lines) {
    if (l.kind === 'rule') { rows.push({ rule: true }); continue; }
    if (l.kind === 'gap') { rows.push({ text: '', bold: false, x: MARGIN }); continue; }
    if (l.kind === 'pair') {
      const right = l.right;
      const leftWidth = Math.max(4, cols - right.length - 1);
      const lefts = wrap(l.left, leftWidth);
      lefts.forEach((left, i) => {
        const text = i === lefts.length - 1 ? left.padEnd(cols - right.length) + right : left;
        rows.push({ text, bold: !!l.bold, x: MARGIN });
      });
      continue;
    }
    for (const part of wrap(l.text, cols)) {
      const x = l.center ? MARGIN + Math.max(0, (cols - part.length) / 2) * CHAR_W : MARGIN;
      rows.push({ text: part, bold: !!l.bold, x });
    }
  }

  const qr = opts.qr ? QRCode.create(opts.qr, { errorCorrectionLevel: 'M' }) : null;
  const moduleCount = qr?.modules.size ?? 0;
  const qrSize = qr ? Math.min(widthPt - 2 * MARGIN, 90) : 0;
  const cell = qr ? qrSize / moduleCount : 0;

  const heightPt = MARGIN * 2 + rows.length * LEADING + (qr ? qrSize + 12 : 0);

  // Content stream: PDF's origin is bottom-left, so y counts down from the top.
  const ops: string[] = [];
  let y = heightPt - MARGIN - FONT_SIZE;
  for (const row of rows) {
    if ('rule' in row) {
      const ry = y + FONT_SIZE / 2 - 1;
      ops.push(`0.6 G 0.5 w [2 2] 0 d ${MARGIN} ${ry.toFixed(2)} m ${(widthPt - MARGIN).toFixed(2)} ${ry.toFixed(2)} l S [] 0 d 0 G`);
    } else if (row.text) {
      ops.push(`BT /${row.bold ? 'F2' : 'F1'} ${FONT_SIZE} Tf ${row.x.toFixed(2)} ${y.toFixed(2)} Td (${escape(row.text)}) Tj ET`);
    }
    y -= LEADING;
  }
  if (qr) {
    const x0 = (widthPt - qrSize) / 2;
    const top = y - 4;
    const cells: string[] = [];
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (qr.modules.get(r, c)) {
          cells.push(`${(x0 + c * cell).toFixed(2)} ${(top - (r + 1) * cell).toFixed(2)} ${cell.toFixed(3)} ${cell.toFixed(3)} re`);
        }
      }
    }
    ops.push(`0 g ${cells.join(' ')} f`);
  }
  const content = ops.join('\n');

  // The file: catalog, pages, one page, two built-in fonts, the content. Offsets in an xref table.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  ];

  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
