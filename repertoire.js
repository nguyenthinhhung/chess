// repertoire.js — curated opening trees the coach drills against.
//
// Shape: an array of openings. Each opening trains ONE side ('w' or 'b'). Its
// `tree` is an array of sibling moves at the current ply; every node is
// { m: <SAN>, name?, note?, children? }. Walking alternates sides automatically
// (ply 0 = White). Moves are written in SAN purely for readability — coach.js
// re-derives UCI from the board, so SAN formatting here never has to be exact.
//
// `note` strings are shown to the user as coaching hints (English).

// n('e4', { note: '...', children: [...] }) — tiny node constructor.
function n(m, opts = {}) {
  return { m, ...opts };
}

// ---------------------------------------------------------------------------
// Shared Caro-Kann Classical mainline (Black to move right after 4.Nxe4).
// Reused by 2.d4 d5 3.Nc3 dxe4 4.Nxe4, the 3.Nd2 move order, and the
// 2.Nc3 d5 3.d4 dxe4 4.Nxe4 transposition. Read-only, so sharing is safe.
// ---------------------------------------------------------------------------
const CARO_CLASSICAL_AFTER_NXE4 = [
  n('Bf5', {
    name: 'Caro-Kann Classical',
    note: 'Develop the light-squared bishop OUTSIDE the pawn chain before playing …e6 — this is the whole point of the Caro over the French.',
    children: [
      n('Ng3', {
        children: [
          n('Bg6', {
            children: [
              n('h4', {
                note: 'White threatens h5 to trap the bishop. You must play …h6 to give it the h7 retreat.',
                children: [
                  n('h6', {
                    children: [
                      n('Nf3', {
                        children: [
                          n('Nd7', {
                            name: 'Caro-Kann Classical (main)',
                            note: 'Standard plan: …Ngf6, …e6, …Bd6/…Be7, …Qc7, then O-O-O.',
                            children: [
                              n('h5', {
                                children: [
                                  n('Bh7', {
                                    children: [
                                      n('Bd3', {
                                        children: [
                                          n('Bxd3', {
                                            children: [
                                              n('Qxd3', {
                                                children: [
                                                  n('e6', {
                                                    note: 'Solid structure. Continue …Ngf6, …Be7/…Bd6, …Qc7, and castle (long is most common).',
                                                    children: [
                                                      n('Bd2', {
                                                        children: [
                                                          n('Ngf6', {
                                                            children: [
                                                              n('O-O-O', {
                                                                children: [
                                                                  n('Be7', {
                                                                    note: 'End of the main theory: castle, …Qc7, …O-O-O, or break with …c5 later.'
                                                                  })
                                                                ]
                                                              })
                                                            ]
                                                          })
                                                        ]
                                                      })
                                                    ]
                                                  })
                                                ]
                                              })
                                            ]
                                          })
                                        ]
                                      })
                                    ]
                                  })
                                ]
                              })
                            ]
                          })
                        ]
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      })
    ]
  })
];

const CARO_DXE4_INTO_CLASSICAL = [
  n('dxe4', {
    children: [
      n('Nxe4', { children: CARO_CLASSICAL_AFTER_NXE4 })
    ]
  })
];

// 2.Nf3 d5 3.Nc3 cannot reuse the Classical subtree: White's king knight is
// already on f3, so its later 7.Nf3 would be illegal. Stop shallow and note
// that d4 transposes back into the main Classical line.
const CARO_NF3_DXE4 = [
  n('dxe4', {
    children: [
      n('Nxe4', {
        children: [
          n('Bf5', {
            note: '…Bf5 as in the Classical. White’s knight is already on f3, so this is an independent line; if White plays d4 it transposes to the main line.',
            children: [
              n('Ng3', {
                children: [
                  n('Bg6', {
                    children: [
                      n('d4', {
                        note: 'Transposes to the main Caro Classical: continue …e6, …Nbd7, …Ngf6.',
                        children: [n('e6', {})]
                      }),
                      n('h4', {
                        note: 'Reply …h6 to keep the bishop; play is similar to the Classical.',
                        children: [n('h6', {})]
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      })
    ]
  })
];

const REPERTOIRE = [
  // =========================================================================
  // ITALIAN GAME — trained as White.
  // =========================================================================
  {
    id: 'italian',
    name: 'Italian Game',
    side: 'w',
    eco: 'C50–C54',
    summary: 'White repertoire: e4, Nf3, Bc4 eyeing f7, then a slow build-up with c3 and d3.',
    tree: [
      n('e4', {
        children: [
          n('e5', {
            children: [
              n('Nf3', {
                note: 'Attacks e5 and forces Black to react.',
                children: [
                  n('Nc6', {
                    children: [
                      n('Bc4', {
                        name: 'Italian Game',
                        note: 'The bishop points straight at f7 — Black’s weakest point in the opening.',
                        children: [
                          // --- 3...Bc5: Giuoco Piano ---
                          n('Bc5', {
                            name: 'Giuoco Piano',
                            children: [
                              n('c3', {
                                note: 'Prepares d4 to build the centre; also opens the Qb3 idea against f7.',
                                children: [
                                  n('Nf6', {
                                    children: [
                                      n('d3', {
                                        name: 'Giuoco Pianissimo',
                                        note: 'Quiet set-up: Nbd2–f1–g3, O-O, and only then d4. Avoid an early 4.d4, where Black equalises easily.',
                                        children: [
                                          n('d6', {
                                            children: [
                                              n('O-O', {
                                                children: [
                                                  n('O-O', {
                                                    children: [
                                                      n('Nbd2', {
                                                        note: 'Re-route the knight Nd2–f1–g3 toward the kingside; keep the tension and break with d4 at the right moment.',
                                                        children: [
                                                          n('a6', { note: 'End of theory: continue Nf1, Ng3, Re1, then d4.' }),
                                                          n('a5', { note: 'Black grabs space for the bishop. Just play Nf1–g3, h3, Re1, d4.' })
                                                        ]
                                                      })
                                                    ]
                                                  })
                                                ]
                                              })
                                            ]
                                          }),
                                          n('O-O', {
                                            children: [
                                              n('O-O', { note: 'Same plan: Nbd2–f1–g3, h3, Re1, d4.' })
                                            ]
                                          })
                                        ]
                                      })
                                    ]
                                  }),
                                  n('Qe7', { note: 'Black keeps the bishop on c5. Play O-O, d4, Re1 for a flexible centre.' }),
                                  n('d6', {
                                    children: [
                                      n('d4', { note: 'Black was slow, so White gets to play d4 and seize the centre.' })
                                    ]
                                  })
                                ]
                              })
                            ]
                          }),
                          // --- 3...Nf6: Two Knights Defense ---
                          n('Nf6', {
                            name: 'Two Knights Defense',
                            children: [
                              n('d3', {
                                note: 'Choose the solid d3 over the sharp 4.Ng5 (Fried Liver) — easier to play and far less theory.',
                                children: [
                                  n('Bc5', {
                                    children: [
                                      n('c3', {
                                        children: [
                                          n('a6', { note: 'Continue Bb3, Nbd2, O-O, Re1, d4 — a typical Italian.' }),
                                          n('d6', {
                                            children: [
                                              n('O-O', { note: 'Same Pianissimo plan: Nbd2–f1–g3, then d4.' })
                                            ]
                                          })
                                        ]
                                      })
                                    ]
                                  }),
                                  n('Be7', {
                                    children: [
                                      n('O-O', { note: 'Black plays it safe. Reply Re1, c3, Nbd2, d4.' })
                                    ]
                                  }),
                                  n('h6', { note: 'Stops Bg5/Ng5. Just continue O-O, c3, Nbd2, d4.' })
                                ]
                              })
                            ]
                          }),
                          // --- minor 3rd moves for Black ---
                          n('Be7', {
                            note: 'Hungarian Defense — passive. Take the centre at once with d4.',
                            children: [n('d4', {})]
                          }),
                          n('d6', {
                            note: 'Semi-Italian. Play c3 and d4 (or O-O first) to grab the centre.',
                            children: [n('c3', {})]
                          })
                        ]
                      })
                    ]
                  }),
                  // Black avoids 2...Nc6
                  n('Nf6', { note: 'Petrov (Russian) Defense — not an Italian. You can play 3.d4 or 3.Nxe5.' }),
                  n('d6', { note: 'Philidor Defense — not an Italian. Play 3.d4 to take the centre.' })
                ]
              })
            ]
          }),
          // Black avoids 1...e5 → the Italian never appears.
          n('c5', { note: 'Sicilian — Black avoids e5, so NO Italian arises. You need a separate anti-Sicilian repertoire.' }),
          n('e6', { note: 'French Defense — outside the Italian repertoire.' }),
          n('c6', { note: 'Caro-Kann — outside the Italian (this is the defense you play as Black).' })
        ]
      })
    ]
  },

  // =========================================================================
  // CARO-KANN DEFENSE — trained as Black.
  // =========================================================================
  {
    id: 'caro-kann',
    name: 'Caro-Kann Defense',
    side: 'b',
    eco: 'B10–B19',
    summary: 'Black repertoire vs 1.e4: …c6 then …d5, a sound structure where the c8-bishop gets out early.',
    tree: [
      n('e4', {
        children: [
          n('c6', {
            name: 'Caro-Kann',
            note: 'Prepare …d5 to hit the centre without burying the c8-bishop like the French does.',
            children: [
              n('d4', {
                children: [
                  n('d5', {
                    name: 'Caro-Kann',
                    children: [
                      // 3.Nc3 / 3.Nd2 -> Classical (shared)
                      n('Nc3', { children: CARO_DXE4_INTO_CLASSICAL }),
                      n('Nd2', { children: CARO_DXE4_INTO_CLASSICAL }),
                      // 3.e5 Advance
                      n('e5', {
                        name: 'Advance Variation',
                        children: [
                          n('Bf5', {
                            note: 'Golden rule of the Caro: get the bishop out with …Bf5 BEFORE closing with …e6.',
                            children: [
                              n('Nf3', {
                                children: [
                                  n('e6', {
                                    children: [
                                      n('Be2', {
                                        children: [
                                          n('Nd7', {
                                            children: [
                                              n('O-O', {
                                                children: [
                                                  n('Ne7', {
                                                    note: 'Plan: …Ng6, …Be7, …O-O, then hit the chain with …c5. The knight goes e7–g6 to pressure e5.'
                                                  })
                                                ]
                                              })
                                            ]
                                          })
                                        ]
                                      })
                                    ]
                                  })
                                ]
                              }),
                              n('Nc3', {
                                note: 'Sharp (threatens g4). Reply …e6; if g4 then …Bg6 and …h5 to counter on the flank.',
                                children: [n('e6', {})]
                              }),
                              n('Be3', {
                                note: 'White keeps the bishop. Reply …e6, then …Qb6 / …Nd7 and …c5.',
                                children: [n('e6', {})]
                              })
                            ]
                          })
                        ]
                      }),
                      // 3.exd5 Exchange / Panov
                      n('exd5', {
                        children: [
                          n('cxd5', {
                            children: [
                              n('Bd3', {
                                name: 'Exchange Variation',
                                children: [
                                  n('Nc6', {
                                    children: [
                                      n('c3', {
                                        children: [
                                          n('Nf6', {
                                            children: [
                                              n('Bf4', {
                                                children: [
                                                  n('Bg4', {
                                                    note: 'Balanced and easy to play. Continue …e6, …Bd6, …Qc7/…O-O.',
                                                    children: [n('Qb3', { children: [n('Qd7', {})] })]
                                                  })
                                                ]
                                              })
                                            ]
                                          })
                                        ]
                                      })
                                    ]
                                  })
                                ]
                              }),
                              n('c4', {
                                name: 'Panov–Botvinnik Attack',
                                children: [
                                  n('Nf6', {
                                    children: [
                                      n('Nc3', {
                                        children: [
                                          n('e6', {
                                            note: 'A solid QGD/Nimzo-style set-up. You can play …Be7 or …Bb4.',
                                            children: [
                                              n('Nf3', {
                                                children: [
                                                  n('Be7', { note: 'Continue …O-O, …Nc6, …dxc4 or …b6 depending on the position.' }),
                                                  n('Bb4', { note: 'Pin the c3-knight, Nimzo-style — pressures the centre.' })
                                                ]
                                              })
                                            ]
                                          })
                                        ]
                                      })
                                    ]
                                  })
                                ]
                              })
                            ]
                          })
                        ]
                      })
                    ]
                  })
                ]
              }),
              // ---- 2.Nc3 (then ...d5) ----
              n('Nc3', {
                children: [
                  n('d5', {
                    children: [
                      n('d4', { children: CARO_DXE4_INTO_CLASSICAL }),
                      n('Nf3', {
                        name: 'Two Knights vs Caro',
                        children: [
                          n('Bg4', {
                            note: 'Pin the f3-knight immediately — the Caro’s main answer to the Two Knights.',
                            children: [
                              n('h3', {
                                children: [
                                  n('Bxf3', {
                                    children: [
                                      n('Qxf3', {
                                        children: [
                                          n('Nf6', {
                                            note: 'Continue …e6, …Bb4/…Nbd7, …d5 is already solid. White’s bishop pair is offset by your structure.'
                                          })
                                        ]
                                      })
                                    ]
                                  })
                                ]
                              })
                            ]
                          })
                        ]
                      }),
                      n('exd5', {
                        children: [n('cxd5', { note: 'Heads into Exchange/Panov structures depending on whether White follows with d4 or c4.' })]
                      })
                    ]
                  })
                ]
              }),
              // ---- 2.Nf3 ----
              n('Nf3', {
                children: [
                  n('d5', {
                    children: [
                      n('Nc3', { children: CARO_NF3_DXE4 }),
                      n('e5', { note: 'Heads into the Advance: …Bf5 then …e6 as above.', children: [n('Bf5', {})] }),
                      n('exd5', { children: [n('cxd5', {})] })
                    ]
                  })
                ]
              }),
              // ---- quiet 2nd moves ----
              n('d3', {
                name: 'King’s Indian Attack',
                note: 'White plays it quietly. Reply …d5 comfortably and take the centre.',
                children: [n('d5', {})]
              }),
              n('c4', {
                note: 'English-style Caro. …d5 is still fine; …e6 can support it.',
                children: [n('d5', {})]
              })
            ]
          })
        ]
      }),
      // Other White first moves: Caro-Kann is a reply to 1.e4 only.
      n('d4', { note: 'White opens 1.d4 — not Caro-Kann territory (you’d need a separate 1.d4 repertoire).' }),
      n('Nf3', { note: 'White opens 1.Nf3 (Réti) — outside the Caro-Kann; you can answer …d5 or …c5.' }),
      n('c4', { note: 'White opens 1.c4 (English) — outside the Caro-Kann.' })
    ]
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REPERTOIRE };
} else if (typeof globalThis !== 'undefined') {
  globalThis.REPERTOIRE = REPERTOIRE;
}
