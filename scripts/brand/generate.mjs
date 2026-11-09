// Generates Gutad brand assets (web + mobile) from SVG sources.
// Run: node scripts/brand/generate.mjs   (needs `sharp`, already in node_modules)
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = (p, data) => { const f = resolve(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); console.log('wrote', p); };

// "Chopped G": a G sliced clean through by one cleaver stroke — gutad = to chop.
const ORANGE_A = '#ff8a3d', ORANGE_B = '#e64f06', INK = '#141210';
const G_PATH = 'M349.3 162.7 A132 132 0 1 0 388 256 H276';
const CUT = -58; // slice angle, degrees
const SLICE_AT = 152; // where on the bowl the cleaver lands, degrees

/** The G with one clean cleaver slice through the bowl, in a 512 box. */
function glyph(color, { id = 'g', scale = 1 } = {}) {
  const t = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  const a = (SLICE_AT * Math.PI) / 180;
  const cx = 256 + 132 * Math.cos(a), cy = 256 + 132 * Math.sin(a);
  const stroke = `fill="none" stroke="${color}" stroke-width="66" stroke-linecap="round" stroke-linejoin="round"`;
  return `
  <defs>
    <mask id="${id}-m" maskUnits="userSpaceOnUse" x="-64" y="-64" width="640" height="640">
      <rect x="-64" y="-64" width="640" height="640" fill="#fff"/>
      <rect x="${cx - 70}" y="${cy - 9}" width="140" height="18" fill="#000" transform="rotate(${CUT} ${cx} ${cy})"/>
    </mask>
  </defs>
  <g${t}><g mask="url(#${id}-m)"><path d="${G_PATH}" ${stroke}/></g></g>`;
}

const tileBg = (rx = 116) => `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ORANGE_A}"/><stop offset="1" stop-color="${ORANGE_B}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.25" cy="0.15" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="${rx}" fill="url(#bg)"/>
  <rect width="512" height="512" rx="${rx}" fill="url(#sheen)"/>`;

const svg = (body, w = 512, h = 512) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

// Sources
const markTile = svg(tileBg() + glyph('#fff'));                 // rounded tile (web favicon / logo)
const markSquare = svg(tileBg(0) + glyph('#fff', { scale: 0.92 })); // full-bleed square (iOS masks corners)
const markGlyphWhite = svg(glyph('#fff', { scale: 0.62 }));     // transparent, for adaptive icon / splash
const markGlyphBrand = svg(glyph(ORANGE_B));                    // transparent, brand colour
const markMono = svg(glyph('#fff', { scale: 0.8 }));            // android notification (white silhouette)

const png = (src, size) => sharp(Buffer.from(src), { density: 384 }).resize(size, size).png().toBuffer();

// ---------- Web (Next.js app router conventions) ----------
out('apps/web/src/app/icon.svg', markTile);
out('apps/web/src/app/apple-icon.png', await png(markSquare, 180));
out('apps/web/public/icon-192.png', await png(markTile, 192));
out('apps/web/public/icon-512.png', await png(markTile, 512));
out('apps/web/public/icon-maskable-512.png', await png(svg(tileBg(0) + glyph('#fff', { scale: 0.72 })), 512));
out('apps/web/public/logo.svg', markTile);
out('apps/web/public/logo-mark.svg', markGlyphBrand);

// favicon.ico (16/32/48 PNG-in-ICO)
{
  const sizes = [16, 32, 48];
  const imgs = await Promise.all(sizes.map((s) => png(markTile, s)));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => { const e = Buffer.alloc(16); e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12); offset += imgs[i].length; return e; });
  out('apps/web/src/app/favicon.ico', Buffer.concat([header, ...dir, ...imgs]));
}

// Open Graph / Twitter card 1200x630
{
  const W = 1200, H = 630;
  const og = svg(`
    <defs>
      <linearGradient id="ogbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c1815"/><stop offset="1" stop-color="${INK}"/></linearGradient>
      <radialGradient id="glow" cx=".85" cy=".2" r=".7"><stop offset="0" stop-color="${ORANGE_A}" stop-opacity=".45"/><stop offset="1" stop-color="${ORANGE_A}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#ogbg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <g opacity=".07" stroke="#fff" stroke-width="2">${Array.from({ length: 14 }, (_, i) => `<line x1="${i * 110 - 200}" y1="${H}" x2="${i * 110 + 164}" y2="0"/>`).join('')}</g>
    <svg x="90" y="155" width="200" height="200" viewBox="0 0 512 512">${tileBg() + glyph('#fff', { id: 'og' })}</svg>
    <text x="330" y="295" font-family="Segoe UI, Inter, Arial, sans-serif" font-weight="800" font-size="150" letter-spacing="-5" fill="#fff">gutad</text>
    <text x="94" y="450" font-family="Segoe UI, Inter, Arial, sans-serif" font-weight="600" font-size="40" fill="#efeae4">Order · Reserve · Experience</text>
    <text x="94" y="505" font-family="Segoe UI, Inter, Arial, sans-serif" font-size="30" fill="#b5aea6">Local kitchens, freshly chopped. gutad.io</text>`, W, H);
  out('apps/web/src/app/opengraph-image.png', await sharp(Buffer.from(og)).png().toBuffer());
  out('apps/web/src/app/twitter-image.png', await sharp(Buffer.from(og)).png().toBuffer());
}

// ---------- Mobile (Expo) ----------
out('apps/mobile/assets/icon.png', await png(markSquare, 1024));
out('apps/mobile/assets/adaptive-icon.png', await png(markGlyphWhite, 1024));
out('apps/mobile/assets/adaptive-icon-mono.png', await png(markGlyphWhite, 1024));
out('apps/mobile/assets/splash.png', await png(svg(glyph('#fff', { scale: 0.95 })), 1024));
out('apps/mobile/assets/notification-icon.png', await png(markMono, 96));
out('apps/mobile/assets/favicon.png', await png(markTile, 48));
out('apps/mobile/assets/logo.png', await png(markTile, 256)); // in-app brand mark
