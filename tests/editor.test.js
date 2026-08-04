/* Testes do Editor (motor de imagem) — node:test, sem DOM.
 *
 * Testa apenas as funções puras que operam sobre ImageData-like
 * sem necessidade de canvas: pixelMap, convolve, clamp255, luma.
 *
 * Funções que dependem de canvas (applyTemperature, duotone,
 * posterize, solarize, noir, equalize) são testadas via
 * analyzer.test.js e captions.test.js que cobrem a lógica.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Editor = require('../js/editor.js');
const Analyzer = require('../js/analyzer.js');

function solidImageData(w, h, r, g, b) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

function stripedImageData(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x % 2 === 0 ? 255 : 0;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// ---- funções utilitárias puras ----

test('clamp255 limita valores ao intervalo 0..255', () => {
  assert.equal(Editor.clamp255(-10), 0);
  assert.equal(Editor.clamp255(300), 255);
  assert.equal(Editor.clamp255(128), 128);
});

test('luma calcula luminância corretamente', () => {
  assert.equal(Editor.luma(255, 255, 255), 255);
  assert.equal(Editor.luma(0, 0, 0), 0);
  const gray = Editor.luma(128, 128, 128);
  assert.ok(gray > 127 && gray < 129, `luma(128,128,128) = ${gray}`);
});

test('pixelMap aplica função a cada pixel', () => {
  const im = solidImageData(4, 4, 100, 150, 200);
  const result = Editor.pixelMap(im, (r, g, b) => [r + 10, g + 10, b + 10]);
  assert.equal(result.data[0], 110);
  assert.equal(result.data[1], 160);
  assert.equal(result.data[2], 210);
});

test('pixelMap não altera alpha', () => {
  const im = solidImageData(2, 2, 100, 100, 100);
  Editor.pixelMap(im, (r, g, b) => [0, 0, 0]);
  assert.equal(im.data[3], 255);
});

// ---- convolve ----

test('convolve com kernel identidade preserva imagem uniforme', () => {
  const im = solidImageData(4, 4, 128, 128, 128);
  Editor.convolve(im, [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(im.data[0], 128);
  assert.equal(im.data[1], 128);
  assert.equal(im.data[2], 128);
});

test('convolve com kernel de borda detecta transições', () => {
  const im = stripedImageData(8, 8);
  const before = im.data[4]; // pixel ao lado da borda
  Editor.convolve(im, [0, -1, 0, -1, 4, -1, 0, -1, 0]);
  // Bordas internas devem ter valores diferentes do original
  // (o convolve processa pixels internos y=1..h-2, x=1..w-2)
  // Para a imagem de tiras verticais, pixels internos na borda terão valor alterado
  let changed = 0;
  for (let i = 0; i < im.data.length; i += 4) {
    if (im.data[i] !== before) changed++;
  }
  assert.ok(changed > 0, `esperado que alguns pixels mudassem, ${changed} mudaram`);
});

// ---- Analyzer (cobertura adicional via editor.test.js) ----

test('Analyzer.analyze retorna estrutura completa', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 128, 128, 128));
  assert.equal(typeof a.brightness, 'number');
  assert.equal(typeof a.saturation, 'number');
  assert.equal(typeof a.contrast, 'number');
  assert.equal(typeof a.sharpness, 'number');
  assert.equal(typeof a.temperature, 'number');
  assert.equal(typeof a.noiseLevel, 'number');
  assert.equal(typeof a.dominance, 'string');
  assert.equal(typeof a.mood, 'string');
  assert.ok(Array.isArray(a.histogram));
  assert.equal(a.histogram.length, 256);
  assert.equal(typeof a.compositionBias, 'string');
});

test('Analyzer.diagnose retorna items e score 0..100', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 128, 128, 128));
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

test('Analyzer.recommend retorna recomendações não vazias', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 128, 128, 128));
  const recs = Analyzer.recommend(a);
  assert.ok(Array.isArray(recs));
  assert.ok(recs.length > 0);
  for (const rec of recs) {
    assert.ok(rec.type && typeof rec.type === 'string');
    assert.ok(rec.label && typeof rec.label === 'string');
    assert.ok(rec.reason && typeof rec.reason === 'string');
  }
});

test('Analyzer.opinion retorna string não vazia', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 128, 128, 128));
  const opinion = Analyzer.opinion(a);
  assert.ok(typeof opinion === 'string');
  assert.ok(opinion.length > 0);
  assert.ok(opinion.includes('100')); // deve conter a nota
});

test('Analyzer.suggestAdjustments retorna valores dentro dos limites', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 128, 128, 128));
  const sug = Analyzer.suggestAdjustments(a);
  assert.ok(sug.brightness >= 0.5 && sug.brightness <= 2.4);
  assert.ok(sug.contrast >= 0.88 && sug.contrast <= 1.28);
  assert.ok(sug.saturation >= 0.85 && sug.saturation <= 1.45);
  assert.ok(sug.sharpness >= 1.0 && sug.sharpness <= 1.5);
  assert.ok(sug.temperature >= -1 && sug.temperature <= 1);
});

test('Analyzer.analyze imagem escura tem mood sombrio', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 10, 10, 10));
  assert.equal(a.mood, 'sombrio');
  assert.ok(a.brightness < 0.2);
});

test('Analyzer.analyze imagem vibrante tem mood vibrante', () => {
  // precisa de brightness > 0.45 E saturation > 0.55
  // (200, 100, 50): L ≈ 0.299*200 + 0.587*100 + 0.114*50 = 59.8+58.7+5.7 = 124.2 → 0.487
  // sat = (200-50)/200 = 0.75
  const a = Analyzer.analyze(solidImageData(8, 8, 200, 100, 50));
  assert.equal(a.mood, 'vibrante');
});

test('Analyzer.recommend inclui recomendação de filtro para mood vibrante', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 220, 50, 50));
  const recs = Analyzer.recommend(a);
  const filterRec = recs.find(r => r.type === 'filter');
  assert.ok(filterRec, 'deveria ter recomendação de filtro');
});

test('Analyzer.recommend inclui recomendação de ajuste para foto escura', () => {
  const a = Analyzer.analyze(solidImageData(8, 8, 10, 10, 10));
  const recs = Analyzer.recommend(a);
  const adjustRec = recs.find(r => r.type === 'adjust' && r.label === 'Clarear suavemente');
  assert.ok(adjustRec, 'deveria ter recomendação de clarear');
});

// ---- motor profissional (Photoshop-like) ----

test('percentile encontra o percentil correto no histograma', () => {
  const hist = new Array(256).fill(0);
  hist[100] = 100; hist[200] = 100;
  assert.equal(Editor.percentile(hist, 1), 100);
  assert.equal(Editor.percentile(hist, 50), 100);
  assert.equal(Editor.percentile(hist, 99), 200);
  assert.equal(Editor.percentile(new Array(256).fill(0), 50), 128); // vazio → 128
});

test('buildToneLUT mapeia black/white points com gamma', () => {
  const lut = Editor.buildToneLUT(20, 200, 1, 8, 248);
  assert.equal(lut[0], 8);
  assert.equal(lut[20], 8);
  assert.equal(lut[200], 248);
  assert.equal(lut[255], 248);
  // meio do range 20..200 = 110 → 128
  assert.ok(Math.abs(lut[110] - 128) <= 2, `lut[110] = ${lut[110]}`);
  // monotônica
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], `não-monotônica em ${i}`);
});

test('applyLutLuminosity preserva cor e muda luminância (máscara de luminosidade)', () => {
  const im = solidImageData(8, 8, 100, 150, 200);
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) lut[i] = clamp(i * 1.5, 0, 255);
  Editor.applyLutLuminosity(im, lut);
  // proporção entre canais preservada (cor mantida)
  assert.ok(im.data[1] > im.data[0], 'g continua maior que r');
  assert.ok(im.data[2] > im.data[1], 'b continua maior que g');
  // luminância subiu (dobrou)
  const Lbefore = Editor.luma(100, 150, 200);
  const Lafter = Editor.luma(im.data[0], im.data[1], im.data[2]);
  assert.ok(Lafter > Lbefore, `luminância deveria subir: ${Lbefore} → ${Lafter}`);
});

test('grayWorldCast detecta cast amarelo (azul abaixo da média)', () => {
  // imagem com muito amarelo (r,g altos, b baixo)
  const im = solidImageData(16, 16, 210, 200, 140);
  const cast = Editor.grayWorldCast(im);
  assert.ok(cast.db > cast.dr, `db=${cast.db} deveria ser > dr=${cast.dr}`);
  assert.ok(cast.dr <= 0.1 && cast.dg <= 0.1, 'r/g próximos da média');
});

test('grayWorldCast ignora pixels de luminância extrema', () => {
  const im = solidImageData(16, 16, 255, 255, 255); // branco puro (L=255, fora do range)
  const cast = Editor.grayWorldCast(im);
  assert.equal(cast.dr, 0);
  assert.equal(cast.dg, 0);
  assert.equal(cast.db, 0);
});

test('applyCast corrige na direção do cast', () => {
  const im = solidImageData(8, 8, 210, 200, 140);
  const cast = Editor.grayWorldCast(im);
  const before = im.data[2]; // azul
  Editor.applyCast(im, cast, 0.5);
  assert.ok(im.data[2] > before, `azul deveria subir: ${before} → ${im.data[2]}`);
});

test('sCurveLUT é S suave: escurece sombras, clareia claros', () => {
  const lut = Editor.sCurveLUT(0.6);
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 255);
  assert.ok(lut[64] < 64, `lut[64] = ${lut[64]} deveria escurecer sombras`);
  assert.ok(lut[192] > 192, `lut[192] = ${lut[192]} deveria clarear claros`);
  // monotônica (sem inverter tons)
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1]);
});

test('histOf calcula histograma de luminância', () => {
  const im = solidImageData(4, 4, 100, 100, 100);
  const hist = Editor.histOf(im);
  assert.equal(hist.length, 256);
  const total = hist.reduce((s, v) => s + v, 0);
  assert.equal(total, 16);
  assert.equal(hist[100], 16);
});

// ---- recorte (crop) ----

test('cropData recorta a região correta de um ImageData', () => {
  // imagem 4x4 com cor por posição: r = x*50, g = y*50, b = 0
  const w = 4, h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x * 50; data[i + 1] = y * 50; data[i + 2] = 0; data[i + 3] = 255;
    }
  }
  const im = { width: w, height: h, data };
  const cut = Editor.cropData(im, 1, 1, 2, 2);
  assert.equal(cut.width, 2);
  assert.equal(cut.height, 2);
  // canto (0,0) do recorte = pixel original (1,1): r=50, g=50
  assert.equal(cut.data[0], 50);
  assert.equal(cut.data[1], 50);
  // canto (1,1) do recorte = pixel original (2,2): r=100, g=100
  assert.equal(cut.data[(1 * 2 + 1) * 4], 100);
  assert.equal(cut.data[(1 * 2 + 1) * 4 + 1], 100);
});

test('cropData preserva alpha e funciona com recorte parcial', () => {
  const im = stripedImageData(6, 4);
  const cut = Editor.cropData(im, 2, 1, 3, 2);
  assert.equal(cut.width, 3);
  assert.equal(cut.height, 2);
  // x=2 do original é par → 255 (tira branca); x=3 é ímpar → 0
  assert.equal(cut.data[0], 255);
  assert.equal(cut.data[4], 0);
  assert.equal(cut.data[3], 255); // alpha preservado
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }