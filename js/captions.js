/* Captions — gerador de legendas para postagens.
 *
 * Combina a análise do JARVIS (clima, tom, período, intensidade) com
 * templates em PT-BR para produzir legendas variadas e prontas para copiar.
 * Estilos: curto, engajador, poético, diário, story, reel, profissional, misturado.
 *
 * PORQUÊ: legendas são a ponte entre a foto e o público. O JARVIS gera
 * opções para cada mood/tone/period, permitindo ao usuário escolher o
 * tom que combina com sua postagem — ou usar "misturado" para variedade.
 */
'use strict';

const Captions = (() => {

  const MOOD = {
    vibrante: {
      label: 'vibrando de energia',
      emoji: ['🔥', '✨', '⚡', '🎉', '💥', '🚀'],
      poetic: 'Quando a vida acende assim, a gente só registra.',
      short: 'Energia pura!',
      professional: 'Alta energia e presença total.',
    },
    calmo: {
      label: 'em paz',
      emoji: ['🌿', '🍃', '☕', '🤍', '🕊️', '🌸'],
      poetic: 'Nem toda grandeza precisa de barulho.',
      short: 'Paz interior.',
      professional: 'Momento de equilíbrio e serenidade.',
    },
    sombrio: {
      label: 'no clima intenso',
      emoji: ['🖤', '🌙', '🕰️', '🌫️', '⛈️', '🗡️'],
      poetic: 'Há beleza até na penumbra.',
      short: 'No clima certo.',
      professional: 'Estética dramática e cinematográfica.',
    },
    suave: {
      label: 'com delicadeza',
      emoji: ['🌸', '💫', '🦋', '☁️', '🎀', '🩷'],
      poetic: 'Suave como um sussurro que fica.',
      short: 'Delicadeza em cada detalhe.',
      professional: 'Abordagem suave e elegante.',
    },
  };

  const TONE = {
    quente: { word: 'tons quentes', emoji: '🌅', extra: 'aconchegante' },
    frio: { word: 'tons frios', emoji: '🌊', extra: 'sereno' },
    neutro: { word: 'tons naturais', emoji: '📷', extra: 'equilibrado' },
  };

  const PERIOD = {
    dia: { label: 'um dia de luz', emoji: '☀️' },
    entardecer: { label: 'aquele fim de tarde', emoji: '🌆' },
    noite: { label: 'a noite pede atenção', emoji: '🌙' },
  };

  const HASH = ['#photography', '#photo', '#instagood', '#picoftheday', '#momento', '#brasil', '#arte',
    '#natureza', '#viagem', '#lifestyle', '#portrait', '#paisagem', '#fotografia', '#criativo'];

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  function baseHashtags(count = 4) {
    const pool = [...HASH].sort(() => Math.random() - 0.5);
    return pool.slice(0, count).join(' ');
  }

  function contextText(place) {
    if (!place || !place.trim()) return '';
    const p = place.trim().toLowerCase();
    if (['praia', 'mar', 'oceano', 'praian', 'litoral'].some(k => p.includes(k))) return '🌊 De frente pro mar';
    if (['mato', 'trilha', 'floresta', 'natureza', 'parque', 'montanha', 'cachoeira'].some(k => p.includes(k))) return '🌲 No meio da natureza';
    if (['casa', 'quarto', 'lar', 'apartamento', 'sofá'].some(k => p.includes(k))) return '🏠 Direto de casa';
    if (['cidade', 'rua', 'centro', 'urbano', 'metrópole'].some(k => p.includes(k))) return '🏙️ Pela cidade';
    if (['viagem', 'estrada', 'road', 'trip', 'rodoviária'].some(k => p.includes(k))) return '🧳 Na estrada';
    if (['café', 'coffee', 'padaria', 'restaurante'].some(k => p.includes(k))) return '☕ No café';
    if ((['festa', 'fest', 'balada', 'noite', 'show', 'concerto', 'festival']).some(k => p.includes(k))) return '🎉 Na noite';
    return `📍 ${place.trim()}`;
  }

  // ---------- templates por estilo ----------

  const TEMPLATES = {
    curto: [
      (c) => `${c.mood.emoji[0]} ${c.mood.label}. ${c.tone.emoji} ${c.tone.word}.`,
      (c) => `${c.period.emoji} ${c.period.label}. Só isso.`,
      (c) => `${c.mood.emoji[0]} Direto do meu ângulo favorito.`,
      (c) => `${c.mood.short} ${c.tone.emoji}`,
      (c) => `${c.period.emoji} ${c.period.label.split(' ')[0]}.`,
    ],
    engajador: [
      (c) => `${pick(c.mood.emoji)} Essa foto combina mais com qual momento: manhã de café ou fim de tarde? ${baseHashtags()}`,
      (c) => `${contextText(c.place)} ${c.period.emoji} — o que esse lugar te transmite? ${baseHashtags()}`,
      (c) => `Se essa imagem fosse um sentimento, seria ${c.mood.label}. Concorda? ${pick(c.mood.emoji)} ${baseHashtags()}`,
      (c) => `Conta nos comentários: essa foto te lembra qual emoção? ${baseHashtags(5)}`,
      (c) => `Salva essa foto se concorda ${pick(c.mood.emoji)} ${baseHashtags()}`,
    ],
    poetico: [
      (c) => `${c.mood.poetic} ${pick(c.mood.emoji)} ${baseHashtags()}`,
      (c) => `O tempo congela o que a gente sente por dentro. ${c.period.emoji} ${baseHashtags()}`,
      (c) => `${c.period.label}, ${c.tone.word}, e um frame que vale por mil palavras. ${pick(c.mood.emoji)} ${baseHashtags()}`,
      (c) => `${c.mood.poetic} ${c.tone.emoji} ${baseHashtags()}`,
      (c) => `Cada click é uma história. Essa é ${c.mood.label}. ${pick(c.mood.emoji)} ${baseHashtags()}`,
    ],
    diario: [
      (c) => `${contextText(c.place)} ${c.period.emoji} — guardando esse ${c.mood.label} de hoje. ${baseHashtags()}`,
      (c) => `Registro nº ${Math.floor(Math.random() * 900 + 100)} de uma vida bem vivida. ${pick(c.mood.emoji)} ${baseHashtags()}`,
      (c) => `${c.mood.label} ${c.tone.emoji} e um clique que resume o dia. ${baseHashtags()}`,
      (c) => `${contextText(c.place)} — ${c.period.label}. ${pick(c.mood.emoji)} ${baseHashtags()}`,
      (c) => `Hoje foi dia de ${c.mood.label}. ${c.tone.emoji} ${baseHashtags()}`,
    ],
    story: [
      (c) => `✨ ${c.mood.label} ${c.tone.emoji} ${c.period.emoji}`,
      (c) => `${contextText(c.place)} — ${c.mood.emoji[0]} ${c.mood.label}`,
      (c) => `Story do dia: ${c.period.label} com ${c.tone.word}. ${pick(c.mood.emoji)}`,
      (c) => `${c.mood.emoji[0]} ${c.mood.label} · ${c.tone.word} · ${c.period.label}`,
      (c) => `Beleza do momento: ${c.mood.label} ${c.tone.emoji} ${baseHashtags(3)}`,
    ],
    reel: [
      (c) => `🎬 Vibe ${c.mood.label} + ${c.tone.word} = ${c.period.emoji} ${baseHashtags()}`,
      (c) => `POV: você tá vivendo esse momento ${c.mood.label}. ${pick(c.mood.emoji)} ${baseHashtags(5)}`,
      (c) => `Essa energia ${c.mood.label} + ${c.tone.word} é o que o reel precisa. ${baseHashtags()}`,
      (c) => `Roteiro: ${c.period.label}, ${c.tone.word}, e muito ${c.mood.label}. ${pick(c.mood.emoji)} ${baseHashtags()}`,
      (c) => `🎵 Mood: ${c.mood.label} · ${c.tone.word} · ${c.period.label} ${baseHashtags(4)}`,
    ],
    profissional: [
      (c) => `${c.mood.professional} ${c.tone.emoji} ${baseHashtags()}`,
      (c) => `Captura profissional — ${c.mood.label}, ${c.tone.word}, ${c.period.label}. ${baseHashtags()}`,
      (c) => `Fotografia: ${c.mood.label} com ${c.tone.word}. ${c.period.emoji} ${baseHashtags()}`,
      (c) => `Editorial style: ${c.mood.label}, ${c.tone.extra}, ${c.period.label}. ${baseHashtags()}`,
      (c) => `Qualidade editorial — ${c.mood.label} e ${c.tone.word}. ${baseHashtags()}`,
    ],
  };

  /**
   * Gera legendas para uma análise (objeto de Analyzer.describe/analyze).
   * @param {object} analysis  resultado de Analyzer.analyze
   * @param {object} opts      { style: 'mix'|'curto'|..., place: string }
   * @returns {string[]}
   */
  function generate(analysis, opts = {}) {
    const ctx = { ...describeSafe(analysis), place: (opts.place || '').trim() };
    const styles = opts.style === 'mix'
      ? ['curto', 'engajador', 'poetico', 'diario', 'story', 'reel']
      : [opts.style];
    const out = [];
    const used = new Set();
    for (const st of styles) {
      const tpls = TEMPLATES[st] || TEMPLATES.curto;
      // evita repetir o mesmo template na mesma geração
      let idx;
      let attempts = 0;
      do {
        idx = Math.floor(Math.random() * tpls.length);
        attempts++;
      } while (used.has(`${st}:${idx}`) && attempts < tpls.length);
      used.add(`${st}:${idx}`);
      out.push(pick(tpls)(ctx));
    }
    return out;
  }

  /** Converte análise bruta em contexto (aceita output de Analyzer.describe também). */
  function describeSafe(a) {
    const mood = MOOD[a.mood] ? a.mood : 'calmo';
    const tone = TONE[a.tone] ? a.tone : 'neutro';
    const period = PERIOD[a.period] ? a.period : 'dia';
    return { mood: MOOD[mood], tone: TONE[tone], period: PERIOD[period] };
  }

  return { generate, baseHashtags };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Captions;
