/**
 * The cards a player holds.
 *
 * Everything else in this game resolves the week it is played: a bid is
 * committed and settled in the same turn, and the deck in {@link ./deck} is
 * weather — it happens to you, it is never yours to spend. Nothing on the board
 * was about *timing*, which is a strange gap in a game about coalitions.
 *
 * A wild is the one thing a player keeps. It is drawn at the top of each
 * parliament, held until it is worth using, and played on the sealed offer like
 * everything else, so the decision is still made blind against a rival deciding
 * the same thing.
 *
 * The seven here are deliberately levers on rules that already exist rather than
 * new subsystems: one suspends the auction's verdict, one strikes a red line,
 * one draws a red line, one unlocks a package, one reopens a package somebody
 * else paid for, one stops the term clock and one stops the forming clock. A
 * card wanting a mechanic of its own is a sign it should be a law or a deck card
 * instead.
 *
 * They are also spread deliberately across the game rather than across the
 * rulebook. The first four could all only be played from in front: you had to
 * hold a party to whip it, hold a package to reshuffle it, hold the government
 * to send it home. A player being outbid held cards they could not use. The
 * auction and the exclusivity are levers for the seat that is behind, and the
 * extension is the only card in the deck that is worth anything on the week the
 * Knesset would otherwise dissolve.
 */

import type { Rng } from "./rng";
import type { GameState, Party } from "./types";
import {
  FORMING_DEADLINE,
  blocSeats,
  freeMinistries,
  playerOf,
  refusalsAgainst,
} from "./types";

/** A card, and the party it is played against where it needs one. */
export interface WildPlay {
  id: string;
  partyKey?: string;
}

export interface WildCard {
  id: string;
  title: string;
  /** One line, as it reads on the card. */
  effect: string;
  /** True when the card is played against a named party. */
  targeted: boolean;
  /**
   * Whether this play is legal on this board, right now.
   *
   * A card with no legal target is not playable rather than a play that
   * fizzles: a wild is the scarcest thing a player has, and spending one on
   * nothing is a rule teaching the wrong lesson.
   */
  playable: (state: GameState, playerKey: string, partyKey?: string) => boolean;
}

/** How many a player may be holding. Drawing past this discards the draw. */
export const HAND_LIMIT = 2;

/** A party that is neither the player's own nor led by a rival. */
const buyable = (state: GameState, playerKey: string, partyKey?: string): Party | null => {
  if (!partyKey) return null;
  const party = state.parties[partyKey];
  if (!party) return null;
  if (party.key === playerOf(state, playerKey).partyKey) return null;
  if (state.players.some((player) => player.partyKey === party.key)) return null;
  return party;
};

export const WILDS: WildCard[] = [
  {
    id: "whip",
    title: "The whip",
    effect: "No party you hold changes hands this turn, whatever it is offered.",
    targeted: false,
    // Worth nothing with no coalition to defend, and the point of the card is
    // that it is spent on the turn the opposition comes for one.
    playable: (state, playerKey) =>
      Object.values(state.parties).some((party) => party.heldBy === playerKey),
  },
  {
    id: "ultimatum",
    title: "An ultimatum",
    effect: "Strike every red line standing between you and one list. It does not come back.",
    targeted: true,
    playable: (state, playerKey, partyKey) => {
      const party = buyable(state, playerKey, partyKey);
      return Boolean(party && refusalsAgainst(state, party, playerKey).length > 0);
    },
  },
  {
    id: "reshuffle",
    title: "A reshuffle",
    effect: "Take back the portfolios locked with one partner, and keep the partner anyway.",
    targeted: true,
    playable: (state, playerKey, partyKey) => {
      const party = buyable(state, playerKey, partyKey);
      return Boolean(party && party.heldBy === playerKey && party.package.length > 0);
    },
  },
  {
    id: "auction",
    title: "The auction",
    effect: "One list hears every offer fresh. What it already has counts for nothing.",
    targeted: true,
    // Against a rival's partner only. Played on a free list it would do
    // nothing, and played on your own it would be an act of self-harm.
    playable: (state, playerKey, partyKey) => {
      const party = buyable(state, playerKey, partyKey);
      return Boolean(party && party.heldBy && party.heldBy !== playerKey);
    },
  },
  {
    id: "exclusivity",
    title: "An exclusivity",
    effect: "One list talks to nobody but you for two weeks. It still has to be paid.",
    targeted: true,
    // A list nobody else has yet: either free, or already yours. Prising one
    // out of a rival's coalition is the auction's job, and letting this card do
    // it as well would make it strictly the better of the two.
    playable: (state, playerKey, partyKey) => {
      const party = buyable(state, playerKey, partyKey);
      if (!party || (party.heldBy && party.heldBy !== playerKey)) return false;
      return state.players.some((rival) => rival.key !== playerKey);
    },
  },
  {
    id: "extension",
    title: "The extension",
    effect: "The President grants another week. The house does not dissolve this time.",
    targeted: false,
    // Only in the week the Knesset would actually fall. The deadline is checked
    // at the end of the turn and the week counter moves after that, so the
    // board a player is looking at on the last week reads exactly
    // `FORMING_DEADLINE` — this is the turn, and there is no next one.
    //
    // A card that buys time is worth nothing while there is still time, and
    // letting it be spent in week two is letting a player throw it away without
    // ever being shown the cost.
    playable: (state) => state.phase === "forming" && state.week >= FORMING_DEADLINE,
  },
  {
    id: "recess",
    title: "The recess",
    effect: "The house rises early. This year does not count against the term.",
    targeted: false,
    playable: (state, playerKey) =>
      state.phase === "governing" && state.primeMinister === playerKey,
  },
];

export const wildById = (id: string): WildCard | undefined =>
  WILDS.find((card) => card.id === id);

/** Draw one, unless this player is already holding as many as they may. */
export const drawWild = (state: GameState, rng: Rng, playerKey: string): string | null => {
  const player = playerOf(state, playerKey);
  if (player.hand.length >= HAND_LIMIT) return null;
  const card = rng.pick(WILDS);
  player.hand.push(card.id);
  return card.id;
};

/** Whether a play is one this player may actually make this turn. */
export const canPlay = (state: GameState, playerKey: string, play: WildPlay | null): boolean => {
  if (!play) return true;
  const card = wildById(play.id);
  if (!card) return false;
  if (!playerOf(state, playerKey).hand.includes(play.id)) return false;
  if (card.targeted !== Boolean(play.partyKey)) return false;
  return card.playable(state, playerKey, play.partyKey);
};

/** Every play this player could legally make, for a hand panel or a bot. */
export const legalPlays = (state: GameState, playerKey: string): WildPlay[] => {
  const plays: WildPlay[] = [];
  for (const id of new Set(playerOf(state, playerKey).hand)) {
    const card = wildById(id);
    if (!card) continue;
    if (!card.targeted) {
      if (card.playable(state, playerKey)) plays.push({ id });
      continue;
    }
    for (const party of Object.values(state.parties)) {
      if (card.playable(state, playerKey, party.key)) plays.push({ id, partyKey: party.key });
    }
  }
  return plays;
};

/**
 * What the cards do, once the offers are opened.
 *
 * Everything here lands before the auction resolves, which is what makes a wild
 * a move rather than an announcement: an ultimatum opens a list to the same
 * turn's bid, and a reshuffle funds it.
 *
 * `whipped` and `recess` are answers this turn's later steps need, so they are
 * handed back rather than written somewhere for those steps to find.
 */
export interface WildOutcome {
  played: Array<{ playerKey: string; play: WildPlay }>;
  /** Players whose coalitions cannot be broken into this turn. */
  whipped: string[];
  /** Players whose year does not count against the term. */
  recess: string[];
  /** Parties weighing every offer fresh, ignoring the package they hold. */
  exposed: string[];
  /** True when somebody bought the house another week to form a government. */
  extended: boolean;
  log: string[];
}

/** The keys of every party sitting in this player's bloc. */
const blocPartyKeys = (state: GameState, playerKey: string): string[] =>
  Object.values(state.parties)
    .filter(
      (party) => party.heldBy === playerKey || party.key === playerOf(state, playerKey).partyKey,
    )
    .map((party) => party.key);

export const applyWilds = (state: GameState): WildOutcome => {
  const outcome: WildOutcome = {
    played: [],
    whipped: [],
    recess: [],
    exposed: [],
    extended: false,
    log: [],
  };

  for (const player of state.players) {
    const play = state.offers[player.key]?.wild ?? null;
    if (!canPlay(state, player.key, play) || !play) continue;

    const card = wildById(play.id);
    if (!card) continue;
    // Spent whether or not the board moves much: that is the whole cost.
    const at = player.hand.indexOf(play.id);
    if (at >= 0) player.hand.splice(at, 1);
    outcome.played.push({ playerKey: player.key, play });

    const party = play.partyKey ? state.parties[play.partyKey] : null;
    switch (card.id) {
      case "whip":
        outcome.whipped.push(player.key);
        outcome.log.push(`${player.name} whips the coalition. Nothing moves this week.`);
        break;

      case "ultimatum": {
        if (!party) break;
        const bloc = new Set(blocPartyKeys(state, player.key));
        party.refusals = party.refusals.filter((refusal) => !bloc.has(refusal.partyKey));
        // A standing line is geography rather than a promise, so it cannot be
        // filtered out of a list — it is recorded as struck instead, and
        // `refusalsAgainst` reads that.
        party.struck = [...new Set([...(party.struck ?? []), player.key])];
        outcome.log.push(
          `${player.name} puts it to the ${party.name} plainly. The red line is gone.`,
        );
        break;
      }

      case "reshuffle": {
        if (!party) break;
        party.package = [];
        outcome.log.push(
          `${player.name} reshuffles the cabinet. The ${party.name} keeps its seat at the table and none of its portfolios.`,
        );
        break;
      }

      case "auction": {
        if (!party) break;
        outcome.exposed.push(party.key);
        outcome.log.push(
          `${player.name} forces the ${party.name} back out to tender. Its coalition agreement counts for nothing this week.`,
        );
        break;
      }

      case "exclusivity": {
        if (!party) break;
        // Written as ordinary carded refusals against every rival's own list,
        // which is the party that never leaves their bloc. It lapses on the
        // same timer every other refusal does, and an ultimatum breaks it the
        // same way — a card that could not be answered by another card would
        // be the only one in the deck.
        const rivals = state.players.filter((other) => other.key !== player.key);
        party.refusals = [
          ...party.refusals,
          ...rivals.map((rival) => ({ partyKey: rival.partyKey, until: state.turn + 2 })),
        ];
        outcome.log.push(
          `${player.name} signs the ${party.name} to an exclusive. It takes nobody else's call for a fortnight.`,
        );
        break;
      }

      case "extension":
        outcome.extended = true;
        outcome.log.push(
          `${player.name} goes to the President, who grants another fortnight. The house does not dissolve.`,
        );
        break;

      case "recess":
        outcome.recess.push(player.key);
        outcome.log.push(`${player.name} sends the house home early. The year does not count.`);
        break;
    }
  }

  return outcome;
};

/** The play in this set against the biggest list, for cards that want size. */
const biggest = (state: GameState, plays: WildPlay[], id: string): WildPlay | undefined =>
  plays
    .filter((play) => play.id === id)
    .sort((a, b) => (state.parties[b.partyKey!]?.seats ?? 0) - (state.parties[a.partyKey!]?.seats ?? 0))[0];

const seatsOf = (state: GameState, play: WildPlay | undefined): number =>
  play ? (state.parties[play.partyKey!]?.seats ?? 0) : 0;

/**
 * The card this player's position argues for, if any.
 *
 * Shared by every seat for the same reason {@link ./laws#preferredLaw} is: a
 * lever only one chair can reach is a handicap wearing a strategy's clothes.
 *
 * Deliberately conservative. A wild held is a wild available next turn, and the
 * bots that hoard slightly beat the bots that spend on the first legal target.
 */
export const preferredWild = (state: GameState, playerKey: string): WildPlay | null => {
  const plays = legalPlays(state, playerKey);
  if (plays.length === 0) return null;

  const seats = blocSeats(state, playerKey);
  const governing = state.primeMinister === playerKey;

  // The house falls this week unless somebody stops it, and every other card in
  // hand goes down with it. Checked before anything else for that reason: this
  // is the one wild with a deadline of its own.
  //
  // Worth a card only to a player who can still use the week. Six seats short
  // is a week away from a government; twelve is a different campaign, and that
  // bloc does better out of the election than out of the extension — which is
  // the bet the card refuses, so it is left unplayed and the country votes.
  const extension = plays.find((play) => play.id === "extension");
  if (extension && seats >= 55 && seats < 61) return extension;

  // Stopping the clock is worth a card only while it is buying a year that
  // would otherwise be spent on an election this player might lose.
  const recess = plays.find((play) => play.id === "recess");
  if (recess && governing && seats < 70) return recess;

  // A red line in front of a list big enough to matter is the best price a
  // wild ever gets: money cannot move one at any size of bid.
  const ultimatum = plays
    .filter((play) => play.id === "ultimatum")
    .sort((a, b) => (state.parties[b.partyKey!]?.seats ?? 0) - (state.parties[a.partyKey!]?.seats ?? 0))[0];
  if (ultimatum && (state.parties[ultimatum.partyKey!]?.seats ?? 0) >= 6 && seats < 61) {
    return ultimatum;
  }

  // A big list already sitting in a rival's coalition is the most expensive
  // thing on the board: the holder's package stacks and ties go to them, so
  // capturing one costs more than it is worth. The card deletes both, and it is
  // the only move a player who is behind can make that money will not sell.
  const auction = biggest(state, plays, "auction");
  if (auction && seatsOf(state, auction) >= 8 && seats < 61) return auction;

  // A list big enough to be the difference, signed to take nobody else's call
  // for a fortnight. On a free list that is a capture no rival can outbid; on
  // one already in this coalition it is the whip narrowed to a single partner.
  // A player short of a majority wants the capture, so a free list is taken
  // first and a held one is the fallback.
  const unheld = plays.filter(
    (play) => play.id === "exclusivity" && !state.parties[play.partyKey!]?.heldBy,
  );
  const exclusivity = biggest(state, unheld.length > 0 ? unheld : plays, "exclusivity");
  if (exclusivity && seatsOf(state, exclusivity) >= 8 && seats < 61) return exclusivity;

  // Locked portfolios with nothing left in hand is the stalemate the card was
  // written for.
  const reshuffle = plays
    .filter((play) => play.id === "reshuffle")
    .sort(
      (a, b) =>
        (state.parties[b.partyKey!]?.package.length ?? 0) -
        (state.parties[a.partyKey!]?.package.length ?? 0),
    )[0];
  if (reshuffle && freeMinistries(state, playerKey).length <= 2) return reshuffle;

  // Defend a majority that is standing, and only one that is standing.
  const whip = plays.find((play) => play.id === "whip");
  if (whip && governing && seats >= 61 && seats < 68) return whip;

  return null;
};
