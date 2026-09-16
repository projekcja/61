import { describe, expect, it } from "vitest";

import { greedyOffer, randomOffer, shrewdOffer } from "../src/bots";
import { resolveRound, validateOffer } from "../src/engine/allocation";
import { applyAction, newCampaign } from "../src/engine/campaign";
import { Rng } from "../src/engine/rng";
import type { GameState, Party } from "../src/engine/types";
import {
  FORMING_DEADLINE,
  blocSeats,
  emptyOffer,
  freeMinistries,
  refusalsAgainst,
  valueOf,
} from "../src/engine/types";
import {
  HAND_LIMIT,
  WILDS,
  applyWilds,
  canPlay,
  drawWild,
  legalPlays,
  preferredWild,
} from "../src/engine/wilds";

const setup = (seed = 11): GameState =>
  newCampaign({ seed, humanParty: "likud", bots: ["greedy"] });

/** A party nobody leads, which is what every card is played against. */
const spare = (state: GameState): Party => {
  const led = new Set(state.players.map((player) => player.partyKey));
  const party = Object.values(state.parties).find((candidate) => !led.has(candidate.key));
  if (!party) throw new Error("every chamber has a party for sale");
  return party;
};

/**
 * A party nobody leads *and* nobody has ruled this player out of.
 *
 * {@link spare} is enough for a card that does not care what the list thinks,
 * but a card about money has to be tested on a list that is actually willing to
 * take the money. A red line beats any bid, so a test that reached for a party
 * standing against likud would pass or fail on geography rather than on the
 * card it was written for.
 */
const open = (state: GameState, ...playerKeys: string[]): Party => {
  const who = playerKeys.length > 0 ? playerKeys : ["you"];
  const led = new Set(state.players.map((player) => player.partyKey));
  const party = Object.values(state.parties).find(
    (candidate) =>
      !led.has(candidate.key) &&
      who.every((playerKey) => refusalsAgainst(state, candidate, playerKey).length === 0),
  );
  if (!party) throw new Error("every list in the chamber has ruled one of these players out");
  return party;
};

/** Open the offers and settle the auction, exactly as a turn does. */
const settle = (state: GameState) => {
  const outcome = applyWilds(state);
  // Both of these are answers the auction needs and is handed nothing to find,
  // so the turn writes them to the board first. A test that forgets one is a
  // test of a card that was never played.
  state.whipped = outcome.whipped;
  state.exposed = outcome.exposed;
  return { outcome, results: resolveRound(state) };
};

describe("what the cards do", () => {
  it("keeps a whipped coalition whole against any bid", () => {
    const build = (whip: boolean) => {
      const state = setup();
      const party = spare(state);
      party.heldBy = "you";
      party.package = ["defense"];
      state.players[0].hand = whip ? ["whip"] : [];

      // Everything the rival has, against one portfolio. Money should win.
      const purse = freeMinistries(state, "bot1");
      expect(valueOf(state, purse)).toBeGreaterThan(valueOf(state, party.package));
      state.offers = {
        you: { bids: [], withdrawFrom: [], wild: whip ? { id: "whip" } : null },
        bot1: { bids: [{ partyKey: party.key, ministries: purse }], withdrawFrom: [] },
      };
      const { results } = settle(state);
      return results.find((result) => result.partyKey === party.key)!;
    };

    // The control matters more than the assertion: without the card the same
    // bid takes the party, so the card is what held it.
    expect(build(false).newHolder).toBe("bot1");
    expect(build(true).newHolder).toBe("you");
  });

  it("strikes a red line for good, and opens the list to the same turn's bid", () => {
    const state = setup();
    const party = spare(state);
    const rival = state.players[1];
    party.refusals = [
      { partyKey: "likud", until: state.turn + 10 },
      { partyKey: rival.partyKey, until: state.turn + 10 },
    ];
    expect(refusalsAgainst(state, party, "you")).not.toEqual([]);
    const against = refusalsAgainst(state, party, rival.key);
    expect(against).not.toEqual([]);

    state.players[0].hand = ["ultimatum"];
    state.offers = {
      you: { bids: [], withdrawFrom: [], wild: { id: "ultimatum", partyKey: party.key } },
    };
    settle(state);

    expect(refusalsAgainst(state, party, "you")).toEqual([]);
    // One player's arrangement, not a change of heart: the list still will not
    // sit with anybody else it had ruled out.
    expect(refusalsAgainst(state, party, rival.key)).toEqual(against);

    // Permanent, where the refusal it replaced would have lapsed on a timer.
    state.turn += 50;
    expect(refusalsAgainst(state, party, "you")).toEqual([]);
  });

  it("takes the portfolios back in a reshuffle and keeps the partner", () => {
    const state = setup();
    const party = spare(state);
    party.heldBy = "you";
    party.package = ["defense", "finance"];

    state.players[0].hand = ["reshuffle"];
    const offer = {
      bids: [],
      withdrawFrom: [],
      wild: { id: "reshuffle", partyKey: party.key },
    };
    // The freed portfolios fund this very turn, exactly as a withdrawal's do.
    expect(validateOffer(state, "you", { ...offer, bids: [] })).toEqual([]);

    state.offers = { you: offer };
    settle(state);

    expect(party.heldBy).toBe("you");
    expect(party.package).toEqual([]);
  });

  it("stops the clock for a recess without banking the year", () => {
    const play = (recess: boolean) => {
      const state = newCampaign({ seed: 4242, humanParty: "likud", bots: [] });
      state.phase = "governing";
      state.primeMinister = "you";
      state.governmentYears = 1;
      state.players[0].yearsInPower = 1;
      state.players[0].hand = recess ? ["recess"] : [];
      state.emergencyUntil = 0;
      const after = applyAction(state, {
        type: "offer",
        playerKey: "you",
        offer: { ...emptyOffer(), wild: recess ? { id: "recess" } : null },
      }).state;
      return after;
    };

    const stopped = play(true);
    const ran = play(false);
    expect(ran.governmentYears).toBe(2);
    expect(stopped.governmentYears).toBe(1);
    // A delay, not a gift: the year does not count toward winning either.
    expect(stopped.players[0].yearsInPower).toBe(1);
    expect(ran.players[0].yearsInPower).toBe(2);
  });

  it("takes a list back out to tender, so a paid-for package counts for nothing", () => {
    const build = (auction: boolean) => {
      const state = setup();
      const party = open(state);
      // A rival's partner, bought and paid for. Defending is meant to be
      // cheap: the package stacks, so an outsider has to beat the whole thing.
      party.heldBy = "bot1";
      party.package = freeMinistries(state, "bot1").slice(0, 3);

      const mine = freeMinistries(state, "you").filter(
        (ministry) => !party.package.includes(ministry),
      );
      const bid = [mine[0]];
      // The point of the control: this offer is genuinely the smaller one.
      expect(valueOf(state, bid)).toBeLessThan(valueOf(state, party.package));

      state.players[0].hand = auction ? ["auction"] : [];
      state.offers = {
        you: {
          bids: [{ partyKey: party.key, ministries: bid }],
          withdrawFrom: [],
          wild: auction ? { id: "auction", partyKey: party.key } : null,
        },
      };
      const { results } = settle(state);
      return results.find((result) => result.partyKey === party.key)!;
    };

    // Without the card the smaller offer loses to a package it never saw.
    expect(build(false).newHolder).toBe("bot1");
    expect(build(true).newHolder).toBe("you");
  });

  it("takes the incumbent's tie away with it, not only the package", () => {
    // The package half of the rule is what the test above measures. This is the
    // other half: an incumbent holds a tie by matching rather than beating, and
    // an exposed list no longer lets it. Both arms are built so the carried
    // package is worth nothing to anybody — the held list has an empty one —
    // which leaves the tie rule as the only thing left to decide the round.
    //
    // Underneath the incumbent's tie is the rule that a tie goes to the larger
    // bloc, so the seat holding the list has to be the smaller one for the
    // change to be visible at all. That is why this board seats the player on a
    // nine-seat list rather than on likud.
    const board = (): GameState =>
      newCampaign({ seed: 11, humanParty: "shas", bots: ["greedy"] });

    const build = (auction: boolean) => {
      const state = board();
      const led = new Set(state.players.map((player) => player.partyKey));
      const party = Object.values(state.parties).find(
        (candidate) =>
          !led.has(candidate.key) &&
          refusalsAgainst(state, candidate, "you").length === 0 &&
          refusalsAgainst(state, candidate, "bot1").length === 0 &&
          // Small enough that holding it still leaves this seat the underdog.
          blocSeats(state, "you") + candidate.seats < blocSeats(state, "bot1"),
      );
      if (!party) throw new Error("no open list on this board leaves the holder behind");
      party.heldBy = "you";
      party.package = [];

      // Equal money from both sides, which is the whole point. An unpromised
      // portfolio is on offer from every seat at once — it is spoken for only
      // when a bid carrying it wins — so the same one from both is the exact
      // tie the rule is about.
      const theirs = new Set(freeMinistries(state, "bot1"));
      const stake = freeMinistries(state, "you").find((ministry) => theirs.has(ministry));
      if (!stake) throw new Error("these two seats have no portfolio in common");
      expect(valueOf(state, [stake])).toBeGreaterThan(0);

      state.players[1].hand = auction ? ["auction"] : [];
      state.offers = {
        you: { bids: [{ partyKey: party.key, ministries: [stake] }], withdrawFrom: [] },
        bot1: {
          bids: [{ partyKey: party.key, ministries: [stake] }],
          withdrawFrom: [],
          wild: auction ? { id: "auction", partyKey: party.key } : null,
        },
      };
      const { results } = settle(state);
      return results.find((result) => result.partyKey === party.key)!;
    };

    // Equal money leaves the list exactly where it is, until the card takes the
    // tie away and the rule underneath hands it to the larger bloc.
    expect(build(false).newHolder).toBe("you");
    expect(build(true).newHolder).toBe("bot1");
  });

  it("does not punish a holder for naming a list it is offering nothing", () => {
    // An empty bid is legal only from the list's own holder, and it promises
    // nothing. It has to stay the no-op it reads as: an exposed list carries a
    // package worth zero, so counting the empty bid as a courtship would score
    // the round at nothing and hand the list to nobody — making the harmless
    // click strictly worse than staying silent.
    const build = (named: boolean) => {
      const state = setup();
      const party = open(state, "you", "bot1");
      party.heldBy = "you";
      party.package = freeMinistries(state, "you").slice(0, 2);

      state.players[1].hand = ["auction"];
      state.offers = {
        you: {
          bids: named ? [{ partyKey: party.key, ministries: [] }] : [],
          withdrawFrom: [],
        },
        bot1: { bids: [], withdrawFrom: [], wild: { id: "auction", partyKey: party.key } },
      };
      const { results } = settle(state);
      return results.find((result) => result.partyKey === party.key)!;
    };

    // Saying nothing and saying nothing out loud are the same move.
    expect(build(false).newHolder).toBe("you");
    expect(build(true).newHolder).toBe("you");
  });

  it("signs a list to an exclusive that shuts every rival out, then lapses", () => {
    const build = (exclusive: boolean) => {
      const state = setup();
      const party = open(state, "you", "bot1");
      const rival = state.players[1];

      state.players[0].hand = exclusive ? ["exclusivity"] : [];
      state.offers = {
        you: {
          bids: [],
          withdrawFrom: [],
          wild: exclusive ? { id: "exclusivity", partyKey: party.key } : null,
        },
        bot1: {
          bids: [{ partyKey: party.key, ministries: freeMinistries(state, rival.key).slice(0, 2) }],
          withdrawFrom: [],
        },
      };
      const { results } = settle(state);
      return { state, party, result: results.find((entry) => entry.partyKey === party.key)! };
    };

    // The rival's money is real and unopposed. Only the card stops it.
    expect(build(false).result.newHolder).toBe("bot1");

    const locked = build(true);
    expect(locked.result.newHolder).toBeNull();
    expect(locked.result.blocked).toContain("bot1");
    // Exclusive to somebody, not shut to everybody: the player who signed it
    // can still walk up and pay.
    expect(refusalsAgainst(locked.state, locked.party, "you")).toEqual([]);

    // A fortnight, and then the list takes calls again — it is an ordinary
    // carded refusal, not the ultimatum's permanent strike.
    locked.state.turn += 3;
    expect(refusalsAgainst(locked.state, locked.party, "bot1")).toEqual([]);
  });

  it("keeps the house standing for one more week and no longer", () => {
    const play = (extend: boolean) => {
      // Nobody else bidding, so nobody reaches 61 and the deadline is the only
      // thing that can happen.
      const state = newCampaign({ seed: 7, humanParty: "likud", bots: [] });
      state.week = FORMING_DEADLINE;
      state.players[0].hand = extend ? ["extension"] : [];
      return applyAction(state, {
        type: "offer",
        playerKey: "you",
        offer: { ...emptyOffer(), wild: extend ? { id: "extension" } : null },
      }).state;
    };

    const dissolved = play(false);
    const saved = play(true);
    expect(dissolved.parliament).toBe(2);
    expect(saved.parliament).toBe(1);
    expect(saved.phase).toBe("forming");

    // One week, not a reprieve. The card is gone and the deadline is still
    // there, so the next turn dissolves exactly as this one would have.
    expect(saved.players[0].hand).toEqual([]);
    const after = applyAction(saved, {
      type: "offer",
      playerKey: "you",
      offer: emptyOffer(),
    }).state;
    expect(after.parliament).toBe(2);
  });
});

describe("holding a hand", () => {
  it("deals one to every player and never more than a hand holds", () => {
    const state = setup();
    for (const player of state.players) {
      expect(player.hand.length).toBe(1);
    }

    // Drawing past the limit discards the draw rather than growing the hand,
    // which is what stops a patient player from arriving at the last
    // parliament with six cards and no decisions left to make.
    const rng = new Rng(5);
    const hand = state.players[0].hand;
    while (hand.length < HAND_LIMIT) drawWild(state, rng, "you");
    expect(hand.length).toBe(HAND_LIMIT);

    const held = [...hand];
    for (let draw = 0; draw < 5; draw += 1) {
      expect(drawWild(state, rng, "you")).toBeNull();
    }
    expect(hand).toEqual(held);
  });

  it("spends the card even when nothing on the board moves", () => {
    const state = setup();
    // A legal whip on a quiet week: nobody was coming for the coalition, so
    // the card protects nothing. It is gone all the same — a wild is spent on
    // the guess, not on the outcome.
    spare(state).heldBy = "you";
    state.players[0].hand = ["whip"];
    state.offers = { you: { bids: [], withdrawFrom: [], wild: { id: "whip" } } };
    settle(state);
    expect(state.players[0].hand).toEqual([]);
  });

  it("refuses a card that is not in hand, and does not spend it", () => {
    const state = setup();
    state.players[0].hand = ["whip"];
    const offer = { bids: [], withdrawFrom: [], wild: { id: "recess" } };

    const problems = validateOffer(state, "you", offer);
    expect(problems.map((problem) => problem.code)).toContain("unplayable-wild");

    state.offers = { you: offer };
    settle(state);
    expect(state.players[0].hand).toEqual(["whip"]);
  });

  it("offers no play for a card with nothing to play it against", () => {
    const state = setup();
    // Nothing held, so there is no coalition to whip and no package to recall.
    for (const party of Object.values(state.parties)) party.heldBy = null;
    state.players[0].hand = ["whip", "reshuffle"];
    expect(legalPlays(state, "you")).toEqual([]);
    expect(canPlay(state, "you", { id: "whip" })).toBe(false);
  });
});

describe("every seat can reach the cards", () => {
  // The order-paper bug was one seat holding a lever the other could not
  // reach. These say the same thing about wilds before it can happen twice.
  const strategies = [
    ["greedy", greedyOffer],
    ["shrewd", shrewdOffer],
    ["random", randomOffer],
  ] as const;

  it("never has a strategy produce a play it may not make", () => {
    for (const [, offer] of strategies) {
      const rng = new Rng(17);
      for (const seed of [3, 91, 613, 4242]) {
        let state = newCampaign({ seed, humanParty: "likud", bots: ["shrewd"] });
        for (let turn = 0; turn < 40 && state.phase !== "over"; turn += 1) {
          const move = offer(state, "you", rng);
          expect(canPlay(state, "you", move.wild ?? null)).toBe(true);
          state = applyAction(state, { type: "offer", playerKey: "you", offer: move }).state;
        }
      }
    }
  });

  it("has a board it will play every card in the deck on", () => {
    // The order-paper bug in the other direction, and the one the regression
    // above cannot see: a card with no branch in `preferredWild` is legal,
    // visible and forever unplayed by every seat a bot is sitting in. A test
    // that only asks whether the bots play *legally* passes that bug happily,
    // because a bot that never plays a card never plays an illegal one.
    //
    // So this asks the positive question instead. Each builder hands the
    // player exactly one card and the board that card was written for.
    const boards: Record<string, (state: GameState) => void> = {
      whip: (state) => {
        state.phase = "governing";
        state.primeMinister = "you";
        state.parties[state.players[0].partyKey].seats = 30;
        const held = spare(state);
        held.heldBy = "you";
        held.seats = 31; // 61 exactly: a majority worth defending and no more.
      },
      ultimatum: (state) => {
        state.parties[state.players[0].partyKey].seats = 30;
        const party = spare(state);
        party.seats = 10;
        party.refusals = [{ partyKey: "likud", until: state.turn + 10 }];
      },
      reshuffle: (state) => {
        state.parties[state.players[0].partyKey].seats = 30;
        const held = spare(state);
        held.heldBy = "you";
        // Everything the player owns is locked up with one partner, which is
        // the stalemate the card exists to break.
        held.package = state.ministries.slice(0, -1).map((ministry) => ministry.key);
        expect(freeMinistries(state, "you").length).toBeLessThanOrEqual(2);
      },
      recess: (state) => {
        state.phase = "governing";
        state.primeMinister = "you";
        state.parties[state.players[0].partyKey].seats = 40;
      },
      auction: (state) => {
        state.parties[state.players[0].partyKey].seats = 30;
        const party = spare(state);
        party.heldBy = "bot1";
        party.seats = 12;
      },
      exclusivity: (state) => {
        state.parties[state.players[0].partyKey].seats = 30;
        const party = spare(state);
        party.heldBy = null;
        party.seats = 12;
      },
      extension: (state) => {
        state.phase = "forming";
        state.week = FORMING_DEADLINE;
        state.parties[state.players[0].partyKey].seats = 55;
      },
    };

    // The gate. A card added without a board here fails before it ships.
    expect(Object.keys(boards).sort()).toEqual(WILDS.map((card) => card.id).sort());

    for (const card of WILDS) {
      const state = setup();
      boards[card.id](state);
      state.players[0].hand = [card.id];

      expect(legalPlays(state, "you").map((play) => play.id)).toContain(card.id);
      const play = preferredWild(state, "you");
      expect(play, `${card.id}: legal on this board and no seat will ever play it`).not.toBeNull();
      expect(play?.id).toBe(card.id);
    }
  });

  it("plays the ultimatum when a red line is the only thing in the way", () => {
    const state = setup();
    const party = spare(state);
    party.seats = 12;
    party.refusals = [{ partyKey: "likud", until: state.turn + 10 }];
    state.players[0].hand = ["ultimatum"];

    const play = preferredWild(state, "you");
    expect(play).toEqual({ id: "ultimatum", partyKey: party.key });
    for (const [, offer] of strategies.slice(0, 2)) {
      expect(offer(state, "you", new Rng(1)).wild).toEqual(play);
    }
  });
});
