/**
 * The campaign model.
 *
 * Everything is plain serialisable data: a whole campaign is a seed plus an
 * ordered list of actions, replayed deterministically. Elections draw from the
 * RNG cursor held in the state, so even a game that runs through three
 * parliaments rebuilds exactly.
 */

import type { Ministry } from "./ministries";
import type { Bloc } from "./parties";

/**
 * Bumped whenever a rule or a tuned number changes.
 *
 * A stored campaign is only a seed and a list of moves, replayed against
 * whatever code is running now, so a mismatch has to be refused rather than
 * silently producing a different game.
 */
export const RULES_VERSION = 11;

export const YEARS_TO_WIN = 10;

/**
 * Weeks a formateur gets before the Knesset is dissolved.
 *
 * The real thing: 28 days to form a government, and a further 14 if the
 * president grants the extension, which they usually do. Six weeks in all.
 *
 * It also happens to be the rule that keeps the game from deadlocking.
 * Portfolios stay locked with the partners that bought them, so without a
 * deadline well-funded players can each hold part of the board with none of
 * them able to afford the rest. The country's answer to that is another
 * election, and so is this game's.
 */
export const FORMING_DEADLINE = 6;

/**
 * Years a Knesset sits before the country votes again.
 *
 * The real term, and the clock a prime minister cannot bid their way out of.
 * Without it a government that holds 61 governs until it has won: the
 * opposition has no date to aim at, and a comfortable majority has no reason
 * to spend another shekel. Four years is what makes the seats bought in one
 * parliament worth defending in the next.
 */
export const TERM_LENGTH = 4;

export type PlayerKind = "human" | "random" | "greedy" | "shrewd";

export interface Player {
  key: string;
  name: string;
  kind: PlayerKind;
  /** The party this player leads. Its seats always count toward their bloc. */
  partyKey: string;
  /** Banked years in office, across every government they have led. */
  yearsInPower: number;
  /** Wild cards in hand; see {@link ./wilds}. At most {@link ./wilds#HAND_LIMIT}. */
  hand: string[];
}

export interface Party {
  key: string;
  name: string;
  seats: number;
  /** Real politics. Never read by the bidding — only by the deck. */
  bloc: Bloc;
  leftRight: number;
  /** The player whose bloc this party currently sits in, or null. */
  heldBy: string | null;
  /**
   * Ministries handed over to keep this party, by whoever holds it.
   *
   * They stay spent for as long as the party stays: every partner you add
   * leaves you less to buy the next one with. Losing the party, or pulling the
   * ministries back, returns them to their owner's hand.
   */
  package: string[];
  /**
   * Parties this one refuses to sit beside, with the turn the refusal lapses.
   *
   * Written by cards, which is how ideology reaches the board without the
   * auction itself ever consulting it.
   */
  refusals: Array<{ partyKey: string; until: number }>;
  /**
   * Players this list has been talked round by an ultimatum.
   *
   * A carded refusal can simply be deleted, but a standing one falls out of
   * where two lists sit and would be re-derived the moment it was removed. So
   * the exception is recorded here instead, and {@link refusalsAgainst} reads
   * it. It never lapses: the whole price of the card is that it is permanent.
   */
  struck?: string[];
}

/**
 * How many parties one player may sit down with in a single turn.
 *
 * This is the dial that sets the pace of the whole game. Money is plentiful;
 * turns are not, so a coalition has to be assembled a few partners at a time
 * while rivals do the same. What goes on each table is unlimited: the scarce
 * thing is the diary, not the purse.
 */
export const OFFERS_PER_TURN = 3;

/** One party courted, and what is being put in front of it. */
export interface Bid {
  partyKey: string;
  /** Ministries on the table, drawn from the player's free hand. */
  ministries: string[];
}

/** One turn's move. */
export interface Offer {
  /** Up to {@link OFFERS_PER_TURN} parties courted this turn, with anything in hand. */
  bids: Bid[];
  /**
   * Parties abandoned this turn to free up the ministries locked with them.
   *
   * Withdrawing costs you the party but funds the offer, which is the only way
   * to move a portfolio once it has been promised.
   */
  withdrawFrom: string[];
  /**
   * The bill the prime minister is putting to the house this year.
   *
   * Sealed with the rest of the turn because it is part of the same move, not
   * because it is secret — a government's legislative programme is the least
   * secret thing about it. It rides on the offer so that a turn stays one
   * commit and one round trip; `null` or absent is the perfectly ordinary
   * choice of passing nothing.
   */
  law?: string | null;
  /**
   * The wild card played this turn, if any; see {@link ./wilds}.
   *
   * Rides on the sealed offer for the same reason the bill does — it is part of
   * the same move — and that is also what makes a wild interesting: it is
   * committed blind, against a rival committing one the same week.
   */
  wild?: import("./wilds").WildPlay | null;
}

export const emptyOffer = (): Offer => ({ bids: [], withdrawFrom: [] });

/** Every ministry this player is putting on a table this turn. */
export const offeredMinistries = (offer: Offer): string[] =>
  offer.bids.flatMap((bid) => bid.ministries);

export const bidFor = (offer: Offer, partyKey: string): Bid | undefined =>
  offer.bids.find((bid) => bid.partyKey === partyKey);

export type Phase =
  /** Bidding for a majority. One turn is a week. */
  | "forming"
  /** A government sits. One turn is a year. */
  | "governing"
  /** The government has slipped below 61 and has one turn to repair it. */
  | "rebuilding"
  /** Somebody has banked ten years. */
  | "over";

export type LogKind = "info" | "card" | "deal" | "trouble" | "election";

export interface LogEntry {
  turn: number;
  /**
   * The parliament this happened in.
   *
   * Recorded rather than worked out afterwards. A campaign runs through several
   * Knessets and the turn counter never restarts, so a bare turn number cannot
   * say which one an entry belongs to; and reconstructing it by scanning for
   * election lines would mean the history is only as reliable as the wording of
   * those lines. An election writes its opening line under the parliament that
   * fell and its closing line under the one just elected, which is where a
   * reader would put them.
   */
  parliament: number;
  kind: LogKind;
  text: string;
}

/** What happened to one party at the end of a turn, for the reveal. */
export interface PartyResult {
  partyKey: string;
  /** Mandates the party was holding when the offers were opened. */
  seats: number;
  /** Player key -> billions offered. */
  bids: Record<string, number>;
  /**
   * Player key -> the portfolios that player actually put on the table.
   *
   * The billions in {@link bids} are what the party weighed, but they are not
   * what the player did: a holder standing pat scores its existing package
   * without offering anything, and two different hands can add up to the same
   * number. The reveal has to name the portfolios or it is not showing the move.
   */
  offered: Record<string, string[]>;
  previousHolder: string | null;
  newHolder: string | null;
  /** Players whose winning bid was refused on a red line written by a card. */
  blocked: string[];
}

/** A player walking away from a partner, and what it freed up. */
export interface Withdrawal {
  playerKey: string;
  partyKey: string;
  /** The portfolios that went back into their hand, in time to fund this turn. */
  ministries: string[];
}

/** Why the country is voting. */
export type ElectionCause =
  /** A government fell, or nobody could form one inside the deadline. */
  | "collapse"
  /** The Knesset sat its full term. */
  | "term";

/**
 * One rearrangement of the ballot paper, as a fact rather than as a sentence.
 *
 * The log already carries the prose. This is the same event in a shape the
 * interface can lay out — which lists were involved, how many mandates moved,
 * and whose deal it cost — because "Shas and UTJ announce a joint run" is a
 * headline and the player also wants to see the arithmetic under it.
 */
export type BallotChange =
  /** Two lists of the same politics run on one ticket. */
  | {
      kind: "union";
      key: string;
      name: string;
      seats: number;
      /** The two lists that went in, with what each brought. */
      parts: Array<{ key: string; name: string; seats: number }>;
      /** The player who lost the smaller partner, if anybody had bought it. */
      costTo: string | null;
    }
  /** A faction walks out of a big list and registers on its own. */
  | {
      kind: "breakaway";
      key: string;
      name: string;
      seats: number;
      parentKey: string;
      parentName: string;
      /** What the parent goes into the election on, after the walkout. */
      parentSeats: number;
    }
  /** A small list gives up, and its mandates go to the nearest one politically. */
  | {
      kind: "wound-up";
      key: string;
      name: string;
      seats: number;
      heirKey: string;
      heirName: string;
      costTo: string | null;
    };

/** One list's night: what it stood on, and what the country gave it. */
export interface Standing {
  partyKey: string;
  name: string;
  bloc: Bloc;
  /** Mandates it went into the election holding, after the ballot rearranged. */
  before: number;
  /** Mandates it came out with. Zero means it is out of the chamber. */
  after: number;
  heldBy: string | null;
  /** True when the ballot invented this list for this election. */
  fresh: boolean;
}

/**
 * An election, in the shape the interface reads it back in.
 *
 * Two separate stories, and conflating them would misreport both. The ballot
 * rearranges first -- lists merge, split and fold -- and only then does the
 * country vote on whatever ended up on the paper. So a swing here is the vote
 * alone, measured against what each list actually stood on, and the ballot
 * changes are reported as their own thing rather than folded into the numbers.
 */
export interface ElectionResult {
  turn: number;
  /** The parliament this vote elected. */
  parliament: number;
  cause: ElectionCause;
  ballot: BallotChange[];
  /** Every list that stood, best result first. */
  standings: Standing[];
}

export interface TurnResult {
  turn: number;
  parties: PartyResult[];
  /** Partners abandoned before the offers were opened. */
  withdrawals: Withdrawal[];
  /**
   * The bill the government passed this year, if it passed one.
   *
   * An array rather than a single entry, and beside the cards rather than
   * inside them, because it is the same shape as a card in the reveal and the
   * opposite thing in the fiction: a card is what happened to the government,
   * a law is what the government did. At most one per turn today.
   */
  laws: Array<{ playerKey: string; lawId: string; title: string; text: string }>;
  cards: Array<{ playerKey: string; title: string; text: string }>;
  /** Set when this turn made someone prime minister who was not one already. */
  swornIn?: string | null;
}

export interface GameState {
  /** Turn number, counting every turn of the campaign. */
  turn: number;
  phase: Phase;
  /** Weeks spent in the current coalition negotiation. */
  week: number;
  /** Which parliament we are in; 1 is the opening one. */
  parliament: number;

  players: Player[];
  parties: Record<string, Party>;
  /** The live ministry list; cards may add to or remove from it. */
  ministries: Ministry[];

  /** The sitting prime minister, or null while forming. */
  primeMinister: string | null;
  /** Years the current government has run; reset at every election. */
  governmentYears: number;
  /** While above the current turn, the government cannot fall. */
  emergencyUntil: number;
  /** True when the government slipped below 61 and is on its repair turn. */
  repairing: boolean;

  /** Sealed offers for the turn in progress, keyed by player. */
  offers: Record<string, Offer>;

  /**
   * Players whose coalitions cannot be broken into this turn.
   *
   * Written when the wilds resolve and cleared when the turn ends. It lives on
   * the state rather than being threaded through because the auction is the
   * thing that has to read it, and the auction is handed nothing but a board.
   */
  whipped: string[];

  /**
   * Parties hearing every offer fresh this turn, with the package they already
   * hold counted as nothing.
   *
   * Same lifetime and the same reason as {@link whipped}: written when the
   * wilds resolve, read by the auction, cleared when the turn ends. The two are
   * opposite halves of one rule — defending is cheaper than capturing, and
   * these are the cards that suspend each half of it.
   */
  exposed: string[];

  log: LogEntry[];
  /** The most recent resolution, kept so the interface can show the reveal. */
  lastTurn: TurnResult | null;
  /**
   * The most recent election, or null if the country has not voted yet.
   *
   * Kept beside {@link lastTurn} rather than inside it: an election is the
   * turn's consequence, not one of its bids, and it stays readable in the side
   * panel for the whole of the parliament it elected.
   */
  lastElection: ElectionResult | null;

  /**
   * The three bills on the order paper, and whose choice they are.
   *
   * Drawn when a government year begins and cleared when it is spent, so a
   * campaign that is not governing has no bill. Kept in the state rather than
   * rolled at resolution time because the prime minister has to be able to read
   * the three before committing the turn they are chosen in.
   */
  bill: Bill | null;
  /** Statutes in force, tilting the ballot until they lapse. */
  statutes: Statute[];
  /** How pleased each party is, by key. Absent means indifferent. */
  moods: Record<string, Mood>;
  /** Everything that has passed, oldest first. */
  lawsPassed: PassedLaw[];

  rngState: number;
  seed: number;
  winner: string | null;
  epilogue: string | null;
}

/** The three bills a prime minister may choose between this year. */
export interface Bill {
  /** The prime minister, who is the only one who gets to choose. */
  playerKey: string;
  /** Law ids, three of them, drawn from what is available on this board. */
  options: string[];
}

/**
 * A law still tilting the ballot.
 *
 * Laws that change the politics do not change it on the day they pass: they
 * change what the country votes for at the next election, and for a while
 * after. So the effect is stored as a standing multiplier on each bloc's vote
 * and consumed by {@link ../engine/campaign.rollSeats} whenever the country
 * actually votes, rather than being applied to seats the moment it passes.
 */
export interface Statute {
  lawId: string;
  title: string;
  /** Vote-weight multiplier per bloc; 1, or absent, is no change. */
  tilt: Partial<Record<Bloc, number>>;
  /** The turn it stops applying. */
  until: number;
}

/**
 * How a party feels about the government, and what that costs.
 *
 * A partner that has just been given what it wanted is harder to buy away from
 * you; one that has just been legislated against is cheaper. Rather than model
 * gratitude, the mood simply scales what the package holding the party is
 * counted as being worth — see {@link packageValue}. An angry party behaves
 * exactly as if the portfolios it was promised had shrunk, which is the same
 * thing from every seat at the table.
 */
export interface Mood {
  /** Added to the multiplier on the package: -0.4 is angry, +0.3 is pleased. */
  delta: number;
  /** The turn it wears off. */
  until: number;
  /** The law that caused it, for the tooltip. */
  because: string;
}

export interface PassedLaw {
  id: string;
  title: string;
  turn: number;
  parliament: number;
  /** The player whose government passed it. */
  by: string;
}

export const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * A party's name with its article, for dropping into a sentence.
 *
 * Most lists take one -- "the Likud", "the Shas" -- but a few carry their own,
 * and "the The Democrats" is how you can tell a game was written before anybody
 * named a party that way. Chambers back to 1949 and the splinter-name pool both
 * contain such names, so this is not a hypothetical.
 */
export const theList = (name: string): string =>
  /^(the|ha)\s/i.test(name) ? name : `the ${name}`;

/** The same, starting a sentence. */
export const TheList = (name: string): string => {
  const text = theList(name);
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const playerOf = (state: GameState, playerKey: string): Player => {
  const player = state.players.find((candidate) => candidate.key === playerKey);
  if (!player) throw new Error(`no such player: ${playerKey}`);
  return player;
};

export const isLedByPlayer = (state: GameState, partyKey: string): boolean =>
  state.players.some((player) => player.partyKey === partyKey);

/** Parties that can be bid for: everything nobody is leading. */
export const biddableParties = (state: GameState): Party[] =>
  Object.values(state.parties)
    .filter((party) => !isLedByPlayer(state, party.key))
    .sort((a, b) => b.seats - a.seats);

/** A player's own party plus everyone they currently hold. */
export const blocParties = (state: GameState, playerKey: string): Party[] => {
  const player = playerOf(state, playerKey);
  return Object.values(state.parties).filter(
    (party) => party.key === player.partyKey || party.heldBy === playerKey,
  );
};

export const blocSeats = (state: GameState, playerKey: string): number =>
  blocParties(state, playerKey).reduce((sum, party) => sum + party.seats, 0);

export const ministryByKey = (state: GameState, key: string): Ministry | undefined =>
  state.ministries.find((ministry) => ministry.key === key);

/** What a set of ministries is worth, in billions. */
export const valueOf = (state: GameState, ministries: readonly string[]): number =>
  ministries.reduce((sum, key) => sum + (ministryByKey(state, key)?.budget ?? 0), 0);

/**
 * How pleased a party is right now: 0 when nothing has been done to it.
 *
 * Read rather than trusted, because a mood lapses on a turn counter and
 * nothing sweeps the record every turn.
 */
export const moodOf = (state: GameState, partyKey: string): Mood | null => {
  const mood = state.moods?.[partyKey];
  return mood && mood.until > state.turn ? mood : null;
};

/**
 * What the party is currently being paid to stay where it is.
 *
 * Not the same as what the portfolios are worth. A law can leave a partner
 * delighted or furious, and a furious one counts the same package for less —
 * which is the whole of what a mood does. Every scale that matters runs through
 * this one function: the incumbent's standing bid in {@link
 * ../engine/allocation.resolveRound}, what a bot thinks it has to beat, and the
 * price printed on the card. So an angry partner really is cheaper to poach,
 * everywhere at once, without anything else having heard of moods.
 */
export const packageValue = (state: GameState, partyKey: string): number => {
  const raw = valueOf(state, state.parties[partyKey]?.package ?? []);
  const mood = moodOf(state, partyKey);
  if (!mood || raw === 0) return raw;
  // A furious party is still holding something: the discount cannot zero a
  // package out, or a single law would hand every partner away for one shekel.
  return Math.max(1, Math.round(raw * (1 + mood.delta)));
};

/** Portfolios shown as a party's own, before its mood is applied. */
export const packageFace = (state: GameState, partyKey: string): number =>
  valueOf(state, state.parties[partyKey]?.package ?? []);

/**
 * The size of party that would have to be given the entire cabinet.
 *
 * The dial on how much of your own hand your own list eats. At 65 a party that
 * is within a few seats of a majority on its own has nothing left to offer
 * anybody — which is the right shape: the closer you are to not needing
 * partners, the less you can pay them, and a giant list is not automatically a
 * government. Below that it scales straight down, so a 30-seat party keeps
 * about half the table and a 6-seat one keeps a couple of small offices.
 *
 * It is also the game's only handicap, and the reason it is worth having one:
 * before this, leading the largest list was strictly better than leading a
 * small one — the same eighteen portfolios to spend, and a head start of
 * twenty mandates. Every player now spends a share of the cabinet on their own
 * backbenchers in proportion to how big that head start is, so the small list
 * comes to the table with more money and fewer seats. Whether picking Likud
 * over Meretz is an advantage becomes a real question rather than an
 * arithmetic one.
 */
export const HOME_SEATS_FOR_ALL = 65;

/** Everything the cabinet is worth today; laws and cards move it. */
export const cabinetValue = (state: GameState): number =>
  state.ministries.reduce((sum, ministry) => sum + ministry.budget, 0);

/**
 * What a player's own party keeps for itself.
 *
 * A leader does not get to spend the whole cabinet on other people. Their own
 * MKs want offices, and the bigger the list the more of them there are to
 * satisfy — this is the single most reliable fact about Israeli coalition
 * arithmetic, and until now the game had the leader treating their own
 * backbenchers as free.
 *
 * The claim is a value, not a list: `seats / 65` of the whole cabinet, rounded.
 * Which portfolios settle it is then the boring part, taken greedily from the
 * top of the ladder — a party big enough to demand a third of the cabinet
 * demands Defense and Finance, not Tourism and Science, and the small offices
 * are what is left over to buy partners with. Greedy from the top also lands
 * within a shekel or two of the target, because the ladder is dense at the
 * bottom.
 *
 * Derived rather than stored, so it follows the seat count through every
 * election without anything having to remember to recalculate it, and so a law
 * that abolishes a ministry shrinks the claim along with the cabinet.
 */
export const reservedMinistries = (state: GameState, playerKey: string): string[] => {
  const player = state.players.find((entry) => entry.key === playerKey);
  const seats = player ? (state.parties[player.partyKey]?.seats ?? 0) : 0;
  if (seats <= 0) return [];

  const target = Math.round((cabinetValue(state) * seats) / HOME_SEATS_FOR_ALL);
  if (target <= 0) return [];

  const ladder = [...state.ministries].sort((a, b) => b.budget - a.budget);
  const taken: string[] = [];
  let spent = 0;
  for (const ministry of ladder) {
    if (spent >= target) break;
    // Descending, and only what still fits. Never overshoot: the claim is a
    // ceiling, and a party that wanted 71bn taking 75 would be taking the
    // difference out of the partners it has not bought yet. On a ladder this
    // dense — every value from 1 upward — taking what fits lands on the target
    // exactly almost every time, and short by a shekel or two otherwise.
    if (spent + ministry.budget <= target) {
      taken.push(ministry.key);
      spent += ministry.budget;
    }
  }
  return taken;
};

/** What the player's own list is holding back, in billions. */
export const reservedValue = (state: GameState, playerKey: string): number =>
  valueOf(state, reservedMinistries(state, playerKey));

/**
 * The ministries a player still has to spend.
 *
 * Everything they own, minus whatever is locked with the parties they hold and
 * minus whatever their own list has claimed. A portfolio that is both promised
 * to a partner and claimed by the home party is only lost once: it is already
 * out of the hand, and the claim is satisfied by it sitting where it sits.
 */
export const freeMinistries = (state: GameState, playerKey: string): string[] => {
  const locked = new Set(
    Object.values(state.parties)
      .filter((party) => party.heldBy === playerKey)
      .flatMap((party) => party.package),
  );
  const kept = new Set(reservedMinistries(state, playerKey));
  return state.ministries
    .filter((ministry) => !locked.has(ministry.key) && !kept.has(ministry.key))
    .map((ministry) => ministry.key);
};

export const freeBudget = (state: GameState, playerKey: string): number =>
  valueOf(state, freeMinistries(state, playerKey));

/**
 * How far apart two lists can be on the axis before neither will serve with the
 * other. At 16 only the genuine extremes of a chamber reach it, so a board of
 * mid-sized lists is untouched and a board with a far right and an Arab left is
 * not.
 */
export const IRRECONCILABLE = 16;

/**
 * An Arab list will not sit with a list at least this far right.
 *
 * A simplification, and worth naming as one: the Joint List has never joined
 * any coalition, but Ra'am sat in one in 2021, and the model has a single
 * `arab` bloc covering both. The game takes the general case.
 */
export const ARAB_REFUSES_RIGHT_OF = 6;

/** The politics of a list, which is all a standing refusal reads. */
type Politics = Pick<Party, "bloc" | "leftRight">;

/**
 * Two lists that will not serve together whatever either is offered.
 *
 * Unlike a card's red line this is not written down anywhere and never lapses:
 * it is a fact about where the two sit, so it survives an election, a merger
 * and a split without anything having to remember to carry it across. That is
 * the reason it is computed rather than stored — a refusal keyed to a party
 * that stops existing has to be redirected, and one derived from politics
 * simply follows the politics.
 *
 * Mutual by construction. A coalition contains both lists, so it does not
 * matter which of them is the one being bought.
 */
export const standingRefusal = (a: Politics, b: Politics): boolean => {
  if (Math.abs(a.leftRight - b.leftRight) >= IRRECONCILABLE) return true;
  if (a.bloc === "arab" && b.leftRight >= ARAB_REFUSES_RIGHT_OF) return true;
  if (b.bloc === "arab" && a.leftRight >= ARAB_REFUSES_RIGHT_OF) return true;
  return false;
};

/**
 * Red lines standing between a party and a player's bloc.
 *
 * Two kinds, and resolution honours them identically. A card writes a concrete
 * party-to-party refusal that lapses on a timer. A standing one is not written
 * at all: it falls out of where the two lists sit, so the geography of a board
 * matters before any card has been turned over.
 *
 * The price is still blind. Nothing here reaches the bidding — a party that
 * will sit with you is weighed on the money alone, exactly as before; politics
 * decides only whether it will sit with you at all.
 */
export const refusalsAgainst = (state: GameState, party: Party, playerKey: string): string[] => {
  const members = blocParties(state, playerKey);
  const bloc = new Set(members.map((member) => member.key));

  // An ultimatum settles the question for good: this list has agreed to sit
  // with this player, and neither a carded promise nor the geography of the
  // board reopens it.
  if (party.struck?.includes(playerKey)) return [];

  const carded = party.refusals
    .filter((refusal) => refusal.until > state.turn && bloc.has(refusal.partyKey))
    .map((refusal) => refusal.partyKey);

  const standing = members
    .filter((member) => member.key !== party.key && standingRefusal(party, member))
    .map((member) => member.key);

  return [...new Set([...carded, ...standing])];
};

/**
 * One red line, seen from outside any particular bloc.
 *
 * {@link refusalsAgainst} answers the question the auction asks — "will this
 * list sit with *me*" — and that is all the engine has ever needed. It is not
 * the question a player asks while deciding what to buy: buying Otzma Yehudit
 * is also a decision not to buy Ra'am, and nothing on the board said so until
 * the whole map was drawn.
 *
 * The two kinds are genuinely different shapes, and the graph should not
 * flatten them:
 *
 *   - a **standing** line falls out of where the two lists sit, is mutual by
 *     construction, and never lapses;
 *   - a **carded** line is a promise one leader made about one other party. It
 *     lapses on a timer, and it points one way — the list that made the promise
 *     is the one that will not come, and the other will still come to it.
 */
export interface RedLine {
  /** The list the line is drawn *by*. On a standing line, the lower key. */
  from: string;
  /** The list it is drawn *against*. On a standing line, the higher key. */
  to: string;
  kind: "standing" | "carded";
  /** The turn a carded line lapses on; absent on a standing one. */
  until?: number;
}

/**
 * Every red line on the board, both kinds, deduplicated.
 *
 * Standing lines are emitted once per pair with the keys in sorted order, since
 * neither end is the author. Carded ones are emitted per direction, because a
 * pair really can have a line one way and not the other — and if both leaders
 * have made the promise, that is two lines and the map says so.
 */
export const redLines = (state: GameState): RedLine[] => {
  const parties = Object.values(state.parties);
  const lines: RedLine[] = [];

  for (let i = 0; i < parties.length; i += 1) {
    for (let j = i + 1; j < parties.length; j += 1) {
      const [a, b] = [parties[i], parties[j]];
      if (standingRefusal(a, b)) {
        const [from, to] = a.key < b.key ? [a.key, b.key] : [b.key, a.key];
        lines.push({ from, to, kind: "standing" });
      }
    }
  }

  for (const party of parties) {
    for (const refusal of party.refusals) {
      if (refusal.until <= state.turn) continue;
      if (!state.parties[refusal.partyKey]) continue;
      // A card that only restates the politics is not a second line on the map.
      if (standingRefusal(party, state.parties[refusal.partyKey])) continue;
      lines.push({ from: party.key, to: refusal.partyKey, kind: "carded", until: refusal.until });
    }
  }

  return lines;
};

/**
 * The lists one party has a red line with, in either direction.
 *
 * Written for the party cards, where the useful phrasing is "this one will not
 * sit with those" rather than a pair. Direction is kept in {@link redLines} for
 * the map; here it is deliberately dropped, because owning either end of a
 * carded line still costs you a partner somewhere.
 */
export const redLinesFor = (state: GameState, partyKey: string): string[] => {
  const touching = redLines(state)
    .filter((line) => line.from === partyKey || line.to === partyKey)
    .map((line) => (line.from === partyKey ? line.to : line.from));
  return [...new Set(touching)];
};
