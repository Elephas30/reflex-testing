# Reflex Testing — Task 3 (Maina)

Standalone edge-case and trade-off evidence suite. This is its own
project with its own `package.json` — it does not import, require, or
share any files with `reflex-backend` or `reflex-frontend`, so there is
no conflict risk with Domisiano's or Genesis's work. It only talks to
the live backend over plain HTTP, the same way any real client would.

## What this proves, and why each test matters for the panel

The Readiness Sprint rubric says the panel draws questions from 4
categories. This suite is built to hand you real evidence for two of
them directly — **Edge cases** and **Trade-offs** — so you're not
guessing what the panel might ask.

| Test | Proves | Panel category |
|---|---|---|
| Happy path + real QR decode | The full lifecycle actually works, using a real decoded QR image (not a database shortcut) | Architecture |
| Wrong QR token rejected | A fake/guessed token cannot fake a delivery confirmation | Edge cases |
| Confirm before pickup blocked | Stages can't be skipped out of order | Edge cases |
| Duplicate confirmation is idempotent | Scanning the same QR twice (or a late/duplicate callback) doesn't double-process | Edge cases |
| Rider can't touch another rider's delivery | Access control actually enforced, not just assumed | Edge cases |
| Can't reassign an already-assigned request | Prevents a dispatcher double-booking a job | Edge cases |
| Can't skip to out-for-delivery without pickup | Same idea as above, different transition | Edge cases |
| Public tracking leaks no internal IDs | The no-login customer tracker doesn't expose retailerId/riderId/qrToken | Trade-offs (security boundary) |
| Unknown tracking code → clean 404 | No stack trace or 500 leaks to a customer typing a wrong code | Edge cases |
| Concurrent double-assignment race | **"What happens when two things happen at once"** — fires two assignment requests at the exact same instant, confirms exactly one wins | Edge cases (this is the literal example the brief gives) |

## Run it

```
npm install
cp .env.example .env
# edit .env to point at wherever reflex-backend is actually running
npm test
```

Needs the backend running first (locally or on Render) — this suite
has nothing to test against otherwise.

## Turning this into your trade-off log entries

Each test's PASS/FAIL line plus its detail line is screenshot-ready
evidence. For the **"acceptable because…"** format the log requires,
here's how these map:

- If **all 10 pass**: that's not "nothing to write" — it's evidence you
  can cite directly ("we deliberately tested the two-things-at-once
  case rather than assuming it was fine — see attached run").
- If **any fail**: that's a real, documented weak point — write it up
  honestly as "what it is → why we accepted it → what we'd do with more
  time," using the actual failing output as the "what it is."

## Known limitations of this test suite itself (be upfront about these too)

- **In-memory backend under test**: since the backend resets on
  restart, these tests assume a freshly started server — running them
  twice in a row against the same running instance is fine (each test
  creates its own fresh request), but don't expect state from a
  previous session to carry over.
- **No load/stress testing**: the concurrency test fires exactly 2
  simultaneous requests — it proves the race is handled correctly at
  small scale, not under real concurrent load. Worth naming as a
  deferred item if asked "did you test this under load?"
- **Assumes the seeded demo accounts exist** — if anyone changes the
  demo passwords in `reflex-backend`, update `ACCOUNTS` in
  `test-edge-cases.mjs` to match.
