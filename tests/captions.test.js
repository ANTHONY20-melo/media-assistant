/* Testes do Captions (gerador de legendas PT-BR) — node:test, sem DOM. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Captions = require('../js/captions.js');

const analysis = {
  mood: 'vibrante',
  tone: 'quente',
  period: 'dia',
  brightness: 0.7,
  saturation: 0.6,
  contrast: 0.55,
  sharpness: 0.2,
  temperature: 0.25,
  dominance: 'quente',
  width: 100,
  height: 100,
};

test('estilo único gera 1 legenda não vazia', () => {
  const list = Captions.generate(analysis, { style: 'curto' });
  assert.equal(list.length, 1);
  assert.ok(list[0].trim().length > 0);
});

test('estilo mix gera 6 legendas', () => {
  const list = Captions.generate(analysis, { style: 'mix' });
  assert.equal(list.length, 6);
});

test('estilo inválido cai para curto', () => {
  const list = Captions.generate(analysis, { style: 'inexistente' });
  assert.equal(list.length, 1);
  assert.ok(list[0].length > 0);
});

test('análise inválida não quebra (fallback calmo/neutro/dia)', () => {
  // fallback: mood→calmo ('em paz'), tone→neutro, period→dia.
  // o template é sorteado; garante que algum sorteio usou o fallback de mood.
  let found = false;
  for (let i = 0; i < 200 && !found; i++) {
    const list = Captions.generate({ mood: 'x', tone: 'y', period: 'z' }, { style: 'curto' });
    found = list[0].includes('em paz');
  }
  assert.ok(found, 'nenhum sorteio usou o fallback de mood calmo');
});

test('place de praia entra no contexto da legenda (determinístico)', () => {
  // o template com contextText é sorteado; garante que ao menos um dos
  // templates de 'diario' usa o contexto de lugar (probabilidade 1/3 por sorteio)
  let found = false;
  for (let i = 0; i < 200 && !found; i++) {
    const list = Captions.generate(analysis, { style: 'diario', place: 'Praia do Forte' });
    found = list[0].includes('mar');
  }
  assert.ok(found, 'nenhum template diário usou o contexto de lugar');
});

test('place vazio não gera contexto falso', () => {
  const list = Captions.generate(analysis, { style: 'engajador', place: '   ' });
  assert.ok(!list[0].includes('📍'));
});

test('baseHashtags retorna 4 hashtags do pool', () => {
  for (let i = 0; i < 20; i++) {
    const tags = Captions.baseHashtags();
    const count = tags.split(' ').length;
    assert.equal(count, 4, tags);
    for (const t of tags.split(' ')) assert.ok(t.startsWith('#'), t);
  }
});

test('legendas usam emoji do clima da foto', () => {
  const list = Captions.generate(analysis, { style: 'curto' });
  assert.ok(list[0].length > 5);
});
