/* Analyzer — a "IA local" do JARVIS.
 *
 * Analisa a imagem via ImageData (RGBA) e devolve um retrato técnico completo:
 * exposição, contraste, saturação, nitidez, temperatura de cor, clima,
 * nível de ruído, distribuição de detalhes e composição.
 *
 * Com base nisso, gera:
 *  - Diagnóstico legível por item (✅/⚠️/🔴)
 *  - Nota 0–100 da foto
 *  - Valores ideais de correção (suggestAdjustments)
 *  - Atributos semânticos (mood/tone/period) para legendas
 *  - Recomendações proativas do JARVIS (sugestões conversacionais)
 *
 * PORQUÊ: o usuário pediu que o próprio JARVIS analisasse o padrão da foto.
 * Heurística local (histograma + gradientes) é determinística, offline,
 * sem custo e sem envio de dados — a base do assistente. A IA externa
 * (OpenAI) fica como camada opcional apenas para legendas criativas.
 *
 * ── Análise profissional (estilo Photoshop) ────────────────────────────
 * Além das médias, o analyzer agora devolve PERCENTIS do histograma
 * (p1, p50, p99) — é o que o Photoshop usa para Auto Tone (clipping 0.5–1%)
 * e Auto Color. Percentis são estáveis a ruído (min/max não são: um único
 * pixel estourado engana o diagnóstico).
 */
'use strict';

const Analyzer = (() => {

  function lum(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  /** Percentil do histograma de luminância (estável a ruído). */
  function percentile(hist, pct) {
    let total = 0;
    for (let v = 0; v < 256; v++) total += hist[v];
    if (!total) return 128;
    const target = total * pct / 100;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  }

  /**
   * Analisa um ImageData-like ({data: Uint8ClampedArray, width, height}).
   * Retorna métricas normalizadas 0..1 + histograma + percentis + faixa tonal.
   */
  function analyze(imageData) {
    const d = imageData.data;
    const n = d.length / 4;
    const w = imageData.width;
    const h = imageData.height;

    let sumL = 0, sumSat = 0;
    let warm = 0, cool = 0, warmAmt = 0, coolAmt = 0;
    const hist = new Array(256).fill(0);
    let noiseAcc = 0, noiseCount = 0;
    // distribuição de detalhes por quadrante (para composição)
    const quadEdges = [0, 0, 0, 0];
    const quadPixels = [0, 0, 0, 0];

    // amostragem em passo para fotos grandes (precisão suficiente)
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 400_000)));

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const L = lum(r, g, b);
        sumL += L;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        sumSat += sat;
        hist[Math.round(L)]++;
        if (r > b + 18) { warm++; warmAmt += (r - b); }
        else if (b > r + 18) { cool++; coolAmt += (b - r); }

        // ruído: variação local entre vizinhos próximos
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
          const iL = (y * w + (x - 1)) * 4;
          const iR = (y * w + (x + 1)) * 4;
          const iU = ((y - 1) * w + x) * 4;
          const iD = ((y + 1) * w + x) * 4;
          const neighbors = [lum(d[iL], d[iL+1], d[iL+2]), lum(d[iR], d[iR+1], d[iR+2]),
                             lum(d[iU], d[iU+1], d[iU+2]), lum(d[iD], d[iD+1], d[iD+2])];
          const avgN = neighbors.reduce((a, b) => a + b, 0) / 4;
          noiseAcc += Math.abs(L - avgN);
          noiseCount++;
        }

        // quadrante para composição + detalhe local (regra dos terços)
        const qx = x < w / 2 ? 0 : 1;
        const qy = y < h / 2 ? 0 : 1;
        const qi = qy * 2 + qx;
        quadPixels[qi]++;
        // magnitude do gradiente com o vizinho diagonal (amostrado) como medida de detalhe
        if (x + step < w && y + step < h) {
          const j = ((y + step) * w + (x + step)) * 4;
          quadEdges[qi] += Math.abs(L - lum(d[j], d[j + 1], d[j + 2]));
        }
      }
    }

    const sampled = Math.max(1, Math.ceil((w / step) * (h / step)));
    const brightness = sumL / sampled / 255;
    const saturation = sumSat / sampled;
    const temperature = sampled === 0 ? 0 : (warm - cool) / sampled; // -1..1

    // nitidez: magnitude média do gradiente (sobel simplificado)
    let edge = 0, edgeCount = 0;
    const s2 = Math.max(2, step);
    for (let y = s2; y < h - s2; y += s2) {
      for (let x = s2; x < w - s2; x += s2) {
        const i = (y * w + x) * 4;
        const L00 = lum(d[i], d[i + 1], d[i + 2]);
        const L11 = lum(d[i + (w + 1) * 4], d[i + (w + 1) * 4 + 1], d[i + (w + 1) * 4 + 2]);
        const L10 = lum(d[i + 4], d[i + 5], d[i + 6]);
        const L01 = lum(d[i + w * 4], d[i + w * 4 + 1], d[i + w * 4 + 2]);
        edge += Math.abs(L00 - L11) + Math.abs(L01 - L10);
        edgeCount++;
      }
    }
    const sharpness = edgeCount === 0 ? 0.5 : (edge / edgeCount) / 510;

    // nível de ruído normalizado 0..1
    const noiseLevel = noiseCount === 0 ? 0 : Math.min(1, noiseAcc / noiseCount / 30);

    // faixa tonal real (percentis — estáveis; min/max enganam com ruído)
    const p1 = percentile(hist, 1);
    const p50 = percentile(hist, 50);
    const p99 = percentile(hist, 99);
    const contrast = (p99 - p1) / 255;

    // dominância de cor
    let dominance = 'neutro';
    if (temperature > 0.18) dominance = 'quente';
    else if (temperature < -0.18) dominance = 'frio';

    let mood = 'equilibrado';
    if (saturation > 0.55 && brightness > 0.45) mood = 'vibrante';
    else if (saturation < 0.18 || brightness < 0.28) mood = 'sombrio';
    else if (saturation < 0.35) mood = 'suave';

    // composição: quadrante com MAIS detalhe local por amostra (regra dos terços)
    const detailPerQuad = quadPixels.map((p, i) => p > 0 ? quadEdges[i] / p : 0);
    const maxQuad = detailPerQuad.indexOf(Math.max(...detailPerQuad));
    const compositionBias = ['top-left', 'top-right', 'bottom-left', 'bottom-right'][maxQuad];

    return {
      width: w,
      height: h,
      brightness,
      saturation,
      contrast,
      sharpness,
      temperature,
      noiseLevel,
      dominance,
      mood,
      histogram: hist,
      sampleCount: sampled,
      compositionBias,
      // faixa tonal profissional
      p1,
      p50,
      p99,
      tonalRange: p99 - p1,
    };
  }

  /* ------------------------------------------------------------------ diagnóstico */

  function diagnose(a) {
    const items = [];

    if (a.brightness < 0.28) {
      items.push({ level: 'bad', text: `Foto subexposta (escura demais) — brilho médio ${Math.round(a.brightness * 100)}%. Um reforço de luz faz diferença.` });
    } else if (a.brightness > 0.88) {
      items.push({ level: 'bad', text: `Foto superexposta (estourada) — brilho médio ${Math.round(a.brightness * 100)}%. Recuperar sombras ajuda.` });
    } else if (a.brightness < 0.42) {
      items.push({ level: 'warn', text: `Levemente escura (${Math.round(a.brightness * 100)}% de brilho) — um reforço de luz ajuda.` });
    } else if (a.brightness > 0.78) {
      items.push({ level: 'warn', text: `Muito clara (${Math.round(a.brightness * 100)}%) — reduzir um pouco o brilho ganha profundidade.` });
    } else {
      items.push({ level: 'ok', text: `Exposição boa (${Math.round(a.brightness * 100)}%).` });
    }

    if (a.contrast < 0.28) {
      items.push({ level: 'warn', text: `Contraste baixo — imagem "chapada". Aumentar contraste dá vida.` });
    } else if (a.contrast > 0.92) {
      items.push({ level: 'warn', text: `Contraste muito alto — risco de perder detalhe em sombras e claros.` });
    } else {
      items.push({ level: 'ok', text: `Contraste equilibrado (${Math.round(a.contrast * 100)}%).` });
    }

    // faixa tonal por percentis (como o Photoshop mede)
    if (a.tonalRange != null) {
      if (a.p1 != null && a.p1 > 90) {
        items.push({ level: 'warn', text: `Sem pretos reais — as sombras começam em ${Math.round(a.p1)} (nível 90+). O black point pode ser ajustado.` });
      }
      if (a.p99 != null && a.p99 < 165) {
        items.push({ level: 'warn', text: `Sem brancos reais — os claros param em ${Math.round(a.p99)} (nível 165−). O white point pode ser ajustado.` });
      }
      if (a.p1 != null && a.p99 != null && a.p1 <= 90 && a.p99 >= 165) {
        items.push({ level: 'ok', text: `Faixa tonal saudável (pretos ~${Math.round(a.p1)}, brancos ~${Math.round(a.p99)}).` });
      }
    }

    if (a.saturation < 0.16) {
      items.push({ level: 'warn', text: `Saturação baixa (${Math.round(a.saturation * 100)}%) — cores sem vida.` });
    } else if (a.saturation > 0.72) {
      items.push({ level: 'warn', text: `Cores muito saturadas — um toque de moderação equilibra.` });
    } else {
      items.push({ level: 'ok', text: `Cores vivas e naturais (${Math.round(a.saturation * 100)}%).` });
    }

    if (a.sharpness < 0.05) {
      items.push({ level: 'bad', text: `Nitidez baixa (${Math.round(a.sharpness * 100)}%) — a foto pode estar desfocada.` });
    } else if (a.sharpness < 0.1) {
      items.push({ level: 'warn', text: `Nitidez média — um reforço sutil melhora os detalhes.` });
    } else {
      items.push({ level: 'ok', text: `Nitidez boa (${Math.round(a.sharpness * 100)}%).` });
    }

    if (a.noiseLevel > 0.3) {
      items.push({ level: 'warn', text: `Ruído visível (${Math.round(a.noiseLevel * 100)}%) — considerar leve suavização.` });
    }

    if (a.dominance !== 'neutro') {
      items.push({ level: 'ok', text: `Temperatura de cor ${a.dominance} (${a.temperature > 0 ? '+' : ''}${Math.round(a.temperature * 100)}).` });
    }

    const score = Math.round(
      Math.min(100, 100 * (0.35 * (1 - Math.abs(a.brightness - 0.5) * 1.4) +
                           0.25 * Math.min(1, a.contrast / 0.6) +
                           0.20 * Math.min(1, a.saturation / 0.45) +
                           0.10 * Math.min(1, a.sharpness / 0.15) +
                           0.10 * (1 - a.noiseLevel)))
    );
    return { items, score };
  }

  /* ------------------------------------------------------------------ correção ideal */

  /**
   * Calcula os ajustes ideais para levar a foto a um padrão equilibrado.
   * Retorna valores compatíveis com Editor.applyAdjust:
   *  { brightness, contrast, saturation, sharpness, temperature } (fatores 0.1..3)
   * NOTA: o pipeline profissional (Editor.autoEnhance) usa percentis e gray
   * world diretamente; estes fatores são o resumo conservador para sliders.
   */
  function suggestAdjustments(a) {
    const target = 0.52;
    const brightness = clamp(a.brightness < 0.06 ? 1 : target / a.brightness, 0.5, 2.4);

    const contrast = a.contrast < 0.28 ? 1.22
      : a.contrast > 0.85 ? 0.9
      : 1.05;

    const saturation = a.saturation < 0.16 ? 1.3
      : a.saturation > 0.65 ? 0.88
      : a.saturation < 0.32 ? 1.12
      : 1.0;

    const sharpness = a.sharpness < 0.05 ? 1.35
      : a.sharpness < 0.1 ? 1.15
      : 1.0;

    const temperature = Math.abs(a.temperature) > 0.2 ? -a.temperature * 0.3 : 0;

    return { brightness, contrast, saturation, sharpness, temperature };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ------------------------------------------------------------------ recomendações proativas */

  /**
   * Retorna recomendações conversacionais do JARVIS — o que fazer com a foto,
   * não só como corrigi-la. Cada recomendação tem um tipo e uma ação sugerida.
   * Assertivas: apontam o problema real (nunca "HDR para tudo").
   */
  function recommend(a) {
    const recs = [];

    // 1. ajuste técnico mais importante (1 card, o mais crítico)
    if (a.brightness < 0.35) {
      recs.push({ type: 'adjust', label: 'Clarear suavemente', reason: `A foto está escura (${Math.round(a.brightness * 100)}%) — a correção ideal eleva o meio-tom preservando as sombras.`, action: { brightness: 1.15 } });
    } else if (a.brightness > 0.8) {
      recs.push({ type: 'adjust', label: 'Reduzir brilho', reason: 'Estourada — a correção recupera detalhes nos claros sem esmagar o branco.', action: { brightness: 0.88 } });
    } else if (a.contrast < 0.28) {
      recs.push({ type: 'adjust', label: 'Mais contraste', reason: 'Imagem chapada — a S-curve define as formas com transição natural.', action: { contrast: 1.18 } });
    } else if (a.saturation < 0.16) {
      recs.push({ type: 'adjust', label: 'Devolver cor', reason: 'Cores desbotadas — saturação leve só nas cores, preservando tons de pele.', action: { saturation: 1.2 } });
    } else if (a.sharpness < 0.08) {
      recs.push({ type: 'adjust', label: 'Nitidez seletiva', reason: 'Levemente macia — nitidez com máscara de luminosidade (sem halos).', action: { sharpness: 1.2 } });
    }

    // 2. filtro que combina com o clima (sem exagero)
    const moodFilterMap = {
      vibrante: { filter: 'vivid', label: 'Vívido', reason: 'Cores vivas pedem um leve reforço de vivacidade — Vívido realça sem artificializar.' },
      sombrio: { filter: 'noir', label: 'Noir', reason: 'O clima sombrio combina com noir — drama elegante, não exagero.' },
      suave: { filter: 'warm', label: 'Quente', reason: 'Tom suave ganha um toque quente e acolhedor, mantendo a serenidade.' },
      equilibrado: { filter: 'auto', label: 'Correção ideal', reason: 'Foto equilibrada — a correção ideal só refina o que está fora do padrão.' },
    };
    const mf = moodFilterMap[a.mood];
    if (mf) {
      recs.push({ type: 'filter', label: mf.label, reason: mf.reason, filter: mf.filter });
    }

    // 3. composição
    if (a.compositionBias && (a.compositionBias === 'top-left' || a.compositionBias === 'top-right')) {
      recs.push({ type: 'compose', label: 'Horizonte equilibrado', reason: 'Mais detalhes no topo — ao exportar, considere um leve recorte (crop) para equilibrar.', action: null });
    }

    // 4. legenda
    const moodCaptionMap = {
      vibrante: 'Essa foto transmite energia — perfeita para feed animado!',
      sombrio: 'Clima intenso — funciona muito bem para posts reflexivos.',
      suave: 'Sereno e elegante — ideal para conteúdo minimalista.',
      equilibrado: 'Foto equilibrada — combina com qualquer estilo de postagem.',
    };
    recs.push({ type: 'caption', label: 'Sugestão de legenda', reason: moodCaptionMap[a.mood] || moodCaptionMap.equilibrado, action: null });

    // 5. exportação
    if (a.p99 != null && a.p99 > 245) {
      recs.push({ type: 'export', label: 'Exportar em PNG', reason: 'Claros próximos de 255 — PNG preserva os detalhes das altas luzes (JPG pode estourar).', action: null });
    }

    return recs;
  }

  /* ------------------------------------------------------------------ descrição p/ legendas */

  /**
   * Retorna atributos semânticos usados pelo gerador de legendas:
   *  { mood, tone, period, intensity, placeHint }
   */
  function describe(a) {
    let mood;
    if (a.saturation > 0.55 && a.brightness > 0.45) mood = 'vibrante';
    else if (a.saturation < 0.18 || a.brightness < 0.28) mood = 'sombrio';
    else mood = 'calmo';

    let tone;
    if (a.temperature > 0.18) tone = 'quente';
    else if (a.temperature < -0.18) tone = 'frio';
    else tone = 'neutro';

    let period = 'dia';
    if (a.brightness < 0.2) period = 'noite';
    else if (a.brightness < 0.38) period = 'entardecer';

    const intensity = a.contrast > 0.6 && a.saturation > 0.45 ? 'forte' : 'suave';

    return { mood, tone, period, intensity };
  }

  /* ------------------------------------------------------------------ opinião JARVIS */

  /**
   * Retorna um texto conversacional com a "opinião" do JARVIS sobre a foto.
   * É um resumo natural do que o analyzer encontrou.
   */
  function opinion(a) {
    const parts = [];

    // abertura
    if (a.mood === 'vibrante') parts.push('Essa foto está <b>vibrante</b> — transmite energia e presença.');
    else if (a.mood === 'sombrio') parts.push('O clima é <b>intenso e sombrio</b> — tem personalidade.');
    else if (a.mood === 'suave') parts.push('Visual <b>suave e sereno</b> — transmite calma.');
    else parts.push('Foto <b>equilibrada</b> — sólida tecnicamente.');

    // exposição
    if (a.brightness < 0.3) parts.push('Está um pouco <b>escura</b> — a correção ideal clareia com cuidado.');
    else if (a.brightness > 0.8) parts.push('Está <b>clara demais</b> — a correção recupera os claros.');
    else parts.push('A <b>exposição está bem</b> controlada.');

    // faixa tonal
    if (a.p1 != null && a.p99 != null) {
      if (a.p1 > 90) parts.push('Faltam <b>pretos reais</b> — o black point pode subir um pouco.');
      if (a.p99 < 165) parts.push('Faltam <b>brancos reais</b> — o white point pode descer um pouco.');
    }

    // cor
    if (a.dominance === 'quente') parts.push('Os <b>tons quentes</b> dão um ar acolhedor.');
    else if (a.dominance === 'frio') parts.push('Os <b>tons frios</b> transmitem serenidade.');

    // nitidez
    if (a.sharpness < 0.08) parts.push('A <b>nitidez poderia ser melhor</b> — reforço seletivo, sem halos.');

    // ruído
    if (a.noiseLevel > 0.3) parts.push('Há <b>ruído visível</b> — considerar leve suavização.');

    // nota final
    const d = diagnose(a);
    parts.push(`Nota geral: <b>${d.score}/100</b>.`);

    return parts.join(' ');
  }

  /* ------------------------------------------------------------ composição */

  /**
   * Sugere um corte automático pela REGRA DOS TERÇOS.
   * Divide a imagem em grade 6×6, mede a saliência local (gradiente de
   * luminância amostrado) e devolve o retângulo do TERÇO (3×3) que contém
   * o sujeito — o novo enquadramento põe o ponto de interesse exatamente
   * sobre uma das linhas/pontos fortes da composição.
   *
   * Imagem uniforme (sem saliência) → terço central (default).
   * Imagem muito pequena (< 12px) → devolve a imagem inteira.
   *
   * @param {Object} im ImageData-like ({data, width, height})
   * @returns {{x, y, w, h}} retângulo de corte
   */
  function suggestCrop(im) {
    const w = im.width, h = im.height;
    if (w < 12 || h < 12) return { x: 0, y: 0, w, h };
    const d = im.data;
    const G = 6; // grade de saliência interna (6×6 → terços bem resolvidos)
    const sal = new Float64Array(G * G);
    const cnt = new Float64Array(G * G);
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200000)));

    for (let y = step; y < h; y += step) {
      for (let x = step; x < w; x += step) {
        const i = (y * w + x) * 4;
        const L = lum(d[i], d[i + 1], d[i + 2]);
        let grad = 0;
        if (x + step < w && y + step < h) {
          const j = ((y + step) * w + (x + step)) * 4;
          grad = Math.abs(L - lum(d[j], d[j + 1], d[j + 2]));
        }
        const cx = Math.min(G - 1, Math.floor(x * G / w));
        const cy = Math.min(G - 1, Math.floor(y * G / h));
        sal[cy * G + cx] += grad;
        cnt[cy * G + cx]++;
      }
    }

    let best = -1, bestVal = -1;
    for (let i = 0; i < G * G; i++) {
      const v = cnt[i] ? sal[i] / cnt[i] : 0;
      if (v > bestVal) { bestVal = v; best = i; }
    }
    // sem saliência (imagem uniforme) → terço central (enquadramento default)
    if (bestVal <= 0) {
      return { x: Math.round(w / 3), y: Math.round(h / 3), w: Math.round(w / 3), h: Math.round(h / 3) };
    }
    const bx = best % G, by = Math.floor(best / G);
    const tx = Math.min(2, Math.floor(bx * 3 / G));
    const ty = Math.min(2, Math.floor(by * 3 / G));
    return {
      x: Math.round(tx * w / 3),
      y: Math.round(ty * h / 3),
      w: Math.round(w / 3),
      h: Math.round(h / 3),
    };
  }

  /**
   * Ranqueia frames/fotos por qualidade (0..100) — para escolher o melhor
   * frame de um lote (ex.: capa de slideshow). Ordena do melhor para o pior.
   * @param {Array<{data, width, height}>} frames ImageData-like
   * @returns {Array<{index, score, analysis}>}
   */
  function rankFrames(frames) {
    return frames
      .map((im, index) => {
        const analysis = analyze(im);
        return { index, score: diagnose(analysis).score, analysis };
      })
      .sort((a, b) => b.score - a.score);
  }

  return { analyze, diagnose, suggestAdjustments, describe, recommend, opinion, lum, percentile, suggestCrop, rankFrames };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Analyzer;
