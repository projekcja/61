/**
 * The stack of cards.
 *
 * One card is drawn each turn, filtered to the phase in play. The
 * deck is the only part of the game that reads a party's politics: when a card
 * writes a red line it records a concrete party-to-party refusal, so the
 * bidding never has to consult ideology itself.
 *
 * Adding or removing the ideology-tagged cards is the dial for how much
 * politics matters, and it moves nothing else.
 *
 * On the writing, since this is the only part of the game with a voice. A card
 * is a news brief: declarative, specific, and never signposting itself. The
 * comedy is that the line is plausible, so it comes from the detail — a hotel
 * on the Dead Sea, a director-general, a photograph at a petrol station near
 * Latrun — and never from wordplay or from a line telling you it was a joke.
 * The test is whether a reader who did not know it was funny would take it for
 * a filing from the political desk. If not, it is winking, and it should be cut.
 *
 * Not every card should land, either. A deck that quips uniformly is a deck
 * with no contrast, and the flat ones are what make the Dead Sea line work.
 */

import { EXTRA_MINISTRIES } from "./ministries";
import { BLOC_LABEL, ELECTORAL_THRESHOLD, MAJORITY } from "./parties";
import type { Bloc } from "./parties";
import type { Rng } from "./rng";
import type { GameState, Party, Phase } from "./types";
import { TERM_LENGTH, TheList, theList } from "./types";
import {
  biddableParties,
  blocParties,
  blocSeats,
  clamp,
  freeMinistries,
  isLedByPlayer,
  ministryByKey,
  playerOf,
  refusalsAgainst,
} from "./types";

export interface Card {
  id: string;
  title: string;
  /** Phases in which this card can come up. */
  phases: Phase[];
  /** True when the card reads party politics; used by the deck-composition test. */
  ideological?: boolean;
  /** Relative likelihood; 0 means its preconditions are not met right now. */
  weight: (state: GameState, drawerKey: string) => number;
  /** Mutates the state and returns the line for the log, or null if it fizzled. */
  play: (state: GameState, rng: Rng, drawerKey: string) => string | null;
}

/**
 * Names a new list can register under.
 *
 * Real ones, retired and available. Israeli lists recycle names constantly, so
 * a party called Telem or Gesher appearing two parliaments after the last one
 * folded is the authentic thing rather than a shortcut. Shared with the
 * election code in {@link ./campaign}, which registers new lists of its own.
 */
export const SPLINTER_NAMES = [
  "Otzma Yehudit", "Noam", "New Hope", "Telem", "Derech Eretz",
  "Gesher", "Balad", "Tzomet", "Meretz", "Ahi",
  "Yachad", "Zehut", "Hetz", "Am Shalem", "Kadima",
  "Shinui", "Rafi", "Moked", "Ometz", "Morasha",
];

/** A name nobody on the board is using yet, or null if they all are. */
export const unusedName = (state: GameState): string | null =>
  SPLINTER_NAMES.find(
    (candidate) => !Object.values(state.parties).some((party) => party.name === candidate),
  ) ?? null;

const unaligned = (state: GameState): Party[] =>
  biddableParties(state).filter((party) => party.heldBy === null);

/**
 * Send a party back to the market.
 *
 * The portfolios it was holding return to whoever paid them, which matters now
 * that a package stays spent for as long as the party stays bought.
 */
const release = (party: Party): void => {
  party.heldBy = null;
  party.package = [];
};

const opposedBloc = (bloc: Bloc): Bloc[] => {
  switch (bloc) {
    case "right":
      return ["arab", "left"];
    case "haredi":
      return ["arab", "left"];
    case "left":
      return ["right"];
    case "arab":
      return ["right", "haredi"];
    case "centre":
      return [];
  }
};

/**
 * Leave a party pleased or furious for a few turns.
 *
 * The same machinery the order paper uses — see {@link ./laws} — reached from
 * the deck, because half of what puts a coalition partner in a mood is not
 * legislation at all. A mood scales what the package holding the party counts
 * for, so an offended partner really is cheaper for a rival to take without the
 * card having to move a portfolio itself.
 */
const feel = (state: GameState, party: Party, delta: number, because: string): void => {
  state.moods[party.key] = { delta, until: state.turn + 3, because };
};

/** Move seats between two parties without changing the size of the Knesset. */
const moveSeats = (from: Party, to: Party, count: number): number => {
  const moved = Math.max(0, Math.min(count, from.seats - 1));
  from.seats -= moved;
  to.seats += moved;
  return moved;
};

/**
 * Weeks in which nothing was agreed.
 *
 * Deadpan on purpose. None of these is a joke with a shape — they are filings
 * from a week of coalition talks that produced nothing, and the comedy is
 * supposed to be that they are all completely plausible.
 */
const QUIET_WEEKS = [
  "A quiet week. Nothing but position papers and leaks about position papers.",
  "A quiet week. Three lists announce they are not negotiating with anybody, from the same conference room.",
  "A quiet week. The talks move to a hotel, which is reported as progress.",
  "A quiet week. Somebody counts to 61 on live television, using a chart, and is wrong.",
  "A quiet week. Both sides brief that the other side is panicking.",
  "A quiet week. Each side appoints a negotiating team, and the teams agree to meet next week.",
  "A quiet week. The only movement all week is a photograph of two advisers at a petrol station near Latrun.",
  "A quiet week. Nothing is agreed, and all of it is denied.",
];

/** Years in which the government governed. */
const QUIET_YEARS = [
  "A quiet year. The government governs, which nobody reports.",
  "A quiet year. The cabinet approves a five-year plan, which is longer than most governments.",
  "A quiet year. The coalition meets weekly and agrees the agenda for the following meeting.",
  "A quiet year. A committee is appointed to review the findings of the last committee.",
  "A quiet year. Two ministers tour the north and are photographed pointing at things.",
  "A quiet year. A minister opens a stretch of road that was finished under the last government.",
  "A quiet year. The opposition demands an election, and the polls advise them against it.",
  "A quiet year. Nothing is reformed and nothing collapses, and the evening news loses viewers.",
];

export const CARDS: Card[] = [
  // ----------------------------------------------------------------- forming
  {
    id: "new-ministry",
    title: "A portfolio is invented",
    phases: ["forming"],
    weight: (state) => (state.ministries.length < 21 ? 2 : 0),
    play: (state, rng) => {
      const candidates = EXTRA_MINISTRIES.filter(
        (extra) => !state.ministries.some((ministry) => ministry.key === extra.key),
      );
      if (candidates.length === 0) return null;
      const ministry = rng.pick(candidates);
      state.ministries.push({ ...ministry });
      return `A ${ministry.name} portfolio is carved out of thin air. Every player now has one more chip, worth ${ministry.budget}bn.`;
    },
  },
  {
    id: "abolish-ministry",
    title: "A ministry is folded",
    phases: ["forming", "governing"],
    weight: (state) => (state.ministries.length > 12 ? 1.5 : 0),
    play: (state, rng) => {
      const doomed = rng.pick(state.ministries.filter((ministry) => ministry.budget <= 10));
      if (!doomed) return null;
      state.ministries = state.ministries.filter((ministry) => ministry.key !== doomed.key);
      for (const party of Object.values(state.parties)) {
        party.package = party.package.filter((key) => key !== doomed.key);
      }
      return `${doomed.name} is folded into a larger ministry, whose minister is not told in advance. Everyone loses that chip, including the coalitions already built on it.`;
    },
  },
  {
    id: "merger",
    title: "Two lists run together",
    phases: ["forming"],
    ideological: true,
    weight: (state) => (mergeCandidates(state).length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      const pairs = mergeCandidates(state);
      if (pairs.length === 0) return null;
      const [keeper, absorbed] = rng.pick(pairs);
      keeper.seats += absorbed.seats;
      delete state.parties[absorbed.key];
      return `${TheList(absorbed.name)} folds into ${theList(keeper.name)} on a joint ticket announced as a merger of equals. One list, ${keeper.seats} mandates, same ${BLOC_LABEL[keeper.bloc].toLowerCase()} politics, one leader.`;
    },
  },

  {
    id: "new-list",
    title: "A new list registers",
    phases: ["forming"],
    weight: (state) => (donorParties(state).length >= 2 && freeName(state) !== null ? 1.5 : 0),
    play: (state, rng) => {
      const name = freeName(state);
      const donors = donorParties(state);
      if (!name || donors.length < 2) return null;
      const [first, second] = rng.sample(donors, 2);

      // Built out of other people's voters: the seats come off the two lists it
      // was founded to replace, never out of thin air, so the chamber stays 120.
      const fromFirst = Math.min(first.seats - 1, rng.int(2, 4));
      const fromSecond = Math.min(second.seats - 1, rng.int(1, 3));
      const taken = fromFirst + fromSecond;
      if (taken < ELECTORAL_THRESHOLD) return null;
      first.seats -= fromFirst;
      second.seats -= fromSecond;

      const key = `list-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      state.parties[key] = {
        key,
        name,
        seats: taken,
        bloc: first.bloc,
        leftRight: clamp(Math.round((first.leftRight + second.leftRight) / 2), -10, 10),
        heldBy: null,
        package: [],
        refusals: [],
      };
      return `${name} registers as a new list, promising a politics above the old divisions, and polls straight into the Knesset with ${taken} mandates — most of them borrowed from ${theList(first.name)} and ${theList(second.name)}, who are the old divisions.`;
    },
  },
  {
    id: "primaries",
    title: "A party holds primaries",
    phases: ["forming", "governing"],
    weight: (state) =>
      Object.values(state.parties).some((party) => party.refusals.length > 0) ? 2 : 0,
    play: (state, rng) => {
      const bound = Object.values(state.parties).filter((party) => party.refusals.length > 0);
      if (bound.length === 0) return null;
      const party = rng.pick(bound);
      const lifted = party.refusals.length;
      // A red line is a promise made by a leader. Change the leader and the
      // promise goes with them, which is the only way back from one early.
      party.refusals = [];
      return `${party.name} holds primaries and replaces its leader, who congratulates the winner warmly and at length. Every red line the old one drew — ${lifted} of them — dies with the leadership.`;
    },
  },
  {
    id: "presidential-extension",
    title: "The president intervenes",
    phases: ["forming"],
    weight: (state) => (state.week > 1 ? 1.5 : 0),
    play: (state) => {
      if (state.week <= 1) return null;
      state.week -= 1;
      return "The president calls the party leaders in one at a time and hands back a week. The clock on forming a government moves the wrong way for once.";
    },
  },

  // --------------------------------------------------------------- governing
  {
    id: "partner-walks",
    title: "A partner walks",
    phases: ["governing", "rebuilding"],
    weight: (state) => (state.primeMinister && partnersOf(state).length > 0 ? 3 : 0),
    play: (state, rng) => {
      const partners = partnersOf(state);
      if (partners.length === 0) return null;
      const leaving = rng.pick(partners);
      release(leaving);
      return `${TheList(leaving.name)} walks out of the coalition over a cabinet row nobody outside the cabinet can explain. ${leaving.seats} mandates gone.`;
    },
  },
  {
    id: "budget-crisis",
    title: "The budget fails",
    phases: ["governing"],
    weight: (state) => (state.primeMinister && partnersOf(state).length > 1 ? 2 : 0),
    play: (state, rng) => {
      const partners = partnersOf(state);
      if (partners.length < 2) return null;
      const [first, second] = rng.sample(partners, 2);
      release(first);
      release(second);
      return `The budget fails its second reading at two in the morning, eleven votes short of a coalition that has 61. ${TheList(first.name)} and ${theList(second.name)} both leave the government.`;
    },
  },
  {
    id: "law-passes",
    title: "A landmark law passes",
    phases: ["governing"],
    weight: (state) => (state.primeMinister ? 2 : 0),
    play: (state) => {
      if (!state.primeMinister) return null;
      const pm = playerOf(state, state.primeMinister);
      pm.yearsInPower += 1;
      state.governmentYears += 1;
      return `A landmark law passes, and four parties hold separate press conferences to explain that it was their idea. ${pm.name} banks an extra year.`;
    },
  },
  {
    id: "emergency",
    title: "National emergency",
    phases: ["governing", "rebuilding"],
    weight: (state) => (state.primeMinister && state.emergencyUntil <= state.turn ? 1.5 : 0),
    play: (state) => {
      if (!state.primeMinister) return null;
      state.emergencyUntil = state.turn + 2;
      return "A national emergency freezes the politics. The government cannot fall for two years.";
    },
  },
  {
    id: "corruption",
    title: "A corruption probe",
    phases: ["governing", "rebuilding"],
    weight: (state) => (partnersOf(state).length > 0 ? 2 : 0),
    play: (state, rng) => {
      const partners = partnersOf(state);
      if (partners.length === 0) return null;
      const accused = rng.pick(partners);
      release(accused);
      return `A corruption probe reaches ${theList(accused.name)}, which discovers an urgent disagreement with the government on an unrelated matter and resigns from the coalition over that instead.`;
    },
  },

  {
    id: "minister-resigns",
    title: "A minister resigns",
    phases: ["governing", "rebuilding"],
    weight: (state) => (paidPartners(state).length > 0 ? 2.5 : 0),
    play: (state, rng) => {
      const partners = paidPartners(state);
      if (partners.length === 0) return null;
      const party = rng.pick(partners);

      // The party stays bought, but the package holding it there gets lighter.
      // That is the cheapest way anyone gets a portfolio back, and it quietly
      // puts the partner within reach of whoever is bidding against you.
      const surrendered = [...party.package].sort(
        (a, b) => (ministryByKey(state, b)?.budget ?? 0) - (ministryByKey(state, a)?.budget ?? 0),
      )[0];
      if (!surrendered) return null;
      party.package = party.package.filter((key) => key !== surrendered);
      const name = ministryByKey(state, surrendered)?.name ?? surrendered;
      return `${TheList(party.name)} minister for ${name} resigns to spend more time with a family that has already given several interviews about missing him. The portfolio goes back to whoever paid for it, and the party stays on a cheaper package than before.`;
    },
  },
  {
    id: "partner-demands",
    title: "A partner reopens the deal",
    phases: ["governing"],
    weight: (state) => (demandTargets(state).length > 0 ? 2 : 0),
    play: (state, rng) => {
      const targets = demandTargets(state);
      if (targets.length === 0 || !state.primeMinister) return null;
      const party = rng.pick(targets);
      const pm = playerOf(state, state.primeMinister);
      const hand = freeMinistries(state, pm.key);
      if (hand.length === 0) return null;

      // Nothing is bought once and for all. A partner that knows the government
      // cannot survive without it comes back for more, and the price comes out
      // of the hand the prime minister was saving for somebody else.
      const cheapest = [...hand].sort(
        (a, b) => (ministryByKey(state, a)?.budget ?? 0) - (ministryByKey(state, b)?.budget ?? 0),
      )[0];
      party.package = [...party.package, cheapest];
      const name = ministryByKey(state, cheapest)?.name ?? cheapest;
      return `${TheList(party.name)} reopens the coalition agreement and walks away with ${name} as well. ${pm.name} pays rather than count the votes without them.`;
    },
  },
  {
    id: "dissolution-vote",
    title: "The Knesset votes to dissolve",
    phases: ["governing"],
    weight: (state) => (state.primeMinister && state.governmentYears >= 1 ? 1 : 0),
    play: (state) => {
      if (!state.primeMinister) return null;
      // The term is the clock, and this card runs it out early. What follows is
      // the ordinary end-of-term election, agreements and all.
      state.governmentYears = TERM_LENGTH;
      return "A dissolution bill passes its first reading and nobody in the coalition can be whipped against it. The term ends here, and the country votes.";
    },
  },
  {
    id: "general-strike",
    title: "A general strike",
    phases: ["governing", "rebuilding"],
    weight: (state) =>
      state.primeMinister && playerOf(state, state.primeMinister).yearsInPower > 0 ? 1.5 : 0,
    play: (state) => {
      if (!state.primeMinister) return null;
      const pm = playerOf(state, state.primeMinister);
      if (pm.yearsInPower <= 0) return null;
      // The mirror of the landmark law: a year in office that buys nothing.
      pm.yearsInPower -= 1;
      return `The country stops for a fortnight. The airport closes, the ports close, the banks close, and the government spends the rest of the year explaining that it has not lost control. ${pm.name} loses a year off the record.`;
    },
  },
  {
    id: "defection-to-government",
    title: "A list joins the coalition",
    phases: ["governing", "rebuilding"],
    weight: (state) => (state.primeMinister && unaligned(state).length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      if (!state.primeMinister) return null;
      const available = unaligned(state).filter((party) => party.seats <= 8);
      if (available.length === 0) return null;
      const joiner = rng.pick(available);
      const pm = playerOf(state, state.primeMinister);
      // It costs nothing, which is the point: a small list would rather be in
      // the room than right. It holds no package either, so it is cheap to poach
      // straight back off them.
      joiner.heldBy = state.primeMinister;
      return `${TheList(joiner.name)} crosses to the government benches for a committee chair and a photograph. ${pm.name} gains ${joiner.seats} mandates and pays nothing for them.`;
    },
  },

  // -------------------------------------------------------------------- both
  {
    id: "floor-crossing",
    title: "A member crosses the floor",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) => (Object.keys(state.parties).length > 1 ? 3 : 0),
    play: (state, rng) => {
      const parties = Object.values(state.parties).filter((party) => party.seats > 1);
      if (parties.length < 2) return null;
      const [from, to] = rng.sample(parties, 2);
      const moved = moveSeats(from, to, rng.int(1, 2));
      if (moved === 0) return null;
      return `${moved === 1 ? "A member" : `${moved} members`} of ${theList(from.name)} cross the floor to ${theList(to.name)}, on a matter of deep principle that arrived the same week as the committee appointments.`;
    },
  },
  {
    id: "scandal",
    title: "A scandal breaks",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) => (biddableParties(state).some((party) => party.heldBy) ? 2 : 0),
    play: (state, rng) => {
      const held = biddableParties(state).filter((party) => party.heldBy);
      if (held.length === 0) return null;
      const party = rng.pick(held);
      release(party);
      return `A recording surfaces. ${TheList(party.name)} suspends its agreement and returns to the market.`;
    },
  },
  {
    id: "quiet",
    title: "A quiet stretch",
    phases: ["forming", "governing", "rebuilding"],
    weight: () => 5,
    // The most likely card in the deck by some way, which for a long time meant
    // one of two lines. A player sees this more often than anything else the
    // game says, so it is the one card where the writing is the feature: a week
    // in which nothing happens is the most Israeli thing a coalition does, and
    // it should not be the most repetitive thing the game says back.
    play: (state, rng) =>
      rng.pick(state.phase === "forming" ? QUIET_WEEKS : QUIET_YEARS) ?? "A quiet stretch.",
  },

  {
    id: "court-ruling",
    title: "The court revalues a portfolio",
    phases: ["forming", "governing"],
    weight: (state) => (state.ministries.length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      const ministry = rng.pick(state.ministries);
      if (!ministry) return null;
      // Everything else on the table moves seats or parties. This is the only
      // card that moves the money, and it moves it for everyone at once: the
      // chip is re-priced in every hand and in every deal already built on it.
      const swing = rng.int(2, 5) * (rng.chance(0.5) ? 1 : -1);
      const before = ministry.budget;
      ministry.budget = clamp(ministry.budget + swing, 1, 20);
      if (ministry.budget === before) return null;
      return ministry.budget > before
        ? `A court ruling hands ${ministry.name} authority it never had. Worth ${ministry.budget}bn now, up from ${before}bn, in every hand and every deal already signed.`
        : `${ministry.name} is stripped of half its powers. Worth ${ministry.budget}bn now, down from ${before}bn, including to whoever is already holding it.`;
    },
  },
  {
    id: "night-budget",
    title: "The budget passes at four in the morning",
    phases: ["governing", "rebuilding"],
    weight: (state) => (state.primeMinister && state.ministries.length > 0 ? 1.6 : 0),
    play: (state, rng) => {
      const ministry = rng.pick(state.ministries);
      if (!ministry) return null;
      const before = ministry.budget;
      ministry.budget = clamp(ministry.budget + rng.int(2, 4), 1, 20);
      if (ministry.budget === before) return null;
      return `The budget passes at four in the morning. By breakfast somebody has found the clause moving ${ministry.budget - before}bn into ${ministry.name}, and no member of the coalition will admit to having drafted it. Worth ${ministry.budget}bn now, up from ${before}bn.`;
    },
  },
  {
    id: "backbench-revolt",
    title: "A backbench revolt",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) =>
      biddableParties(state).filter((party) => party.seats >= 5).length > 0 ? 2 : 0,
    play: (state, rng) => {
      const big = biddableParties(state).filter((party) => party.seats >= 5);
      if (big.length === 0) return null;
      const party = rng.pick(big);
      const rest = Object.values(state.parties).filter((other) => other.key !== party.key);
      if (rest.length === 0) return null;
      const moved = moveSeats(party, rng.pick(rest), rng.int(1, 3));
      if (moved === 0) return null;
      return `${moved} of ${theList(party.name)} refuse the whip and walk, and a rival list is happy to seat them.`;
    },
  },
  {
    id: "leader-retires",
    title: "A leader stands down",
    phases: ["forming", "governing"],
    weight: (state) => (biddableParties(state).length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      const party = rng.pick(biddableParties(state));
      if (!party) return null;
      const rest = Object.values(state.parties).filter((other) => other.key !== party.key);
      if (rest.length === 0) return null;
      const other = rng.pick(rest);
      const rising = rng.chance(0.5);
      const size = rng.int(1, 3);
      const moved = rising ? moveSeats(other, party, size) : moveSeats(party, other, size);
      if (moved === 0) return null;
      return rising
        ? `${TheList(party.name)} leader stands down and the successor turns out to be popular. ${moved} mandates come their way.`
        : `${TheList(party.name)} leader stands down after thirty years, and ${moved} mandates of personal loyalty go elsewhere.`;
    },
  },

  // ------------------------------------------------------------- ideological
  {
    id: "split",
    title: "A list splits",
    phases: ["forming", "governing"],
    ideological: true,
    weight: (state) => (splitCandidates(state).length > 0 ? 2 : 0),
    play: (state, rng) => {
      const candidates = splitCandidates(state);
      if (candidates.length === 0) return null;
      const party = rng.pick(candidates);
      const breakaway = Math.max(2, Math.floor(party.seats * rng.range(0.25, 0.45)));
      party.seats -= breakaway;

      const name = rng.pick(
        SPLINTER_NAMES.filter(
          (candidate) =>
            !Object.values(state.parties).some((existing) => existing.name === candidate),
        ),
      );
      if (!name) return null;

      // Keyed by the breakaway's own name, which is drawn from the names not
      // already in use. Keying by turn collided when two lists split at once,
      // and the second splinter overwrote the first.
      const key = `split-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      // The breakaway sits further out than the list it left.
      const drift = party.leftRight >= 0 ? 2 : -2;
      state.parties[key] = {
        key,
        name,
        seats: breakaway,
        bloc: party.bloc,
        leftRight: Math.max(-10, Math.min(10, party.leftRight + drift)),
        heldBy: null,
        package: [],
        refusals: [],
      };
      return `${TheList(party.name)} splits over what both halves describe as the same principle. ${name} breaks away with ${breakaway} mandates and sits further ${drift > 0 ? "right" : "left"} than the list it left.`;
    },
  },
  {
    id: "bloc-red-line",
    title: "A red line is drawn",
    phases: ["forming", "governing"],
    ideological: true,
    weight: (state) => (redLineCandidates(state).length > 0 ? 2.5 : 0),
    play: (state, rng) => {
      const pairs = redLineCandidates(state);
      if (pairs.length === 0) return null;
      const [refuser, target] = rng.pick(pairs);
      const turns = rng.int(3, 6);
      refuser.refusals.push({ partyKey: target.key, until: state.turn + turns });
      return `${refuser.name} rules it out on the record, in writing, on camera, and signed by every one of its members: no government with ${theList(target.name)}. That holds for ${turns} turns.`;
    },
  },
  {
    id: "rules-out-drawer",
    title: "Ruled out on air",
    phases: ["forming"],
    ideological: true,
    weight: (state, drawerKey) => (rulesOutTargets(state, drawerKey).length > 0 ? 2 : 0),
    play: (state, rng, drawerKey) => {
      const targets = rulesOutTargets(state, drawerKey);
      if (targets.length === 0) return null;
      const refuser = rng.pick(targets);
      const drawer = playerOf(state, drawerKey);
      const own = state.parties[drawer.partyKey];
      const turns = rng.int(2, 5);
      refuser.refusals.push({ partyKey: own.key, until: state.turn + turns });
      return `${refuser.name} rules out sitting under ${own.name} — "not in this parliament, not at any price." ${turns} turns.`;
    },
  },
  {
    id: "bloc-swing",
    title: "The country moves",
    phases: ["forming", "governing"],
    ideological: true,
    weight: (state) => (swingPairs(state).length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      const pairs = swingPairs(state);
      if (pairs.length === 0) return null;
      const [gaining, losing] = rng.pick(pairs);
      let moved = 0;
      for (const donor of losing) {
        if (moved >= 4) break;
        const beneficiary = gaining[moved % gaining.length];
        moved += moveSeats(donor, beneficiary, rng.int(1, 2));
      }
      if (moved === 0) return null;
      const gainingBloc = BLOC_LABEL[gaining[0].bloc];
      return `The mood shifts for no reason any of the four panels on television can agree on. ${moved} mandates move toward the ${gainingBloc.toLowerCase()}.`;
    },
  },
  {
    id: "religious-demand",
    title: "A rabbinical ruling",
    phases: ["forming", "governing"],
    ideological: true,
    weight: (state) => (religiousDemandTargets(state).length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      const targets = religiousDemandTargets(state);
      if (targets.length === 0) return null;
      const party = rng.pick(targets);
      const opposed = Object.values(state.parties).filter((candidate) =>
        opposedBloc(party.bloc).includes(candidate.bloc),
      );
      if (opposed.length === 0) return null;
      const turns = rng.int(3, 6);
      for (const other of opposed) {
        party.refusals.push({ partyKey: other.key, until: state.turn + turns });
      }
      return `A rabbinical ruling binds ${party.name}: no government alongside ${opposed.map((p) => p.name).join(" or ")}, for ${turns} turns.`;
    },
  },

  // -------------------------------------------------------------- the economy
  // Everybody is holding the same eighteen shares of it, so a card that moves
  // the whole ladder moves it in every hand at once. Nobody comes out of these
  // relatively better off, which is exactly what makes them interesting: the
  // board gets cheaper or dearer for all four players on the same turn.
  {
    id: "inflation",
    title: "Inflation",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) => (state.ministries.some((ministry) => ministry.budget > 2) ? 1.6 : 0),
    play: (state) => {
      let moved = 0;
      for (const ministry of state.ministries) {
        if (ministry.budget <= 1) continue;
        ministry.budget -= 1;
        moved += 1;
      }
      if (moved === 0) return null;
      return "Inflation reaches double digits for the first time in thirty years. Every portfolio in the cabinet is worth a billion less than it was, and every coalition agreement in the house is quietly thinner than the day it was signed.";
    },
  },
  {
    id: "gas-revenues",
    title: "The gas fields come online",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) => (state.ministries.some((ministry) => ministry.budget < 20) ? 1.4 : 0),
    play: (state) => {
      let moved = 0;
      for (const ministry of state.ministries) {
        if (ministry.budget >= 20) continue;
        ministry.budget += 1;
        moved += 1;
      }
      if (moved === 0) return null;
      return "Royalties from the offshore fields reach the sovereign fund and the treasury stops saying no to things. Every portfolio is worth a billion more, for everyone, which is worth a good deal less than it sounds.";
    },
  },

  // ------------------------------------------------------------------- moods
  // Things that change what a partner costs without moving a single portfolio.
  {
    id: "comptroller-report",
    title: "The comptroller reports",
    phases: ["governing", "rebuilding"],
    weight: (state) => (partnersOf(state).length > 0 ? 2 : 0),
    play: (state) => {
      const partners = partnersOf(state);
      if (partners.length === 0) return null;
      for (const party of partners) feel(state, party, -0.25, "the comptroller's report");
      const one = partners.length === 1;
      return `The state comptroller publishes on the coalition's use of discretionary funds and names every party in it. ${one ? "Your partner is" : "Your partners are"} embarrassed, resentful, and cheaper to take off you than ${one ? "it was" : "they were"} yesterday.`;
    },
  },
  {
    id: "coalition-retreat",
    title: "A coalition retreat",
    phases: ["governing"],
    weight: (state) => (partnersOf(state).length > 1 ? 1.6 : 0),
    play: (state, rng) => {
      const partners = partnersOf(state);
      if (partners.length < 2) return null;
      const pleased = rng.pick(partners);
      feel(state, pleased, 0.4, "two days of being listened to");
      return `Two days at a hotel on the Dead Sea, and ${theList(pleased.name)} comes back convinced that somebody is finally listening to them. Taking them off you has just become expensive.`;
    },
  },
  {
    id: "unpopular-appointment",
    title: "An appointment goes badly",
    phases: ["governing", "rebuilding"],
    weight: (state) => (paidPartners(state).length > 0 ? 1.8 : 0),
    play: (state, rng) => {
      const partners = paidPartners(state);
      if (partners.length === 0) return null;
      const snubbed = rng.pick(partners);
      feel(state, snubbed, -0.45, "a director-general appointed over their head");
      return `A director-general is appointed to ${theList(snubbed.name)}'s own ministry without anybody asking them first. They stay in the government, they are furious, and everyone can now see how little they are actually being held with.`;
    },
  },
  {
    id: "sectoral-win",
    title: "A sector gets its way",
    phases: ["forming", "governing"],
    weight: (state) => (unaligned(state).length > 0 ? 1.5 : 0),
    play: (state, rng) => {
      const loose = unaligned(state);
      if (loose.length === 0) return null;
      const winner = rng.pick(loose);
      feel(state, winner, 0.35, "a ruling that went their way");
      return `A High Court ruling goes ${theList(winner.name)}'s way on the one question their voters care about more than any other. They can afford to wait now, and their price has gone up to match.`;
    },
  },
  {
    id: "quiet-word",
    title: "A quiet word",
    phases: ["forming"],
    weight: (state) => (unaligned(state).length > 1 ? 1.3 : 0),
    play: (state, rng) => {
      const loose = unaligned(state);
      if (loose.length < 2) return null;
      const [a, b] = rng.sample(loose, 2);
      feel(state, a, 0.28, "an understanding with a neighbour");
      feel(state, b, 0.28, "an understanding with a neighbour");
      return `${TheList(a.name)} and ${theList(b.name)} are seen leaving the same room, and neither of them will say what was agreed in it. Both are holding out for more than they were this morning.`;
    },
  },

  {
    id: "rotation",
    title: "A rotation agreement is offered",
    phases: ["forming"],
    weight: (state) => (unaligned(state).some((party) => party.seats >= 4) ? 1.4 : 0),
    play: (state, rng) => {
      const loose = unaligned(state).filter((party) => party.seats >= 4);
      if (loose.length === 0) return null;
      const party = rng.pick(loose);
      feel(state, party, 0.32, "a rotation it intends to be on the first half of");
      return `${TheList(party.name)} lets it be known that it will sign a rotation agreement, on the single condition that it goes first. Nobody who has ever gone second in this country has taken their turn, and ${theList(party.name)}'s price has gone up to match.`;
    },
  },
  {
    id: "agreement-published",
    title: "The coalition agreement is published",
    phases: ["governing", "rebuilding"],
    weight: (state) => (paidPartners(state).length > 1 ? 1.7 : 0),
    play: (state, rng) => {
      const partners = paidPartners(state);
      if (partners.length < 2) return null;
      const [reader, favoured] = rng.sample(partners, 2);
      feel(state, reader, -0.4, "page 61 of an agreement it signed unread");
      return `The full coalition agreement is published: ninety-one pages, four annexes, and a clause on page 61 promising ${theList(favoured.name)} something none of the others were told about. ${TheList(reader.name)} confirms that it signed the document without reading it, on the record, apparently as a defence.`;
    },
  },

  // --------------------------------------------------- the street and the news
  {
    id: "mass-protest",
    title: "The squares fill up",
    phases: ["governing", "rebuilding"],
    weight: (state) => (state.primeMinister ? 1.8 : 0),
    play: (state, rng) => {
      if (!state.primeMinister) return null;
      const pm = playerOf(state, state.primeMinister);
      const governing = state.parties[pm.partyKey];
      const opposition = Object.values(state.parties).filter(
        (party) => party.heldBy !== pm.key && party.key !== pm.partyKey,
      );
      if (!governing || governing.seats <= 3 || opposition.length === 0) return null;
      const beneficiary = rng.pick(opposition);
      const moved = moveSeats(governing, beneficiary, rng.int(1, 3));
      if (moved === 0) return null;
      return `Three hundred thousand people on the roads every Saturday night for a month. ${TheList(governing.name)} loses ${moved} in the polls and ${theList(beneficiary.name)} picks ${moved === 1 ? "it" : "them"} up.`;
    },
  },
  {
    id: "border-flareup",
    title: "The northern border",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) =>
      Object.values(state.parties).some((party) => party.bloc === "right") &&
      Object.values(state.parties).some((party) => party.bloc !== "right" && party.seats > 3)
        ? 1.6
        : 0,
    play: (state, rng) => {
      const gaining = Object.values(state.parties).filter((party) => party.bloc === "right");
      const losing = Object.values(state.parties).filter(
        (party) => party.bloc !== "right" && party.seats > 3,
      );
      if (gaining.length === 0 || losing.length === 0) return null;
      const to = rng.pick(gaining);
      const from = rng.pick(losing);
      const moved = moveSeats(from, to, rng.int(1, 3));
      if (moved === 0) return null;
      return `A week of exchanges on the northern border, and a night of sirens as far south as Haifa. The country moves right in every poll taken afterwards: ${moved} from ${theList(from.name)} to ${theList(to.name)}.`;
    },
  },
  {
    id: "tent-protest",
    title: "The tent protest",
    phases: ["forming", "governing"],
    weight: (state) =>
      Object.values(state.parties).some((party) => party.bloc === "centre" || party.bloc === "left")
        ? 1.5
        : 0,
    play: (state, rng) => {
      const gaining = Object.values(state.parties).filter(
        (party) => party.bloc === "centre" || party.bloc === "left",
      );
      const losing = Object.values(state.parties).filter(
        (party) => party.bloc !== "centre" && party.bloc !== "left" && party.seats > 3,
      );
      if (gaining.length === 0 || losing.length === 0) return null;
      const to = rng.pick(gaining);
      const from = rng.pick(losing);
      const moved = moveSeats(from, to, rng.int(1, 2));
      if (moved === 0) return null;
      return `Tents go up on Rothschild over the price of a one-bedroom flat, and then they stay up. ${TheList(to.name)} is the list the cameras keep finding, and it takes ${moved} off ${theList(from.name)}.`;
    },
  },
  {
    id: "hostage-deal",
    title: "A deal is done",
    phases: ["governing"],
    weight: (state) => (state.primeMinister ? 1.2 : 0),
    play: (state, rng) => {
      if (!state.primeMinister) return null;
      const pm = playerOf(state, state.primeMinister);
      const hardliners = partnersOf(state).filter((party) => party.leftRight >= 7);
      pm.yearsInPower += 1;
      state.governmentYears += 1;
      if (hardliners.length === 0) {
        return `A deal is done, at a price nobody will print, and for once the country is in the streets for a good reason. ${pm.name} banks a year on it.`;
      }
      // The right kind of victory for a government and the wrong kind for the
      // partners who spent a year promising it would never be signed.
      const walker = rng.pick(hardliners);
      release(walker);
      return `A deal is done at a price nobody will print. ${pm.name} banks the year — and ${theList(walker.name)}, having assured its voters this would never happen, leaves the government the same afternoon.`;
    },
  },

  // ------------------------------------- procedure, where the politics happens
  {
    id: "mk-defects",
    title: "An MK crosses the floor",
    phases: ["forming", "governing"],
    weight: (state, drawerKey) => {
      const drawer = state.players.find((player) => player.key === drawerKey);
      if (!drawer) return 0;
      return donorParties(state).some((party) => party.key !== drawer.partyKey) ? 1.8 : 0;
    },
    play: (state, rng, drawerKey) => {
      const drawer = state.players.find((player) => player.key === drawerKey);
      const own = drawer ? state.parties[drawer.partyKey] : undefined;
      if (!drawer || !own) return null;
      const donors = donorParties(state).filter((party) => party.key !== own.key);
      if (donors.length === 0) return null;
      const from = rng.pick(donors);
      const moved = moveSeats(from, own, 1);
      if (moved === 0) return null;
      return `An MK leaves ${theList(from.name)} and signs with ${theList(own.name)}, with the Knesset's blessing and a deputy ministry nobody will confirm was promised. ${drawer.name} is one mandate better off.`;
    },
  },
  {
    id: "court-strikes-red-line",
    title: "A red line is struck down",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) =>
      Object.values(state.parties).some((party) => party.refusals.length > 0) ? 1.6 : 0,
    play: (state, rng) => {
      const bound = Object.values(state.parties).filter((party) => party.refusals.length > 0);
      if (bound.length === 0) return null;
      const party = rng.pick(bound);
      const lifted = party.refusals.length;
      party.refusals = [];
      return `${TheList(party.name)} is taken to court over the terms it registered its list on, and the refusals it published are struck out as unlawful conditions. ${lifted} red line${lifted === 1 ? "" : "s"} gone, and the party will now talk to anybody.`;
    },
  },
  {
    id: "denied-meeting",
    title: "Nobody was at the meeting",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) =>
      Object.values(state.parties).some((party) => party.refusals.length > 0) ? 1.5 : 0,
    // The court card strikes every red line a list published. This one drops
    // exactly one, and says nothing about why, which is the more common way a
    // refusal actually ends: not struck down, just never mentioned again.
    play: (state, rng) => {
      const bound = Object.values(state.parties).filter((party) => party.refusals.length > 0);
      if (bound.length === 0) return null;
      const party = rng.pick(bound);
      const dropped = rng.pick(party.refusals);
      const other = dropped ? state.parties[dropped.partyKey] : undefined;
      if (!dropped || !other) return null;
      party.refusals = party.refusals.filter((refusal) => refusal !== dropped);
      return `A photograph appears of ${theList(party.name)}'s leader leaving a house in Kfar Shmaryahu at one in the morning, twenty minutes behind ${theList(other.name)}'s. Both offices confirm that no meeting took place, and that it went well. One red line stops being mentioned.`;
    },
  },
  {
    id: "speaker-deal",
    title: "The speakership is traded",
    phases: ["forming"],
    weight: (state) => (unaligned(state).some((party) => party.seats <= 6) ? 1.4 : 0),
    play: (state, rng, drawerKey) => {
      const drawer = state.players.find((player) => player.key === drawerKey);
      if (!drawer) return null;
      const small = unaligned(state).filter((party) => party.seats <= 6);
      if (small.length === 0) return null;
      const party = rng.pick(small);
      // A red line still beats a favour. The speakership is not worth sitting
      // with somebody your voters were promised you would never sit with.
      if (refusalsAgainst(state, party, drawerKey).length > 0) return null;
      party.heldBy = drawerKey;
      party.package = [];
      return `The speakership goes to ${theList(party.name)} on ${drawer.name}'s nomination, and the coalition agreement follows it the same afternoon. ${TheList(party.name)} is in, for nothing at all.`;
    },
  },
  {
    id: "party-funding-scandal",
    title: "The books are opened",
    phases: ["forming", "governing", "rebuilding"],
    weight: (state) => (paidPartners(state).length > 0 ? 1.7 : 0),
    play: (state, rng) => {
      const partners = paidPartners(state);
      if (partners.length === 0) return null;
      const party = rng.pick(partners);
      // The most expensive thing it holds goes back, which is the mirror of the
      // resignation card and hurts a great deal more.
      const richest = [...party.package].sort(
        (a, b) => (ministryByKey(state, b)?.budget ?? 0) - (ministryByKey(state, a)?.budget ?? 0),
      )[0];
      if (!richest) return null;
      party.package = party.package.filter((key) => key !== richest);
      feel(state, party, -0.2, "the party financing inquiry");
      const name = ministryByKey(state, richest)?.name ?? richest;
      return `The party financing inquiry reaches ${theList(party.name)}, and its nominee for ${name} cannot take office. The portfolio goes back to whoever paid it, and the party is left being held on very little.`;
    },
  },
  {
    id: "municipal-elections",
    title: "The municipal elections",
    phases: ["forming", "governing"],
    weight: (state) =>
      Object.values(state.parties).some((party) => party.seats >= 10) &&
      Object.values(state.parties).some((party) => party.seats <= 6)
        ? 1.4
        : 0,
    play: (state, rng) => {
      const big = Object.values(state.parties).filter((party) => party.seats >= 10);
      const small = Object.values(state.parties).filter((party) => party.seats <= 6);
      if (big.length === 0 || small.length === 0) return null;
      const from = rng.pick(big);
      const to = rng.pick(small);
      const moved = moveSeats(from, to, rng.int(1, 2));
      if (moved === 0) return null;
      return `The municipal elections go badly for the big lists and well for everybody with a mayor. ${TheList(to.name)} takes ${moved} off ${theList(from.name)} in every poll for a month afterwards.`;
    },
  },
];

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

const partnersOf = (state: GameState): Party[] =>
  state.primeMinister
    ? blocParties(state, state.primeMinister).filter((party) =>
        state.primeMinister ? party.key !== playerOf(state, state.primeMinister).partyKey : false,
      )
    : [];

/** Coalition partners actually holding a package worth taking apart. */
const paidPartners = (state: GameState): Party[] =>
  partnersOf(state).filter((party) => party.package.length > 0);

/** Partners a government cannot afford to lose, which is what lets them ask. */
const demandTargets = (state: GameState): Party[] => {
  const pmKey = state.primeMinister;
  if (!pmKey || blocSeats(state, pmKey) < MAJORITY) return [];
  return partnersOf(state).filter((party) => blocSeats(state, pmKey) - party.seats < MAJORITY);
};

/** Lists big enough to donate seats to a newcomer without vanishing. */
const donorParties = (state: GameState): Party[] =>
  Object.values(state.parties).filter((party) => party.seats >= 6);

/** A splinter name nobody on the board is using yet. */
const freeName = (state: GameState): string | null => unusedName(state);

const splitCandidates = (state: GameState): Party[] =>
  Object.values(state.parties).filter(
    (party) => party.seats >= 8 && !isLedByPlayer(state, party.key),
  );

const mergeCandidates = (state: GameState): Array<[Party, Party]> => {
  const pairs: Array<[Party, Party]> = [];
  const pool = unaligned(state);
  for (const a of pool) {
    for (const b of pool) {
      if (a.key === b.key || a.bloc !== b.bloc) continue;
      if (a.seats >= b.seats) pairs.push([a, b]);
    }
  }
  return pairs;
};

const redLineCandidates = (state: GameState): Array<[Party, Party]> => {
  const pairs: Array<[Party, Party]> = [];
  for (const refuser of Object.values(state.parties)) {
    if (isLedByPlayer(state, refuser.key)) continue;
    for (const target of Object.values(state.parties)) {
      if (target.key === refuser.key) continue;
      if (!opposedBloc(refuser.bloc).includes(target.bloc)) continue;
      if (refuser.refusals.some((refusal) => refusal.partyKey === target.key)) continue;
      pairs.push([refuser, target]);
    }
  }
  return pairs;
};

const rulesOutTargets = (state: GameState, drawerKey: string): Party[] => {
  const drawer = state.players.find((player) => player.key === drawerKey);
  if (!drawer) return [];
  const own = state.parties[drawer.partyKey];
  if (!own) return [];
  return biddableParties(state).filter(
    (party) =>
      opposedBloc(party.bloc).includes(own.bloc) &&
      !party.refusals.some((refusal) => refusal.partyKey === own.key),
  );
};

const religiousDemandTargets = (state: GameState): Party[] =>
  Object.values(state.parties).filter(
    (party) => party.bloc === "haredi" && !isLedByPlayer(state, party.key),
  );

const swingPairs = (state: GameState): Array<[Party[], Party[]]> => {
  const byBloc = new Map<Bloc, Party[]>();
  for (const party of Object.values(state.parties)) {
    byBloc.set(party.bloc, [...(byBloc.get(party.bloc) ?? []), party]);
  }
  const pairs: Array<[Party[], Party[]]> = [];
  for (const [bloc, gaining] of byBloc) {
    const losing = Object.values(state.parties).filter(
      (party) => opposedBloc(bloc).includes(party.bloc) && party.seats > 2,
    );
    if (gaining.length > 0 && losing.length > 0) pairs.push([gaining, losing]);
  }
  return pairs;
};

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Draw and resolve one card for a player.
 *
 * Anything that would leave the board unplayable — no parties left to bid for —
 * is rolled back and treated as a quiet turn instead.
 */
export const drawCard = (
  state: GameState,
  rng: Rng,
  drawerKey: string,
): { title: string; text: string } | null => {
  const playable = CARDS.filter(
    (card) => card.phases.includes(state.phase) && card.weight(state, drawerKey) > 0,
  );
  if (playable.length === 0) return null;

  // Everything a card is allowed to touch, so a fizzle can be undone whole.
  // Moods joined this list when cards learned to set them: a card that leaves a
  // party furious and then returns null would otherwise have half happened.
  const snapshot = JSON.stringify({
    parties: state.parties,
    ministries: state.ministries,
    players: state.players,
    emergencyUntil: state.emergencyUntil,
    governmentYears: state.governmentYears,
    moods: state.moods,
  });

  const card = rng.weighted(playable, (candidate) => candidate.weight(state, drawerKey));
  const text = card.play(state, rng, drawerKey);

  const stillPlayable =
    biddableParties(state).length > 0 &&
    state.ministries.length > 0 &&
    Object.values(state.parties).reduce((sum, party) => sum + party.seats, 0) > 0;

  if (text === null || !stillPlayable) {
    const restored = JSON.parse(snapshot) as Pick<
      GameState,
      "parties" | "ministries" | "players" | "emergencyUntil" | "governmentYears" | "moods"
    >;
    state.parties = restored.parties;
    state.ministries = restored.ministries;
    state.players = restored.players;
    state.emergencyUntil = restored.emergencyUntil;
    state.governmentYears = restored.governmentYears;
    state.moods = restored.moods;
    return null;
  }

  return { title: card.title, text };
};

/** Drop refusals that have run their course, so red lines really do lapse. */
export const expireRefusals = (state: GameState): void => {
  for (const party of Object.values(state.parties)) {
    party.refusals = party.refusals.filter((refusal) => refusal.until > state.turn);
  }
};

/** Exported for the balance probe: how close a player is to a majority. */
export const majorityGap = (state: GameState, playerKey: string): number =>
  Math.max(0, 61 - blocSeats(state, playerKey));
