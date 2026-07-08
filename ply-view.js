// ply-view.js — resolves which prefix of a game's move list corresponds to the
// ply currently on screen. chess.com's board API always returns the FULL game
// move list from game.getHistorySANs(), even while the user is scrubbing back
// through past moves in the move-list navigator; only game.getSelectedNode()
// tracks what is actually displayed (its `.ply`, or null at the starting
// position). Pure: no DOM, no chrome. Runs both as a content script (globals)
// and under the Node test runner.

// Slice `sans` down to the ply that is actually on screen. `ply` is the
// 1-indexed ply count reported by chess.com's game.getSelectedNode() (0 at the
// starting position). Any other value (undefined, out of range) is treated as
// "not navigating" and the full list is returned unchanged, which matches live
// play where the viewed position is always the last ply.
function sliceToViewedPly(sans, ply) {
  const list = Array.isArray(sans) ? sans : [];
  if (typeof ply !== 'number' || !Number.isFinite(ply) || ply < 0 || ply > list.length) {
    return list;
  }
  return list.slice(0, ply);
}

const _pvExports = { sliceToViewedPly };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _pvExports;
} else if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, _pvExports);
}
