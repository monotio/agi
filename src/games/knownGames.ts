/**
 * Known AGI games catalog and content hash lookups.
 * Zero runtime dependencies, pure TypeScript for engine, harness, and app.
 */

import { requireResourceRevision, type ResourceRevision } from "../gameIdentity.ts";

export type GameHash = string;

export interface KnownAgiGame {
  readonly alias: string;
  readonly title: string;
  readonly author: string;
  readonly era: "v2-split" | "v3-combined";
  readonly profile: string;
  readonly wordsSha256: GameHash;
  readonly objectSha256: string;
  readonly targetRevision?: ResourceRevision | undefined;
  readonly walkthroughLabel?: string | undefined;
  readonly walkthroughCoverage?: "complete-game" | "chapter" | "partial" | undefined;
  /**
   * Additional bundle revisions the walkthrough supports beyond
   * `targetRevision` — e.g. a builtin served through the dev fixture server
   * boots a filtered file set whose revision differs from the catalog's.
   */
  readonly walkthroughRevisions?: readonly ResourceRevision[] | undefined;
  /**
   * The game's resources are assembled by project code, so no fixture files
   * need to exist on disk: the loader builds it from source. See the builder
   * registry in test/game-fixture.ts.
   */
  readonly builtin?: true;
}

export const KNOWN_GAME_HASH = {
  KQ1: "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780",
  KQ2: "d404578e135a58dafd390b722e9f7bef57e30a693cf08608c824fc6315c73d93",
  KQ3: "3119d49660710ab1efcbf11e5d37d299bb8415ba0af19d731a4b8cd5cc12ae54",
  KQ4: "b4312845b4713c29f4c5ba397477c47073d37ca5c3951953c1e4f0bf56125517",
  SQ1: "7538e02617e9d8afd8c8de8cb1c2290ca24291d5b1af1e329486c2f84571803e",
  SQ2: "243a927918759dd3f17654f1bdfb87ea333c81da9c6df63a3a2b39136e433cf5",
  MH1: "a1321c4bcac945ec224481989e22e42972ef02aee48221e3ec95b2d83cc479f6",
  MH2: "3a603f629fde2da7faaa2cf4496b7485bc76a058ef5a139f38ed161ff718f8fd",
  PQ1: "a95eed1c9b2fcafb5ba63f2424adf05a3a1f7c349089fc22b09277ae020a13c2",
  LSL1: "c915d38790325343154322fa1ad9e529bb548a45f3c09c12e9e8942a1bca0853",
  BC: "0bfd4cf711c67edf6ca132b6f9053517564dd6497e0032e34076ec7a7f59a8b2",
  GR1: "2d1a372f25f07dcccf606b01ad503287ef6b2ddd69d0b88bdbcd1b59993296ee",
  DDP: "ea3856277ff2bca73bd85884d7b2f5d269a0be8f115c0b824c7f8e98da30d116",
  MUMG: "a718ca71030b946726a197e891998ab44ad3fe363e346810fa2d720151aa1d3e",
  DEMOPAC4: "6c7456ae306ad62ed6be4d3442f03d853e66c773661dcad79ae4b2f0152ccdec",
  SYNTHETIC: "d00cc5981820a66d3a56c802f8d747a73fe153d394a80463accf313947623fa1",
  ADVENTURE_DEPARTMENT: "c9085eb86d115abce91442186553a4b4a39cf30a2729fc8faaf259d74c07175d",
} as const;

export const KNOWN_GAMES: readonly KnownAgiGame[] = [
  {
    alias: "synthetic",
    title: "Synthetic Test Chamber",
    author: "Monotio",
    era: "v2-split",
    profile: "2.936",
    wordsSha256: KNOWN_GAME_HASH.SYNTHETIC,
    objectSha256: "f58e6871c43d8639afca350562544a1f040dc94475c545ca069f4e69635d6425",
    targetRevision: requireResourceRevision(
      "cee5199128b5bd05b609cb4b5d5941e1706010949c5177c19e4746fdddac0baf",
    ),
    walkthroughLabel: "Complete route (50 pts)",
    walkthroughCoverage: "complete-game",
    builtin: true,
  },
  {
    alias: "adventure-department",
    title: "Adventure Department",
    author: "Monotio",
    era: "v2-split",
    profile: "2.936",
    wordsSha256: KNOWN_GAME_HASH.ADVENTURE_DEPARTMENT,
    objectSha256: "1a3d0818f9664f9d92b8e1b4721bc2568419849067c44bf36fc1a4ed0e8d67a9",
    // TESTS.JSON is not part of the canonical playable set, so the fixture
    // server's public file set and the full project boot to one revision.
    targetRevision: requireResourceRevision(
      "cea77c79b10524206e9ad09881b00dcf856fca0e3ae640917f7e3ca391042f2b",
    ),
    walkthroughLabel: "Complete route (30 pts)",
    walkthroughCoverage: "complete-game",
    builtin: true,
  },
  {
    alias: "kq1",
    title: "King's Quest I: Quest for the Crown",
    author: "Roberta Williams (Sierra On-Line)",
    era: "v2-split",
    profile: "2.917",
    wordsSha256: KNOWN_GAME_HASH.KQ1,
    objectSha256: "2d1b7a75bb443b4a340cb8d9a2842ff5c834d7d597ea2a1365b6a7a2dfb57985",
    targetRevision: requireResourceRevision(
      "d1553b8b6ac8e69c6ced7da7450b88a8ff093e83c52dcb0ed9df550b5661931a",
    ),
    walkthroughLabel: "Completed throne-room ending (159 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "kq2",
    title: "King's Quest II: Romancing the Throne",
    author: "Roberta Williams (Sierra On-Line)",
    era: "v2-split",
    profile: "2.411",
    wordsSha256: KNOWN_GAME_HASH.KQ2,
    objectSha256: "14c85b6720fafd5e045416f65246e695bf4966c0ca52bf5f5e678b5c14a56e2a",
    targetRevision: requireResourceRevision(
      "16375e1aae7033480dc07715c8bb7a0a742e0ada34af7cd4e7acc0b8954cab42",
    ),
    walkthroughLabel: "Completed wedding & credits (185 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "kq3",
    title: "King's Quest III: To Heir Is Human",
    author: "Roberta Williams (Sierra On-Line)",
    era: "v2-split",
    profile: "2.936",
    wordsSha256: KNOWN_GAME_HASH.KQ3,
    objectSha256: "c6bd058fea81017391dc7d61ad20817b678c1c2702ff2d43df22992922233712",
    targetRevision: requireResourceRevision(
      "fcb5fc83e2b4844d38aa5c0fcfcc291b6e41a97df2015aacad85b7f42b73a399",
    ),
    walkthroughLabel: "Completed royal reunion (210 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "kq4",
    title: "King's Quest IV: The Perils of Rosella",
    author: "Roberta Williams (Sierra On-Line)",
    era: "v3-combined",
    profile: "3.002.086",
    wordsSha256: KNOWN_GAME_HASH.KQ4,
    objectSha256: "d1abca8f74c371555038ea7d5808507b76a4f7d0978eba250a1766c2737660bf",
    targetRevision: requireResourceRevision(
      "ad3bef3648923e5082ef5b5f318aa47e3afd47c5492b60d69705b441bbb074f9",
    ),
    walkthroughLabel: "Returned the talisman & healed King Graham (230 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "sq1",
    title: "Space Quest I: The Sarien Encounter",
    author: "Mark Crowe, Scott Murphy (Sierra On-Line)",
    era: "v2-split",
    profile: "2.917",
    wordsSha256: KNOWN_GAME_HASH.SQ1,
    objectSha256: "058d2fcfef8df6667e764b889a1c22d6b8746eac8c25321f707a64e4d712464c",
    targetRevision: requireResourceRevision(
      "4e25ac4490afba3c5d6bd49c0d1429d8d375f8bb557e284c7337c1f334ccbe1e",
    ),
    walkthroughLabel: "Completed ceremony & credits (202 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "sq2",
    title: "Space Quest II: Vohaul's Revenge",
    author: "Mark Crowe, Scott Murphy (Sierra On-Line)",
    era: "v2-split",
    profile: "2.936",
    wordsSha256: KNOWN_GAME_HASH.SQ2,
    objectSha256: "3b887ff34eb1ec5b9f398e98ad6443b03cb3f7d32eeac01abc096c08a048a766",
    targetRevision: requireResourceRevision(
      "90b7a965bf889351bb79340ca710ce4abf1eae1777c8e10de409d40263df7cbb",
    ),
    walkthroughLabel: "Completed Vohaul's defeat & escape (250 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "mh1",
    title: "Manhunter: New York",
    author: "Dave Murry, Barry Murry (Sierra On-Line)",
    era: "v3-combined",
    profile: "3.002.102",
    wordsSha256: KNOWN_GAME_HASH.MH1,
    objectSha256: "1eb55220ec7e22ebb7cb181486d54eaddbf4ec0159193645cbf2876321b495a5",
    targetRevision: requireResourceRevision(
      "010d2c6c1edf1a27bedded58faad86cb50a9f6970050f27736dc84d41854216d",
    ),
    walkthroughLabel: "Completed all four days",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "mh2",
    title: "Manhunter 2: San Francisco",
    author: "Dave Murry, Barry Murry (Sierra On-Line)",
    era: "v3-combined",
    profile: "3.002.149",
    wordsSha256: KNOWN_GAME_HASH.MH2,
    objectSha256: "6a4e3f3eaf1070e119a9667352c0d58e360843af1577767664a8719b4ecdae06",
    targetRevision: requireResourceRevision(
      "eea0ebc7f22ef50d2fc4f7c3557622f6331242ab1b8152a57badf855d761dd60",
    ),
    walkthroughLabel: "Freed San Francisco & reached the closing card",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "pq1",
    title: "Police Quest: In Pursuit of the Death Angel",
    author: "Jim Walls (Sierra On-Line)",
    era: "v2-split",
    profile: "2.903",
    wordsSha256: KNOWN_GAME_HASH.PQ1,
    objectSha256: "ed0e6e31fe8f714dcc10243f0b5cdff5f707375ee4b1d55f4b311da3b9803d47",
    targetRevision: requireResourceRevision(
      "cb643573c06cb9799fa2c08fcf4eec77db3a2102d07b199a6703a0d49c5164b3",
    ),
    walkthroughLabel: "Arrested Jessie Bains & key to the city (254 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "lsl1",
    title: "Leisure Suit Larry in the Land of the Lounge Lizards",
    author: "Al Lowe (Sierra On-Line)",
    era: "v2-split",
    profile: "2.440",
    wordsSha256: KNOWN_GAME_HASH.LSL1,
    objectSha256: "772c057edfd5ef994465580e3bb944f790e20661921d894f54b68920fa26647d",
    targetRevision: requireResourceRevision(
      "2e604e7968796317b407bd87708e75f985b43737f2677e09591191af100cd470",
    ),
    walkthroughLabel: "Spent the night with Eve (222 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "bc",
    title: "The Black Cauldron",
    author: "Al Lowe (Sierra On-Line / Walt Disney)",
    era: "v2-split",
    profile: "2.440",
    wordsSha256: KNOWN_GAME_HASH.BC,
    objectSha256: "44963ca0358f6aeb922456346275494b5f931c3c8e627f2764640b7d441acbd9",
    targetRevision: requireResourceRevision(
      "76a1c27b07d3c22cd336aaa69838fb3f35bce1bf6c7851e4f72c2b225bd051ef",
    ),
    walkthroughLabel: "Destroyed the Black Cauldron (230 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "gr1",
    title: "Gold Rush!",
    author: "Doug MacNeill, Ken MacNeill (Sierra On-Line)",
    era: "v3-combined",
    profile: "3.002.149",
    wordsSha256: KNOWN_GAME_HASH.GR1,
    objectSha256: "2ff4ecbb1513d5951a9847fd5d283d2a7d1cbba211f2c763e34741ee5cb73766",
    targetRevision: requireResourceRevision(
      "0be9505e2a9582c5fe99347acc5713459bab81fb65063bcc46985fd5c49d8433",
    ),
    walkthroughLabel: "Struck the mother lode via Panama (255 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "ddp",
    title: "Donald Duck's Playground",
    author: "Al Lowe (Sierra On-Line / Walt Disney)",
    era: "v2-split",
    profile: "2.440",
    wordsSha256: KNOWN_GAME_HASH.DDP,
    objectSha256: "ef60a61d5c92943f073873ddc4daa983c545831d60a5826bbc210de5b0897d67",
    targetRevision: requireResourceRevision(
      "4ae970dd2e680033206d042b0fddf295ae91b29e6bd303d8c0cfc9635c766a15",
    ),
    walkthroughLabel: "Beginner shift, bought & placed the Old Box",
    walkthroughCoverage: "chapter",
  },
  {
    alias: "mumg",
    title: "Mixed-Up Mother Goose",
    author: "Roberta Williams (Sierra On-Line)",
    era: "v2-split",
    profile: "2.917",
    wordsSha256: KNOWN_GAME_HASH.MUMG,
    objectSha256: "addd77de06fa96476cda9452e7e828e1b398aa73fbae5bc2a6dd133ffdf645b8",
    targetRevision: requireResourceRevision(
      "0c20e2c06cf48a1738b76f3dd82753967f50ec2f635dfe2f91b524857301cfba",
    ),
    walkthroughLabel: "Fixed all 18 rhymes & woke up at home (18 pts)",
    walkthroughCoverage: "complete-game",
  },
  {
    alias: "demopac4",
    title: "Sierra AGI Demo Pack 4",
    author: "Sierra On-Line",
    era: "v3-combined",
    profile: "3.002.102",
    wordsSha256: KNOWN_GAME_HASH.DEMOPAC4,
    objectSha256: "e44f10db5325edfa883a5a1fc02646239ee4b628a82c94f5bb60937e40efa3f9",
    targetRevision: requireResourceRevision(
      "1e914a657dc2a7e0b9c9fda5f183c5d1ec9f52cab146a58d9ed1077b016d5df7",
    ),
  },
  // Platform ports carry their own (WORDS.TOK, OBJECT) pair and run under
  // their own interpreter profiles (docs/fidelity.md "Amiga interpreter
  // profiles"; the IIgs entry stays on the PC profile it was catalogued with).
  {
    alias: "sq1-amiga",
    title: "Space Quest I (Amiga)",
    author: "Mark Crowe, Scott Murphy (Sierra On-Line)",
    era: "v2-split",
    profile: "amiga-2.082",
    wordsSha256: "252c863e9d8e65f0c08f63ec8188a4956d056658032cd2e04a9588db838e695e",
    objectSha256: "ce283e791f78be46ba63a2d96065293befbe6f01156ffc714493259900eaf28a",
  },
  {
    alias: "kq2-amiga",
    title: "King's Quest II (Amiga)",
    author: "Roberta Williams (Sierra On-Line)",
    era: "v2-split",
    profile: "amiga-2.176",
    wordsSha256: "536b272ad012c93a2dcc238d263ced36b406cd96eed3e1e2378c911b504475d4",
    objectSha256: "4eeb797b36cc448a3f834b6ad066cee732c5a5b77aa00cd99663ed23b6459473",
  },
  {
    alias: "sq2-amiga",
    title: "Space Quest II (Amiga)",
    author: "Mark Crowe, Scott Murphy (Sierra On-Line)",
    era: "v2-split",
    profile: "amiga-2.202",
    wordsSha256: KNOWN_GAME_HASH.SQ2,
    objectSha256: "d5c766d0725ab0cd4bb23b863217277d97ca99a8bf073e44199d7387297ecb27",
  },
  {
    alias: "pq1-amiga",
    title: "Police Quest (Amiga)",
    author: "Jim Walls (Sierra On-Line)",
    era: "v3-combined",
    profile: "amiga-2.310",
    wordsSha256: KNOWN_GAME_HASH.PQ1,
    objectSha256: "f0d630abc339c4acf3492a6f6e7b59b72ef7d80a948b2b1f97124f11a218893a",
  },
  {
    alias: "goldrush-amiga",
    title: "Gold Rush! (Amiga)",
    author: "Doug MacNeill, Ken MacNeill (Sierra On-Line)",
    era: "v3-combined",
    profile: "amiga-2.316",
    wordsSha256: KNOWN_GAME_HASH.GR1,
    objectSha256: "f87ac0d5dea09968f1068d158b4f98119c3ddb2fa0a221bacecb7f530df70bd3",
  },
  {
    alias: "mh2-amiga",
    title: "Manhunter 2 (Amiga)",
    author: "Dave Murry, Barry Murry (Sierra On-Line)",
    era: "v3-combined",
    profile: "amiga-2.333",
    wordsSha256: KNOWN_GAME_HASH.MH2,
    objectSha256: "afd8025f7944a997f397ed6b15607cb6e85f3282935165123b11bfe4b4a76ca8",
  },
  {
    alias: "sq2-iigs",
    title: "Space Quest II (Apple IIgs)",
    author: "Mark Crowe, Scott Murphy (Sierra On-Line)",
    era: "v2-split",
    profile: "iigs-1.014",
    wordsSha256: "c4af35513d77e3956170139a5545c6170e9a73d9431ca8099d465c5a7d68b2a3",
    objectSha256: "3b887ff34eb1ec5b9f398e98ad6443b03cb3f7d32eeac01abc096c08a048a766",
  },
];

const BY_ALIAS = new Map<string, KnownAgiGame>(KNOWN_GAMES.map((g) => [g.alias.toLowerCase(), g]));
// A platform port can share its PC release's vocabulary hash; the first
// entry keeps a bare WORDS.TOK lookup on the catalogued PC edition and the
// port resolves through the (WORDS.TOK, OBJECT) pair instead.
const BY_WORDS_HASH = new Map<string, KnownAgiGame>();
for (const game of KNOWN_GAMES) {
  const key = game.wordsSha256.toLowerCase();
  if (!BY_WORDS_HASH.has(key)) BY_WORDS_HASH.set(key, game);
}
const BY_REVISION = new Map<string, KnownAgiGame>(
  KNOWN_GAMES.filter((g): g is KnownAgiGame & { targetRevision: ResourceRevision } =>
    Boolean(g.targetRevision),
  ).map((g) => [g.targetRevision.toLowerCase(), g]),
);

/** Look up a known game by its human-friendly alias (e.g. "mh1", "kq1"). */
export function getKnownGameByAlias(alias: string): KnownAgiGame | null {
  return BY_ALIAS.get(alias.toLowerCase()) ?? null;
}

/** Look up a known game by content hash (WORDS.TOK hash or bundle revision). */
export function getKnownGameByHash(hash: string): KnownAgiGame | null {
  const norm = hash.toLowerCase();
  return BY_WORDS_HASH.get(norm) ?? BY_REVISION.get(norm) ?? null;
}

/** Look up a known game by its full bundle revision hash. */
export function getKnownGameByRevision(revision: string): KnownAgiGame | null {
  return BY_REVISION.get(revision.toLowerCase()) ?? null;
}

/**
 * Look up a known game by its WORDS.TOK hash (and optional OBJECT hash).
 * With the OBJECT hash the (WORDS.TOK, OBJECT) pair is unique per edition;
 * without it the vocabulary's catalogued edition answers.
 */
export function detectKnownGameByHashes(
  wordsSha256: string,
  objectSha256?: string,
): KnownAgiGame | null {
  const norm = wordsSha256.toLowerCase();
  if (!objectSha256) return BY_WORDS_HASH.get(norm) ?? null;
  const obj = objectSha256.toLowerCase();
  return (
    KNOWN_GAMES.find(
      (g) => g.wordsSha256.toLowerCase() === norm && g.objectSha256.toLowerCase() === obj,
    ) ?? null
  );
}

/**
 * Resolve a user/script alias (e.g. "kq1", "KQ1") or raw content hash to a canonical GameHash.
 * Intended for CLI, script arguments, and UI entrypoints.
 */
export function resolveGameHash(query: string): GameHash | null {
  if (!query) return null;
  const norm = query.toLowerCase().trim();
  const byAlias = getKnownGameByAlias(norm);
  if (byAlias) return byAlias.wordsSha256;
  const byHash = getKnownGameByHash(norm);
  if (byHash) return byHash.wordsSha256;
  if (/^[0-9a-f]{64}$/i.test(norm)) return norm;
  return null;
}
