/* Editor — motor de imagem no navegador (Canvas 2D).
 *
 * Todas as funções são PURAS: recebem um canvas e devolvem um canvas NOVO.
 * O histórico (desfazer/refazer) é responsabilidade do app.js.
 *
 * Filtros rápidos usam ctx.filter (nativo, acelerado). Filtros de pixel
 * (duotone, posterize, etc.) usam ImageData + LUTs/convoluções.
 *
 * ── Motor profissional (estilo Photoshop) ──────────────────────────────
 * A correção ideal NÃO usa multiplicação cega (brightness/contrast/saturate
 * do CSS estouram claros e esmagam sombras — resultado "estranho").
 * O pipeline profissional replica os algoritmos do Photoshop:
 *   · Auto Tone  → black point / white point (percentis p1/p99) + gamma
 *   · Auto Color → gray world (neutraliza cast nos midtones)
 *   · Curves     → S-curve suave de contraste perceptivo
 *   · Luminosity masks → ajustes graduais por brilho (transição em "ladeira",
 *     nunca em "balde") — é o que evita halos e cara artificial.
 */
'use strict';

const Editor = (() => {

  /* ------------------------------------------------------------------ base */

  function fromImage(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    return c;
  }

  function clone(c) {
    const n = document.createElement('canvas');
    n.width = c.width;
    n.height = c.height;
    n.getContext('2d', { willReadFrequently: true }).drawImage(c, 0, 0);
    return n;
  }

  function toImageData(c) {
    return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  }

  function fromImageData(im) {
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    c.getContext('2d').putImageData(im, 0, 0);
    return c;
  }

  function withFilter(c, filter) {
    const n = document.createElement('canvas');
    n.width = c.width;
    n.height = c.height;
    const ctx = n.getContext('2d');
    ctx.filter = filter;
    ctx.drawImage(c, 0, 0);
    ctx.filter = 'none';
    return n;
  }

  function pixelMap(im, fn) {
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const out = fn(d[i], d[i + 1], d[i + 2]);
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
    }
    return im;
  }

  function convolve(im, kernel, divisor = 1, offset = 0) {
    const w = im.width, h = im.height;
    const src = im.data;
    const out = new Uint8ClampedArray(src.length);
    const K = kernel;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let acc = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const idx = ((y + ky) * w + (x + kx)) * 4 + ch;
              acc += src[idx] * K[(ky + 1) * 3 + (kx + 1)];
            }
          }
          const v = Math.min(255, Math.max(0, acc / divisor + offset));
          out[(y * w + x) * 4 + ch] = v;
        }
        out[(y * w + x) * 4 + 3] = src[(y * w + x) * 4 + 3];
      }
    }
    // bordas: cópia do original
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y === 0 || x === 0 || y === h - 1 || x === w - 1) {
          const i = (y * w + x) * 4;
          out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
        }
      }
    }
    im.data.set(out);
    return im;
  }

  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  /* ------------------------------------------------------------------ ajustes */

  /**
   * Ajustes combinados (fatores 0.1..3; temperatura em -1..1).
   * Usado nos sliders manuais — preview rápido via ctx.filter (nativo).
   */
  function applyAdjust(c, { brightness = 1, contrast = 1, saturation = 1, sharpness = 1, temperature = 0 } = {}) {
    let out = c;
    if (brightness !== 1 || contrast !== 1 || saturation !== 1) {
      out = withFilter(out,
        `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`);
    }
    if (sharpness !== 1) {
      const im = toImageData(out);
      // kernel soma 1: identidade + laplaciano*alpha → nitidifica SEM clarear (nível DC preservado)
      const a = sharpness - 1;
      convolve(im, [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]);
      out = fromImageData(im);
    }
    if (temperature !== 0) {
      out = applyTemperature(out, temperature);
    }
    return out;
  }

  function applyTemperature(c, t) {
    const im = toImageData(c);
    const f = Math.abs(t) * 0.45;
    pixelMap(im, (r, g, b) => {
      if (t > 0) return [clamp255(r * (1 + f)), g, clamp255(b * (1 - f))];
      return [clamp255(r * (1 - f)), g, clamp255(b * (1 + f))];
    });
    return fromImageData(im);
  }

  /* ------------------------------------------------------------ presets */

  /**
   * Presets de correção — combinações nomeadas de fatores (dados PUROS).
   * Cada factors é compatível com applyAdjust: brightness/contrast/saturation
   * em 0.1..3, temperature em -1..1. Aplicar um preset = aplicar applyAdjust
   * com esses fatores (o histórico/estilo automático tratam como ajuste).
   */
  const PRESETS = [
    { key: 'claro', label: 'Claro', factors: { brightness: 1.15, contrast: 1.05 } },
    { key: 'contraste', label: 'Contraste', factors: { contrast: 1.3, brightness: 1.03 } },
    { key: 'vivido', label: 'Vívido', factors: { saturation: 1.3, contrast: 1.12 } },
    { key: 'quente', label: 'Quente', factors: { temperature: 0.35, brightness: 1.05 } },
    { key: 'frio', label: 'Frio', factors: { temperature: -0.35 } },
    { key: 'suave', label: 'Suave', factors: { contrast: 0.92, saturation: 0.95, sharpness: 1.1 } },
  ];

  /** Retorna os fatores de um preset (dados puros, testável em Node) ou null. */
  function presetFactors(key) {
    const p = PRESETS.find(x => x.key === key);
    return p ? p.factors : null;
  }

  /** Aplica um preset ao canvas (DOM). Chave desconhecida → devolve o mesmo canvas. */
  function applyPreset(c, key) {
    const factors = presetFactors(key);
    if (!factors) return c;
    return applyAdjust(c, factors);
  }

  /* ------------------------------------------------------------------ motor profissional (Photoshop-like) */

  /** Percentil do histograma (hist: array 256). Retorna valor 0..255. */
  function percentile(hist, pct) {
    let total = 0;
    for (let v = 0; v < 256; v++) total += hist[v] || 0;
    if (!total) return 128;
    const target = total * pct / 100;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v] || 0;
      if (acc >= target) return v;
    }
    return 255;
  }

  /**
   * LUT de tons estilo Auto Tone do Photoshop: mapeia lowIn→lowOut e
   * highIn→highOut (black point / white point) e aplica gamma no meio-tom.
   * Padrão PS: black 4% (≈10), white 96% (≈245) — clipping suave, sem estourar.
   */
  function buildToneLUT(lowIn, highIn, gamma = 1, lowOut = 8, highOut = 248) {
    const span = Math.max(1, highIn - lowIn);
    const out = new Array(256);
    for (let i = 0; i < 256; i++) {
      if (i <= lowIn) out[i] = lowOut;
      else if (i >= highIn) out[i] = highOut;
      else {
        const t = (i - lowIn) / span;
        out[i] = clamp255(lowOut + (highOut - lowOut) * Math.pow(t, 1 / gamma));
      }
    }
    return out;
  }

  /**
   * Aplica LUT mudando SÓ a luminância (preserva matiz e saturação).
   * Equivale a aplicar uma Curva com máscara de luminosidade no Photoshop.
   */
  function applyLutLuminosity(im, lut) {
    return pixelMap(im, (r, g, b) => {
      const L = luma(r, g, b);
      const L2 = lut[Math.round(L)];
      const k = L === 0 ? 0 : L2 / L;
      return [clamp255(r * k), clamp255(g * k), clamp255(b * k)];
    });
  }

  /**
   * Cast médio (gray world): desvio de cada canal em relação à luminância,
   * calculado só nos midtones (L 30..225) para não se enganar com
   * áreas dominadas por uma cor saturada. Retorna { dr, dg, db }.
   */
  function grayWorldCast(im) {
    const d = im.data;
    let sr = 0, sg = 0, sb = 0, sl = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const L = luma(r, g, b);
      if (L > 30 && L < 225) {
        sr += r; sg += g; sb += b; sl += L; n++;
      }
    }
    if (!n) return { dr: 0, dg: 0, db: 0 };
    const avgL = sl / n;
    return { dr: avgL - sr / n, dg: avgL - sg / n, db: avgL - sb / n };
  }

  /**
   * Aplica correção de cast com máscara de luminosidade: plena nos midtones,
   * reduzida em sombras/claros extremos — evita estourar e ficar "plástico".
   */
  function applyCast(im, cast, strength = 0.6) {
    const { dr, dg, db } = cast;
    return pixelMap(im, (r, g, b) => {
      const mask = Math.sin((luma(r, g, b) / 255) * Math.PI);
      const k = strength * (0.35 + 0.65 * mask);
      return [clamp255(r + dr * k), clamp255(g + dg * k), clamp255(b + db * k)];
    });
  }

  /**
   * Curva S suave (contraste perceptivo) — pontos de controle interpolação
   * linear, como Curves do Photoshop. Leve para não ficar artificial.
   */
  function sCurveLUT(strength = 0.6) {
    return lut([
      [0, 0],
      [64, 64 - 12 * strength],
      [128, 128 + 3 * strength],
      [192, 192 + 12 * strength],
      [255, 255],
    ]);
  }

  /**
   * Nitidez com máscara de luminosidade: detalhe = L - blur; aplica com peso
   * máximo no médio e ~0 nos extremos (protege sombras/claros → sem halos).
   */
  function sharpenLuminosity(im, amount = 0.6) {
    const w = im.width, h = im.height;
    const src = im.data;
    const lum = new Float32Array(w * h);
    const blurred = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        lum[y * w + x] = luma(src[i], src[i + 1], src[i + 2]);
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let ky = -1; ky <= 1; ky++)
          for (let kx = -1; kx <= 1; kx++)
            s += lum[(y + ky) * w + (x + kx)];
        blurred[y * w + x] = s / 9;
      }
    }
    const out = new Uint8ClampedArray(src.length);
    out.set(src);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const L = lum[idx];
        const detail = L - blurred[idx];
        const mask = Math.sin((L / 255) * Math.PI);
        const nL = clamp255(L + detail * amount * mask);
        const k = L === 0 ? 0 : nL / L;
        const pi = idx * 4;
        out[pi] = clamp255(src[pi] * k);
        out[pi + 1] = clamp255(src[pi + 1] * k);
        out[pi + 2] = clamp255(src[pi + 2] * k);
      }
    }
    im.data.set(out);
    return im;
  }

  /** Histograma de luminância de um ImageData. */
  function histOf(im) {
    const d = im.data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    return hist;
  }

  /**
   * Reduz um histograma de 256 bins para N bins (para desenhar em tela pequena).
   * Pura e testável — usado pelo histograma visual da aba Ajustes.
   */
  function histToBars(hist, bins) {
    bins = Math.max(1, Math.floor(bins));
    const out = new Array(bins).fill(0);
    const perBin = 256 / bins;
    for (let i = 0; i < 256; i++) {
      const b = Math.min(bins - 1, Math.floor(i / perBin));
      out[b] += hist[i] || 0;
    }
    return out;
  }

  /**
   * Correção ideal profissional (substitui o autoEnhance "estranho"):
   *  1. Balanço de branco (gray world) — força 0.5, máscara de luminosidade
   *  2. Auto Tone — black/white points (percentis) + gamma do midtone
   *  3. S-curve suave de contraste
   *  4. Saturação leve (só quando fora da faixa saudável)
   *  5. Nitidez com máscara de luminosidade (só quando necessário)
   * Tudo com força parcial (0.65) — o Photoshop não aplica 100% do Auto;
   * ele deixa espaço para o olho humano.
   */
  function autoEnhance(c, analysis) {
    const im = toImageData(c);
    const hist = (analysis && analysis.histogram) || histOf(im);
    const p1 = analysis && analysis.p1 != null ? analysis.p1 : percentile(hist, 1);
    const p50 = analysis && analysis.p50 != null ? analysis.p50 : percentile(hist, 50);
    const p99 = analysis && analysis.p99 != null ? analysis.p99 : percentile(hist, 99);

    // 1. balanço de branco (gray world) — neutro nos midtones
    applyCast(im, grayWorldCast(im), 0.5);

    // 2. tons: black/white points + gamma para levar o midtone ao alvo
    const lowIn = Math.max(0, Math.min(90, p1));
    const highIn = Math.min(255, Math.max(165, p99));
    const t = (p50 - lowIn) / Math.max(1, highIn - lowIn);
    const u = 128 / 255; // alvo: midtone perto de 128
    let gamma = 1;
    if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) {
      gamma = Math.max(0.6, Math.min(1.7, Math.log(t) / Math.log(u)));
    }
    const lutTone = buildToneLUT(lowIn, highIn, gamma);
    // força parcial: mistura com identidade (65% do ajuste)
    const strength = 0.65;
    for (let i = 0; i < 256; i++) lutTone[i] = Math.round(i + (lutTone[i] - i) * strength);
    applyLutLuminosity(im, lutTone);

    // 3. S-curve suave
    const s = (analysis && analysis.contrast != null ? analysis.contrast : 0.5) < 0.42 ? 0.5 : 0.35;
    applyLutLuminosity(im, sCurveLUT(s));

    // 4. saturação leve (nunca agressiva)
    const sat = analysis && analysis.saturation != null ? analysis.saturation : 0.5;
    if (sat < 0.32) {
      const k = 1 + (0.32 - sat) * 0.55;
      pixelMap(im, (r, g, b) => {
        const L = luma(r, g, b);
        return [clamp255(L + (r - L) * k), clamp255(L + (g - L) * k), clamp255(L + (b - L) * k)];
      });
    } else if (sat > 0.72) {
      const k = 1 - (sat - 0.72) * 0.4;
      pixelMap(im, (r, g, b) => {
        const L = luma(r, g, b);
        return [clamp255(L + (r - L) * k), clamp255(L + (g - L) * k), clamp255(L + (b - L) * k)];
      });
    }

    // 5. nitidez com máscara de luminosidade (só se a foto está macia)
    const sharp = analysis && analysis.sharpness != null ? analysis.sharpness : 0.15;
    if (sharp < 0.1) {
      sharpenLuminosity(im, 0.5);
    }

    return fromImageData(im);
  }

  /* ------------------------------------------------------------------ recorte (crop) */

  /**
   * Recorte puro em dados de pixel (testável em Node):
   * copia a região (x,y,w,h) de um ImageData e devolve { width, height, data }.
   */
  function cropData(im, x, y, w, h) {
    const d = im.data;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const si = ((y + row) * im.width + (x + col)) * 4;
        const di = (row * w + col) * 4;
        out[di] = d[si];
        out[di + 1] = d[si + 1];
        out[di + 2] = d[si + 2];
        out[di + 3] = d[si + 3];
      }
    }
    return { width: w, height: h, data: out };
  }

  /** Recorte de um canvas (usa drawImage — requer DOM, não roda em Node). */
  function crop(c, x, y, w, h) {
    x = Math.max(0, Math.min(c.width - 1, Math.round(x)));
    y = Math.max(0, Math.min(c.height - 1, Math.round(y)));
    w = Math.max(1, Math.min(c.width - x, Math.round(w)));
    h = Math.max(1, Math.min(c.height - y, Math.round(h)));
    const n = document.createElement('canvas');
    n.width = w;
    n.height = h;
    n.getContext('2d', { willReadFrequently: true }).drawImage(c, x, y, w, h, 0, 0, w, h);
    return n;
  }

  /* ------------------------------------------------------------------ filtros */

  const FILTERS = [
    ['original', 'Original'],
    ['vivid', 'Vívido'],
    ['auto', 'Correção ideal'],
    ['grayscale', 'P&B'],
    ['sepia', 'Sépia'],
    ['negative', 'Negativo'],
    ['blur', 'Blur'],
    ['sharpen', 'Nitidez'],
    ['emboss', 'Relevo'],
    ['edge', 'Bordas'],
    ['pixelate', 'Pixel'],
    ['posterize', 'Poster'],
    ['solarize', 'Solar'],
    ['vignette', 'Vinheta'],
    ['warm', 'Quente'],
    ['cool', 'Frio'],
    ['duotone', 'Duotone'],
    ['noise', 'Grão'],
    ['cartoon', 'Cartoon'],
    ['oil', 'Óleo'],
    ['hdr', 'HDR'],
    ['noir', 'Noir'],
    ['dreamy', 'Dreamy'],
    ['neon', 'Neon'],
    ['crossprocess', 'Cross-Process'],
    ['lomo', 'Lomo'],
    ['vintage', 'Vintage'],
  ];

  function applyFilter(c, name) {
    switch (name) {
      case 'original': return clone(c);
      case 'auto': {
        // correção ideal sem análise prévia (calcula o histograma local)
        const im = toImageData(c);
        const hist = histOf(im);
        const p1 = percentile(hist, 1), p50 = percentile(hist, 50), p99 = percentile(hist, 99);
        const contrast = (p99 - p1) / 255;
        const sat = saturationOf(im);
        const sharp = sharpnessOf(im);
        return autoEnhance(c, { histogram: hist, p1, p50, p99, contrast, saturation: sat, sharpness: sharp });
      }
      case 'vivid': return withFilter(c, 'saturate(1.18) contrast(1.05)');
      case 'grayscale': return withFilter(c, 'grayscale(1)');
      case 'sepia': return withFilter(c, 'sepia(0.8) contrast(1.08) brightness(1.04)');
      case 'negative': return withFilter(c, 'invert(1)');
      case 'blur': return withFilter(c, 'blur(3px)');
      case 'sharpen': {
        const im = toImageData(c);
        // kernel soma 1 (antes soma 2 clareava a imagem); nitidez com brilho preservado
        convolve(im, [0, -1, 0, -1, 5, -1, 0, -1, 0]);
        return fromImageData(im);
      }
      case 'emboss': {
        const im = toImageData(c);
        convolve(im, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 128);
        return fromImageData(im);
      }
      case 'edge': {
        const im = toImageData(c);
        convolve(im, [0, 1, 0, 1, -4, 1, 0, 1, 0], 1, 128);
        return fromImageData(im);
      }
      case 'pixelate': return pixelate(c, 12);
      case 'posterize': return posterize(c, 4);
      case 'solarize': return solarize(c, 128);
      case 'vignette': return vignette(c, 0.65);
      case 'warm': return applyTemperature(c, 0.35);
      case 'cool': return applyTemperature(c, -0.35);
      case 'duotone': return duotone(c, [23, 45, 99], [247, 183, 51]);
      case 'noise': return noise(c, 0.16);
      case 'cartoon': return cartoon(c);
      case 'oil': return oil(c);
      case 'hdr': return hdr(c);
      case 'noir': return noir(c);
      case 'dreamy': return dreamy(c);
      case 'neon': return neon(c);
      case 'crossprocess': return crossprocess(c);
      case 'lomo': return lomo(c);
      case 'vintage': return vintage(c);
      default: return clone(c);
    }
  }

  /** Saturação média 0..1 (usada pelo filtro auto sem análise prévia). Amostrado como sharpnessOf. */
  function saturationOf(im) {
    const d = im.data, w = im.width, h = im.height;
    const step = Math.max(2, Math.floor(Math.sqrt((w * h) / 40000)));
    let sum = 0, n = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sum += mx === 0 ? 0 : (mx - mn) / mx;
        n++;
      }
    }
    return n ? sum / n : 0.5;
  }

  /** Nitidez média 0..1 (gradiente diagonal, amostrado). */
  function sharpnessOf(im) {
    const d = im.data, w = im.width, h = im.height;
    const step = Math.max(2, Math.floor(Math.sqrt((w * h) / 40000)));
    let edge = 0, count = 0;
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        const i = (y * w + x) * 4;
        const L = luma(d[i], d[i + 1], d[i + 2]);
        const LR = luma(d[i + step * 4], d[i + step * 4 + 1], d[i + step * 4 + 2]);
        const LD = luma(d[i + step * w * 4], d[i + step * w * 4 + 1], d[i + step * w * 4 + 2]);
        edge += Math.abs(L - LR) + Math.abs(L - LD);
        count++;
      }
    }
    return count ? (edge / count) / 510 : 0.5;
  }

  function pixelate(c, size) {
    const n = document.createElement('canvas');
    n.width = c.width; n.height = c.height;
    const ctx = n.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, 0, 0, Math.max(2, c.width / size), Math.max(2, c.height / size));
    ctx.drawImage(n, 0, 0, Math.max(2, c.width / size), Math.max(2, c.height / size),
                 0, 0, c.width, c.height);
    return n;
  }

  function posterize(c, bits) {
    const im = toImageData(c);
    const levels = Math.max(2, Math.pow(2, bits)) - 1;
    pixelMap(im, (r, g, b) => [
      clamp255(Math.round(r / 255 * levels) / levels * 255),
      clamp255(Math.round(g / 255 * levels) / levels * 255),
      clamp255(Math.round(b / 255 * levels) / levels * 255),
    ]);
    return fromImageData(im);
  }

  function solarize(c, th) {
    const im = toImageData(c);
    pixelMap(im, (r, g, b) => [
      r > th ? 255 - r : r,
      g > th ? 255 - g : g,
      b > th ? 255 - b : b,
    ]);
    return fromImageData(im);
  }

  function vignette(c, strength = 0.65) {
    const n = clone(c);
    const ctx = n.getContext('2d');
    const w = n.width, h = n.height;
    const cx = w / 2, cy = h / 2;
    const maxR = Math.sqrt(cx * cx + cy * cy) || 1;
    const g = ctx.createRadialGradient(cx, cy, maxR * 0.35, cx, cy, maxR);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${Math.max(0, Math.min(1, strength))})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return n;
  }

  function duotone(c, shadow, highlight) {
    const im = toImageData(c);
    pixelMap(im, (r, g, b) => {
      const t = luma(r, g, b) / 255;
      return [
        clamp255(shadow[0] + (highlight[0] - shadow[0]) * t),
        clamp255(shadow[1] + (highlight[1] - shadow[1]) * t),
        clamp255(shadow[2] + (highlight[2] - shadow[2]) * t),
      ];
    });
    return fromImageData(im);
  }

  function noise(c, amount = 0.15) {
    const n = clone(c);
    const ctx = n.getContext('2d');
    const w = n.width, h = n.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = (Math.random() * 2 - 1) * 60 * amount;
      d[i] = clamp255(d[i] + g);
      d[i + 1] = clamp255(d[i + 1] + g);
      d[i + 2] = clamp255(d[i + 2] + g);
    }
    ctx.putImageData(img, 0, 0);
    return n;
  }

  function cartoon(c) {
    const flat = posterize(c, 4);
    const im = toImageData(flat);
    const w = im.width, h = im.height;
    const src = im.data;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const L = luma(src[i], src[i + 1], src[i + 2]);
        const gx = Math.abs(luma(src[i + 4], src[i + 5], src[i + 6]) - luma(src[i - 4], src[i - 3], src[i - 2]));
        const gy = Math.abs(luma(src[i + w * 4], src[i + w * 4 + 1], src[i + w * 4 + 2]) - luma(src[i - w * 4], src[i - w * 4 + 1], src[i - w * 4 + 2]));
        if (gx + gy > 120) { src[i] = 0; src[i + 1] = 0; src[i + 2] = 0; }
        else { src[i] = src[i + 1] = src[i + 2] = clamp255(L); }
      }
    }
    return fromImageData(im);
  }

  function oil(c) {
    let out = posterize(c, 3);
    return withFilter(out, 'blur(1.2px)');
  }

  function equalize(im) {
    const d = im.data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    const n = d.length / 4;
    let cdf = 0;
    const map = new Array(256);
    for (let v = 0; v < 256; v++) { cdf += hist[v]; map[v] = clamp255(cdf / n * 255); }
    for (let i = 0; i < d.length; i += 4) {
      const L = map[Math.round(luma(d[i], d[i + 1], d[i + 2]))];
      d[i] = clamp255(d[i] * L / Math.max(1, luma(d[i], d[i + 1], d[i + 2])));
      d[i + 1] = clamp255(d[i + 1] * L / Math.max(1, luma(d[i], d[i + 1], d[i + 2])));
      d[i + 2] = clamp255(d[i + 2] * L / Math.max(1, luma(d[i], d[i + 1], d[i + 2])));
    }
    return im;
  }

  function hdr(c) {
    const im = toImageData(c);
    equalize(im);
    convolve(im, [0, -1, 0, -1, 5, -1, 0, -1, 0]);
    return fromImageData(im);
  }

  function noir(c) {
    const im = toImageData(c);
    const d = im.data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = luma(d[i], d[i + 1], d[i + 2]);
      if (L < min) min = L; if (L > max) max = L;
    }
    const span = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      const v = clamp255((luma(d[i], d[i + 1], d[i + 2]) - min) / span * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return fromImageData(im);
  }

  function dreamy(c) {
    const n = clone(c);
    const ctx = n.getContext('2d');
    ctx.filter = 'blur(12px)';
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(c, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    return n;
  }

  function neon(c) {
    const im = toImageData(c);
    const w = im.width, h = im.height;
    const src = im.data;
    const edges = new Uint8ClampedArray(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const gx = Math.abs(luma(src[i + 4], src[i + 5], src[i + 6]) - luma(src[i - 4], src[i - 3], src[i - 2]));
        const gy = Math.abs(luma(src[i + w * 4], src[i + w * 4 + 1], src[i + w * 4 + 2]) - luma(src[i - w * 4], src[i - w * 4 + 1], src[i - w * 4 + 2]));
        edges[y * w + x] = Math.min(255, (gx + gy) * 3);
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const e = edges[y * w + x];
        if (e > 40) { src[i] = 0; src[i + 1] = clamp255(e); src[i + 2] = 255; }
        else { const v = Math.round(luma(src[i], src[i + 1], src[i + 2]) / 8); src[i] = src[i + 1] = src[i + 2] = v; }
      }
    }
    return fromImageData(im);
  }

  function crossprocess(c) {
    const im = toImageData(c);
    const d = im.data;
    const curveR = lut([[0, 10], [64, 60], [160, 200], [255, 255]]);
    const curveG = lut([[0, 20], [96, 110], [200, 235], [255, 255]]);
    const curveB = lut([[0, 90], [96, 150], [192, 205], [255, 235]]);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = curveR[d[i]];
      d[i + 1] = curveG[d[i + 1]];
      d[i + 2] = curveB[d[i + 2]];
    }
    return fromImageData(im);
  }

  function lut(points) {
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    const out = new Array(256);
    for (let i = 0; i < 256; i++) {
      if (i <= pts[0][0]) out[i] = pts[0][1];
      else if (i >= pts[pts.length - 1][0]) out[i] = pts[pts.length - 1][1];
      else {
        for (let k = 0; k < pts.length - 1; k++) {
          const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
          if (i >= x0 && i <= x1) {
            out[i] = clamp255(y0 + (y1 - y0) * (i - x0) / Math.max(1, x1 - x0));
            break;
          }
        }
      }
    }
    return out;
  }

  function lomo(c) {
    let out = withFilter(c, 'saturate(1.35)');
    return vignette(out, 0.8);
  }

  function vintage(c) {
    let out = withFilter(c, 'sepia(0.55) contrast(0.88) brightness(1.06)');
    return noise(out, 0.1);
  }

  /* ------------------------------------------------------------------ mesclagem */

  const BLEND_MODES = ['overlay', 'multiply', 'screen', 'soft-light', 'hard-light',
    'darken', 'lighten', 'difference', 'exclusion', 'color-dodge', 'color-burn',
    'hue', 'saturation', 'color', 'luminosity'];

  function blend(c, mode, prepName, opacity) {
    const base = c;
    const top = prepName === 'original' ? clone(c) : applyFilter(c, prepName);
    const n = document.createElement('canvas');
    n.width = base.width;
    n.height = base.height;
    const ctx = n.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0);
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.globalCompositeOperation = BLEND_MODES.includes(mode) ? mode : 'overlay';
    ctx.drawImage(top, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    return n;
  }

  /* ------------------------------------------------------------------ correção ideal */

  function autoEnhanceWithAnalysis(c, analysis) {
    return autoEnhance(c, analysis);
  }

  /* ------------------------------------------------------------------ estilos automáticos (presets) */

  /** Rótulos dos filtros (usados pelo styleLabel). */
  const FILTER_LABELS = Object.fromEntries(FILTERS);

  /**
   * Aplica um "estilo" gravado (filtro/ajuste/mesclagem/correção/moldura) a um canvas.
   * Recebe o snapshot serializado de uma operação anterior e reproduz em outra foto —
   * é o motor do "aplicar último estilo às fotos novas".
   */
  function applyStyle(c, style) {
    if (!style) return clone(c);
    switch (style.type) {
      case 'filter': return applyFilter(c, style.name);
      case 'adjust': return applyAdjust(c, style.factors || {});
      case 'blend': return blend(c, style.mode, style.prep, style.opacity);
      case 'auto': return applyFilter(c, 'auto'); // correção ideal (histograma local)
      case 'frame': return applyFrame(c, style.name);
      default: return clone(c);
    }
  }

  /** Descrição humana de um estilo (para a badge "Último estilo: ..."). Pura e testável. */
  function styleLabel(style) {
    if (!style) return null;
    switch (style.type) {
      case 'filter': return 'Filtro: ' + (FILTER_LABELS[style.name] || style.name);
      case 'adjust': return 'Ajustes (brilho/contraste/saturação/nitidez)';
      case 'blend': return 'Mesclagem: ' + (style.mode || '') + ' + ' + (style.prep || '');
      case 'auto': return 'Correção ideal (JARVIS)';
      case 'frame': return 'Moldura: ' + (FRAME_LABELS[style.name] || style.name);
      default: return 'Estilo';
    }
  }

  /* ------------------------------------------------------------------ molduras (frames) */

  const FRAMES = [
    ['none', 'Sem moldura'],
    ['classic', 'Clássica'],
    ['polaroid', 'Polaroid'],
    ['film', 'Filme'],
    ['double', 'Dupla'],
    ['vintage', 'Vintage'],
    ['neon', 'Neon'],
    ['gradient', 'Gradiente'],
    ['shadow', 'Sombra'],
    ['rounded', 'Cantos'],
    // ---- molduras com recorte (shaped) ----
    ['heart', 'Coração'],
    ['circle', 'Círculo'],
    ['oval', 'Oval'],
    ['star', 'Estrela'],
    ['hexagon', 'Hexágono'],
    // ---- molduras multi-slot (colagem) ----
    ['grid-2x2', 'Grade 2×2'],
    ['grid-1x2', 'Grade 1×2'],
    ['grid-2x1', 'Grade 2×1'],
    ['diptych', 'Díptico'],
    ['triptych', 'Tríptico'],
    ['collage-3', 'Colagem 3'],
    ['collage-4', 'Colagem 4'],
    ['collage-5', 'Colagem 5'],
  ];
  const FRAME_LABELS = Object.fromEntries(FRAMES);

  /**
   * Geometria pura da moldura: tamanho do canvas final (W,H) e deslocamento da foto (ox,oy).
   * Testável em Node sem canvas.
   */
  function frameLayout(w, h, type) {
    switch (type) {
      case 'classic': return { W: w + 32, H: h + 32, ox: 16, oy: 16 };
      case 'polaroid': return { W: w + 48, H: h + 114, ox: 24, oy: 24 };
      case 'film': return { W: w + 88, H: h + 88, ox: 44, oy: 44 };
      case 'double': return { W: w + 52, H: h + 52, ox: 26, oy: 26 };
      case 'vintage': return { W: w + 56, H: h + 56, ox: 28, oy: 28 };
      case 'neon': return { W: w + 36, H: h + 36, ox: 18, oy: 18 };
      case 'gradient': return { W: w + 40, H: h + 40, ox: 20, oy: 20 };
      case 'shadow': return { W: w + 72, H: h + 72, ox: 30, oy: 30 };
      case 'rounded': return { W: w + 16, H: h + 16, ox: 8, oy: 8 };
      // shaped: canvas quadrado que comporta a forma
      case 'heart':
      case 'circle':
      case 'oval':
      case 'star':
      case 'hexagon': {
        const size = Math.max(w, h) + 40; // padding 20 cada lado
        return { W: size, H: size, ox: (size - w) / 2, oy: (size - h) / 2 };
      }
      // multi-slot: grid com gap
      case 'grid-2x2':
      case 'grid-1x2':
      case 'grid-2x1': {
        const [cols, rows] = type.split('-')[1].split('x').map(Number);
        const gap = 8, pad = 16;
        const cellW = Math.floor(w / cols);
        const cellH = Math.floor(h / rows);
        const W = pad * 2 + cols * cellW + (cols - 1) * gap;
        const H = pad * 2 + rows * cellH + (rows - 1) * gap;
        return { W, H, ox: pad, oy: pad, cols, rows, cellW, cellH, gap };
      }
      case 'diptych': { // 2 vertical
        const gap = 8, pad = 16;
        const cellW = w, cellH = Math.floor(h / 2);
        const W = pad * 2 + cellW;
        const H = pad * 2 + 2 * cellH + gap;
        return { W, H, ox: pad, oy: pad, cols: 1, rows: 2, cellW, cellH, gap };
      }
      case 'triptych': { // 3 horizontal
        const gap = 8, pad = 16;
        const cellW = Math.floor(w / 3), cellH = h;
        const W = pad * 2 + 3 * cellW + 2 * gap;
        const H = pad * 2 + cellH;
        return { W, H, ox: pad, oy: pad, cols: 3, rows: 1, cellW, cellH, gap };
      }
      case 'collage-3': { // 1 grande + 2 pequenas
        const gap = 8, pad = 16;
        const bigW = Math.floor(w * 0.6), bigH = Math.floor(h * 0.6);
        const smallW = Math.floor((w - bigW - gap) / 2);
        const smallH = Math.floor((h - bigH - gap) / 2);
        const W = pad * 2 + Math.max(bigW, smallW * 2 + gap);
        const H = pad * 2 + Math.max(bigH, smallH * 2 + gap);
        return { W, H, ox: pad, oy: pad, layout: 'collage-3', bigW, bigH, smallW, smallH, gap };
      }
      case 'collage-4': { // 2x2 igual
        const gap = 8, pad = 16;
        const cellW = Math.floor((w - gap) / 2);
        const cellH = Math.floor((h - gap) / 2);
        const W = pad * 2 + 2 * cellW + gap;
        const H = pad * 2 + 2 * cellH + gap;
        return { W, H, ox: pad, oy: pad, cols: 2, rows: 2, cellW, cellH, gap };
      }
      case 'collage-5': { // 1 grande + 4 pequenas
        const gap = 8, pad = 16;
        const bigW = Math.floor(w * 0.65), bigH = Math.floor(h * 0.65);
        const smallW = Math.floor((w - bigW - gap) / 2);
        const smallH = Math.floor((h - bigH - gap) / 2);
        const W = pad * 2 + Math.max(bigW, smallW * 2 + gap);
        const H = pad * 2 + Math.max(bigH, smallH * 2 + gap);
        return { W, H, ox: pad, oy: pad, layout: 'collage-5', bigW, bigH, smallW, smallH, gap };
      }
      default: return { W: w, H: h, ox: 0, oy: 0 };
    }
  }

  /**
   * Constrói clipPath para formas shaped (pura, testável em Node - retorna array de comandos).
   * Cada comando: {type: 'moveTo'|'lineTo'|'arcTo'|'arc'|'bezierCurveTo'|'closePath', args: [...]}
   */
  function buildClipPath(type, w, h) {
    const cx = w / 2, cy = h / 2;
    switch (type) {
      case 'circle': return [
        { type: 'arc', args: [cx, cy, Math.min(w, h) / 2, 0, Math.PI * 2] }
      ];
      case 'oval': return [
        { type: 'ellipse', args: [cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2] }
      ];
      case 'heart': {
        // Coração clássico (curva canônica do Canvas/MDN): moveTo(75,40) + 6 bezierCurveTo.
        // Mapeado proporcionalmente para ocupar 84% de w×h com margens uniformes —
        // a forma inteira SEMPRE cabe no canvas (o antigo usava r = min/2*0.9 e o topo
        // em cy - 1.5r caía NEGATIVO para fotos paisagem → coração cortado/estranho).
        const u = w * 0.84, v = h * 0.84;
        const ox0 = (w - u) / 2, oy0 = (h - v) / 2;
        const X = n => ox0 + ((n - 20) / 110) * u; // x canônico 20..130 (largura 110)
        const Y = n => oy0 + ((n - 25) / 95) * v;  // y canônico 25..120 (altura 95)
        return [
          { type: 'moveTo', args: [X(75), Y(40)] },
          { type: 'bezierCurveTo', args: [X(75), Y(37), X(70), Y(25), X(50), Y(25)] },
          { type: 'bezierCurveTo', args: [X(20), Y(25), X(20), Y(62.5), X(20), Y(62.5)] },
          { type: 'bezierCurveTo', args: [X(20), Y(80), X(40), Y(102), X(75), Y(120)] },
          { type: 'bezierCurveTo', args: [X(110), Y(102), X(130), Y(80), X(130), Y(62.5)] },
          { type: 'bezierCurveTo', args: [X(130), Y(62.5), X(130), Y(25), X(100), Y(25)] },
          { type: 'bezierCurveTo', args: [X(85), Y(25), X(75), Y(37), X(75), Y(40)] }
        ];
      }
      case 'star': {
        const spikes = 5, outerR = Math.min(w, h) / 2 * 0.9, innerR = outerR * 0.45;
        const cmds = [{ type: 'moveTo', args: [cx, cy - outerR] }];
        for (let i = 1; i <= spikes * 2; i++) {
          const angle = (i * Math.PI) / spikes - Math.PI / 2;
          const r = i % 2 === 0 ? outerR : innerR;
          cmds.push({ type: 'lineTo', args: [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] });
        }
        cmds.push({ type: 'closePath', args: [] });
        return cmds;
      }
      case 'hexagon': {
        const r = Math.min(w, h) / 2 * 0.9;
        const cmds = [{ type: 'moveTo', args: [cx + r, cy] }];
        for (let i = 1; i < 6; i++) {
          const angle = (i * Math.PI * 2) / 6;
          cmds.push({ type: 'lineTo', args: [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] });
        }
        cmds.push({ type: 'closePath', args: [] });
        return cmds;
      }
      default: return [{ type: 'rect', args: [0, 0, w, h] }];
    }
  }

  /**
   * Geometria pura para frames multi-slot (retorna layout dos slots).
   * Testável em Node - não usa canvas.
   */
  function frameLayoutMulti(w, h, type, slotCount = 1) {
    const base = frameLayout(w, h, type);
    if (!base.cols && !base.rows && !base.layout) return { slots: [] };

    const pad = base.ox, gap = base.gap || 8;
    const slots = [];

    if (base.cols && base.rows) {
      // grid regular
      for (let r = 0; r < base.rows; r++) {
        for (let c = 0; c < base.cols; c++) {
          slots.push({
            x: pad + c * (base.cellW + gap),
            y: pad + r * (base.cellH + gap),
            w: base.cellW,
            h: base.cellH
          });
        }
      }
    } else if (base.layout === 'collage-3') {
      // 1 grande no canto sup-esq + 2 pequenas ao lado/embaixo
      slots.push({ x: pad, y: pad, w: base.bigW, h: base.bigH });
      slots.push({ x: pad + base.bigW + gap, y: pad, w: base.smallW, h: base.smallH });
      slots.push({ x: pad + base.bigW + gap, y: pad + base.smallH + gap, w: base.smallW, h: base.smallH });
    } else if (base.layout === 'collage-5') {
      // 1 grande + 4 pequenas (2x2 no lado direito)
      slots.push({ x: pad, y: pad, w: base.bigW, h: base.bigH });
      slots.push({ x: pad + base.bigW + gap, y: pad, w: base.smallW, h: base.smallH });
      slots.push({ x: pad + base.bigW + gap, y: pad + base.smallH + gap, w: base.smallW, h: base.smallH });
      slots.push({ x: pad, y: pad + base.bigH + gap, w: base.smallW, h: base.smallH });
      slots.push({ x: pad + base.smallW + gap, y: pad + base.bigH + gap, w: base.smallW, h: base.smallH });
    }
    return { W: base.W, H: base.H, slots };
  }

  /**
   * Aplica moldura ao canvas (usa drawImage/2D — não roda em Node; testar frameLayout).
   * Cada tipo desenha a borda característica ao redor da foto.
   */
  function applyFrame(c, type) {
    const { W, H, ox, oy } = frameLayout(c.width, c.height, type);
    const n = document.createElement('canvas');
    n.width = W;
    n.height = H;
    const ctx = n.getContext('2d');
    const w = c.width, h = c.height;
    const rounded = (x, y, rw, rh, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + rw, y, x + rw, y + rh, r);
      ctx.arcTo(x + rw, y + rh, x, y + rh, r);
      ctx.arcTo(x, y + rh, x, y, r);
      ctx.arcTo(x, y, x + rw, y, r);
      ctx.closePath();
    };
    switch (type) {
      // ---- molduras shaped (recortam a foto na forma) ----
      case 'heart':
      case 'circle':
      case 'oval':
      case 'star':
      case 'hexagon': {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        // clipPath centralizado
        const cmds = buildClipPath(type, w, h);
        ctx.save();
        ctx.translate(ox, oy);
        execClipPath(ctx, cmds);
        ctx.clip();
        // drawImage com preserveAspect crop
        const scale = Math.min(w / w, h / h); // preenche o círculo
        ctx.drawImage(c, 0, 0, w, h);
        ctx.restore();
        // borda decorativa
        ctx.strokeStyle = '#1B2637';
        ctx.lineWidth = 3;
        ctx.translate(ox, oy);
        execClipPath(ctx, cmds);
        ctx.stroke();
        ctx.translate(-ox, -oy);
        break;
      }
      // ---- molduras multi-slot (colagem) ----
      case 'grid-2x2':
      case 'grid-1x2':
      case 'grid-2x1':
      case 'diptych':
      case 'triptych':
      case 'collage-3':
      case 'collage-4':
      case 'collage-5':
        // delegate: caller must use applyFrameMulti with fotos dos slots
        // se chamado direto (1 foto), replica a mesma foto em todos os slots
        return applyFrameMulti(c, type);
      // ---- molduras clássicas (bordas) ----
      case 'none':
        ctx.drawImage(c, 0, 0);
        break;
      case 'classic':
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(c, ox, oy);
        ctx.strokeStyle = '#1B2637';
        ctx.lineWidth = 2;
        ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
        break;
      case 'polaroid': {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 10;
        ctx.fillRect(ox, oy, w, h);
        ctx.shadowBlur = 0;
        ctx.drawImage(c, ox, oy);
        break;
      }
      case 'film': {
        ctx.fillStyle = '#0B0F14';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(c, ox, oy);
        const holes = Math.max(4, Math.floor(W / 90));
        const holeW = 30, holeH = 12;
        const gap = (W - holes * holeW) / (holes + 1);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (let i = 0; i < holes; i++) {
          const x = gap + i * (holeW + gap);
          ctx.fillRect(x, 12, holeW, holeH);
          ctx.fillRect(x, H - 24, holeW, holeH);
        }
        break;
      }
      case 'double':
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(c, ox, oy);
        ctx.strokeStyle = '#1B2637';
        ctx.lineWidth = 3;
        ctx.strokeRect(ox - 12, oy - 12, w + 24, h + 24);
        break;
      case 'vintage':
        ctx.fillStyle = '#F1E8D5';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(c, ox, oy);
        ctx.strokeStyle = '#9C8B6A';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox - 14, oy - 14, w + 28, h + 28);
        break;
      case 'neon':
        ctx.fillStyle = '#0A0F18';
        ctx.fillRect(0, 0, W, H);
        ctx.shadowColor = '#00E5FF';
        ctx.shadowBlur = 26;
        ctx.strokeStyle = '#00E5FF';
        ctx.lineWidth = 5;
        ctx.strokeRect(ox - 3, oy - 3, w + 6, h + 6);
        ctx.shadowBlur = 0;
        ctx.drawImage(c, ox, oy);
        break;
      case 'gradient': {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#1B2637');
        g.addColorStop(1, '#2D4A6E');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(ox - 4, oy - 4, w + 8, h + 8);
        ctx.drawImage(c, ox, oy);
        break;
      }
      case 'shadow':
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        ctx.shadowColor = 'rgba(0,0,0,0.30)';
        ctx.shadowBlur = 18;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(ox + 8, oy + 8, w, h);
        ctx.shadowBlur = 0;
        ctx.drawImage(c, ox, oy);
        break;
      case 'rounded': {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        rounded(ox, oy, w, h, 22);
        ctx.clip();
        ctx.drawImage(c, ox, oy);
        break;
      }
      default:
        ctx.drawImage(c, ox, oy);
    }
    return n;
  }

  /** Executa os comandos de clipPath no contexto (helper DOM). */
  function execClipPath(ctx, cmds) {
    ctx.beginPath();
    for (const cmd of cmds) {
      switch (cmd.type) {
        case 'moveTo': ctx.moveTo(...cmd.args); break;
        case 'lineTo': ctx.lineTo(...cmd.args); break;
        case 'arc': ctx.arc(...cmd.args); break;
        case 'ellipse': ctx.ellipse(...cmd.args); break;
        case 'bezierCurveTo': ctx.bezierCurveTo(...cmd.args); break;
        case 'rect': ctx.rect(...cmd.args); break;
        case 'closePath': ctx.closePath(); break;
      }
    }
  }

  /**
   * Aplica moldura multi-slot (colagem) — recebe a foto e replica em todos os slots,
   * ou um array de fotos (uma por slot). Usa drawImage com preserveAspect em cada slot.
   */
  function applyFrameMulti(c, type, photos) {
    const w = c.width, h = c.height;
    const { W, H, slots } = frameLayoutMulti(w, h, type);
    if (!slots.length) return clone(c);
    const srcList = photos && photos.length ? photos : new Array(slots.length).fill(c);
    const n = document.createElement('canvas');
    n.width = W;
    n.height = H;
    const ctx = n.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);
    slots.forEach((slot, i) => {
      const src = srcList[i % srcList.length] || c;
      // preserveAspect: preenche o slot mantendo proporção
      const scale = Math.min(slot.w / src.width, slot.h / src.height, 1);
      const dw = Math.round(src.width * scale);
      const dh = Math.round(src.height * scale);
      const dx = slot.x + Math.round((slot.w - dw) / 2);
      const dy = slot.y + Math.round((slot.h - dh) / 2);
      // borda do slot
      ctx.strokeStyle = '#DDE3EB';
      ctx.lineWidth = 1;
      ctx.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1);
      ctx.drawImage(src, dx, dy, dw, dh);
    });
    return n;
  }

  /* ------------------------------------------------------------------ assinatura */

  /**
   * Retângulo puro da assinatura por IMAGEM (testável em Node).
   * Altura = settings.size (px), largura proporcional; posição resolve dos presets.
   */
  function signatureImageRect(settings, canvasW, canvasH, imgW, imgH) {
    const pad = 24;
    const pos = settings.position || 'bottom-right';
    const h = Math.max(10, Math.round(settings.size));
    const w = h * (imgW / imgH);
    const x = { 'top-left': pad, 'top-right': canvasW - pad - w, 'top-center': (canvasW - w) / 2,
                'bottom-left': pad, 'bottom-right': canvasW - pad - w, 'bottom-center': (canvasW - w) / 2,
                'center': (canvasW - w) / 2 };
    const y = { 'top-left': pad, 'top-right': pad, 'top-center': pad,
                'bottom-left': canvasH - pad - h, 'bottom-right': canvasH - pad - h, 'bottom-center': canvasH - pad - h,
                'center': (canvasH - h) / 2 };
    return { x: x[pos] ?? pad, y: y[pos] ?? pad, w, h };
  }

  function watermark(ctx, settings, w, h, imageEl) {
    if (!settings.enabled) return;
    const alpha = Math.max(0, Math.min(1, settings.opacity));

    // modo IMAGEM: desenha a logo/assinatura PNG (mantém proporção)
    if (settings.mode === 'image') {
      if (!imageEl) return;
      const iw = imageEl.naturalWidth || imageEl.width || 0;
      const ih = imageEl.naturalHeight || imageEl.height || 0;
      if (!iw || !ih) return;
      const r = signatureImageRect(settings, w, h, iw, ih);
      if (r.w <= 0 || r.h <= 0) return;
      if (settings.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8; }
      ctx.globalAlpha = alpha;
      ctx.drawImage(imageEl, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      return;
    }

    // modo TEXTO
    if (!settings.text) return;
    const pad = 24;
    const size = Math.max(10, Math.round(settings.size));
    ctx.font = `${size}px ${settings.font}`;
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(settings.text).width;
    const x = { 'top-left': pad, 'top-right': w - pad - tw, 'top-center': (w - tw) / 2,
                'bottom-left': pad, 'bottom-right': w - pad - tw, 'bottom-center': (w - tw) / 2,
                'center': (w - tw) / 2 };
    const y = { 'top-left': pad + size / 2, 'top-right': pad + size / 2, 'top-center': pad + size / 2,
                'bottom-left': h - pad - size / 2, 'bottom-right': h - pad - size / 2, 'bottom-center': h - pad - size / 2,
                'center': h / 2 };
    const pos = settings.position || 'bottom-right';
    if (settings.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8; }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = settings.color || '#ffffff';
    ctx.fillText(settings.text, x[pos] ?? pad, y[pos] ?? h - pad - size / 2);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  /* ------------------------------------------------------------------ export */

  function exportCanvas(c, format, quality, settings, withWatermark, cb, imageEl) {
    const n = document.createElement('canvas');
    n.width = c.width;
    n.height = c.height;
    const ctx = n.getContext('2d');
    ctx.drawImage(c, 0, 0);
    if (withWatermark) watermark(ctx, settings, n.width, n.height, imageEl);
    n.toBlob((blob) => cb(blob), `image/${format}`, quality || 0.92);
  }

  return {
    fromImage, clone, toImageData, fromImageData,
    applyAdjust, applyFilter, blend, autoEnhance,
    watermark, exportCanvas, FILTERS, BLEND_MODES, pixelMap, convolve, luma,
    clamp255, applyTemperature, duotone, posterize, solarize, equalize, noir,
    signatureImageRect,
    // presets de correção (dados puros testáveis em Node)
    PRESETS, presetFactors, applyPreset,
    // motor profissional (puro, testável)
    percentile, buildToneLUT, applyLutLuminosity, grayWorldCast, applyCast,
    sCurveLUT, sharpenLuminosity, histOf, saturationOf, histToBars,
    // recorte
    crop, cropData,
    // estilos automáticos + molduras (bordas, shaped, multi-slot)
    applyStyle, styleLabel, FRAMES, FRAME_LABELS,
    frameLayout, applyFrame, buildClipPath, frameLayoutMulti, applyFrameMulti, execClipPath,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Editor;
