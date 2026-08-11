/* Testes do Analyzer (IA local do JARVIS) — node:test, sem DOM. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Analyzer = require('../js/analyzer.js');

/** Cria um ImageData-like com cor uniforme (RGBA). */
function solid(w, h, [r, g, b]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** Imagem cinza uniforme com listras de alto contraste apenas na região dada. */
function detailRegion(w, h, rx, ry, rw, rh) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 128;
      if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
        v = (y % 2) ? 40 : 220; // listras horizontais: gradiente forte em y
      }
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/* ------------------------------------------------------- suggestCrop */

test('suggestCrop: sujeito no canto inferior direito → terço (2,2)', () => {
  const im = detailRegion(90, 60, 60, 40, 30, 20);
  const c = Analyzer.suggestCrop(im);
  assert.deepEqual(c, { x: 60, y: 40, w: 30, h: 20 });
});

test('suggestCrop: sujeito no canto superior esquerdo → terço (0,0)', () => {
  const im = detailRegion(90, 60, 0, 0, 30, 20);
  const c = Analyzer.suggestCrop(im);
  assert.deepEqual(c, { x: 0, y: 0, w: 30, h: 20 });
});

test('suggestCrop: imagem uniforme → terço central', () => {
  const c = Analyzer.suggestCrop(solid(90, 60, [128, 128, 128]));
  assert.deepEqual(c, { x: 30, y: 20, w: 30, h: 20 });
});

test('suggestCrop: imagem pequena devolve a imagem inteira', () => {
  const im = solid(8, 8, [10, 20, 30]);
  assert.deepEqual(Analyzer.suggestCrop(im), { x: 0, y: 0, w: 8, h: 8 });
});

/* ------------------------------------------------------- rankFrames */

test('rankFrames: foto nítida (listras) ranqueia acima da uniforme (desfocada)', () => {
  const nitida = detailRegion(64, 48, 8, 8, 48, 32); // alto contraste
  const chapada = solid(64, 48, [128, 128, 128]); // sem detalhe
  const ranked = Analyzer.rankFrames([chapada, nitida]);
  assert.equal(ranked[0].index, 1, 'nítida deve vir primeiro');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].score > 0 && ranked[0].score <= 100);
});

test('rankFrames: preserva índices originais e ordena decrescente', () => {
  const frames = [
    detailRegion(64, 48, 8, 8, 48, 32),
    solid(64, 48, [128, 128, 128]),
    detailRegion(64, 48, 20, 10, 30, 25),
  ];
  const ranked = Analyzer.rankFrames(frames);
  assert.equal(ranked.length, 3);
  assert.deepEqual(ranked.map(r => r.index).sort(), [0, 1, 2]);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, 'ordem decrescente');
  }
});

test('rankFrames: lote vazio devolve array vazio', () => {
  assert.deepEqual(Analyzer.rankFrames([]), []);
});

test('rankFrames: frames idênticos têm scores iguais', () => {
  const a = detailRegion(64, 48, 8, 8, 48, 32);
  const b = detailRegion(64, 48, 8, 8, 48, 32);
  const ranked = Analyzer.rankFrames([a, b]);
  assert.equal(ranked[0].score, ranked[1].score);
});

test('imagem clara tem brightness alto e contraste ~0', () => {
  const a = Analyzer.analyze(solid(32, 32, [200, 200, 200]));
  assert.ok(a.brightness > 0.7, `brightness ${a.brightness}`);
  assert.ok(a.contrast < 0.2, `contrast ${a.contrast}`);
  assert.equal(a.width, 32);
  assert.equal(a.height, 32);
});

test('imagem escura tem brightness baixo', () => {
  const a = Analyzer.analyze(solid(32, 32, [25, 25, 25]));
  assert.ok(a.brightness < 0.2, `brightness ${a.brightness}`);
});

test('imagem quente é detectada como dominante quente', () => {
  const a = Analyzer.analyze(solid(32, 32, [255, 190, 110]));
  assert.equal(a.dominance, 'quente');
  assert.ok(a.temperature > 0);
});

test('imagem fria é detectada como dominante fria', () => {
  const a = Analyzer.analyze(solid(32, 32, [70, 110, 220]));
  assert.equal(a.dominance, 'frio');
  assert.ok(a.temperature < 0);
});

test('imagem uniforme tem nitidez ~0', () => {
  const a = Analyzer.analyze(solid(32, 32, [128, 128, 128]));
  assert.ok(a.sharpness < 0.01, `sharpness ${a.sharpness}`);
});

test('imagem com alto detalhe tem nitidez > 0', () => {
  const w = 32, h = 32;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x % 2 === 0 ? 255 : 0; // tiras verticais de 1px
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const a = Analyzer.analyze({ data, width: w, height: h });
  assert.ok(a.sharpness > 0.5, `sharpness ${a.sharpness}`);
});

test('histograma soma ~número de amostras e tem 256 bins', () => {
  const a = Analyzer.analyze(solid(40, 40, [90, 90, 90]));
  assert.equal(a.histogram.length, 256);
  const total = a.histogram.reduce((s, v) => s + v, 0);
  assert.ok(total > 0);
  assert.equal(total, a.sampleCount);
});

test('diagnose retorna items e score 0..100', () => {
  const a = Analyzer.analyze(solid(32, 32, [128, 128, 128]));
  const d = Analyzer.diagnose(a);
  assert.ok(Array.isArray(d.items));
  assert.ok(d.items.length >= 3);
  assert.ok(d.score >= 0 && d.score <= 100);
  for (const item of d.items) {
    assert.ok(['ok', 'warn', 'bad'].includes(item.level));
    assert.equal(typeof item.text, 'string');
    assert.ok(item.text.length > 0);
  }
});

test('foto escura recebe diagnóstico bad de exposição', () => {
  const a = Analyzer.analyze(solid(32, 32, [10, 10, 10]));
  const d = Analyzer.diagnose(a);
  const exp = d.items.find(i => i.text.includes('subexposta'));
  assert.ok(exp, 'deveria acusar subexposição');
  assert.equal(exp.level, 'bad');
});

test('suggestAdjustments: foto escura clareia, saturada modera', () => {
  const escura = Analyzer.analyze(solid(32, 32, [30, 30, 30]));
  const sugEsc = Analyzer.suggestAdjustments(escura);
  assert.ok(sugEsc.brightness > 1, `brightness ${sugEsc.brightness}`);
  assert.ok(sugEsc.brightness <= 2.4);

  const saturada = { ...Analyzer.analyze(solid(32, 32, [200, 20, 20])), saturation: 0.8 };
  const sugSat = Analyzer.suggestAdjustments(saturada);
  assert.ok(sugSat.saturation < 1, `saturation ${sugSat.saturation}`);
});

test('suggestAdjustments: valores dentro dos limites 0.5..2.4', () => {
  const a = Analyzer.analyze(solid(32, 32, [128, 128, 128]));
  const sug = Analyzer.suggestAdjustments(a);
  assert.ok(sug.brightness >= 0.5 && sug.brightness <= 2.4);
  assert.ok(sug.contrast >= 0.88 && sug.contrast <= 1.28);
  assert.ok(sug.saturation >= 0.85 && sug.saturation <= 1.45);
  assert.ok(sug.sharpness >= 1.0 && sug.sharpness <= 1.5);
});

test('describe mapeia mood/tone/period/intensity', () => {
  const vibrante = Analyzer.describe({
    saturation: 0.7, brightness: 0.7, temperature: 0.3, contrast: 0.7,
  });
  assert.equal(vibrante.mood, 'vibrante');
  assert.equal(vibrante.tone, 'quente');
  assert.equal(vibrante.period, 'dia');
  assert.equal(vibrante.intensity, 'forte');

  const sombrio = Analyzer.describe({
    saturation: 0.1, brightness: 0.1, temperature: -0.4, contrast: 0.3,
  });
  assert.equal(sombrio.mood, 'sombrio');
  assert.equal(sombrio.period, 'noite');
});
