/* AI — integração opcional com API de IA (OpenAI) para legendas criativas.
 *
 * PORQUÊ do design: o assistente funciona 100% offline com a análise local
 * (Analyzer). A IA externa é um EXTRA: se o usuário colocar uma chave de API
 * no navegador (campo em Assinatura → API), o JARVIS gera uma legenda única
 * baseada no retrato técnico da foto.
 *
 * ⚠️ A chave fica no localStorage do navegador (uso pessoal/local). Não use
 * em sites públicos sem backend. Alternativa futura: proxy local.
 */
'use strict';

const AI = (() => {

  const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

  /**
   * Gera uma legenda criativa com LLM.
   * @param {object} analysis  output de Analyzer.analyze
   * @param {object} settings  { apiKey, model }
   * @param {object} opts      { style, place }
   * @returns {Promise<string|null>}  legenda ou null se sem chave
   */
  async function generateCaption(analysis, settings, opts = {}) {
    if (!settings || !settings.apiKey) return null;

    const profile = {
      mood: analysis.mood,
      tone: analysis.dominance,
      period: analysis.brightness < 0.2 ? 'noite' : analysis.brightness < 0.38 ? 'entardecer' : 'dia',
      brightness: Math.round(analysis.brightness * 100),
      saturation: Math.round(analysis.saturation * 100),
      contrast: Math.round(analysis.contrast * 100),
      sharpness: Math.round(analysis.sharpness * 100),
      place: opts.place || '',
    };

    const system = [
      'Você é o JARVIS, assistente de mídia. Escreva UMA legenda criativa em PT-BR',
      'para uma postagem de foto, com base no perfil técnico e no contexto.',
      'Tom: humano, sem exageros, 1-2 frases curtas + 4 hashtags.',
      `Estilo: ${opts.style || 'natural'}.`,
    ].join(' ');

    const user = `Foto: ${JSON.stringify(profile)}. Escreva a legenda.`;

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 140,
        temperature: 0.9,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`API de IA falhou (${res.status}): ${err.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
    return text || null;
  }

  return { generateCaption };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AI;
