/**
 * The campaign: setting one up, and running its turns.
 *
 * A turn is the same shape in both phases — everybody commits a spread of
 * ministries, the parties pick the best offer, then each player draws a card.
 * What changes is the clock (a week while forming, a year while governing) and
 * what the board does with the result.
 *
 * Bot commitments are computed from the state and the seeded RNG rather than
 * stored, so the action log only ever holds the moves people actually made and
 * a whole campaign still replays exactly.
 */

import { offerFor } from "../bots";
import { applyRound, applyWithdrawals, resolveRound } from "./allocation";
import { drawCard, expireRefusals, unusedName } from "./deck";
import { applyWilds, drawWild } from "./wilds";
import { ballotTilt, drawBill, enactLaw, expireLegislation, lawById } from "./laws";
import { MINISTRIES } from "./ministries";
import type { PartyProfile } from "./parties";
import {
  ELECTORAL_THRESHOLD,
  MAJORITY,
  PARTY_PROFILES,
  TOTAL_SEATS,
  chamberById,
} from "./parties";
import { Rng } from "./rng";
import type {
  BallotChange,
  ElectionCause,
  GameState,
  Offer,
  Party,
  Player,
  PlayerKind,
  TurnResult,
} from "./types";
import {
  FORMING_DEADLINE,
  TERM_LENGTH,
  YEARS_TO_WIN,
  blocSeats,
  TheList,
  clamp,
  isLedByPlayer,
  packageValue,
  playerOf,
  theList,
  valueOf,
} from "./types";

export interface CampaignOptions {
  seed?: number;
  /** The party the human leads. Defaults to the largest. */
  humanParty?: string;
  /** Bot opponents, in order of size after the human's pick. */
  bots?: PlayerKind[];
  /**
   * Which Knesset the campaign opens on; see {@link ./parties}.
   *
   * Only the opening board. Once a campaign is running, every election carries
   * forward from what is standing rather than from here, so the chamber is the
   * hand you are dealt and not a fact the rest of the game keeps consulting.
   */
  chamber?: string;
}

const cloneState = (state: GameState): GameState =>
  typeof structuredClone === "function"
    ? structuredClone(state)
    : (JSON.parse(JSON.stringify(state)) as GameState);

const log = (state: GameState, kind: GameState["log"][number]["kind"], text: string): void => {
  state.log.push({ turn: state.turn, parliament: state.parliament, kind, text });
};

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

const buildParties = (
  profiles: readonly PartyProfile[],
  seats: Record<string, number>,
): Record<string, Party> => {
  const parties: Record<string, Party> = {};
  for (const profile of profiles) {
    const count = seats[profile.key] ?? 0;
    if (count <= 0) continue;
    parties[profile.key] = {
      key: profile.key,
      name: profile.name,
      seats: count,
      bloc: profile.bloc,
      leftRight: profile.leftRight,
      heldBy: null,
      package: [],
      refusals: [],
    };
  }
  return parties;
};

const baselineSeats = (
  profiles: readonly PartyProfile[] = PARTY_PROFILES,
): Record<string, number> =>
  Object.fromEntries(profiles.map((profile) => [profile.key, profile.baseSeats]));

export const newCampaign = (options: CampaignOptions = {}): GameState => {
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = new Rng(seed);
  // Two players by default: one rival, and the rest of the Knesset for sale.
  // More players means more parties off the market, and the pool shrinks faster
  // than the number of contenders grows.
  const botKinds = options.bots ?? ["greedy"];

  const chamber = chamberById(options.chamber);
  const ranked = [...chamber.parties].sort((a, b) => b.baseSeats - a.baseSeats);
  // A party from another Knesset is not on this board, so fall back to the
  // largest list rather than seating a leader with no party behind them.
  const humanParty = ranked.some((profile) => profile.key === options.humanParty)
    ? options.humanParty!
    : ranked[0].key;
  const remaining = ranked.filter((profile) => profile.key !== humanParty);

  const parties = buildParties(chamber.parties, baselineSeats(chamber.parties));
  const players: GameState["players"] = [
    {
      key: "you",
      name: parties[humanParty]?.name ?? "You",
      kind: "human",
      partyKey: humanParty,
      yearsInPower: 0,
      hand: [],
    },
    ...botKinds.map((kind, index) => ({
      key: `bot${index + 1}`,
      name: remaining[index]?.name ?? `Rival ${index + 1}`,
      kind,
      partyKey: remaining[index]?.key ?? ranked[index + 1].key,
      yearsInPower: 0,
      hand: [],
    })),
  ];

  const state: GameState = {
    turn: 1,
    phase: "forming",
    week: 1,
    parliament: 1,
    players,
    parties,
    ministries: MINISTRIES.map((ministry) => ({ ...ministry })),
    primeMinister: null,
    governmentYears: 0,
    emergencyUntil: 0,
    repairing: false,
    offers: {},
    whipped: [],
    exposed: [],
    log: [],
    lastTurn: null,
    lastElection: null,
    bill: null,
    statutes: [],
    moods: {},
    lawsPassed: [],
    rngState: rng.state,
    seed,
    winner: null,
    epilogue: null,
  };

  log(
    state,
    "election",
    `The ${state.parliament}${ordinal(state.parliament)} Knesset is sworn in. ${MAJORITY} mandates form a government.`,
  );
  // One card each, at the top of the parliament, dealt from the same stream as
  // everything else so a campaign still replays from its seed alone.
  for (const player of state.players) drawWild(state, rng, player.key);
  state.rngState = rng.state;
  return state;
};

/** The suffix that makes a number an ordinal: 1st, 2nd, 21st, 111th. */
export const ordinal = (value: number): string => {
  if (value % 100 >= 11 && value % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][value % 10] ?? "th";
};

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export type Action = { type: "offer"; playerKey: string; offer: Offer };

export interface ActionResult {
  state: GameState;
  /** Set when this action completed the turn. */
  resolved: TurnResult | null;
}

export const humanPlayers = (state: GameState) =>
  state.players.filter((player) => player.kind === "human");

/** Whether everyone who has to press a button has pressed it. */
export const readyToResolve = (state: GameState): boolean =>
  humanPlayers(state).every((player) => state.offers[player.key] !== undefined);

/**
 * The human seat still owed a move this turn, in seating order.
 *
 * With one human this is always them. With two sharing a keyboard it is who
 * should be looking at the screen right now, which is the whole of hot-seat
 * play: offers are sealed, so the second player must not see the first one
 * until the turn resolves.
 */
export const pendingSeat = (state: GameState): Player | null =>
  humanPlayers(state).find((player) => state.offers[player.key] === undefined) ?? null;

export const applyAction = (input: GameState, action: Action): ActionResult => {
  const state = cloneState(input);
  if (state.phase === "over") return { state, resolved: null };

  state.offers[action.playerKey] = action.offer;
  if (!readyToResolve(state)) return { state, resolved: null };

  const resolved = resolveTurn(state);
  return { state, resolved };
};

/**
 * Which bill the prime minister actually puts.
 *
 * One path for every seat. A choice that rides in on the sealed offer settles
 * it, and is re-checked against the order paper rather than trusted: a replayed
 * action from an older campaign could name a law that was never on offer, and
 * the answer to that is to pass nothing rather than to legislate something
 * nobody chose.
 *
 * Nothing here reads what kind of player sent the offer. It used to: a human
 * seat's law came off the offer, and a bot seat's was scored here instead. But
 * the bot strategies are also what drives the human seat in every headless run,
 * and they named no law, so that seat silently forfeited the government's one
 * act of the year — worth between three and fifteen points of win rate, with
 * the identical strategy on both sides. The scoring now lives in
 * {@link ./laws#preferredLaw}, where a strategy can reach it, and every seat
 * declares its choice the same way.
 */
const chosenLaw = (state: GameState, playerKey: string): string | null => {
  const bill = state.bill;
  if (!bill || bill.options.length === 0) return null;

  const wanted = state.offers[playerKey]?.law ?? null;
  return wanted && bill.options.includes(wanted) ? wanted : null;
};

/**
 * Run one whole turn: bids, cards, then whatever the board now implies.
 */
const resolveTurn = (state: GameState): TurnResult => {
  const rng = new Rng(state.rngState);

  // Bots decide with the same seeded stream, so nothing has to be stored.
  for (const player of state.players) {
    if (player.kind === "human") continue;
    state.offers[player.key] = offerFor(state, player.key, rng);
  }

  // The cards come first. An ultimatum has to open a list before the auction
  // reads its red lines, and a reshuffle has to free portfolios before the
  // bids they are funding are weighed.
  const wilds = applyWilds(state);
  state.whipped = wilds.whipped;
  state.exposed = wilds.exposed;
  for (const line of wilds.log) log(state, "deal", line);

  // Anyone walking away from a partner does so before the offers are opened,
  // which is what lets those portfolios fund this turn's bid.
  const withdrawals = applyWithdrawals(state);
  for (const withdrawal of withdrawals) {
    const party = state.parties[withdrawal.partyKey];
    log(
      state,
      "trouble",
      `${playerOf(state, withdrawal.playerKey).name} pulls out of ${theList(party?.name ?? withdrawal.partyKey)}, reclaiming ${valueOf(state, withdrawal.ministries)}bn of portfolios.`,
    );
  }

  const parties = resolveRound(state);
  applyRound(state, parties);

  for (const result of parties) {
    if (result.newHolder && result.newHolder !== result.previousHolder) {
      const party = state.parties[result.partyKey];
      const winner = playerOf(state, result.newHolder);
      const taken = result.previousHolder
        ? ` away from ${playerOf(state, result.previousHolder).name}`
        : "";
      log(
        state,
        "deal",
        `${winner.name} takes ${theList(party.name)} (${party.seats})${taken} for ${packageValue(state, party.key)}bn.`,
      );
    }
  }

  // A year in office is served before anything can take it away -- unless the
  // house rose early, which buys the government a year off the term without
  // banking one toward winning. The recess is a delay, not a gift.
  const recessed = state.primeMinister !== null && wilds.recess.includes(state.primeMinister);
  if ((state.phase === "governing" || state.phase === "rebuilding") && !recessed) {
    state.governmentYears += 1;
    if (state.primeMinister) playerOf(state, state.primeMinister).yearsInPower += 1;
  }

  // The government's one act of the year, after the bidding and before the
  // news. After, because a law that abolishes a ministry would otherwise pull
  // portfolios out from under offers already on the table; before the card,
  // because a card is what the world does back.
  const laws: TurnResult["laws"] = [];
  if (state.bill) {
    const chooser = state.bill.playerKey;
    const chosen = chosenLaw(state, chooser);
    if (chosen) {
      const text = enactLaw(state, rng, chooser, chosen);
      if (text) {
        const title = lawById(chosen)?.title ?? chosen;
        laws.push({ playerKey: chooser, lawId: chosen, title, text });
        log(state, "deal", `${title} — ${text}`);
      }
    } else {
      log(
        state,
        "info",
        `${playerOf(state, chooser).name} puts nothing on the order paper this year.`,
      );
    }
    state.bill = null;
  }

  // One card a round, not one for each player. Dealing everybody in meant a
  // three-handed game got three times the chaos, and the news drowned out the
  // bidding it was supposed to interrupt. The drawer still matters -- a red
  // line is drawn against whoever turned the card over -- so one player is
  // picked for it rather than all of them.
  const cards: TurnResult["cards"] = [];
  const drawer = rng.pick(state.players);
  const card = drawer ? drawCard(state, rng, drawer.key) : null;
  if (card && drawer) {
    cards.push({ playerKey: drawer.key, title: card.title, text: card.text });
    log(state, "card", `${card.title} — ${card.text}`);
  }

  expireRefusals(state);
  const pmBefore = state.primeMinister;
  advancePhase(state, rng, wilds.extended);
  const swornIn =
    state.primeMinister && state.primeMinister !== pmBefore ? state.primeMinister : null;

  expireLegislation(state);

  // Next year's order paper, drawn once the board has settled so the bills on
  // it are the ones that make sense against the government that actually
  // stands. Only while governing: a repair turn is a crisis, and a Knesset
  // with no government legislates nothing.
  state.bill =
    state.phase === "governing" && state.primeMinister
      ? { playerKey: state.primeMinister, options: drawBill(state, rng, state.primeMinister) }
      : null;

  const result: TurnResult = { turn: state.turn, parties, withdrawals, cards, laws, swornIn };
  state.lastTurn = result;
  state.offers = {};
  // The whip and the auction last the turn they were played and not a moment
  // longer.
  state.whipped = [];
  state.exposed = [];
  state.turn += 1;
  if (state.phase === "forming") state.week += 1;
  state.rngState = rng.state;
  return result;
};

const advancePhase = (state: GameState, rng: Rng, extended = false): void => {
  if (state.phase === "forming") {
    const contenders = state.players
      .map((player) => ({ player, seats: blocSeats(state, player.key) }))
      .filter((entry) => entry.seats >= MAJORITY)
      .sort((a, b) => b.seats - a.seats);

    if (contenders.length === 0) {
      // Nobody can put 61 together. The Knesset dissolves itself and the
      // voters get another go, which is the only thing that breaks a deadlock
      // once every portfolio is locked up.
      if (state.week >= FORMING_DEADLINE && !extended) {
        log(
          state,
          "trouble",
          `${FORMING_DEADLINE} weeks and no government. The Knesset dissolves itself.`,
        );
        runElection(state, rng);
      }
      checkWin(state);
      return;
    }

    {
      const winner = contenders[0].player;
      state.primeMinister = winner.key;
      state.phase = "governing";
      state.governmentYears = 0;
      state.repairing = false;
      state.week = 1;
      log(
        state,
        "deal",
        `${winner.name} forms a government with ${contenders[0].seats} mandates and is sworn in as prime minister.`,
      );
    }
    checkWin(state);
    return;
  }

  if (state.phase === "governing" || state.phase === "rebuilding") {
    const pmKey = state.primeMinister;
    if (!pmKey) {
      state.phase = "forming";
      return;
    }
    const seats = blocSeats(state, pmKey);
    const shielded = state.emergencyUntil > state.turn;

    // Ten years is a career, and it beats the calendar: a prime minister who
    // reaches it on the last year of a term goes into the record books rather
    // than to the polls.
    checkWin(state);
    if (state.winner) return;

    // The term runs out whatever the arithmetic says. A government still
    // holding 61 goes to the country anyway, and one already short of it does
    // not get its repair turn -- the voters have arrived either way.
    if (state.governmentYears >= TERM_LENGTH && !shielded) {
      log(
        state,
        "trouble",
        `The Knesset has sat its ${TERM_LENGTH} years. The country votes.`,
      );
      runElection(state, rng, "term");
      checkWin(state);
      return;
    }

    if (seats >= MAJORITY) {
      if (state.phase === "rebuilding") {
        log(state, "deal", `${playerOf(state, pmKey).name} rebuilds the majority. The government survives.`);
      }
      state.phase = "governing";
      state.repairing = false;
    } else if (shielded) {
      log(state, "info", "The government is below 61, but the emergency holds it up.");
    } else if (state.governmentYears >= TERM_LENGTH) {
      // Only reachable while shielded, since the term is checked above.
      log(state, "info", "The term is up, but the emergency postpones the election.");
    } else if (state.phase === "governing") {
      state.phase = "rebuilding";
      state.repairing = true;
      log(
        state,
        "trouble",
        `${playerOf(state, pmKey).name} is down to ${seats} mandates. One turn to put it back together.`,
      );
    } else {
      runElection(state, rng);
    }
    checkWin(state);
  }
};

const checkWin = (state: GameState): void => {
  const winner = state.players.find((player) => player.yearsInPower >= YEARS_TO_WIN);
  if (!winner) return;
  state.winner = winner.key;
  state.phase = "over";
  state.epilogue =
    `${winner.name} has governed for ${winner.yearsInPower} years across ${state.parliament} ` +
    `parliament${state.parliament === 1 ? "" : "s"}. That is a career, and the record books will call it an era.`;
  log(state, "deal", `${winner.name} reaches ${YEARS_TO_WIN} years in power.`);
};

// ---------------------------------------------------------------------------
// Elections
// ---------------------------------------------------------------------------

/**
 * Re-roll the Knesset around the real baseline and start bidding again.
 *
 * Coalition agreements are not torn up by an election. A party that keeps its
 * place in the Knesset keeps whatever it was promised and whoever it was
 * promised to — only the arithmetic changes underneath it. A list that falls
 * below the threshold takes its seat out of the chamber, and the portfolios it
 * was holding go back to the player who paid them.
 */
export const runElection = (
  state: GameState,
  rng: Rng,
  cause: ElectionCause = "collapse",
): void => {
  const protectedKeys = new Set(state.players.map((player) => player.partyKey));

  const opening =
    cause === "term"
      ? "The term ends and the country votes."
      : "The government falls.";
  log(state, "election", opening);

  // The chamber as it sat, so a list the ballot invents can be told apart from
  // one that has been there all along.
  const sat = new Set(Object.keys(state.parties));

  // The ballot is settled before the country votes: lists merge, split and wind
  // up during the campaign, and only then are the votes counted.
  const ballot = realign(state, rng);

  const before = state.parties;
  // Whatever the statutes in force have done to the country's politics. This
  // is the only place a law touches a seat: it changes the vote, and the vote
  // is counted here.
  const seats = rollSeats(rng, protectedKeys, standingSeats(before), ballotTilt(state));

  // The chamber that just sat is the thing being re-elected, so every list
  // carries its own identity through: a party invented by a split is a real
  // party now, and one folded into another by a merger stays folded. Only the
  // seat count is new.
  const parties: Record<string, Party> = {};
  for (const [key, count] of Object.entries(seats)) {
    const previous = before[key];
    if (!previous) continue;
    // Red lines outlive an election too; they lapse on their own timer.
    parties[key] = { ...previous, seats: count };
  }

  state.parties = parties;
  state.primeMinister = null;
  state.governmentYears = 0;
  state.emergencyUntil = 0;
  state.repairing = false;
  state.phase = "forming";
  // The turn is still being wound up, and its last act is to advance the week,
  // so the new Knesset starts counting from zero here to land on week one.
  state.week = 0;
  state.parliament += 1;

  // The swing is the vote and nothing else: measured against what each list
  // actually stood on, which for a joint ticket is both partners added up and
  // for a breakaway is the mandates it walked out with. Folding the ballot
  // changes into these numbers would report a merger as a landslide.
  state.lastElection = {
    turn: state.turn,
    parliament: state.parliament,
    cause,
    ballot,
    standings: Object.values(before)
      .map((party) => ({
        partyKey: party.key,
        name: party.name,
        bloc: party.bloc,
        before: party.seats,
        after: seats[party.key] ?? 0,
        heldBy: party.heldBy,
        fresh: !sat.has(party.key),
      }))
      .sort((a, b) => b.after - a.after || b.before - a.before),
  };

  log(
    state,
    "election",
    `The ${state.parliament}${ordinal(state.parliament)} Knesset is elected, and the bidding starts again.`,
  );

  // A fresh card each for the new parliament, up to what a hand will hold. The
  // opposition draws too: a card only the government gets is a lead that
  // compounds, and this game already has enough of those.
  for (const player of state.players) drawWild(state, rng, player.key);
};

// ---------------------------------------------------------------------------
// The ballot, before the votes are counted
// ---------------------------------------------------------------------------

/**
 * One rearrangement of the ballot paper, or null if it cannot happen here.
 *
 * These run on the chamber that just sat, before {@link rollSeats} swings it,
 * so the seats they move are the baseline the country then votes on. A list
 * that folds takes its old vote share into whoever absorbed it; a breakaway
 * starts the next election with the mandates it walked out with.
 */
type Realignment = (state: GameState, rng: Rng) => { note: string; change: BallotChange } | null;

/** The lists the ballot can rearrange: everything nobody is leading. */
const looseParties = (state: GameState): Party[] =>
  Object.values(state.parties).filter((party) => !isLedByPlayer(state, party.key));

/**
 * Refusals name a party by key, so a key that stops existing has to be
 * redirected or the red line quietly evaporates.
 */
const redirectRefusals = (state: GameState, from: readonly string[], to: string): void => {
  const gone = new Set(from);
  for (const party of Object.values(state.parties)) {
    party.refusals = party.refusals.map((refusal) =>
      gone.has(refusal.partyKey) ? { ...refusal, until: refusal.until, partyKey: to } : refusal,
    );
  }
};

/**
 * Two lists of the same politics run on a joint ticket.
 *
 * The bigger partner's coalition agreement carries: it is their list the other
 * one joined. Whoever had bought the smaller partner loses it, and gets the
 * portfolios back — a merger is one of the few things that can undo a deal
 * without the buyer choosing to.
 */
const jointTicket: Realignment = (state, rng) => {
  const pool = looseParties(state);
  const pairs: Array<[Party, Party]> = [];
  for (const a of pool) {
    for (const b of pool) {
      if (a.key === b.key || a.bloc !== b.bloc) continue;
      if (a.seats > b.seats || (a.seats === b.seats && a.key < b.key)) pairs.push([a, b]);
    }
  }
  if (pairs.length === 0) return null;

  const [big, small] = rng.pick(pairs);
  const key = `${big.key}+${small.key}`;
  if (state.parties[key]) return null;

  // Hyphenating is how these are really named, until the name gets silly and
  // the joint list registers under something new instead.
  const hyphenated = `${big.name}-${small.name}`;
  const fresh = unusedName(state);
  const name = hyphenated.length <= 30 || !fresh ? hyphenated : fresh;
  const total = big.seats + small.seats;

  const lost = small.heldBy && small.heldBy !== big.heldBy ? small.heldBy : null;
  state.parties[key] = {
    key,
    name,
    seats: total,
    bloc: big.bloc,
    leftRight: Math.round((big.leftRight * big.seats + small.leftRight * small.seats) / total),
    heldBy: big.heldBy,
    package: [...big.package],
    // A red line drawn against either partner sticks to the joint ticket.
    refusals: [...big.refusals, ...small.refusals],
  };
  delete state.parties[big.key];
  delete state.parties[small.key];
  redirectRefusals(state, [big.key, small.key], key);

  const cost = lost
    ? ` ${playerOf(state, lost).name} loses ${theList(small.name)} and the portfolios that were holding it.`
    : "";
  return {
    note: `${TheList(big.name)} and ${theList(small.name)} announce a joint run as ${theList(name)}, ${total} mandates on one ticket.${cost}`,
    change: {
      kind: "union",
      key,
      name,
      seats: total,
      parts: [
        { key: big.key, name: big.name, seats: big.seats },
        { key: small.key, name: small.name, seats: small.seats },
      ],
      costTo: lost,
    },
  };
};

/**
 * A faction walks out of a large list and registers on its own.
 *
 * The new list starts unaligned whatever the parent had agreed, which is what
 * makes a split worth watching: it puts fresh mandates on the market that
 * nobody has paid for yet.
 */
const breakaway: Realignment = (state, rng) => {
  const name = unusedName(state);
  const parents = looseParties(state).filter(
    (party) => party.seats >= ELECTORAL_THRESHOLD * 2 + 2,
  );
  if (!name || parents.length === 0) return null;

  const parent = rng.pick(parents);
  const most = parent.seats - ELECTORAL_THRESHOLD;
  const taken = Math.min(most, rng.int(ELECTORAL_THRESHOLD, ELECTORAL_THRESHOLD + 3));
  if (taken < ELECTORAL_THRESHOLD) return null;

  let key = `${parent.key}-split`;
  for (let n = 2; state.parties[key]; n += 1) key = `${parent.key}-split${n}`;

  parent.seats -= taken;
  state.parties[key] = {
    key,
    name,
    seats: taken,
    bloc: parent.bloc,
    leftRight: clamp(parent.leftRight + (rng.chance(0.5) ? 2 : -2), -10, 10),
    heldBy: null,
    package: [],
    refusals: [],
  };
  return {
    note: `${taken} of ${theList(parent.name)} walk out over the leadership and register as ${theList(name)}. ${TheList(parent.name)} goes into the election on ${parent.seats}.`,
    change: {
      kind: "breakaway",
      key,
      name,
      seats: taken,
      parentKey: parent.key,
      parentName: parent.name,
      parentSeats: parent.seats,
    },
  };
};

/**
 * A small list gives up and does not run again.
 *
 * Its voters go somewhere, so the seats go to the nearest list politically
 * rather than out of the chamber. Anyone who had bought it loses it.
 */
const windUp: Realignment = (state, rng) => {
  const going = looseParties(state).filter((party) => party.seats <= ELECTORAL_THRESHOLD + 2);
  if (going.length === 0) return null;
  const folding = rng.pick(going);

  const rest = Object.values(state.parties).filter((party) => party.key !== folding.key);
  if (rest.length === 0) return null;
  const sameBloc = rest.filter((party) => party.bloc === folding.bloc);
  const heir = rng.pick(sameBloc.length > 0 ? sameBloc : rest);

  const buyer = folding.heldBy;
  heir.seats += folding.seats;
  delete state.parties[folding.key];
  redirectRefusals(state, [folding.key], heir.key);

  const cost = buyer
    ? ` ${playerOf(state, buyer).name} paid for a list that no longer exists, and the portfolios come home.`
    : "";
  return {
    note: `${TheList(folding.name)} winds itself up rather than face the voters. Its ${folding.seats} mandates go to ${theList(heir.name)}.${cost}`,
    change: {
      kind: "wound-up",
      key: folding.key,
      name: folding.name,
      seats: folding.seats,
      heirKey: heir.key,
      heirName: heir.name,
      costTo: buyer,
    },
  };
};

/**
 * Rearrange the ballot for this election.
 *
 * Israeli lists do not survive elections unchanged: something merges, splits or
 * folds nearly every time. Without this the board was a fixed cast of parties
 * whose numbers moved, which made a long campaign repetitive — you learned the
 * ten lists once and they were the same ten in the sixth parliament.
 *
 * Player-led parties are left alone. A campaign cannot strand somebody with no
 * party to lead, and a leader whose own list folds under them has had the game
 * taken away rather than made harder.
 */
const realign = (state: GameState, rng: Rng): BallotChange[] => {
  const moves: Realignment[] = [jointTicket, breakaway, windUp];
  // Most elections rearrange the ballot once, some twice, and a quiet one not
  // at all. More than that and a campaign stops being about the same country.
  const count = rng.chance(0.25) ? 0 : rng.chance(0.72) ? 1 : 2;

  const changes: BallotChange[] = [];
  for (let event = 0; event < count; event += 1) {
    for (const move of rng.sample(moves, moves.length)) {
      const happened = move(state, rng);
      if (happened) {
        log(state, "election", happened.note);
        changes.push(happened.change);
        break;
      }
    }
  }
  return changes;
};

/** What a chamber is holding now, as the baseline for the next election. */
const standingSeats = (parties: Record<string, Party>): Record<string, number> =>
  Object.fromEntries(Object.values(parties).map((party) => [party.key, party.seats]));

/**
 * A fresh result: every list swings around what it last won, anything under the
 * threshold drops out, and the survivors are scaled back to 120.
 *
 * The baseline is the chamber that just sat, not the one the game opened on, so
 * a defeat is carried into the next parliament instead of being wiped by the
 * next vote. A list beaten down to five seats starts the next campaign from
 * five. The cost is that drift compounds, and a party voted out is out for
 * good: nothing puts it back on the board.
 *
 * The parties players lead always survive — a campaign cannot strand somebody
 * with no party to lead.
 */
export const rollSeats = (
  rng: Rng,
  protectedKeys: Set<string>,
  baseline: Record<string, number> = baselineSeats(),
  /**
   * Per-list multipliers on the vote, from the laws in force.
   *
   * Applied to the weight rather than to the resulting seats, so a tilt moves
   * mandates between lists instead of inventing them — the Knesset is still
   * 120 afterwards, and a bloc that gains gains at somebody's expense. Empty by
   * default, which is the old behaviour exactly.
   */
  tilt: Record<string, number> = {},
): Record<string, number> => {
  const weights = Object.entries(baseline)
    .filter(([, seats]) => seats > 0)
    .map(([key, seats]) => ({
      key,
      weight: seats * rng.range(0.6, 1.45) * (tilt[key] ?? 1),
    }));

  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const survivors = weights.filter(
    (entry) =>
      protectedKeys.has(entry.key) || (entry.weight / total) * TOTAL_SEATS >= ELECTORAL_THRESHOLD,
  );

  const survivingTotal = survivors.reduce((sum, entry) => sum + entry.weight, 0);
  const seats: Record<string, number> = {};
  for (const entry of survivors) {
    seats[entry.key] = Math.max(
      ELECTORAL_THRESHOLD,
      Math.round((entry.weight / survivingTotal) * TOTAL_SEATS),
    );
  }

  // Reconcile rounding against the fixed size of the Knesset.
  const keys = Object.keys(seats);
  let guard = 0;
  while (keys.reduce((sum, key) => sum + seats[key], 0) !== TOTAL_SEATS && guard < 5000) {
    guard += 1;
    const drift = TOTAL_SEATS - keys.reduce((sum, key) => sum + seats[key], 0);
    const key = keys[rng.int(0, keys.length - 1)];
    if (drift > 0) seats[key] += 1;
    else if (seats[key] > ELECTORAL_THRESHOLD) seats[key] -= 1;
  }
  return seats;
};

// ---------------------------------------------------------------------------
// Read-only helpers for the interface
// ---------------------------------------------------------------------------

export const standings = (state: GameState) =>
  state.players
    .map((player) => ({
      player,
      seats: blocSeats(state, player.key),
      years: player.yearsInPower,
    }))
    .sort((a, b) => b.seats - a.seats);

export const isTurnClock = (state: GameState): "week" | "year" =>
  state.phase === "forming" ? "week" : "year";

export { MAJORITY, isLedByPlayer };
