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

/**
 * Width, height and bytes of a JPEG data URL, read off its SOF marker. Null if it is not one the
 * page can draw: PDF takes JPEG bytes as they are (DCTDecode), which is the whole reason the logo
 * is kept as JPEG -- no decoding here, no library. Grey and RGB only; CMYK would print wrong.
 */
function jpegFromDataUrl(dataUrl: string): { data: Buffer; w: number; h: number; gray: boolean } | null {
  const m = /^data:image[/]jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const data = Buffer.from(m[1], 'base64');
  if (data.length < 4 || data.readUInt16BE(0) !== 0xFFD8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xFF) return null;
    const marker = data[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const comps = data[i + 9];
      if (comps !== 1 && comps !== 3) return null;
      return { data, w: data.readUInt16BE(i + 7), h: data.readUInt16BE(i + 5), gray: comps === 1 };
    }
    i += 2 + data.readUInt16BE(i + 2);
  }
  return null;
}

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
  type Row = { text: string; bold: boolean; x: number } | { rule: true } | { image: Buffer; w: number; h: number; gray: boolean; drawW: number; drawH: number };
  const rows: Row[] = [];
  for (const l of lines) {
    if (l.kind === 'rule') { rows.push({ rule: true }); continue; }
    if (l.kind === 'image') {
      // A logo, not a poster: at most 42 mm across and 20 mm tall, centred. Unreadable input is
      // simply not drawn -- a bill with no logo beats no bill.
      const img = jpegFromDataUrl(l.dataUrl);
      if (img) {
        const scale = Math.min((Math.min(widthPt - 2 * MARGIN, 42 * PT_PER_MM)) / img.w, (20 * PT_PER_MM) / img.h);
        rows.push({ ...img, image: img.data, drawW: img.w * scale, drawH: img.h * scale });
      }
      continue;
    }
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

  const rowH = (r: Row) => ('image' in r ? r.drawH + 6 : LEADING);
  const heightPt = MARGIN * 2 + rows.reduce((h, r) => h + rowH(r), 0) + (qr ? qrSize + 12 : 0);
  // ponytail: one picture per receipt, the logo. A second would need its own XObject name.
  const image = rows.find((r): r is Extract<Row, { image: Buffer }> => 'image' in r);

  // Content stream: PDF's origin is bottom-left, so y counts down from the top.
  const ops: string[] = [];
  let y = heightPt - MARGIN - FONT_SIZE;
  for (const row of rows) {
    if ('image' in row) {
      const x = (widthPt - row.drawW) / 2;
      const top = y + FONT_SIZE;
      ops.push(`q ${row.drawW.toFixed(2)} 0 0 ${row.drawH.toFixed(2)} ${x.toFixed(2)} ${(top - row.drawH).toFixed(2)} cm /Im1 Do Q`);
      y -= rowH(row);
      continue;
    }
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
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> ${image ? '/XObject << /Im1 7 0 R >> ' : ''}>> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  ];
  if (image) {
    objects.push(`<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /${image.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.image.length} >>
stream
${image.image.toString('latin1')}
endstream`);
  }

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
