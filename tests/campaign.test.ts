import { describe, expect, it } from "vitest";

import { greedyOffer, randomOffer } from "../src/bots";
import { validateOffer } from "../src/engine/allocation";
import {
  applyAction,
  newCampaign,
  pendingSeat,
  readyToResolve,
  rollSeats,
  runElection,
  standings,
} from "../src/engine/campaign";
import { CARDS } from "../src/engine/deck";
import {
  CHAMBERS,
  DEFAULT_CHAMBER,
  ELECTORAL_THRESHOLD,
  MAJORITY,
  TOTAL_SEATS,
  chamberById,
} from "../src/engine/parties";
import { Rng } from "../src/engine/rng";
import type { GameState, Offer } from "../src/engine/types";
import {
  FORMING_DEADLINE,
  OFFERS_PER_TURN,
  TERM_LENGTH,
  YEARS_TO_WIN,
  biddableParties,
  blocSeats,
  emptyOffer,
  freeMinistries,
  reservedMinistries,
  reservedValue,
  valueOf,
} from "../src/engine/types";
import { playCampaign } from "./harness";

const SEEDS = Array.from({ length: 40 }, (_, index) => index * 977 + 3);

const seatTotal = (state: GameState): number =>
  Object.values(state.parties).reduce((sum, party) => sum + party.seats, 0);

const humanMove = (state: GameState, offer: Offer): GameState =>
  applyAction(state, { type: "offer", playerKey: "you", offer }).state;

describe("the chambers a campaign can open on", () => {
  it("seats a full Knesset in every one of them", () => {
    for (const chamber of CHAMBERS) {
      const total = chamber.parties.reduce((sum, profile) => sum + profile.baseSeats, 0);
      expect(`${chamber.id}: ${total}`).toBe(`${chamber.id}: ${TOTAL_SEATS}`);
      // Keys are how a party is followed across an election, so a repeat inside
      // one chamber would quietly merge two lists into one.
      const keys = chamber.parties.map((profile) => profile.key);
      expect(new Set(keys).size).toBe(keys.length);
      // Nobody starts already holding a majority; there would be no game.
      expect(Math.max(...chamber.parties.map((p) => p.baseSeats))).toBeLessThan(MAJORITY);
    }
  });

  it("opens on the chamber it was asked for, and plays out from there", () => {
    for (const chamber of CHAMBERS) {
      const state = newCampaign({ seed: 5, chamber: chamber.id, bots: ["greedy"] });
      expect(Object.keys(state.parties).sort()).toEqual(
        chamber.parties.map((profile) => profile.key).sort(),
      );
      expect(seatTotal(state)).toBe(TOTAL_SEATS);

      // The largest list leads, and the rival takes the largest one left.
      const ranked = [...chamber.parties].sort((a, b) => b.baseSeats - a.baseSeats);
      expect(state.players[0].partyKey).toBe(ranked[0].key);
      expect(state.players[1].partyKey).toBe(ranked[1].key);

      const outcome = playCampaign({ seed: 5, chamber: chamber.id, maxTurns: 200 });
      expect(seatTotal(outcome.state)).toBe(TOTAL_SEATS);
    }
  });

  it("falls back to the largest list when the chosen party is from another Knesset", () => {
    // Religious Zionism sat in the 25th, not the 23rd.
    const state = newCampaign({ seed: 6, chamber: "knesset-23", humanParty: "rz" });
    expect(state.players[0].partyKey).toBe("likud");
    expect(state.parties.rz).toBeUndefined();
  });

  it("defaults to a real election, and to one nobody could form a government on", () => {
    const asked = newCampaign({ seed: 7, chamber: DEFAULT_CHAMBER });
    const unasked = newCampaign({ seed: 7 });
    expect(unasked.parties).toEqual(asked.parties);

    // A matter of record rather than somebody's estimate, and a board where the
    // game is genuinely open: the largest list is nowhere near 61.
    const chamber = chamberById(DEFAULT_CHAMBER);
    expect(chamber.projected).toBeUndefined();
    expect(chamber.outcome?.formedBy).toBeNull();
    expect(Math.max(...chamber.parties.map((party) => party.baseSeats))).toBeLessThan(MAJORITY - 20);
  });

  it("covers every election from the first to the sitting Knesset", () => {
    const years = CHAMBERS.filter((chamber) => !chamber.projected).map((c) => c.year);
    expect(years.length).toBe(25);
    expect(Math.min(...years)).toBe(1949);
    expect(Math.max(...years)).toBe(2022);
    // Newest first, the projection ahead of them all.
    expect(CHAMBERS[0].projected).toBe(true);
    expect([...years].sort((a, b) => b - a)).toEqual(years);
  });
});

describe("setup", () => {
  it("seats the human in the party they picked and bots in the largest left", () => {
    const state = newCampaign({
      seed: 1,
      chamber: "knesset-25",
      humanParty: "shas",
      bots: ["greedy", "random"],
    });
    expect(state.players[0].partyKey).toBe("shas");
    expect(state.players[0].kind).toBe("human");
    expect(state.players[1].partyKey).toBe("likud");
    expect(state.players[2].partyKey).toBe("yesh-atid");
  });

  it("opens on a real hung Knesset with nothing promised", () => {
    const state = newCampaign({ seed: 2 });
    expect(seatTotal(state)).toBe(TOTAL_SEATS);
    for (const player of state.players) {
      expect(blocSeats(state, player.key)).toBeLessThan(MAJORITY);
      // Not all eighteen: every leader's own list has already claimed a share
      // of the cabinet in proportion to its seats.
      expect(freeMinistries(state, player.key).length).toBeLessThan(18);
      expect(freeMinistries(state, player.key).length).toBeGreaterThan(0);
      expect(
        valueOf(state, freeMinistries(state, player.key)) + reservedValue(state, player.key),
      ).toBe(171);
    }
    expect(state.phase).toBe("forming");
    expect(state.ministries.reduce((sum, m) => sum + m.budget, 0)).toBe(171);
    for (const party of Object.values(state.parties)) {
      expect(party.heldBy).toBeNull();
      expect(party.package).toEqual([]);
    }
  });

  it("is reproducible from a seed", () => {
    const a = playCampaign({ seed: 7788, maxTurns: 60 });
    const b = playCampaign({ seed: 7788, maxTurns: 60 });
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});

describe("turns", () => {
  it("does not mutate the state handed to it", () => {
    const state = newCampaign({ seed: 3 });
    const before = JSON.stringify(state);
    humanMove(state, greedyOffer(state, "you", new Rng(1)));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("resolves the whole turn once the human commits", () => {
    const state = newCampaign({ seed: 4 });
    const next = humanMove(state, greedyOffer(state, "you", new Rng(1)));

    expect(next.turn).toBe(state.turn + 1);
    expect(next.lastTurn).not.toBeNull();
    expect(next.offers).toEqual({});
    // Bots played too, without anything being written to the action log.
    expect(next.lastTurn?.parties.some((party) => Object.keys(party.bids).length > 0)).toBe(true);
  });

  it("never lets a player spend more than they hold", () => {
    for (const seed of SEEDS.slice(0, 15)) {
      const outcome = playCampaign({ seed, maxTurns: 80 });
      const state = outcome.state;
      for (const player of state.players) {
        const locked = Object.values(state.parties)
          .filter((party) => party.heldBy === player.key)
          .flatMap((party) => party.package);
        // No portfolio is ever promised to two parties at once.
        expect(new Set(locked).size).toBe(locked.length);
        expect(locked.length).toBeLessThanOrEqual(state.ministries.length);
      }
    }
  });

  it("keeps the Knesset at 120 seats through every card", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const outcome = playCampaign({ seed, maxTurns: 80 });
      expect(seatTotal(outcome.state)).toBe(TOTAL_SEATS);
    }
  });
});

describe("forming a government", () => {
  it("makes the first player past 61 prime minister", () => {
    let state = newCampaign({ seed: 5, humanParty: "likud", bots: ["random"] });
    for (let turn = 0; turn < 60 && state.phase === "forming"; turn += 1) {
      state = humanMove(state, greedyOffer(state, "you", new Rng(turn)));
    }
    if (state.phase === "forming") return; // this seed stalled; covered elsewhere

    expect(state.primeMinister).not.toBeNull();
    expect(blocSeats(state, state.primeMinister as string)).toBeGreaterThanOrEqual(MAJORITY);
    expect(state.phase).toBe("governing");
  });

  it("reports the turn that crowns a prime minister, and stays quiet once one sits", () => {
    let state = newCampaign({ seed: 5, humanParty: "likud", bots: ["random"] });
    let crowned: string | null = null;
    for (let turn = 0; turn < 60 && state.phase === "forming"; turn += 1) {
      const next = humanMove(state, greedyOffer(state, "you", new Rng(turn)));
      if (next.lastTurn?.swornIn) crowned = next.lastTurn.swornIn;
      state = next;
    }
    if (state.phase === "forming") return; // this seed stalled; covered elsewhere

    expect(crowned).toBe(state.primeMinister);

    // The very next governing turn does not crown anybody a second time.
    const after = humanMove(state, greedyOffer(state, "you", new Rng(999)));
    expect(after.lastTurn?.swornIn ?? null).toBeNull();
  });

  it("banks a year for the prime minister on every governing turn", () => {
    let state = newCampaign({ seed: 9, humanParty: "likud", bots: ["random"] });
    for (let turn = 0; turn < 80 && state.phase === "forming"; turn += 1) {
      state = humanMove(state, greedyOffer(state, "you", new Rng(turn)));
    }
    if (state.phase !== "governing") return;

    const pm = state.primeMinister as string;
    const before = state.players.find((player) => player.key === pm)?.yearsInPower ?? 0;
    state = humanMove(state, greedyOffer(state, "you", new Rng(99)));
    const after = state.players.find((player) => player.key === pm)?.yearsInPower ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});

describe("the term", () => {
  /**
   * A sworn-in government with nobody bidding against it.
   *
   * The auction is tested everywhere else; this block is about the calendar,
   * so the majority is handed over rather than bought and there is no rival to
   * take it away again.
   */
  const sworn = (seed: number): GameState => {
    const state = newCampaign({ seed, humanParty: "likud", bots: [] });
    for (const party of biddableParties(state)) {
      if (blocSeats(state, "you") >= MAJORITY) break;
      state.parties[party.key].heldBy = "you";
    }
    return humanMove(state, emptyOffer());
  };

  it("goes to the country when the term runs out, majority or not", () => {
    let state = sworn(4242);
    expect(state.phase).toBe("governing");
    expect(blocSeats(state, "you")).toBeGreaterThanOrEqual(MAJORITY);

    const parliament = state.parliament;
    for (let year = 0; year < TERM_LENGTH + 2 && state.parliament === parliament; year += 1) {
      state.emergencyUntil = 0; // the emergency card postpones a vote; not this test
      state = humanMove(state, emptyOffer());
    }

    // Still holding 61 and turned out anyway.
    expect(state.parliament).toBe(parliament + 1);
    expect(state.phase).toBe("forming");
    expect(state.primeMinister).toBeNull();
    expect(state.governmentYears).toBe(0);
    expect(seatTotal(state)).toBe(TOTAL_SEATS);
    expect(state.log.some((entry) => entry.text.includes("sat its"))).toBe(true);
  });

  it("sits the whole term and not a year less", () => {
    // The clock is set rather than counted in turns: a card can bank a year of
    // its own, which moves the calendar too. One card a turn is the most that
    // can land, so a government starting the turn on year zero cannot reach a
    // four-year term by the end of it, and one starting on its last year must.
    const early = sworn(4242);
    early.governmentYears = 0;
    early.emergencyUntil = 0;
    const afterEarly = humanMove(early, emptyOffer());
    expect(afterEarly.parliament).toBe(early.parliament);
    expect(afterEarly.phase).not.toBe("forming");

    // The last year has to be found rather than pinned to a seed. A card drawn
    // on this very turn can declare a national emergency, which freezes the
    // government and is a different rule working correctly -- the same reason
    // the coalition-agreement test below scans instead of trusting one board.
    let checkedLast = false;
    for (const seed of SEEDS) {
      const last = sworn(seed);
      if (last.phase !== "governing") continue;
      last.governmentYears = TERM_LENGTH - 1;
      last.emergencyUntil = 0;
      const afterLast = humanMove(last, emptyOffer());
      if (afterLast.emergencyUntil > afterLast.turn) continue;

      expect(afterLast.parliament).toBe(last.parliament + 1);
      expect(afterLast.phase).toBe("forming");
      checkedLast = true;
      break;
    }
    expect(checkedLast).toBe(true);
  });

  it("lets a tenth year in power beat the calendar", () => {
    const state = sworn(4242);
    expect(state.phase).toBe("governing");
    state.governmentYears = TERM_LENGTH - 1;
    state.players[0].yearsInPower = YEARS_TO_WIN - 1;

    const after = humanMove(state, emptyOffer());

    // The term and the tenth year land on the same turn; the record book wins.
    expect(after.winner).toBe("you");
    expect(after.phase).toBe("over");
    expect(after.parliament).toBe(state.parliament);
  });

  it("postpones the vote while an emergency holds", () => {
    const state = sworn(4242);
    expect(state.phase).toBe("governing");
    state.governmentYears = TERM_LENGTH;
    state.emergencyUntil = state.turn + 5;

    const after = humanMove(state, emptyOffer());

    expect(after.parliament).toBe(state.parliament);
    expect(["governing", "rebuilding"]).toContain(after.phase);
  });

  it("carries coalition agreements across the end of a term", () => {
    // A card that reopens the deal takes the portfolio back, which is a
    // different rule working and would be read here as this one failing. Rather
    // than pin a seed that happens to avoid the deck — the deck grows, and the
    // seed silently stops meaning what it meant — run seeds until one gets
    // through a whole term with the agreement undisturbed, and assert on that.
    let checked = false;
    for (const seed of SEEDS.slice(0, 40)) {
      let state = sworn(seed);
      if (!state.parties.shas) continue;
      state.parties.shas.heldBy = "you";
      state.parties.shas.package = ["defense"];

      const parliament = state.parliament;
      let disturbed = false;
      for (let year = 0; year < TERM_LENGTH + 2 && state.parliament === parliament; year += 1) {
        state.emergencyUntil = 0;
        state = humanMove(state, emptyOffer());
        const shas = state.parties.shas;
        if (!shas) break;
        // Only the election itself may move this agreement.
        if (state.parliament === parliament && (shas.heldBy !== "you" || shas.package.length !== 1)) {
          disturbed = true;
          break;
        }
      }
      if (disturbed || state.parliament !== parliament + 1) continue;
      if (!state.parties.shas) continue; // voted out of the chamber; covered elsewhere

      expect(state.parties.shas.heldBy).toBe("you");
      expect(state.parties.shas.package).toEqual(["defense"]);
      checked = true;
      break;
    }
    expect(checked).toBe(true);
  });
});

describe("elections", () => {
  it("re-rolls a full 120-seat Knesset around the baseline", () => {
    const rng = new Rng(31337);
    for (let round = 0; round < 200; round += 1) {
      const seats = rollSeats(rng, new Set(["likud"]));
      const total = Object.values(seats).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(TOTAL_SEATS);
      for (const count of Object.values(seats)) {
        expect(count).toBeGreaterThanOrEqual(ELECTORAL_THRESHOLD);
      }
      expect(seats.likud).toBeGreaterThanOrEqual(ELECTORAL_THRESHOLD);
    }
  });

  it("dissolves a Knesset that cannot produce a government", () => {
    // Nobody offers anything, so nobody can ever reach 61.
    let state = newCampaign({ seed: 606, humanParty: "likud", bots: [] });
    const parliament = state.parliament;

    // The president can hand a week back, so the deadline is a floor on how
    // long this takes rather than the exact number of turns.
    for (let week = 0; week < FORMING_DEADLINE * 4 && state.parliament === parliament; week += 1) {
      state = humanMove(state, { bids: [], withdrawFrom: [] });
    }

    expect(state.parliament).toBe(parliament + 1);
    expect(state.phase).toBe("forming");
    expect(state.week).toBe(1);
    expect(seatTotal(state)).toBe(TOTAL_SEATS);
    expect(state.log.some((entry) => entry.text.includes("dissolves itself"))).toBe(true);
  });

  it("swings each list around what it last won, not the opening board", () => {
    const state = newCampaign({ seed: 909, chamber: "knesset-25", humanParty: "likud", bots: [] });
    // Beat Labor down to a rump and take Likud off its opening 32.
    state.parties.labor.seats = 4;
    state.parties.likud.seats = 12;
    state.parties["yesh-atid"].seats = 46;

    // Over several elections a list drifting from 4 cannot climb back to the
    // 24 seats the opening board would have handed it every time.
    const rng = new Rng(909);
    let sawLargeLabor = false;
    for (let round = 0; round < 12; round += 1) {
      runElection(state, rng);
      if (!state.parties.labor) break;
      if (state.parties.labor.seats > 20) sawLargeLabor = true;
      expect(seatTotal(state)).toBe(TOTAL_SEATS);
    }
    expect(sawLargeLabor).toBe(false);
  });

  it("keeps a list invented by a split, and keeps a merged one folded", () => {
    // A seed where the invented list clears the threshold at the election. One
    // that falls below it leaves the chamber, which is the sibling test.
    const state = newCampaign({ seed: 56, humanParty: "likud", bots: [] });
    // A split card puts a party on the board that no profile knows about.
    state.parties["split-new-list"] = {
      key: "split-new-list",
      name: "New List",
      seats: 9,
      bloc: "centre",
      leftRight: 0,
      heldBy: "you",
      package: ["defense"],
      refusals: [],
    };
    state.parties.likud.seats -= 9;
    // A merger card took Labor-Gesher off the board entirely.
    delete state.parties["labor-gesher"];

    runElection(state, new Rng(56));

    // The invented list is re-elected like any other, deal intact.
    expect(state.parties["split-new-list"]).toBeDefined();
    expect(state.parties["split-new-list"].heldBy).toBe("you");
    expect(state.parties["split-new-list"].package).toEqual(["defense"]);
    // And the merged one does not come back from the profile table.
    expect(state.parties["labor-gesher"]).toBeUndefined();
    expect(seatTotal(state)).toBe(TOTAL_SEATS);
  });

  it("carries coalition agreements through an election", () => {
    const state = newCampaign({ seed: 707, humanParty: "likud", bots: [] });
    const partner = biddableParties(state).find((party) => party.key === "shas");
    expect(partner).toBeDefined();
    state.parties.shas.heldBy = "you";
    state.parties.shas.package = ["defense", "finance"];

    const seatsBefore = state.parties.shas.seats;
    runElection(state, new Rng(707));

    // The deal stands; only the arithmetic under it has moved.
    expect(state.parties.shas.heldBy).toBe("you");
    expect(state.parties.shas.package).toEqual(["defense", "finance"]);
    expect(freeMinistries(state, "you")).not.toContain("defense");
    expect(state.parties.shas.seats).toBeGreaterThan(0);
    expect(seatsBefore).toBeGreaterThan(0);
    expect(state.primeMinister).toBeNull();
    expect(state.phase).toBe("forming");
  });

  it("rearranges the ballot: lists merge, split and wind up", () => {
    // Over enough elections all three happen, and none of them ever leaves the
    // chamber at anything other than 120.
    const seen = { joint: 0, split: 0, fold: 0 };
    for (const seed of SEEDS.slice(0, 20)) {
      const state = newCampaign({ seed, chamber: "knesset-25", humanParty: "likud", bots: [] });
      const rng = new Rng(seed);
      for (let round = 0; round < 8; round += 1) {
        runElection(state, rng);
        expect(seatTotal(state)).toBe(TOTAL_SEATS);
        // The party the player leads is never merged away or wound up.
        expect(state.parties.likud).toBeDefined();
      }
      for (const entry of state.log) {
        if (entry.text.includes("joint run")) seen.joint += 1;
        if (entry.text.includes("register as")) seen.split += 1;
        if (entry.text.includes("winds itself up")) seen.fold += 1;
      }
    }
    expect(seen.joint).toBeGreaterThan(0);
    expect(seen.split).toBeGreaterThan(0);
    expect(seen.fold).toBeGreaterThan(0);
  });

  it("hands back the portfolios of a partner that merges or folds away", () => {
    // A list bought and paid for can stop existing on the ballot, and the
    // portfolios behind it have to come home when it does.
    for (const seed of SEEDS.slice(0, 30)) {
      const state = newCampaign({ seed, chamber: "knesset-24", humanParty: "likud", bots: [] });
      for (const party of Object.values(state.parties)) {
        if (party.key === "likud") continue;
        party.heldBy = "you";
        party.package = [];
      }
      // Everything the player holds is paid for out of one portfolio each.
      const hand = state.ministries.map((ministry) => ministry.key);
      Object.values(state.parties)
        .filter((party) => party.heldBy === "you")
        .forEach((party, index) => {
          if (hand[index]) party.package = [hand[index]];
        });

      runElection(state, new Rng(seed));

      // Nothing is locked with a party that is no longer on the board.
      const locked = Object.values(state.parties)
        .filter((party) => party.heldBy === "you")
        .flatMap((party) => party.package);
      expect(new Set(locked).size).toBe(locked.length);
      // Every portfolio is in exactly one of three places: promised to a
      // partner, kept by the player's own list, or free in their hand.
      const free = new Set(freeMinistries(state, "you"));
      const kept = new Set(reservedMinistries(state, "you"));
      const held = new Set(locked);
      for (const ministry of state.ministries) {
        expect(free.has(ministry.key) || kept.has(ministry.key) || held.has(ministry.key)).toBe(
          true,
        );
        expect(free.has(ministry.key) && held.has(ministry.key)).toBe(false);
      }
    }
  });

  it("gives a breakaway list its own seats, unbought", () => {
    // A split puts fresh mandates on the market: whatever the parent had agreed
    // to, the faction that walked out has agreed to nothing.
    let found = false;
    for (const seed of SEEDS.slice(0, 40)) {
      const state = newCampaign({ seed, chamber: "knesset-25", humanParty: "likud", bots: [] });
      for (const party of Object.values(state.parties)) {
        if (party.key !== "likud") party.heldBy = "you";
      }
      const rng = new Rng(seed);
      runElection(state, rng);
      for (const party of Object.values(state.parties)) {
        if (!party.key.includes("-split")) continue;
        found = true;
        expect(party.heldBy).toBeNull();
        expect(party.package).toEqual([]);
        expect(party.seats).toBeGreaterThanOrEqual(ELECTORAL_THRESHOLD);
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });

  it("returns the portfolios of a party voted out of the Knesset", () => {
    const state = newCampaign({ seed: 708, chamber: "knesset-25", humanParty: "likud", bots: [] });
    state.parties.labor.heldBy = "you";
    state.parties.labor.package = ["defense"];
    expect(freeMinistries(state, "you")).not.toContain("defense");

    // Run elections until Labor falls below the threshold and drops out.
    const rng = new Rng(4);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      runElection(state, rng);
      if (!state.parties.labor) break;
      state.parties.labor.heldBy = "you";
      state.parties.labor.package = ["defense"];
    }
    if (state.parties.labor) return; // never dropped out on this seed

    // Nothing is holding it any more. Whether it lands in the hand or is
    // claimed by the player's own list is the other rule's business.
    expect(
      Object.values(state.parties).some((party) => party.package.includes("defense")),
    ).toBe(false);
    expect([
      ...freeMinistries(state, "you"),
      ...reservedMinistries(state, "you"),
    ]).toContain("defense");
    expect(seatTotal(state)).toBe(TOTAL_SEATS);
  });

  it("goes back to the voters when a government falls", () => {
    const outcome = playCampaign({ seed: 4242, maxTurns: 300 });
    if (outcome.state.parliament > 1) {
      expect(outcome.state.log.some((entry) => entry.kind === "election")).toBe(true);
    }
    expect(seatTotal(outcome.state)).toBe(TOTAL_SEATS);
  });
});

describe("full campaigns", () => {
  it("never crashes and never leaves an illegal board", () => {
    for (const seed of SEEDS) {
      const outcome = playCampaign({ seed, maxTurns: 400 });
      const state = outcome.state;

      expect(["forming", "governing", "rebuilding", "over"]).toContain(state.phase);
      expect(seatTotal(state)).toBe(TOTAL_SEATS);
      expect(state.ministries.length).toBeGreaterThan(0);

      // Something must still be for sale on a board somebody is expected to go
      // on playing. A finished one is exempt: a campaign that runs long enough
      // can end with every seat in the two leaders' own lists, and demanding a
      // party for sale after the game is won is asking the board to stay
      // playable after there is nobody left to play it.
      if (state.phase !== "over") {
        expect(biddableParties(state).length).toBeGreaterThan(0);
      }

      if (state.phase === "over") {
        expect(state.winner).not.toBeNull();
        const winner = state.players.find((player) => player.key === state.winner);
        expect(winner?.yearsInPower).toBeGreaterThanOrEqual(YEARS_TO_WIN);
      } else {
        for (const player of state.players) {
          expect(player.yearsInPower).toBeLessThan(YEARS_TO_WIN);
        }
      }
    }
  });

  it("reaches a winner on most seeds inside a sane number of turns", () => {
    const outcomes = SEEDS.map((seed) => playCampaign({ seed, maxTurns: 400 }));
    const finished = outcomes.filter((outcome) => outcome.finished);
    expect(finished.length / outcomes.length).toBeGreaterThan(0.8);
  });

  it("only ever has one government at a time", () => {
    for (const seed of SEEDS.slice(0, 15)) {
      let state = newCampaign({ seed, bots: ["greedy", "random"] });
      const rng = new Rng(seed);
      for (let turn = 0; turn < 100 && state.phase !== "over"; turn += 1) {
        state = humanMove(state, greedyOffer(state, "you", rng));
        const majorities = state.players.filter(
          (player) => blocSeats(state, player.key) >= MAJORITY,
        );
        expect(majorities.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the deck", () => {
  it("only fires cards that belong to the phase in play", () => {
    for (const card of CARDS) {
      expect(card.phases.length).toBeGreaterThan(0);
      for (const phase of card.phases) {
        expect(["forming", "governing", "rebuilding"]).toContain(phase);
      }
    }
  });

  it("keeps some ideological cards, since that is the only thing reading politics", () => {
    expect(CARDS.filter((card) => card.ideological).length).toBeGreaterThanOrEqual(4);
  });

  it("has no card that cannot come up", () => {
    // The other two tests here are satisfied by a card that never fires: a
    // weight stuck at 0, or a play() that always returns null, passes both. A
    // card nobody ever sees is not a card, and the deck is the part of this
    // game most likely to grow a dead one, since a precondition is easy to
    // write and hard to notice going stale.
    //
    // Titles rather than ids because the log is what a player actually gets,
    // and a card that fires into a log line nobody can attribute is the same
    // problem wearing a different hat. Every title is distinct, and this holds
    // that too.
    const titles = CARDS.map((card) => card.title);
    expect(new Set(titles).size).toBe(titles.length);

    // Full coverage lands around thirty campaigns; sixty is the margin.
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      for (const entry of playCampaign({ seed, maxTurns: 400 }).state.log) {
        if (entry.kind === "card") seen.add(entry.text.split(" — ")[0]);
      }
    }

    for (const title of titles) {
      expect(seen.has(title), `${title}: in the deck and never drawn in 60 campaigns`).toBe(true);
    }
  });
});

describe("bots", () => {
  it("never break the rules of an offer", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const state = newCampaign({ seed });
      const rng = new Rng(seed);
      for (const bot of [greedyOffer, randomOffer]) {
        const offer = bot(state, "you", rng);
        expect(offer.bids.length).toBeLessThanOrEqual(OFFERS_PER_TURN);
        expect(validateOffer(state, "you", offer)).toEqual([]);
      }
    }
  });

  it("only offer portfolios they actually hold", () => {
    const state = newCampaign({ seed: 23 });
    const hand = new Set(freeMinistries(state, "you"));
    for (const bot of [greedyOffer, randomOffer]) {
      const offer = bot(state, "you", new Rng(23));
      for (const bid of offer.bids) {
        for (const key of bid.ministries) expect(hand.has(key)).toBe(true);
      }
    }
  });

  it("keep greedy out of parties that have ruled it out", () => {
    const state = newCampaign({ seed: 22 });
    const target = biddableParties(state)[0];
    target.refusals.push({ partyKey: state.players[0].partyKey, until: state.turn + 5 });

    const offer = greedyOffer(state, "you", new Rng(1));
    expect(offer.bids.map((bid) => bid.partyKey)).not.toContain(target.key);
  });
});

describe("standings", () => {
  it("ranks players by the mandates behind them", () => {
    const state = newCampaign({ seed: 30, humanParty: "likud" });
    const ranked = standings(state);
    expect(ranked[0].seats).toBeGreaterThanOrEqual(ranked[ranked.length - 1].seats);
    expect(ranked.reduce((sum, entry) => sum + entry.seats, 0)).toBeLessThanOrEqual(TOTAL_SEATS);
  });
});

describe("two people at one keyboard", () => {
  it("seats them both as players, and neither is for sale", () => {
    const state = newCampaign({
      seed: 40,
      chamber: "knesset-25",
      humanParty: "likud",
      bots: ["human"],
    });
    expect(state.players.map((player) => player.kind)).toEqual(["human", "human"]);
    expect(state.players[1].partyKey).toBe("yesh-atid");
    expect(biddableParties(state).map((party) => party.key)).not.toContain("yesh-atid");
  });

  it("waits for both offers before anything resolves", () => {
    let state = newCampaign({ seed: 41, humanParty: "likud", bots: ["human"] });
    expect(pendingSeat(state)?.key).toBe("you");

    const target = biddableParties(state)[0];
    let step = applyAction(state, {
      type: "offer",
      playerKey: "you",
      offer: { bids: [{ partyKey: target.key, ministries: ["education"] }], withdrawFrom: [] },
    });
    // Nothing has happened yet, and the screen now belongs to the other player.
    expect(step.resolved).toBeNull();
    expect(readyToResolve(step.state)).toBe(false);
    expect(pendingSeat(step.state)?.key).toBe("bot1");
    expect(step.state.turn).toBe(1);

    step = applyAction(step.state, {
      type: "offer",
      playerKey: "bot1",
      offer: { bids: [{ partyKey: target.key, ministries: ["defense"] }], withdrawFrom: [] },
    });
    expect(step.resolved).not.toBeNull();
    expect(step.state.turn).toBe(2);
    // Sealed and simultaneous: 18bn beats 17bn whichever seat moved first.
    expect(step.state.parties[target.key].heldBy).toBe("bot1");

    state = step.state;
    expect(pendingSeat(state)?.key).toBe("you");
  });

  it("plays a whole campaign out to a winner", () => {
    const rng = new Rng(9);
    let state = newCampaign({ seed: 42, humanParty: "likud", bots: ["human"] });
    for (let turn = 0; turn < 200 && state.phase !== "over"; turn += 1) {
      for (const seat of ["you", "bot1"]) {
        state = applyAction(state, {
          type: "offer",
          playerKey: seat,
          offer: greedyOffer(state, seat, rng),
        }).state;
      }
    }
    expect(state.phase).toBe("over");
    expect(state.winner).not.toBeNull();
  });

  it("hands the seat straight back when one of them passes", () => {
    const state = newCampaign({ seed: 43, humanParty: "likud", bots: ["human"] });
    const step = applyAction(state, {
      type: "offer",
      playerKey: "you",
      offer: { bids: [], withdrawFrom: [] },
    });
    // A pass is a move: it is still the other seat next.
    expect(pendingSeat(step.state)?.key).toBe("bot1");
  });
});

describe("what an election reports back", () => {
  /** Play a fresh campaign until the country votes, and hand back the result. */
  const firstVote = (seed: number): GameState => {
    let state = newCampaign({ seed, humanParty: "likud", bots: ["greedy"] });
    for (let turn = 0; turn < 400 && !state.lastElection; turn += 1) {
      state = applyAction(state, {
        type: "offer",
        playerKey: "you",
        offer: greedyOffer(state, "you", new Rng(seed + turn)),
      }).state;
    }
    return state;
  };

  it("records every list that stood, and what the country did to it", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const state = firstVote(seed);
      const vote = state.lastElection;
      expect(vote).not.toBeNull();
      if (!vote) continue;

      // The standings are the ballot paper, and the chamber they produced.
      const seated = Object.values(state.parties);
      expect(vote.standings.length).toBeGreaterThanOrEqual(seated.length);
      expect(vote.standings.reduce((sum, entry) => sum + entry.after, 0)).toBe(TOTAL_SEATS);

      for (const standing of vote.standings) {
        const seat = state.parties[standing.partyKey];
        // A list that sat is reported at the seats it actually holds; one that
        // did not is reported at zero rather than left out, because "out of the
        // chamber" is the single most important thing an election can say.
        expect(standing.after).toBe(seat?.seats ?? 0);
        expect(standing.before).toBeGreaterThan(0);
      }

      // Every list in the new chamber stood in the election that produced it.
      const stood = new Set(vote.standings.map((standing) => standing.partyKey));
      for (const party of seated) expect(stood.has(party.key)).toBe(true);

      expect(vote.parliament).toBe(state.parliament);
    }
  });

  it("measures the swing against what each list stood on, not what it used to be", () => {
    // A joint ticket is the case that separates the two. The merged list stood
    // on both partners added together, so reporting it against either one alone
    // would call an ordinary night a landslide.
    let found = 0;
    for (let seed = 1; seed <= 40 && found < 3; seed += 1) {
      const vote = firstVote(seed).lastElection;
      if (!vote) continue;
      for (const change of vote.ballot) {
        if (change.kind !== "union") continue;
        found += 1;
        const standing = vote.standings.find((entry) => entry.partyKey === change.key);
        expect(standing).toBeDefined();
        expect(change.seats).toBe(change.parts[0].seats + change.parts[1].seats);
        expect(standing!.before).toBe(change.seats);
        // And it is a list that did not exist in the chamber that just sat.
        expect(standing!.fresh).toBe(true);
        // Both partners are off the ballot: they ran as one.
        for (const part of change.parts) {
          expect(vote.standings.some((entry) => entry.partyKey === part.key)).toBe(false);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("reports a rearranged ballot as facts as well as prose", () => {
    let seen = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const state = firstVote(seed);
      const vote = state.lastElection;
      if (!vote || vote.ballot.length === 0) continue;
      seen += 1;

      // One log line per change, so the panel and the log cannot disagree about
      // how many things happened on the ballot paper.
      const lines = state.log.filter(
        (entry) => entry.turn === vote.turn && entry.kind === "election",
      );
      expect(lines.length).toBe(vote.ballot.length + 2);

      for (const change of vote.ballot) {
        expect(change.seats).toBeGreaterThan(0);
        if (change.kind === "breakaway") {
          // A breakaway is the one that puts unbought mandates on the market --
          // unless a later change on the same ballot takes it straight back
          // off. Two realignments can fire per election and the second may act
          // on the list the first invented, so a faction can walk out and fold
          // again before anybody votes.
          const after = vote.ballot.slice(vote.ballot.indexOf(change) + 1);
          const removedLater = after.some(
            (later) =>
              (later.kind === "wound-up" && later.key === change.key) ||
              (later.kind === "union" && later.parts.some((part) => part.key === change.key)),
          );
          const standing = vote.standings.find((entry) => entry.partyKey === change.key);
          if (removedLater) {
            expect(standing).toBeUndefined();
          } else {
            expect(standing?.fresh).toBe(true);
            expect(standing?.heldBy ?? null).toBeNull();
          }
        }
        if (change.kind === "wound-up") {
          // The list that folded is not on the ballot; its heir is.
          expect(vote.standings.some((entry) => entry.partyKey === change.key)).toBe(false);
          expect(vote.standings.some((entry) => entry.partyKey === change.heirKey)).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("the campaign log", () => {
  it("stamps every entry with the parliament it happened in", () => {
    const outcome = playCampaign({ seed: 88, maxTurns: 200 });
    const state = outcome.state;
    expect(state.log.length).toBeGreaterThan(0);

    let highest = 0;
    for (const entry of state.log) {
      expect(entry.parliament).toBeGreaterThanOrEqual(1);
      expect(entry.parliament).toBeLessThanOrEqual(state.parliament);
      // A parliament is only ever left forwards, so the log is already grouped:
      // the history view has to collect runs rather than decide boundaries.
      expect(entry.parliament).toBeGreaterThanOrEqual(highest);
      highest = entry.parliament;
    }
    expect(highest).toBe(state.parliament);
  });

  it("splits an election turn between the Knesset that fell and the one elected", () => {
    const outcome = playCampaign({ seed: 91, maxTurns: 200 });
    const state = outcome.state;
    if (state.parliament < 2) return;

    // The turn the country votes writes its opening line under the parliament
    // that fell and its closing line under the one just elected -- which is
    // where a reader would put them, and it is why the field is recorded rather
    // than worked out from the turn number afterwards.
    const votingTurns = new Set(
      state.log.filter((entry) => entry.kind === "election").map((entry) => entry.turn),
    );
    expect(votingTurns.size).toBeGreaterThan(0);

    let split = 0;
    for (const turn of votingTurns) {
      const onThatTurn = state.log.filter((entry) => entry.turn === turn);
      if (new Set(onThatTurn.map((entry) => entry.parliament)).size > 1) split += 1;
    }
    expect(split).toBeGreaterThan(0);
  });
});
