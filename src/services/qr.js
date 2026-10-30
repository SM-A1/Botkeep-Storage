import QRCode from 'qrcode';
import sharp from 'sharp';

const MARGIN = 4; // quiet zone, in modules (QR spec minimum)
const TARGET_PX = 3000; // minimum output width/height
const DARK = '#0b1220';
const BLUE = '#2a7fff';

/**
 * Builds a vector QR code (SVG) with a "download" icon in the centre.
 * Error correction level H (30 %) keeps the code scannable with the logo on top.
 * The pixel size per module is an integer so the PNG render is perfectly crisp.
 */
export function buildQrSvg(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const total = n + MARGIN * 2;
  const px = Math.ceil(TARGET_PX / total);
  const size = total * px;

  // One path for all dark modules, merged into horizontal runs.
  let path = '';
  for (let y = 0; y < n; y += 1) {
    let x = 0;
    while (x < n) {
      if (qr.modules.get(y, x)) {
        let run = 1;
        while (x + run < n && qr.modules.get(y, x + run)) run += 1;
        path += `M${x + MARGIN} ${y + MARGIN}h${run}v1h-${run}z`;
        x += run;
      } else {
        x += 1;
      }
    }
  }

  const logo = Math.max(7, Math.round(n * 0.2)); // logo diameter in modules (~5 % of the area)
  const c = total / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="${DARK}" shape-rendering="crispEdges"/>` +
    `<g transform="translate(${c} ${c}) scale(${logo})" shape-rendering="geometricPrecision">` +
    `<rect x="-0.6" y="-0.6" width="1.2" height="1.2" rx="0.22" fill="#ffffff"/>` +
    `<circle r="0.5" fill="${BLUE}"/>` +
    `<path d="M0 -0.24V0.1M-0.16 -0.06L0 0.1L0.16 -0.06M-0.23 0.24H0.23" fill="none" stroke="#ffffff" stroke-width="0.085" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g></svg>`;
  return { svg, size };
}

export async function buildQrPng(text) {
  const { svg, size } = buildQrSvg(text);
  const png = await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9 }).toBuffer();
  return { png, size };
}
