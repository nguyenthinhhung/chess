// i18n.js — string tables for the coach UI and the deterministic (non-AI)
// move explanations in explain.js. Pure: no DOM, no chrome, no network — runs
// both as a content script (globals) and under the Node test runner.
//
// Usage: t(lang, 'key') or t(lang, 'key', arg1, arg2, ...) for templates with
// %s placeholders (filled in order). Unknown lang falls back to English.

const _iIsNode = typeof module !== 'undefined' && module.exports;

const STRINGS = {
  en: {
    turnCoachingOff: 'Turn coaching off',
    turnCoachingOn: 'Turn coaching on',
    toggleCoaching: 'Toggle coaching',
    sideWhite: 'White',
    sideBlack: 'Black',
    autoDetect: 'Auto-detect (%s)',
    reloadToRetry: 'Reload the page to retry',
    stockfishStopped: '⚠ Stockfish stopped',
    stockfishUnavailable: 'Stockfish unavailable',
    engineError: '⚠ Engine error',
    analysingDepth: 'Analysing… (d%s)',
    opponentsReply: "Opponent's reply",
    yourReply: 'Your reply',
    analysing: 'Analysing…',
    reviewingYourMove: 'Reviewing your move…',
    shouldHavePlayed: 'Better:',
    explainFailed: '⚠ Explain failed',
    retry: 'Retry',
    explainThisMove: '✨ Explain this move',
    bestMoveLabel: '⭐ Best move',
    planLabel: '🎯 Plan',
    replyLabel: '🛡 What the opponent wants',
    outOfBook: 'Out of book',
    coach: 'Coach',
    syncing: 'Syncing with the board…',
    expand: 'Expand',
    minimize: 'Minimize',
    depth: 'Depth',
    arrows: 'Arrows',
    legendBook: 'Book',
    legendBest: 'Best',
    legend2nd: '2nd',
    legend3rd: '3rd',
    skipNoAnalysis: 'no analysis yet',
    skipShallowDepth: 'depth too shallow',
    skipForcedMate: 'forced mate — nothing to explain',
    // explain.js
    pieceP: 'pawn', pieceN: 'knight', pieceB: 'bishop', pieceR: 'rook', pieceQ: 'queen', pieceK: 'king', pieceGeneric: 'piece',
    labelBest: 'Best move',
    labelGood: 'Good move',
    labelInaccuracy: 'Inaccuracy',
    labelMistake: 'Mistake',
    labelBlunder: 'Blunder',
    forcesMateIn: 'forces mate in %s',
    capturesThe: 'captures the %s',
    castlesToSafety: 'castles the king to safety',
    promotesToA: 'promotes to a %s',
    givesCheckInitiative: 'gives check and keeps the initiative',
    keepsStrongest: 'keeps the strongest position here',
    withCheck: 'with check',
    expectInReply: 'Expect %s in reply.',
    winsThe: 'Wins the %s.',
    strongWithCheck: 'A strong move with check.',
    solidInLine: 'Solid — right in line with the engine.',
    dropsThe: 'Drops the %s — the opponent can answer %s.',
    enginePrefersTougher: 'The engine prefers %s; %s is the tougher reply.',
    enginePrefers: 'The engine prefers %s.'
  },
  vi: {
    turnCoachingOff: 'Tắt huấn luyện',
    turnCoachingOn: 'Bật huấn luyện',
    toggleCoaching: 'Bật/tắt huấn luyện',
    sideWhite: 'Trắng',
    sideBlack: 'Đen',
    autoDetect: 'Tự nhận diện (%s)',
    reloadToRetry: 'Tải lại trang để thử lại',
    stockfishStopped: '⚠ Stockfish đã dừng',
    stockfishUnavailable: 'Stockfish không khả dụng',
    engineError: '⚠ Lỗi công cụ phân tích',
    analysingDepth: 'Đang phân tích… (độ sâu %s)',
    opponentsReply: 'Nước đi của đối thủ',
    yourReply: 'Nước đi của bạn',
    analysing: 'Đang phân tích…',
    reviewingYourMove: 'Đang chấm nước vừa đi…',
    shouldHavePlayed: 'Lẽ ra:',
    explainFailed: '⚠ Giải thích thất bại',
    retry: 'Thử lại',
    explainThisMove: '✨ Giải thích nước đi này',
    bestMoveLabel: '⭐ Nước tốt nhất',
    planLabel: '🎯 Kế hoạch',
    replyLabel: '🛡 Đối thủ định làm gì',
    outOfBook: 'Ngoài sách khai cuộc',
    coach: 'Huấn luyện viên',
    syncing: 'Đang đồng bộ với bàn cờ…',
    expand: 'Mở rộng',
    minimize: 'Thu nhỏ',
    depth: 'Độ sâu',
    arrows: 'Số mũi tên',
    legendBook: 'Sách',
    legendBest: 'Tốt nhất',
    legend2nd: 'Thứ 2',
    legend3rd: 'Thứ 3',
    skipNoAnalysis: 'chưa có phân tích',
    skipShallowDepth: 'độ sâu chưa đủ',
    skipForcedMate: 'buộc chiếu hết — không cần giải thích',
    // explain.js
    pieceP: 'tốt', pieceN: 'mã', pieceB: 'tượng', pieceR: 'xe', pieceQ: 'hậu', pieceK: 'vua', pieceGeneric: 'quân cờ',
    labelBest: 'Nước đi tốt nhất',
    labelGood: 'Nước đi tốt',
    labelInaccuracy: 'Không chính xác',
    labelMistake: 'Sai lầm',
    labelBlunder: 'Sai lầm nghiêm trọng',
    forcesMateIn: 'buộc chiếu hết sau %s nước',
    capturesThe: 'ăn %s',
    castlesToSafety: 'nhập thành đưa vua vào nơi an toàn',
    promotesToA: 'phong cấp thành %s',
    givesCheckInitiative: 'chiếu tướng và giữ quyền chủ động',
    keepsStrongest: 'giữ vị trí mạnh nhất ở đây',
    withCheck: 'kèm chiếu tướng',
    expectInReply: 'Dự kiến đối thủ đáp trả bằng %s.',
    winsThe: 'Ăn được %s.',
    strongWithCheck: 'Một nước đi mạnh kèm chiếu tướng.',
    solidInLine: 'Vững chắc — đúng như máy tính đề xuất.',
    dropsThe: 'Để mất %s — đối thủ có thể đáp trả bằng %s.',
    enginePrefersTougher: 'Máy tính ưu tiên %s; %s là câu trả lời khó chịu hơn.',
    enginePrefers: 'Máy tính ưu tiên %s.'
  }
};

function t(lang, key, ...args) {
  const table = STRINGS[lang] || STRINGS.en;
  let s = table[key] ?? STRINGS.en[key] ?? key;
  for (const a of args) s = s.replace('%s', a);
  return s;
}

const _iExports = { STRINGS, t };
if (_iIsNode) {
  module.exports = _iExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessI18n = _iExports;
}
