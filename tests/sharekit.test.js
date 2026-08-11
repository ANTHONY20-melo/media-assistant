/* Testes do ShareKit — estratégia de compartilhamento (função pura).
 *
 * A decisão share → clipboard → download precisa ser determinística
 * e testável em Node; a execução real (navigator.share / clipboard /
 * download) é validada no navegador via Playwright.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ShareKit = require('../js/sharekit.js');

test('pickShareStrategy: sem navigator → download (universal)', () => {
  assert.equal(ShareKit.pickShareStrategy(undefined), 'download');
  assert.equal(ShareKit.pickShareStrategy(null), 'download');
  assert.equal(ShareKit.pickShareStrategy({}), 'download');
});

test('pickShareStrategy: Web Share API tem prioridade', () => {
  const nav = { share: () => {}, clipboard: { write: () => {} } };
  assert.equal(ShareKit.pickShareStrategy(nav), 'share');
});

test('pickShareStrategy: sem share → clipboard quando disponível', () => {
  const nav = { clipboard: { write: () => {} } };
  assert.equal(ShareKit.pickShareStrategy(nav), 'clipboard');
});

test('pickShareStrategy: clipboard sem write não conta (cai no download)', () => {
  const nav = { clipboard: {} };
  assert.equal(ShareKit.pickShareStrategy(nav), 'download');
});

test('pickShareStrategy: Electron/Node (sem share/clipboard) → download', () => {
  // ambiente desktop: navigator existe mas sem share nem clipboard.write
  const nav = { clipboard: undefined, userAgent: 'Electron' };
  assert.equal(ShareKit.pickShareStrategy(nav), 'download');
});
