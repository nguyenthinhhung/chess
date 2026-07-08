// ai/response-parser.js — turns Gemini's raw text reply into the validated
// {summary, whyBest, strategy, tactics, nextPlan, commonMistake, difficulty}
// shape the UI expects, or throws AiParseError. Pure: no DOM, no chrome, no
// network — no markdown parsing beyond stripping an accidental code fence.

const _rpIsNode = typeof module !== 'undefined' && module.exports;

class AiParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'AiParseError';
    this.raw = raw;
  }
}

// Gemini sometimes wraps JSON in a ```json ... ``` fence even when told not
// to; strip it before parsing rather than failing outright.
function stripCodeFence(text) {
  const s = String(text || '').trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : s;
}

function parseExplainResponse(text) {
  let obj;
  try {
    obj = JSON.parse(stripCodeFence(text));
  } catch {
    throw new AiParseError('Gemini did not return valid JSON', text);
  }
  if (!obj || typeof obj !== 'object') throw new AiParseError('Gemini response was not a JSON object', text);

  const str = (v) => (typeof v === 'string' ? v : '');
  const plan = Array.isArray(obj.nextPlan) ? obj.nextPlan.filter((s) => typeof s === 'string') : [];
  const difficulty = Math.max(1, Math.min(5, Math.round(Number(obj.difficulty)) || 3));

  return {
    summary: str(obj.summary),
    whyBest: str(obj.whyBest),
    strategy: str(obj.strategy),
    tactics: str(obj.tactics),
    nextPlan: plan,
    commonMistake: str(obj.commonMistake),
    difficulty
  };
}

const _rpExports = { AiParseError, stripCodeFence, parseExplainResponse };
if (_rpIsNode) {
  module.exports = _rpExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiParser = _rpExports;
}
