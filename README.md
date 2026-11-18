# 61

A turn-based browser game about buying a coalition government in the Knesset.

Sixty-one mandates buys you a government. **Ten years in office wins the campaign.** Every week
you spread eighteen ministries across the parties, everyone bids at once, and each party goes to
whoever offered it the most.

Written in TypeScript. The rules are a pure, deterministic module with no DOM dependency; React is
only the interface on top of it.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build      # type-check, then bundle to dist/
npm test           # engine, bots and interface
npm run typecheck  # tsc --noEmit
npm run balance    # does the game reward skill?
npm run playtest   # sit language models at the table (needs OPENROUTER_API_KEY)
```

## The game

### The board
By default the **22nd Knesset**, elected September 2019: Blue and White 33, Likud 32, Joint List
13, Shas 9, Yisrael Beiteinu 8, Yamina 7, UTJ 7, Labor-Gesher 6, Democratic Union 5. Nine lists,
the two largest a seat apart, and nobody within 28 of a majority. It is the default because it is
the one election in the file where the country played this exact game for three months and lost —
neither Netanyahu nor Gantz could reach 61, the Knesset dissolved itself, and everyone voted again.
You pick which list to lead; rivals take the largest you left. Your own party's mandates always
count toward your bloc.

**Or open on any Knesset ever elected.** All twenty-five real elections are on the setup screen,
from the first in January 1949 to the twenty-fifth in November 2022, each with the lists that
actually ran and the seats they actually won — Mapai 46 and Mapam 19 in 1949, the Alignment on 56
in 1969, the 48–47 deadlock of 1981, the fifteen-list Knesset of 1999.

Party rosters differ genuinely between elections, so each chamber carries its own list rather than
one shared table of seat counts. Keys are reused where the party is the same one, so Likud is
`likud` in every chamber it appears in. Every list sums to 120, no key repeats inside a chamber,
and nobody starts holding a majority; a test checks all three.

Only the *opening* board comes from the chamber. Once a campaign is running, every election is
re-drawn from what is standing at the time, so a chamber is the hand you are dealt rather than a
fact the rest of the game keeps consulting.

All twenty-six decide every campaign, and none is degenerate — but they are nothing like equally
skill-rewarding, and the reason is the shape of the board rather than the era:

| Board | Greedy beats random | Why |
|---|---|---|
| 18th (2009) | 100% | Kadima 28, Likud 27 — everything is on the market |
| Next election (projected) | 98% | ten lists, no bloc close to 61 |
| 25th (2022) | 98% | |
| 15th (1999) | 99% | fifteen lists, largest only 26 |
| 21st (2019) | 91% | 35 apiece — who draws which starts to matter |
| 13th (1992) | 87% | |
| 12th (1988) | 78% | |
| **22nd (2019)** — the default | 71.5% | 33–32, and seven mid-sized lists holding the balance |
| 11th (1984) | 70% | 44–41, and the rest is small change |
| 8th (1973) | 70% | Alignment 51 |
| 10th (1981) | 68% | 48–47, only 25 mandates on the market at all |
| 7th (1969) | 60% | the Alignment on 56 — five seats from a majority before anyone bids |

The pattern is that **skill lives in the seats that are for sale**. A board where the two big lists
start near 61 is decided mostly by who draws them; a board of ten or fifteen mid-sized lists is
decided by how you spend. That is the game working as intended, and it makes the older Knessets a
genuinely different exercise rather than a reskin.

There is also a **projected next election** on the setup screen — a hand-entered snapshot of
published polling averages, and the one board in the game where no bloc is anywhere near 61: Likud
27, Bennett 2026 25, Democrats 12, Yisrael Beiteinu 12, Otzma Yehudit 9, Shas 9, Yesh Atid 9, UTJ
7, Hadash-Ta'al 5, Ra'am 5. It makes an excellent board. It is the one board that is somebody's
estimate rather than a matter of record, though — frozen, not a live feed, and not a forecast; the
setup screen says so in those words, and a test asserts it does. That is why it is no longer what
the game opens on: what a new player is handed first should be a matter of record. Edit it — and
any of the rest — in `src/engine/parties.ts`.

**Two players by default** — you and one rival. A party somebody leads is never for sale, so each
extra rival takes seats off the market faster than it adds a contender: with two players there are
64 mandates to buy, with three only 50, and by four the smaller seats cannot reach 61 at all.

Every player holds their own eighteen ministries, worth 1–18bn — 171bn each, every turn.

### The bidding
Each turn you may sit down with **three parties**, and put as many portfolios in front of each as
you like. Everyone commits at once; the offers are sealed. Each party then takes the **best offer
on its table**, weighed against what it is already being paid.

The scarce thing is the diary, not the purse: what goes on a table is unlimited, but you only get
three tables, so the decision is who is worth a week rather than how much to spend.

### Elections rearrange the ballot
Before the country votes, the lists reorganise. Two lists of the same politics announce a **joint
run** and become one ticket; a faction **walks out** of a big list and registers on its own; a small
list **winds itself up** rather than face the voters, its mandates going to the nearest list
politically. About one of these happens per election.

They are not free. A joint ticket carries the bigger partner's coalition agreement, so whoever had
bought the smaller partner loses it — one of the few things that can undo a deal without the buyer
choosing to. A list that folds takes its buyer's investment with it. A breakaway starts unaligned
whatever its parent had agreed, which puts fresh mandates on the market that nobody has paid for.

The party you lead is never merged away or wound up: a campaign cannot strand somebody with no
party to lead.

Ministries handed over stay **locked with that party for as long as it stays bought**, so every
partner you add leaves you less to buy the next one with. Getting from 55 seats to 61 is the hard
part. The only way to move a portfolio once promised is to **pull out** of the party holding it,
which costs you the party.

An offer that loses costs nothing — you only pay on success.

Money is plentiful; **turns are the scarce resource**. That single restriction is what makes this a
negotiation rather than one decisive auction.

Ties break twice over. An incumbent defends — it only has to match a challenger, not beat one, and
a holder's top-up stacks on the package it has already paid. Where nobody holds the party, a tie
goes to the bidder with **more mandates already behind them**: a seat in the government most likely
to actually form is worth more than the same seat in one that never will, so success bandwagons.

### The two phases
- **Forming** — one turn is a week. Bid until somebody's bloc reaches 61; they become prime
  minister. A formateur gets **six weeks**: 28 days, plus the 14 the president usually grants. Fail
  and the Knesset dissolves itself and the country votes again. That deadline is also what keeps
  the game from deadlocking — portfolios stay locked with the partners that bought them, so without
  it well-funded players can each hold part of the board with none able to afford the rest.
- **Governing** — one turn is a year. The opposition bids to peel partners away, the prime minister
  defends, and each surviving year is banked. Drop below 61 and there is **one turn** to put it
  back together; fail and the government falls, the Knesset is re-elected, and the bidding starts
  over.

**A Knesset sits four years.** When the term is up the country votes whatever the arithmetic says,
and a government still holding 61 is turned out with the rest. That is the clock a prime minister
cannot bid their way out of: without it, a comfortable majority had no reason to spend another
shekel and the opposition had no date to aim at. A term that expires goes straight to the polls —
there is no repair turn, because the voters have arrived either way. A national emergency postpones
the vote for as long as it holds.

**An election does not tear up your agreements.** A party that keeps its place in the new Knesset
keeps whatever it was promised and whoever it was promised to; only the arithmetic underneath moves.
A list that falls below the threshold leaves the chamber, and the portfolios it was holding go back
to the player who paid them.

**Each election starts from the last one.** Every list swings around what it won at the previous
vote, not around the 2022 result the game opened on, so a defeat is carried forward instead of being
wiped clean by the next campaign. A party beaten down to five seats begins the next parliament on
five and has to climb back. Two things follow. A list voted out of the chamber is out for good —
nothing puts it back on the board, and a campaign ends with a median of eight parties rather than
ten. And drift compounds: over a long campaign the seats concentrate, so the largest party runs a
mean of 42 mandates by the end against the 32 it started with.

Ten banked years, across as many governments as it takes, wins.

### The cards
One card is drawn per turn, filtered to the phase in play: lists split, merge and register,
members cross the floor, portfolios are invented, abolished and re-priced by the courts, budgets
fail, ministers resign, partners reopen deals they have already signed, scandals break, emergencies
freeze the politics, the Knesset votes to dissolve itself, and parties draw red lines they will not
cross.

**One card a turn, not one each.** Dealing every player in meant a three-handed game took three
times the news, and the deck drowned out the bidding it was there to interrupt. One card is turned
over per round, by one player picked at random — which still matters, because a red line is drawn
against whoever turned it over.

**Ideology decides who will deal, never what they cost.** Every party carries its real bloc and a
left–right number, and the price is blind to both: a list that will sit with you is weighed on the
money alone. What politics decides is whether it will sit with you at all.

Two kinds of red line, honoured identically. A card writes a concrete party-to-party refusal that
lapses on a timer. A **standing** refusal is not written down anywhere: lists 16 or more apart on
the axis will not serve together, and an Arab list will not sit with a list at 6 or further right.
Those fall out of where the lists sit, so a board's geography matters before a single card has been
turned over — and they survive an election, a merger and a split without anything having to
remember to carry them across, which is why they are computed rather than stored.

A test scrambles politics inside the range where no standing refusal can arise and asserts no
bidding outcome changes, which is the part that has to stay true: the auction never prices a
party by its opinions.

### The hand
Everything else in the game resolves the week it is played. A bid is committed and settled in the
same turn; the deck is weather, in that it happens to you and is never yours to spend. Nothing on
the board was about *timing*, which is a strange gap in a game about coalitions.

A **wild** is the one thing a player keeps. One is dealt to each player at the top of every
parliament, at most two are held at once — drawing past the limit discards the draw — and it is
played on the sealed offer like everything else, so it is still spent blind against a rival
deciding the same thing in the same envelope. There are seven:

| | |
| --- | --- |
| **The whip** | No party you hold changes hands this turn, whatever it is offered. |
| **An ultimatum** | Strike every red line standing between you and one list. It does not come back. |
| **A reshuffle** | Take back the portfolios locked with one partner, and keep the partner anyway. |
| **The recess** | The house rises early. This year does not count against the term. |
| **The auction** | One list hears every offer fresh. What it already has counts for nothing. |
| **An exclusivity** | One list talks to nobody but you for two weeks. It still has to be paid. |
| **The extension** | The President grants another week. The house does not dissolve this time. |

All seven are levers on rules that already exist rather than new subsystems: one suspends the
auction's verdict, one strikes a red line, one draws a red line, one unlocks a package, one reopens
a package somebody else paid for, one stops the term clock and one stops the forming clock. A card
wanting a mechanic of its own is a sign it should be a law or a deck card instead.

They are spread across the game as deliberately as across the rulebook. The first four could only be
played from in front: you had to hold a party to whip it, hold a package to reshuffle it, hold the
government to send it home, so a player being outbid held cards they could not use. The auction and
the exclusivity are levers for the seat that is behind — the auction suspends both halves of the
incumbent's advantage on one list, since defending is otherwise cheaper than capturing twice over,
and the exclusivity takes a list off the market before a rival can bid. It plays on a list already
in your coalition too, where it is the whip narrowed to a single partner, though a player short of a
majority usually wants the capture. The extension is worth nothing on any board except the week the
Knesset would otherwise dissolve.

The exclusivity is written as ordinary carded refusals against every rival's own list, so it lapses
on the same timer every other refusal does and an ultimatum breaks it the same way. A card that
could not be answered by another card would be the only one in the deck.

They land before the auction resolves, which is what makes a wild a move rather than an
announcement — an ultimatum opens a list to the same turn's bid, and a reshuffle funds it, through
the same code path a withdrawal's freed portfolios take. The ultimatum is the only thing in the game
that removes a standing refusal, and because a standing refusal is computed from geography rather
than stored, it cannot be deleted: the strike is recorded against the player instead, and it is
one player's arrangement rather than a change of heart.

A card with no legal target cannot be played at all, rather than played to no effect. A wild is the
scarcest thing a player has, and spending one on nothing is a rule teaching the wrong lesson. It
still shows in the hand, greyed, because a whip that is absent while you hold no party never
teaches why.

Wilds narrowed the gap between the two thinking bots: shrewd beat greedy 65.8% with no cards and
has sat between 59% and 62% ever since — 59.2% with four cards, 61.9% with seven, 59.8% with seven
and a wider deck. Only the first of those moves is real. At 480 campaigns the 95% interval on a rate
near 60% is about ±4.4 points, so every later measurement is the same number, and an earlier draft of
this section that read a story into the wobble was reading noise. A
card is a fixed-size lever, so it is worth proportionally more to the weaker position, and the
deliberately conservative heuristic every seat shares (hold unless the board argues otherwise)
leaves less room for a better plan to show. The three later cards pull the other way because two of
them reward reading the board rather than holding it — knowing which rival's partner is worth
prising loose is the kind of judgement shrewd is better at than greedy.

## Layout

```
src/engine/     the rules, with no reference to the DOM
  parties.ts      the real Knesset, with bloc tags
  ministries.ts   the eighteen portfolios and their budgets
  allocation.ts   sealed offers, resolution, tie-breaking, withdrawal
  deck.ts         the card stack — the only consumer of ideology
  wilds.ts        the seven cards a player holds, and what they do to a turn
  campaign.ts     setup, the turn machine, elections, the win check
  rng.ts          seeded PRNG; the cursor lives in the game state
src/bots/       random, greedy and shrewd opponents, plus the language-model seat
  greedy.ts       biggest lists first, bought by mandates per billion
  shrewd.ts       the same turn, played against a rival rather than beside one
  llm.ts          the briefing, and reading a reply back into a legal move
src/net/        persistence: a campaign is a seed plus its moves
src/ui/         the interface
tests/          rules, bots, interface, plus a headless campaign harness
scripts/        balance probe, and the language-model playtest runner
```

## Persistence

Nothing about the live state is stored. A saved campaign is a seed, a setup, and an append-only
list of the moves you made — a few hundred bytes — replayed through the engine on load. Bots decide
from the same seeded stream, so their play never needs to be written down and a campaign running
through three parliaments still rebuilds exactly.

Each move is its own record keyed by turn number, so concurrent writes conflict instead of
clobbering. Storage sits behind the `Transport` interface, deliberately shaped like a hosted
document store, so pointing this at a shared backend is one more implementation of that interface.

Saved campaigns carry a `RULES_VERSION`; retuning the rules makes old logs replay as different
games, so a mismatch is refused rather than silently mangled.

## Playtesting with language models

`scripts/balance.ts` answers whether the game rewards a good algorithm. `scripts/playtest.ts`
answers a different question: whether the rules can be picked up and played by something that has
never seen them. It sits a model from [OpenRouter](https://openrouter.ai) in the human seat, gives
it the briefing in `src/bots/llm.ts` and the position each turn, and nothing else — no engine
internals, and never a rival's sealed offer.

```bash
$env:OPENROUTER_API_KEY = "sk-or-..."          # PowerShell; export on a shell
npm run playtest -- --list-models=sonnet       # what OpenRouter is actually serving
npm run playtest -- --models=openai/gpt-5-mini,anthropic/claude-sonnet-5 --games=2
```

Every turn is one API call and a campaign is tens of turns, so start with `--games=1` (that is
still two campaigns, one from each end of the table). Other flags: `--opponent=random`,
`--max-turns`, `--attempts`, `--temperature`, `--no-verdict`, `--quiet`. Reports land in
`playtests/`, which is git-ignored.

Three things come back that a bot harness cannot produce:

- **Which rules get broken**, counted by validation code. A model is never allowed to play an
  illegal move — the offer goes through the same `validateOffer` the interface uses, and the
  complaints go back for another try — so the tally is a direct reading of which rules are hard to
  follow from a plain description. Those are the rules the interface is probably explaining badly
  too.
- **What it thought it was doing**, in its own words, sampled through the campaign.
- **Its verdict on the game**, asked at the end of a campaign it just played: which rule was
  hardest to understand, which move was obviously right almost every turn, and the one change it
  would make.

The seat itself is pure and network-free (`src/bots/llm.ts`), so the whole loop is tested offline
with a canned model that speaks only JSON — including a campaign that plays identically whether the
greedy bot's move goes to the engine directly or through a round trip of model-shaped JSON.

## Balance

`scripts/balance.ts` plays every seed twice with the strategies swapped between the same two seats,
because the parties are wildly unequal and a naive comparison would mostly measure who drew Likud.

Re-measured with seven wilds in play: **greedy beats random 83.1%** over 480 campaigns, every one of
them reaching a winner and none hitting the turn cap, a campaign running a median of 18 turns across
a mean of 4.10 parliaments. Forming a coalition takes a median of 2 weeks — well inside the six-week
limit. Governments last a mean of 2.64 years, inside the four-year term, so the term is a ceiling on
the safe ones rather than the usual way one ends. **Shrewd beats greedy 59.8%.**

The evenly-matched tail is long and does not need shortening. Greedy against itself still forms in a
median of 2 weeks, and negotiations of ten weeks or more run at somewhere between 0 and 8 in 400.
That range is the finding rather than a sloppy way of quoting one: the first 400-seed set measured
after the deck grew returned 0 and a p99 of 9, and two further sets on the same code returned 7 and
8 with a p99 of 14 and 12. One seed set is not enough to measure a thin tail, and a single flattering
run of it is the easiest number in this file to fool yourself with.

Dropping one card at a time attributes the earlier thickening to the auction, which is the expected
shape rather than a regression — it is the only card that takes a list back off a rival, so a board
where two blocs both hold one takes longer to settle. Nothing in any 480-campaign run has failed to
reach a winner, and the forming deadline still dissolves a house that cannot agree, so the long tail
is the rule working rather than a stall to design out.

Two identical bots with identical money and no tiebreaker beyond the dice is exactly the position
that should be able to deadlock. The single worst board moves around between runs — 61 weeks on one
measurement, 24 on another, 9 on a third — which is what a thin tail of outliers looks like, and why
the distribution is quoted here instead of the maximum.

`scripts/tune.ts` is the other half of this, and the one to reach for when changing a bot rather than
a rule. It plays a matchup over four boards with the seats swapped — 3200 games a configuration —
sweeps one dial at a time, and prints a 95% interval beside every number so a three-point move is
visibly not a result. `--defender` chooses who is on the other side of the table, which turns out to
matter more than anything else in the file:

- **A dial tuned against a weak opponent can be tuned backwards.** Greedy's defensive spending
  measures best at *zero* against random — 80% against 76% — because random almost never poaches a
  partner, so every shekel spent defending is wasted by construction. Against shrewd, turning
  defence off costs eight points. Random is the wrong opponent for a defensive question.
- **A rule change silently re-tuned both bots.** Both price a bid as a fraction of the purse, and
  the home party's claim halved the purse, so both were quietly bidding half what they used to.
  Greedy's best aggression moved from 0.3 to 0.7, worth ten points against a fixed opponent; shrewd's
  from 0.3 to 0.55 once greedy stopped underbidding, worth nine.
- **Denial does nothing.** Swept from 0 to 2.5, shrewd's win rate moves between 61.4% and 62.5% —
  the width of the noise. Turning off one of that bot's three headline ideas is indistinguishable
  from turning it up fourfold, and the docstring in `shrewd.ts` now says so.
- **An exact portfolio picker is worth nothing.** Choosing the cheapest subset that clears a price,
  rather than piling on the small end until it does, measures dead level in all three matchups. The
  note in `src/bots/spend.ts` records it so it is not tried a third time.

The probe reads `DEFAULT_CHAMBER`, so it measures whichever board the game opens on; the table above
is that same probe run once per chamber.

Three findings from that probe are baked into the rules and the bot:

- **One offer a turn was the fix for pacing.** Under an earlier rule where players spread all
  eighteen portfolios across the whole board every turn, coalitions formed in a single turn even
  between competent players, and the campaign was just its governing phase.
- **Acquisition has to outrank defence in the bot.** A two-billion top-up on a party you already
  hold looks wonderfully efficient beside buying anything, so a version that ranked the two
  together polished its coalition forever and never grew it — and lost to random.
- **The deadline exists because the game deadlocked without it.** Three greedy players would
  stalemate for 200+ turns; with dissolution they settle inside 70. The six-week figure comes from
  Israeli practice rather than from tuning, and it happens to bite about as often as it should.
- **The deck was the biggest thing standing between skill and winning, until the offer limit
  changed.** Moving to one card a round cost greedy 73% to 68%, and the eleven new cards took it
  from 68% to 62%. Several of them — a partner reopening the deal, a general strike, a minister
  resigning, a dissolution vote — only fire at a sitting government, and the sitting government is
  usually the better player. That rubber band is still there; it is simply no longer the loudest
  thing in the measurement.
- **Every extra table costs skill.** Holding the bot fixed and sweeping tables against the bot's
  aggression, the pattern is flat and monotone: one table a turn is worth 89% to greedy, two 74%,
  three 60%, four 57% (all at the bot's best aggression setting). A turn that can court more of the
  board is a turn where a plan matters less, because a scattergun covers it too. Three is the
  current setting because it plays better than it measures; two is the number to reach for if the
  margin ever needs widening.
- **How hard the bot bids matters as much as the rule.** At three tables, bidding 30% of what a
  party is worth beats bidding 85% by nine points — paying to be sure on the first table is paying
  with the second and third. An earlier version that fell back to the *minimum* winning bid when it
  could not afford a proper one was worse still: the bot ranks candidates by mandates per billion,
  so a bare-minimum bid outranked every real one and it spent whole campaigns being outbid.
- **A ballot that never changes makes a long campaign repetitive.** Lists now merge, split and wind
  up between elections, about one event per election. It is the authentic thing — Israeli lists do
  not survive elections unchanged — and it also *raised* greedy from 60% to 69%: churn breaks up
  entrenched positions and puts unbought mandates on the market, which a player with a plan exploits
  better than one without.
- **A compounding baseline is what luck costs.** Carrying each election forward from the last drops
  greedy from 82% to 73%: a bad result now follows a player into the next parliament instead of
  being erased, so the same skill wins less often. It also concentrates the chamber, and in about
  one campaign in eighty leaves nobody able to reach 61 even by buying the whole board.
- **The four-year term is a ceiling, not the usual ending.** Governments average 2.64 years, so most
  still fall to the opposition rather than to the calendar; the term costs greedy nothing (79% to
  82%) and buys the one thing missing from a winning position — a date on which it has to be
  defended again.
- **Letting agreements survive an election cost greedy its dominance**, from 93% down to 79%,
  because a lucky bloc assembled by accident now persists instead of being wiped. That is a better
  game, not a worse one: the margin is still decisive and the recovery from a bad election is real.
