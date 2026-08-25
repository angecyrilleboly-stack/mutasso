// ============================================================
// MUTASSO — générateur d'icônes PWA (pur Node, sans dépendance)
// Produit des PNG RGBA : fond dégradé 135° #2dd4bf -> #0d9488
// avec un « M » blanc géométrique. Usage : node generer-icones.js
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- Table CRC32 pour les chunks PNG ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtre none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Contour du « M » (espace 1000x1000, sens horaire) ----
const M = [
  [210, 790], [210, 210], [350, 210], [500, 500], [650, 210], [790, 210],
  [790, 790], [670, 790], [670, 390], [500, 700], [330, 390], [330, 790]
];
function dansM(x, y) {
  let dedans = false;
  for (let i = 0, j = M.length - 1; i < M.length; j = i++) {
    const [xi, yi] = M[i], [xj, yj] = M[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

// Couleurs du dégradé (135° : diagonale haut-gauche -> bas-droite)
const C1 = [45, 212, 191];   // #2dd4bf
const C2 = [13, 148, 136];   // #0d9488

function generer(taille, echelleM, fichier) {
  const rgba = Buffer.alloc(taille * taille * 4);
  const S = 3; // super-échantillonnage 3x3 pour l'anticrénelage
  const off = (1000 - 1000 * echelleM) / 2;
  for (let py = 0; py < taille; py++) {
    for (let px = 0; px < taille; px++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = ((px + (sx + 0.5) / S) / taille) * 1000;
          const v = ((py + (sy + 0.5) / S) / taille) * 1000;
          if (dansM((u - off) / echelleM, (v - off) / echelleM)) hit++;
        }
      }
      const t = (px / taille + py / taille) / 2; // position sur la diagonale
      let r = C1[0] + (C2[0] - C1[0]) * t;
      let g = C1[1] + (C2[1] - C1[1]) * t;
      let b = C1[2] + (C2[2] - C1[2]) * t;
      const a = hit / (S * S);
      if (a > 0) { // mélange blanc du M
        r = r * (1 - a) + 255 * a;
        g = g * (1 - a) + 255 * a;
        b = b * (1 - a) + 255 * a;
      }
      const i = (py * taille + px) * 4;
      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b); rgba[i + 3] = 255;
    }
  }
  fs.writeFileSync(fichier, png(taille, taille, rgba));
  console.log('OK', fichier, taille + 'x' + taille);
}

const dossier = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(dossier, { recursive: true });
generer(192, 0.72, path.join(dossier, 'icon-192.png'));
generer(512, 0.72, path.join(dossier, 'icon-512.png'));
generer(512, 0.58, path.join(dossier, 'icon-maskable-512.png')); // zone sûre maskable
generer(180, 0.72, path.join(dossier, 'apple-touch-icon.png'));
console.log('Icônes PWA générées dans public/icons/');
