/* GIF89a encoder — puro e sem dependências (testável em Node).
 *
 * Implementa:
 *   1. `quantize(imageData, maxColors)` — median cut: reduz a imagem a uma
 *      paleta de até N cores + índices por pixel (Uint8Array).
 *   2. `encodeGIF(width, height, frames, delayMs)` — monta o arquivo GIF89a
 *      com paleta LOCAL por frame (LCT) e compressão LZW.
 *
 * Decisões (PORQUÊ):
 *   · Paleta por frame em vez de global → cada foto do slideshow tem as cores
 *     próprias (sem "lavar" a paleta misturando fotos diferentes).
 *   · Median cut em vez de popularidade pura → distribui melhor as cores ao
 *     longo do espaço RGB (popularidade só agrupa tons parecidos).
 *   · LZW com clear-code automático (dict 4096 = 12 bits máx) → GIFs grandes
 *     não crescem sem limite.
 *   · Sem transparente (desposal 2, background branco) — slideshow simples.
 *
 * Limitação documentada: GIF é 256 cores por frame; fotos fotográficas muito
 * coloridas podem ter leve banding — aceitável para animações/posts.
 */
'use strict';

const GIF = (() => {

  /* ------------------------------------------------------------ median cut */

  /**
   * Quantiza uma imagem (ImageData ou {data,width,height}) para uma paleta.
   * Retorna { palette: [[r,g,b],...], indices: Uint8Array } — indices[i] aponta
   * para a entrada da paleta que representa o pixel i.
   */
  function quantize(imageData, maxColors = 256) {
    const d = imageData.data;
    const n = imageData.width * imageData.height;

    // frequência por cor exata (chave compacta r<<16|g<<8|b)
    const freq = new Map();
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      const key = (r << 16) | (g << 8) | b;
      freq.set(key, (freq.get(key) || 0) + 1);
    }
    const keys = Array.from(freq.keys());

    // um único box cobrindo todo o espaço de cores
    let boxes = [boxOf(keys)];
    while (boxes.length < maxColors) {
      // box com maior range ponderado para dividir
      let bi = -1, bestRange = -1;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.keys.length < 2) continue;
        const range = Math.max(b.r1 - b.r0, b.g1 - b.g0, b.b1 - b.b0);
        if (range > bestRange) { bestRange = range; bi = i; }
      }
      if (bi < 0) break; // todos indivisíveis
      const [a, b2] = splitBox(boxes[bi], freq);
      boxes.splice(bi, 1, a, b2);
    }

    // paleta = média ponderada de cada box
    const palette = boxes.map(bx => {
      let r = 0, g = 0, b = 0, count = 0;
      for (const k of bx.keys) {
        const c = freq.get(k);
        r += (k >> 16 & 0xff) * c;
        g += (k >> 8 & 0xff) * c;
        b += (k & 0xff) * c;
        count += c;
      }
      if (!count) return [0, 0, 0];
      return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
    });

    // índices: box cujo range contém a cor; fallback = box de média mais próxima
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      let idx = -1;
      for (let j = 0; j < boxes.length; j++) {
        const bx = boxes[j];
        if (r >= bx.r0 && r <= bx.r1 && g >= bx.g0 && g <= bx.g1 && b >= bx.b0 && b <= bx.b1) {
          idx = j; break;
        }
      }
      if (idx < 0) {
        let best = 0, bestD = Infinity;
        for (let j = 0; j < boxes.length; j++) {
          const p = palette[j];
          const dr = r - p[0], dg = g - p[1], db = b - p[2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestD) { bestD = dist; best = j; }
        }
        idx = best;
      }
      indices[i] = idx;
    }

    return { palette, indices };
  }

  function boxOf(keys) {
    let r0 = 255, g0 = 255, b0 = 255, r1 = 0, g1 = 0, b1 = 0;
    for (const k of keys) {
      const r = k >> 16 & 0xff, g = k >> 8 & 0xff, b = k & 0xff;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (g < g0) g0 = g; if (g > g1) g1 = g;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    return { r0, g0, b0, r1, g1, b1, keys };
  }

  /** Divide um box no canal de maior range, no ponto mediano (50% da contagem). */
  function splitBox(box, freq) {
    const { r0, g0, b0, r1, g1, b1, keys } = box;
    const ranges = [r1 - r0, g1 - g0, b1 - b0];
    const chan = ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 'r'
      : ranges[1] >= ranges[2] ? 'g' : 'b';
    const get = (k) => chan === 'r' ? (k >> 16 & 0xff) : chan === 'g' ? (k >> 8 & 0xff) : (k & 0xff);
    keys.sort((a, b) => get(a) - get(b));

    let total = 0;
    for (const k of keys) total += freq.get(k);
    let acc = 0, mid = 0;
    for (let i = 0; i < keys.length; i++) {
      acc += freq.get(keys[i]);
      if (acc * 2 >= total) { mid = i + 1; break; }
    }
    if (mid <= 0) mid = Math.ceil(keys.length / 2);
    if (mid >= keys.length) mid = keys.length - 1;
    if (mid <= 0) mid = 1; // garante 2 lados não vazios

    return [boxOf(keys.slice(0, mid)), boxOf(keys.slice(mid))];
  }

  /* ------------------------------------------------------------ LZW (GIF) */

  /**
   * Comprime um stream de índices (0..255) no formato LZW do GIF.
   * Retorna array de bytes (sem sub-blocos — a montagem faz isso).
   */
  function lzwEncode(pixels, minCodeSize = 8) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dict = new Map();
    let bitBuffer = 0, bitCount = 0;
    const out = [];

    const writeCode = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        out.push(bitBuffer & 0xff);
        bitBuffer >>>= 8;
        bitCount -= 8;
      }
    };
    const resetDict = () => {
      dict = new Map();
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    };

    writeCode(clearCode);
    if (pixels.length === 0) { writeCode(eoiCode); return flush(); }

    let currentStr = String(pixels[0]);
    let currentCode = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i];
      const key = currentStr + ',' + k;
      if (dict.has(key)) {
        currentStr = key;
        currentCode = dict.get(key);
      } else {
        writeCode(currentCode);
        if (nextCode < 4096) {
          dict.set(key, nextCode++);
          // Encoder adiciona a 1ª entrada ao emitir o 1º código; o decoder só
          // adiciona a partir do 2º código lido. Por isso o encoder deve
          // ATRASAR a troca de codeSize em 1 código (usar >, não >=) para
          // alinhar com decoders canônicos (libgif/Skia/Chrome usam >=).
          if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
        }
        if (nextCode >= 4096) {
          writeCode(clearCode);
          resetDict();
        }
        currentStr = String(k);
        currentCode = k;
      }
    }
    writeCode(currentCode);
    writeCode(eoiCode);

    function flush() {
      if (bitCount > 0) out.push(bitBuffer & 0xff);
      return out;
    }
    return flush();
  }

  /* ------------------------------------------------------------ montagem */

  function u16le(v) { return [v & 0xff, (v >> 8) & 0xff]; }

  /**
   * Normaliza o delay do GIF (ms). Aceita 100..5000; qualquer valor fora
   * (ou não numérico) volta ao default 600 — zero-trust no input da UI.
   */
  function normalizeDelay(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 100 && n <= 5000 ? Math.round(n) : 600;
  }

  function subBlocks(bytes) {
    const blocks = [];
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      blocks.push(chunk.length, ...chunk);
    }
    blocks.push(0x00);
    return blocks;
  }

  /**
   * Monta o GIF89a.
   * @param {number} width  largura (todos os frames devem ter o mesmo tamanho)
   * @param {number} height altura
   * @param {Array<{data: Uint8ClampedArray, width, height}>} frames — ImageData-like
   * @param {number} delayMs atraso por frame em milissegundos
   * @returns {Uint8Array} bytes do GIF
   */
  function encodeGIF(width, height, frames, delayMs = 600) {
    const out = [];
    // header + logical screen descriptor (GCT desabilitado — usamos LCT por frame)
    out.push(...'GIF89a'.split('').map(c => c.charCodeAt(0)));
    out.push(...u16le(width), ...u16le(height));
    out.push(0x00, 0x00, 0x00); // packed (GCT off) + bg index + aspect

    for (const frame of frames) {
      const q = quantize(frame, 256);
      const nColors = q.palette.length;
      // GIF: paleta tem 2^(n+1) entradas; mínimo 2 (n=0). nColors=1 → gctSize 0.
      const gctSize = Math.max(0, Math.ceil(Math.log2(nColors)) - 1);
      const gctEntries = 1 << (gctSize + 1);

      // graphic control extension: 21 f9 04 + packed + delay(2) + transp + term
      out.push(0x21, 0xF9, 0x04);
      out.push(0x02); // packed: disposal=2 (restore bg) + transparent off
      out.push(...u16le(Math.max(1, Math.round(delayMs / 10))));
      out.push(0x00, 0x00);

      // image descriptor com LCT
      out.push(0x2C);
      out.push(0x00, 0x00, 0x00, 0x00); // left, top
      out.push(...u16le(width), ...u16le(height));
      out.push(0x80 | gctSize); // LCT presente, tamanho gctSize

      // paleta local
      for (let i = 0; i < gctEntries; i++) {
        const p = q.palette[i] || [0, 0, 0];
        out.push(p[0], p[1], p[2]);
      }

      // dados LZW
      out.push(8); // min code size
      out.push(...subBlocks(lzwEncode(q.indices, 8)));
    }

    out.push(0x3B); // trailer
    return Uint8Array.from(out);
  }

  return { quantize, lzwEncode, encodeGIF, normalizeDelay };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GIF;
