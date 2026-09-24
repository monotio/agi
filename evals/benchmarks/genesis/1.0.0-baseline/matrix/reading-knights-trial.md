### Reading (hand-written; JUDGMENT unless a number is quoted from the tables)

Facts (verified from the files):

- Every lane passed the harness playtest, used exactly one picture and one start-room logic, and wrote no sound (the only sound is the template death sound 255). Logic 255 is byte-identical to the template in all five runs. Logic 0 was extended only by Opus high (+17 instructions, 11 new global parser replies); the others changed the About text and set max score 230; Luna left it untouched.
- Luna's room has `set.horizon(0)`, no control lines and no priority bands. The flood fill from the ego start covers 100% of the screen, including light-blue/blue water (31% of reachable cells) and gray castle wall (23%). Its ego view has 4 loops of 1 cel each, so Wenna does not animate while walking. The room has no alligator sprite and no swim/death handler.
- Sol drew barriers over the moat but no depth bands; 10% of reachable cells are castle-wall gray below its horizon (110), and 2.7% of the picture is left unpainted white.
- Only Opus (both efforts) and Astra painted depth bands for props (bench, notice, rock), so Wenna can pass behind them. Astra stored a test that asserts this ("stone_walk_behind_then_in_front").
- Opus high awarded no points in the opening room. The errand is accepted in the hall, which the brief allows. The checklist row is a heuristic, not a defect.
- Four of five lanes hit the same `Source revision changed` failure on logic 0 (expectedRevision `3088-905c0d2a`). The revision taken at the first read goes stale once the model writes WORDS.TOK. This is a harness cost that every model pays, not a model weakness.

Judgment (single run per lane, one brief):

- Best value: Sol ($0.31, 202 s). It produced a coherent, playable gate room with sensible barriers, but with thinner parser coverage (26 distinct said patterns) and no depth.
- Best balance: Astra ($1.87). It had the fewest failures (4, all harness or expected), the most tests (7), depth and barrier lines, and a clean first frame.
- Richest content: Opus high (97 distinct said patterns, 3.1k chars of room text, 4-cel walk cycle). It also cost the most ($2.95, 782 s, 10 repair turns). Opus medium was about as rich (62 patterns, 3.7k chars) for 18% less.
- Luna costs almost nothing ($0.028) but falls short on authenticity: no horizon, no control or priority, a static ego and no moat death. It needs a stronger picture/priority prompt or validator before it is usable.
