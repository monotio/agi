### Reading (hand-written; JUDGMENT unless a number is quoted from the tables)

Facts, against the [baseline](../../1.0.0-baseline/matrix/matrix.md):

- Every lane passed. Tool failures fell from 48 to 20: Luna from 15 to 3, Opus high from 9 to 5, Astra from 5 to 2.
- Opus high needed 23 model turns instead of 46 and cost $2.01 instead of $3.24. It also wrote less this time: 48 said() phrases against 190. One run per lane cannot separate that from variance.
- Luna now sets a horizon (50), draws depth bands (22% of the picture) and animates ego. Opus medium and Astra draw depth too; Opus high stays flat and Sol nearly so (0.3%).
- Opus still named plan rooms `name`, which accounts for its remaining invalid-args failures. That is fixed after this run; see the README.

Judgment (single run per lane):

- Best balance: Astra ($1.80): the fewest failures (2), the most tests (7) and depth.
- Opus medium ($1.66) builds a rich room with depth for less than Astra.
- Sol ($0.31) remains the value pick. Luna ($0.03) is plain but now plays like an AGI room.
