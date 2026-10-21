---
section: Fixed
---

The eval harness canary now closes part (a) of the known bypasses (#468). It
records every own property and the prototype of every standard built-in, not a
hand-picked list (the ECMAScript globals enumerated from a fresh realm, the
iterator and generator intrinsics, and the jsdom and Node prototypes and
constructors), and it checks them from inside the hidden tests: chai's config
reads on every assertion and verdict become non-configurable accessors that
compare the record, so a matcher patched and restored inside one test (in a
microtask, or by hooks registered after the canary's own) is caught. Its
behavioural probes run from inside the hidden tests and from a canary test in
every hidden-test directory, so a cheat that checks its caller cannot spare
them. The hidden tests' own spies, stubs and fake timers are told apart; the
whole unit tier passes under it. A new self-check in the default gate
(`evals/maintainer/canary-live.test.ts`) replays both bypasses and the in-test
patch on a fixture repository and requires a fail. Residual risks stay
documented in `evals/maintainer/README.md`, and the paid agent stays disabled
until the operator accepts them.
