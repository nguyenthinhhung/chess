# Plan: Gemini Chess Coach — MVP → thông minh dần

Extension đã có Stockfish (offscreen worker, MultiPV, PV, eval) nên phần LLM chỉ chiếm ~20–30% công việc. Hướng đi: MVP trước, tăng độ thông minh sau. Settings Gemini tham khảo pattern từ repo `wordly` (`src/lib/server/ai/geminiNativeProvider.ts`, `validate.ts`, `types/settings.ts`).

---

## Phase 0 — Fix bug mũi tên khi xem ván đã kết thúc (làm trước tiên)

**Hiện trạng:** mũi tên chỉ đúng khi đang chơi live; khi mở ván đã kết thúc / tua lại nước đi thì mũi tên loạn.

**Root cause:** `chess-coach-bridge.js` chỉ gửi `game.getHistorySANs()` (toàn bộ ván) + `getPlayingAs()`, không gửi ply đang hiển thị. `chess-coach.js:634` replay toàn bộ SANs → FEN đem đi phân tích (`chess-coach.js:319-321`) và `sideToMove` (parity của tổng số nước, `:321`, `:524`) luôn ứng với vị trí **cuối ván**, trong khi board đang hiển thị một ply giữa ván → mũi tên vẽ cho vị trí khác với vị trí trên màn hình.

**Fix:**
1. `chess-coach-bridge.js`: đọc thêm ply/vị trí đang hiển thị từ board API (thử theo thứ tự: FEN vị trí hiện tại nếu API có, ví dụ `game.getFEN()`; hoặc con trỏ node/ply hiện tại như `game.getCurrentMoveNumber()`/selected node; fallback: đếm nước đang highlight trong move list DOM). Gửi kèm trong message `{__chessCoach:'moves', sans, playingAs, plyViewed}`.
2. `chess-coach.js`: slice `bridgeSans.slice(0, plyViewed)` trước khi `sanToUci()` (`:634`) — tách logic slice thành helper thuần để unit-test được.
3. Thêm `plyViewed` vào `arrowSig` (`:642`) để mũi tên redraw khi tua nước.
4. Kiểm tra lại `isFlipped()` (`:154-175`) trên trang replay/analysis (markup có thể khác live).

**Verify:** load unpacked qua CDP `Extensions.loadUnpacked` (Chrome 137+ bỏ `--load-extension`), mở một ván đã kết thúc trên chess.com, tua tới/lui từng nước → mũi tên phải khớp vị trí đang hiển thị; chơi live một ván → vẫn đúng như cũ.

---

## Phase 1 — MVP: Input từ Stockfish (1–2 ngày)

Dữ liệu đã có sẵn trong `engineState.result` (`chess-coach.js:339-345`), chỉ cần gom lại đúng shape — **không gửi toàn bộ log Stockfish**:

```js
// shape truyền cho AI service
{
  fen,            // từ pos đang phân tích (toFen trong chesscore.js)
  bestMove,       // lines[0].move
  playedMove,     // nếu có (so với nước user vừa đi)
  eval,           // lines[0].score (cp hoặc mate)
  depth,          // lines[0].depth
  pv,             // lines[0].pv.slice(0, 8) — 5–8 nước
  topMoves,       // lines.slice(0, 3).map(l => ({move: l.move, eval: l.score}))
}
```

Trigger: thêm nút **"Explain"** vào panel coach (panel pattern: `buildPanel`/`bindPanel` trong `chess-coach.js:590-613`, `:678-719`) — không auto-call Gemini mỗi nước.

## Phase 2 — AI Service

Repo là vanilla JS không bundler → thay vì `src/ai/*.ts`, tạo module thuần dual-export (giống `explain.js`):

```
ai/gemini-service.js    // fetch Gemini — chạy trong background.js (CORS), port từ wordly geminiNativeProvider.ts
ai/prompt-builder.js    // build {system, user} + JSON schema — module thuần, test được
ai/response-parser.js   // strip code-fence + JSON.parse + validate shape — port từ wordly validate.ts
```

- API duy nhất: `explainMove(data)` → `{summary, whyBest, strategy, tactics, nextPlan, commonMistake, difficulty}`.
- UI không biết Gemini tồn tại — chỉ gọi qua message `CC_EXPLAIN` tới background (pattern như `CC_ANALYZE` trong `background.js:108-126`).
- Manifest: thêm `host_permissions` cho `https://generativelanguage.googleapis.com/*`.
- Settings: options page thêm ô Gemini API key (`type="password"`, placeholder `AIza...`, link "Get free key" → `https://aistudio.google.com/app/apikey`), lưu `chrome.storage.local` key `geminiApiKey` (+ `geminiModel`, default `gemini-2.5-flash`) — giống pattern `lichessToken` trong `options.js` và `AI_PROVIDER_CONFIGS` của wordly.

## Phase 3 — Prompt Engineering (quan trọng nhất)

Ép Gemini trả **JSON only** — dùng `responseMimeType: 'application/json'` + `responseSchema` (nhớ sanitize schema kiểu `toGeminiSchema` của wordly: bỏ optional fields, `additionalProperties`, min/max). Không parse markdown; vẫn giữ code-fence stripper làm fallback.

Prompt khuyến nghị (Gemini không được "chém gió", chỉ diễn giải từ dữ liệu Stockfish):

```
You are a professional chess coach.
Do NOT invent variations. Only explain using the supplied Stockfish analysis.
Keep the explanation under 180 words.
Audience: 1200 Elo player.
Return JSON only.

{
  "summary": "",
  "whyBest": "",
  "strategy": "",
  "tactics": "",
  "nextPlan": [""],
  "commonMistake": "",
  "difficulty": 1-5
}

Position: FEN ...
Best Move: ...
Evaluation: ...
Principal Variation: ...
Top Moves: ...
```

Config: `temperature: 0.2`, `thinkingConfig: { thinkingBudget: 0 }` (như wordly).

## Phase 4 — UI

Render kết quả thành một `.cc-prow` mới trong panel (theo pattern `resultsHtml()` `chess-coach.js:523-574`): hiện "Analyzing…" rồi fill. Layout đọc nhanh:

```
⭐ Best Move: Nf3
💡 Why: Develops the knight and prepares castling...
♟ Strategy: Improve piece activity before attacking.
⚔ Tactical Idea: No immediate tactics.
🎯 Plan: Castle → d4 → activate bishop
⚠ Common mistake: Playing h3 wastes a tempo.
Difficulty: ★★☆☆☆
```

(Toàn bộ text coach bằng tiếng Anh.)

## Phase 5 — Cache

Cache theo `hash(FEN + bestMove)` (thêm depth vào key để phân biệt chất lượng phân tích). Lưu `chrome.storage.local` (đơn giản hơn IndexedDB, đã dùng sẵn trong repo). Phân tích lại vị trí cũ → không gọi Gemini.

## Phase 6 — Streaming

Chuyển sang endpoint `streamGenerateContent?alt=sse`, UI hiện "Analyzing…" rồi từng đoạn xuất hiện. (Lưu ý: streaming + ép JSON khó hiển thị từng phần — có thể stream field-by-field hoặc chỉ stream mode text sau này.)

## Phase 7 — Cost Control

Không gọi AI nếu:
- `depth < 12`
- Mate detected (`score.type === 'mate'`)
- Forced move (chỉ có 1 nước hợp lệ — check bằng movegen trong `chesscore.js`)

## Phase 8 — Prompt nâng cao

Tiền xử lý trước khi gọi Gemini (tính bằng `chesscore.js` + `explain.js` `moveFacts`, giảm token, Gemini chỉ diễn giải thay vì suy luận từ FEN):

```js
{
  phase: "middlegame",
  material: "equal",
  kingSafety: "white safe, black slightly exposed",
  centerControl: "white controls e5 and d5",
  mobility: "white pieces more active",
  opening: "Italian Game",   // đã có openings.json
  bestMove: "Nf3",
  eval: "+0.82",
  pv: ["Nf3", "d5", "g3", "Nc6", "Bg2"]
}
```

## Phase 9 — Nâng cấp dần (modes)

- **Coach** — giải thích như HLV (default).
- **Beginner** — chỉ dùng từ đơn giản.
- **Advanced** — weak square, prophylaxis, initiative, pawn break.
- **Compare** — Your Move ↓ Stockfish Move ↓ Why? (mode người học thích nhất; tận dụng `explainPlayed`/`classify` sẵn có trong `explain.js`).
- **Quiz** — "Find the best move" → Ready? → Reveal (không hiện đáp án trước).

`explain.js` (rule-based) giữ làm **offline fallback** khi chưa có API key / hết quota.

---

## Testing

- `prompt-builder.js`, `response-parser.js`, helper slice-ply (Phase 0) là module thuần → test bằng `node --test` trong `test/` (pattern sẵn có: `explain.test.js`).
- E2E: load unpacked qua CDP `Extensions.loadUnpacked`, test trên ván live + ván đã kết thúc.
