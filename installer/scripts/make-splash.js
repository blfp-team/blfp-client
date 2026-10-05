/*
 * 生成 portable 安装程序解压时显示的 splash 图。
 *
 * 为什么需要它：electron-builder 的 portable 目标是个自解压包，
 * 双击后要先把 452MB（Electron 运行时 + payload）解到 %TEMP% 才会启动 Electron。
 * 而且 templates/nsis/portable.nsi 里写着 —— **没配 splashImage 就 SetSilent silent**，
 * 整个过程一个窗口都没有。用户看到的就是"双击了，半天没反应"。
 *
 * 输出：
 *   installer/splash.bmp          给 electron-builder 用（必须是 24 位 BMP）
 *   installer/splash-preview.png  给我自己看的预览（read_image 不认 BMP）
 *
 * 零依赖：自己解 PNG、自己画、自己写 BMP。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'icon.png');
const OUT_BMP = path.join(ROOT, 'splash.bmp');
const OUT_PNG = path.join(ROOT, 'splash-preview.png');

/* ---------- 1. 解 PNG ---------- */
function decodePng(buf) {
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('没有 IHDR');
  if (ihdr.depth !== 8) throw new Error('只支持 8 位深度');
  if (ihdr.interlace !== 0) throw new Error('不支持隔行扫描');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('不支持的 colorType ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: W, height: H } = ihdr;
  const stride = W * channels;
  const px = Buffer.alloc(H * stride);
  let pos = 0;
  for (let y = 0; y < H; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= channels) ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[x] = v & 0xff;
    }
  }
  /* 统一成 RGBA，后面好混合 */
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0, n = W * H; i < n; i++) {
    const s = i * channels;
    if (channels === 4) { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; rgba[i * 4 + 3] = px[s + 3]; }
    else if (channels === 3) { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; rgba[i * 4 + 3] = 255; }
    else if (channels === 2) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; rgba[i * 4 + 3] = px[s + 1]; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; rgba[i * 4 + 3] = 255; }
  }
  return { width: W, height: H, rgba };
}

/* ---------- 2. 画布 ---------- */
const W = 420;
const H = 300;
const canvas = Buffer.alloc(W * H * 4); /* RGBA */

const put = (x, y, r, g, b, a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const dst = canvas;
  dst[i] = Math.round(dst[i] * (1 - a) + r * a);
  dst[i + 1] = Math.round(dst[i + 1] * (1 - a) + g * a);
  dst[i + 2] = Math.round(dst[i + 2] * (1 - a) + b * a);
  dst[i + 3] = 255;
};

/* 背景：竖直渐变，跟客户端深色主题一个调子 */
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const r = Math.round(11 + (23 - 11) * t);
  const g = Math.round(12 + (26 - 12) * t);
  const b = Math.round(22 + (51 - 22) * t);
  for (let x = 0; x < W; x++) put(x, y, r, g, b, 1);
}
/* 顶部一条高光，别显得太平 */
for (let y = 0; y < 2; y++) for (let x = 0; x < W; x++) put(x, y, 60, 72, 130, 0.5);
/* 1px 边框 */
for (let x = 0; x < W; x++) { put(x, 0, 42, 47, 82, 1); put(x, H - 1, 42, 47, 82, 1); }
for (let y = 0; y < H; y++) { put(0, y, 42, 47, 82, 1); put(W - 1, y, 42, 47, 82, 1); }

/* ---------- 3. 贴图标 ---------- */
const icon = decodePng(fs.readFileSync(SRC));
const ICON = 104;
const ix = Math.round((W - ICON) / 2);
const iy = 54;
for (let ty = 0; ty < ICON; ty++) {
  for (let tx = 0; tx < ICON; tx++) {
    /* 盒式采样 */
    const x0 = Math.floor(tx * icon.width / ICON), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * icon.width / ICON));
    const y0 = Math.floor(ty * icon.height / ICON), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * icon.height / ICON));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const s = (sy * icon.width + sx) * 4;
        const al = icon.rgba[s + 3] / 255;
        r += icon.rgba[s] * al; g += icon.rgba[s + 1] * al; b += icon.rgba[s + 2] * al; a += al; n++;
      }
    }
    if (!n || a <= 0) continue;
    put(ix + tx, iy + ty, r / a, g / a, b / a, Math.min(1, a / n));
  }
}

/* ---------- 4. 手搓 5×7 点阵字体，只写 "BLFP" ---------- */
const FONT = {
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
};
function drawText(text, x0, y0, scale, [r, g, b]) {
  let cx = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) { cx += 4 * scale; continue; }
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) put(cx + gx * scale + dx, y0 + gy * scale + dy, r, g, b, 1);
        }
      }
    }
    cx += 6 * scale; /* 5 宽 + 1 间隔 */
  }
  return cx - scale;
}
const TITLE = 'BLFP';
const TS = 5;                       /* 放大 5 倍 → 每字 25×35 */
const titleW = TITLE.length * 6 * TS - TS;
drawText(TITLE, Math.round((W - titleW) / 2), 178, TS, [232, 236, 255]);

/* ---------- 5. 进度条 ---------- */
const barX = 110, barY = 244, barW = 200, barH = 5;
const roundRect = (x, y, w, h, rad, color, alpha) => {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const dx = Math.min(xx - x, x + w - 1 - xx);
      const dy = Math.min(yy - y, y + h - 1 - yy);
      if (dx < rad && dy < rad) {
        const d = Math.hypot(rad - dx, rad - dy);
        if (d > rad) continue;
      }
      put(xx, yy, color[0], color[1], color[2], alpha);
    }
  }
};
roundRect(barX, barY, barW, barH, 2, [35, 39, 66], 1);
roundRect(barX, barY, Math.round(barW * 0.62), barH, 2, [91, 140, 255], 1);
/* 进度条右端一个亮点，让它看起来"正在动" */
roundRect(barX + Math.round(barW * 0.62) - 3, barY - 1, 3, barH + 2, 2, [160, 190, 255], 1);

/* ---------- 6. 写 24 位 BMP（BI_RGB，行 4 字节对齐，自下而上） ---------- */
const rowBytes = W * 3;
const pad = (4 - (rowBytes % 4)) % 4;
const pixelBytes = (rowBytes + pad) * H;
const bmp = Buffer.alloc(54 + pixelBytes);
bmp.write('BM', 0, 'ascii');
bmp.writeUInt32LE(54 + pixelBytes, 2);
bmp.writeUInt32LE(54, 10);          /* 像素数据偏移 */
bmp.writeUInt32LE(40, 14);          /* BITMAPINFOHEADER */
bmp.writeInt32LE(W, 18);
bmp.writeInt32LE(H, 22);
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);          /* 24 位 */
bmp.writeUInt32LE(0, 30);           /* BI_RGB */
bmp.writeUInt32LE(pixelBytes, 34);
bmp.writeInt32LE(2835, 38);
bmp.writeInt32LE(2835, 42);
for (let y = 0; y < H; y++) {
  const srcY = H - 1 - y;           /* BMP 自下而上 */
  let o = 54 + y * (rowBytes + pad);
  for (let x = 0; x < W; x++) {
    const i = (srcY * W + x) * 4;
    bmp[o++] = canvas[i + 2];       /* B */
    bmp[o++] = canvas[i + 1];       /* G */
    bmp[o++] = canvas[i];           /* R */
  }
}
fs.writeFileSync(OUT_BMP, bmp);

/* ---------- 7. 顺便出一张 PNG 预览 ---------- */
const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (b) => { let c = 0xFFFFFFFF; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}
const rawOut = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  rawOut[y * (W * 4 + 1)] = 0;
  canvas.copy(rawOut, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdrOut = Buffer.alloc(13);
ihdrOut.writeUInt32BE(W, 0); ihdrOut.writeUInt32BE(H, 4);
ihdrOut[8] = 8; ihdrOut[9] = 6;
fs.writeFileSync(OUT_PNG, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdrOut),
  chunk('IDAT', zlib.deflateSync(rawOut, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));

console.log('图标源:', icon.width + 'x' + icon.height);
console.log('splash:', W + 'x' + H, '24 位 BMP', bmp.length, 'bytes →', OUT_BMP);
console.log('预览  :', OUT_PNG);
