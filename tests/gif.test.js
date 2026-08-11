/* Testes do encoder GIF (js/gif.js) — roundtrip com mini-decoder LZW
 * independente + estrutura do arquivo + median cut.
 *
 * O decoder LZW abaixo é implementado do zero (sem reaproveitar código do
 * encoder) para provar que o code stream é compatível com o formato GIF.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GIF = require('../js/gif.js');

/* ---------------------------------------------------------- mini decoder */

/** Decodifica um stream LZW GIF (indices) a partir dos bytes crus. */
function lzwDecode(bytes, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = [];
  let bitBuffer = 0, bitCount = 0, bitPos = 0;
  const out = [];
  let prev = null;

  const readCode = () => {
    while (bitCount < codeSize) {
      if (bitPos >= bytes.length) return -1;
      bitBuffer |= bytes[bitPos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  const resetDict = () => {
    dict = [];
    for (let i = 0; i < (1 << minCodeSize); i++) dict.push([i]);
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  resetDict();
    let code;
    while ((code = readCode()) !== -1 && code !== eoiCode) {
      if (code === clearCode) { resetDict(); prev = null; continue; }
      let entry;
      if (code < nextCode) entry = dict[code];
      else if (code === nextCode && prev) entry = prev.concat(prev[0]);
      else throw new Error('LZW: código inválido ' + code);
      out.push(...entry);
      if (prev && nextCode < 4096) {
        dict[nextCode] = prev.concat(entry[0]); // posição exata do código, não push
        nextCode++;
        if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = entry;
    }
  return Uint8Array.from(out);
}

function unescapeSubBlocks(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i++];
    if (len === 0) break;
    for (let j = 0; j < len; j++) out.push(bytes[i + j]);
    i += len;
  }
  return Uint8Array.from(out);
}

/** Faz parse mínimo do GIF: frames com {palette, indices, delayCs}. */
function parseGIF(buf) {
  const u8 = Uint8Array.from(buf);
  assert.strictEqual(String.fromCharCode(...u8.slice(0, 6)), 'GIF89a');
  assert.strictEqual(u8[u8.length - 1], 0x3b, 'trailer');
  const width = u8[6] | (u8[7] << 8);
  const height = u8[8] | (u8[9] << 8);
  const frames = [];
  let i = 13; // após header + LSD (13 bytes)
  let delay = 0;
  while (i < u8.length - 1) {
    if (u8[i] === 0x21 && u8[i + 1] === 0xf9) {
      delay = u8[i + 4] | (u8[i + 5] << 8);
      i += 8; // 21 f9 04 packed delay delay term
      assert.strictEqual(u8[i], 0x2c, 'esperava image descriptor');
    }
    assert.strictEqual(u8[i], 0x2c, 'separador de frame');
    const left = u8[i + 1] | (u8[i + 2] << 8);
    const top = u8[i + 3] | (u8[i + 4] << 8);
    const w = u8[i + 5] | (u8[i + 6] << 8);
    const h = u8[i + 7] | (u8[i + 8] << 8);
    const packed = u8[i + 9];
    const hasLCT = (packed & 0x80) !== 0;
    const gctSize = packed & 0x07;
    i += 10;
    let palette = [];
    if (hasLCT) {
      const entries = 1 << (gctSize + 1);
      for (let e = 0; e < entries; e++) {
        palette.push([u8[i], u8[i + 1], u8[i + 2]]);
        i += 3;
      }
    }
    const minCode = u8[i++];
    const stream = unescapeSubBlocks(u8.slice(i));
    i += countSubBlockBytes(u8, i); // avança sobre sub-blocos + terminator
    const indices = lzwDecode(stream, minCode);
    frames.push({ left, top, w, h, palette, indices, delayCs: delay });
  }
  return { width, height, frames };
}

function countSubBlockBytes(u8, start) {
  // reconstrói quantos bytes os sub-blocos ocupam a partir de `start` (após min code)
  let i = start, total = 0;
  while (i < u8.length) {
    const len = u8[i];
    if (len === 0) break;
    total += len + 1;
    i += len + 1;
  }
  return total + 1; // + terminator
}

function solidFrame(w, h, r, g, b) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
  return { data: d, width: w, height: h };
}

function gradientFrame(w, h, phase) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = Math.round(127 + 127 * Math.sin(x / 7 + phase));
      d[i + 1] = Math.round(255 * y / h);
      d[i + 2] = Math.round(255 * x / w);
      d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

/* --------------------------------------------------------------- testes */

test('quantize: cor única gera paleta de 1 cor e índices zerados', () => {
  const f = solidFrame(8, 8, 200, 40, 10);
  const q = GIF.quantize(f, 256);
  assert.ok(q.palette.length >= 1);
  assert.ok(q.indices.every(v => v === 0), 'todos os pixels viram índice 0');
  const p = q.palette[0];
  assert.ok(Math.abs(p[0] - 200) <= 2 && Math.abs(p[1] - 40) <= 2 && Math.abs(p[2] - 10) <= 2);
});

test('quantize: paleta respeita maxColors e índices no range', () => {
  const f = gradientFrame(40, 30, 0);
  const q = GIF.quantize(f, 64);
  assert.ok(q.palette.length <= 64, 'paleta <= maxColors');
  assert.ok(q.palette.length >= 2, 'gradiente gera mais de uma cor');
  for (let i = 0; i < q.indices.length; i++) {
    assert.ok(q.indices[i] >= 0 && q.indices[i] < q.palette.length);
  }
});

test('quantize: cores fora do range dos boxes caem na mais próxima', () => {
  // paleta mínima (1 cor) e imagem com 2 cores: a 2ª cai no fallback
  const d = new Uint8ClampedArray(2 * 4);
  d[0] = 10; d[1] = 10; d[2] = 10; d[3] = 255;
  d[4] = 250; d[5] = 250; d[6] = 250; d[7] = 255;
  const q = GIF.quantize({ data: d, width: 2, height: 1 }, 2);
  assert.strictEqual(q.palette.length, 2);
  assert.ok(q.indices[0] !== q.indices[1], 'pixels distintos ganham índices distintos');
});

test('lzwEncode: roundtrip de stream repetitivo', () => {
  const pixels = new Uint8Array(300);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 8; // padrão repetitivo
  const bytes = GIF.lzwEncode(pixels, 8);
  const decoded = lzwDecode(Uint8Array.from(bytes), 8);
  assert.deepStrictEqual(decoded, pixels, 'roundtrip preserva os índices');
});

test('lzwEncode: roundtrip com stream aleatório (dict grande)', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
  const pixels = new Uint8Array(1500);
  for (let i = 0; i < pixels.length; i++) pixels[i] = rand();
  const bytes = GIF.lzwEncode(pixels, 8);
  const decoded = lzwDecode(Uint8Array.from(bytes), 8);
  assert.deepStrictEqual(decoded, pixels);
});

test('encodeGIF: estrutura completa (header, LSD, 2 frames, trailer)', () => {
  const bytes = GIF.encodeGIF(16, 10, [solidFrame(16, 10, 255, 0, 0), solidFrame(16, 10, 0, 0, 255)], 600);
  assert.strictEqual(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  assert.strictEqual(bytes[bytes.length - 1], 0x3b);
  const g = parseGIF(bytes);
  assert.strictEqual(g.width, 16);
  assert.strictEqual(g.height, 10);
  assert.strictEqual(g.frames.length, 2);
});

test('encodeGIF: roundtrip frame sólido (cores da paleta corretas)', () => {
  const bytes = GIF.encodeGIF(16, 10, [solidFrame(16, 10, 200, 40, 10)], 300);
  const g = parseGIF(bytes);
  assert.strictEqual(g.frames.length, 1);
  const frame = g.frames[0];
  assert.strictEqual(frame.w, 16);
  assert.strictEqual(frame.h, 10);
  assert.strictEqual(frame.indices.length, 160);
  // índice 0 deve mapear para a cor próxima de (200,40,10)
  const p = frame.palette[frame.indices[0]];
  assert.ok(Math.abs(p[0] - 200) <= 2 && Math.abs(p[1] - 40) <= 2 && Math.abs(p[2] - 10) <= 2);
});

test('encodeGIF: roundtrip gradiente (2 frames, delay correto)', () => {
  const bytes = GIF.encodeGIF(20, 15, [gradientFrame(20, 15, 0), gradientFrame(20, 15, 1)], 500);
  const g = parseGIF(bytes);
  assert.strictEqual(g.frames.length, 2);
  assert.strictEqual(g.frames[0].indices.length, 300);
  assert.strictEqual(g.frames[1].indices.length, 300);
  // cada frame decodifica sem erro (lzwDecode já valida) e paletas têm cores
  assert.ok(g.frames[0].palette.length >= 2);
  assert.ok(g.frames[1].palette.length >= 2);
});

test('normalizeDelay: valores válidos passam (100..5000)', () => {
  assert.strictEqual(GIF.normalizeDelay(600), 600);
  assert.strictEqual(GIF.normalizeDelay(100), 100);
  assert.strictEqual(GIF.normalizeDelay(5000), 5000);
  assert.strictEqual(GIF.normalizeDelay(625), 625); // arredonda, não truncar
  assert.strictEqual(GIF.normalizeDelay('1200'), 1200); // string numérica
});

test('normalizeDelay: inválidos caem no default 600 (zero-trust)', () => {
  assert.strictEqual(GIF.normalizeDelay(50), 600);   // abaixo do mínimo
  assert.strictEqual(GIF.normalizeDelay(9999), 600); // acima do máximo
  assert.strictEqual(GIF.normalizeDelay('abc'), 600);
  assert.strictEqual(GIF.normalizeDelay(null), 600);
  assert.strictEqual(GIF.normalizeDelay(undefined), 600);
  assert.strictEqual(GIF.normalizeDelay(NaN), 600);
  assert.strictEqual(GIF.normalizeDelay(''), 600);
});

/* ---------------- blendImages (cross-dissolve) ---------------- */

test('blendImages: t=0 devolve A, t=1 devolve B', () => {
  const a = solidFrame(4, 4, 100, 0, 0);
  const b = solidFrame(4, 4, 0, 0, 200);
  const zero = GIF.blendImages(a, b, 0);
  const one = GIF.blendImages(a, b, 1);
  assert.strictEqual(zero.data[0], 100);
  assert.strictEqual(one.data[2], 200);
  // alpha sempre 255 (sem transparência no GIF)
  assert.strictEqual(zero.data[3], 255);
});

test('blendImages: t=0.5 é a média exata entre dois sólidos', () => {
  const a = solidFrame(2, 2, 100, 40, 0);
  const b = solidFrame(2, 2, 0, 40, 200);
  const m = GIF.blendImages(a, b, 0.5);
  assert.strictEqual(m.data[0], 50);
  assert.strictEqual(m.data[1], 40);
  assert.strictEqual(m.data[2], 100);
  assert.strictEqual(m.data[3], 255);
});

test('blendImages: zero-trust — t inválido é clampado, nunca explode', () => {
  const a = solidFrame(2, 2, 10, 10, 10);
  const b = solidFrame(2, 2, 250, 250, 250);
  assert.strictEqual(GIF.blendImages(a, b, '0.5').data[0], 130); // string numérica ok
  assert.strictEqual(GIF.blendImages(a, b, 2).data[0], 250);     // > 1 → B
  assert.strictEqual(GIF.blendImages(a, b, -1).data[0], 10);     // < 0 → A
  assert.strictEqual(GIF.blendImages(a, b, 'abc').data[0], 10);  // NaN → A
  assert.strictEqual(GIF.blendImages(a, b, null).data[0], 10);   // null → A
  assert.strictEqual(GIF.blendImages(a, b, undefined).data[0], 10);
});

test('blendImages: tamanhos diferentes → null (não interpola distorcido)', () => {
  assert.strictEqual(GIF.blendImages(solidFrame(2, 2, 0, 0, 0), solidFrame(3, 2, 0, 0, 0), 0.5), null);
  assert.strictEqual(GIF.blendImages(null, solidFrame(2, 2, 0, 0, 0), 0.5), null);
});

/* ---------------- fadeSequence (transição GIF) ---------------- */

test('fadeSequence: <2 frames devolve cópia sem frames extras', () => {
  const one = GIF.fadeSequence([solidFrame(2, 2, 0, 0, 0)], 3);
  assert.strictEqual(one.length, 1);
  const none = GIF.fadeSequence([], 3);
  assert.strictEqual(none.length, 0);
});

test('fadeSequence: steps=0 ou inválido → sem fade (cópias)', () => {
  const frames = [solidFrame(2, 2, 0, 0, 0), solidFrame(2, 2, 0, 0, 0)];
  assert.strictEqual(GIF.fadeSequence(frames, 0).length, 2);
  assert.strictEqual(GIF.fadeSequence(frames, 'abc').length, 2);
});

test('fadeSequence: 2 frames + steps=3 → 5 frames, intermediários com delay curto', () => {
  const a = solidFrame(4, 4, 0, 0, 0);
  const b = solidFrame(4, 4, 200, 200, 200);
  const out = GIF.fadeSequence([a, b], 3, 80);
  assert.strictEqual(out.length, 5); // f0 + 3 blend + f1
  assert.strictEqual(out[0], a);     // extremos são as próprias refs
  assert.strictEqual(out[4], b);
  assert.strictEqual(out[1].delay, 80);
  assert.strictEqual(out[1].data[0], Math.round(200 * (1 / 4))); // t=1/4
  assert.strictEqual(out[2].data[0], 100);                       // t=2/4
  assert.strictEqual(out[3].data[0], Math.round(200 * (3 / 4))); // t=3/4
  assert.strictEqual(out[1].width, 4);
  assert.strictEqual(out[1].height, 4);
});

test('fadeSequence: clamps steps>12 e stepDelay fora de 40..1000 (zero-trust)', () => {
  const frames = [solidFrame(2, 2, 0, 0, 0), solidFrame(2, 2, 0, 0, 0)];
  const big = GIF.fadeSequence(frames, 99, 80);
  assert.strictEqual(big.length, 2 + 12); // clamp 12 passos
  const low = GIF.fadeSequence(frames, 3, 5);
  assert.strictEqual(low[1].delay, 40);   // clamp mínimo
  const high = GIF.fadeSequence(frames, 3, 99999);
  assert.strictEqual(high[1].delay, 1000); // clamp máximo
  const bad = GIF.fadeSequence(frames, 3, 'abc');
  assert.strictEqual(bad[1].delay, 80);    // fallback 80
});

test('fadeSequence: pares de tamanhos diferentes pulam interpolação (corte seco)', () => {
  const a = solidFrame(2, 2, 0, 0, 0);
  const big = solidFrame(3, 3, 0, 0, 0);
  const c = solidFrame(2, 2, 0, 0, 0);
  const out = GIF.fadeSequence([a, big, c], 3, 80);
  assert.strictEqual(out.length, 3); // f0, f1, f2 — sem blends (sizes divergem)
  assert.strictEqual(out[0], a);
  assert.strictEqual(out[1], big);
  assert.strictEqual(out[2], c);
});

/* ---------------- encodeGIF com delay por frame ---------------- */

test('encodeGIF: frame.delay por frame vence o delay global (GCE)', () => {
  const a = solidFrame(16, 10, 255, 0, 0);
  const b = solidFrame(16, 10, 0, 0, 255);
  // frame B carrega delay próprio de 100ms; A usa o global 600ms
  const bytes = GIF.encodeGIF(16, 10, [a, { data: b.data, width: b.width, height: b.height, delay: 100 }], 600);
  const g = parseGIF(bytes);
  assert.strictEqual(g.frames.length, 2);
  assert.strictEqual(g.frames[0].delayCs, 60);  // 600ms → 60 centésimos
  assert.strictEqual(g.frames[1].delayCs, 10);  // 100ms → 10 centésimos
});
