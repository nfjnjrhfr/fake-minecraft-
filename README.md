# Synthesis Camp Games

Playable single-player reconstructions of the collaborative strategy games run at
**Synthesis** — the programme that began as a class at Ad Astra, the school Elon Musk
set up on the SpaceX campus, and now runs as an online school of its own.

The originals are multiplayer, moderated by an adult facilitator, and deliberately
taught *without rules*: children are dropped into the simulation mid-stream and have to
work out what is going on from the inside. These are reconstructions of the same
mechanics for one player against an AI or against a system — shifting scoring, a
common-pool resource, sealed bids, an opponent that is a fire rather than a person.

## Playing

No build step, no dependencies, no network. Either:

```
open index.html          # straight off disk
```

or serve the folder statically if you prefer (`npx http-server`, `python3 -m http.server`).
Everything is plain HTML, CSS and JavaScript, and every game runs offline.

## The games

| Game | What it is | The thing it teaches |
| --- | --- | --- |
| **Constellation** | Three claimants take turns taking stars off a 6×6 map. Three scoring variables are live at once and one is swapped out after rounds 3 and 6. | Build for the rules you have, hedge for the rules you might get. |
| **Constellation 3D** | The same idea in a 4×4×4 cube. 76 straight lines of four run through it and a line pays only the claimant who holds it uncontested. | Depth you cannot see is still depth. Blocking is worth as much as building. |
| **Proxima** | One ship, one tank of fuel, sixteen systems. Every arrival tells you how many jumps you are from Proxima b; the survey only counts if you get it home. | Routing under a hard budget, and paying to find out before you commit. |
| **Fish** | Four fleets, one stock of fish, twelve seasons. You can announce a cap; nobody is bound by it. | The commons. Fishing flat out beats the other fleets and lands you less fish. |
| **Fire** | A forest fire under a shifting wind, four crew actions an hour, six homes to protect. | The opponent is a system. It behaves the same whether or not you understand it. |
| **Art For All** | Fourteen works, open ascending auction, three rival museums with visible tastes. Depth, breadth and public appeal all score. | What a thing is worth to you is not what it costs, and the auction you win is the one you overpaid for. |
| **Hollywood** | Buy scripts, stars and directors in sealed bids, then cut one film a season into an audience whose taste has already moved. | Forecasting, and the difference between a great asset and a profitable one. |
| **GeoBridge** | Connect eleven towns to the capital on a budget, over terrain and across a river. The spring flood takes one bridge at random. | The cheapest connected network is a tree, and a tree is exactly what a single failure cuts in half. |

## Notes on the reconstructions

The published descriptions of the Synthesis games are short, so these are built from the
*mechanic* each one is known for rather than from its exact rules. Where a design choice
was open, it was settled by simulating the game and checking that the intended lesson
actually pays:

- **Fish** — the naive line (fish 300 t a season, announce nothing) collapses the fishery
  100% of the time and lands about 2,700 t. Announcing a cap at the sustainable share and
  keeping it survives 85% of the time and lands about 4,700 t. Fishing flat out lands 3,200 t
  and comes first every time, which is why the game scores you against a managed
  quarter-share of 4,500 t rather than against the other fleets.
- **GeoBridge** — a minimum spanning tree scores a median 187 and survives the flood intact
  5% of the time. The same tree plus one redundant bridge scores 215 and survives 54%.
- **Hollywood** — bidding 45% of an asset's stated worth wins nothing; bidding 75% wins the
  decade 9 times in 14. Sitting out entirely loses to all three rival studios.
- **Art For All** — bidding to 70% of a work's raw prestige-and-appeal value wins no lots at
  all; bidding to 130% wins the season 7 times in 12.
- **Proxima** — an expedition that knows the way and takes the cheapest route home makes it
  89% of the time on a full tank, so the difficulty is in finding the way, not in the arithmetic.

## Layout

```
index.html            hub with a card per game
shared/theme.css      one visual language for all eight
shared/util.js        seeded RNG, canvas fitting, pointer maths, logging
games/<name>/index.html   one self-contained game each
```

Each game is a single file with its rules, AI and rendering inline, so any one of them can
be lifted out and dropped somewhere else with only `shared/` alongside it.

## Attribution

The original game concepts belong to Synthesis. These are independent implementations
written from public descriptions of how each game plays — no Synthesis code, art, assets or
content is used, and this project is not affiliated with or endorsed by Synthesis.
