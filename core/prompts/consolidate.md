Consolidate your experience using only file tools; do not interact with the
environment or invent observations.

Read your skills and memory. Use the current capability evaluation catalog
supplied below: if a capability binds an `@eval_capability` (or is marked
`adapting`), retain or promote it into `skills/` only when it is `verified`
against the current `codeSHA`, and remove `unverified`, `stale`, `adapting`, or
`failed` entries from skills until verified. Capabilities without a bound eval
(`missing`, such as live device-action macros) may be retained or promoted when
proven useful in live runs. Do not edit capability or eval source during this
file-only turn; record needed changes, `adapting` counterexample records, any
sim-to-real gaps or 30 Hz `.ludens/timeline/` replay slices (`record_window` /
`around=<record-id>`) needed to upgrade the Critic (`eval_env` surrogate
environment or test set) before iterating the Actor (`@capability`), and
`ludens eval run <id>` commands in `memory/current.md` for the next execution
turn.
Rewrite skills under the skill policy: resolve conflicting
versions in place, keep only reusable methods, and separate independent
capabilities with accurate descriptions. Update `memory/current.md` with the
latest actionable state and open questions. Do not move discarded experiment
histories into memory or other reference files; existing logs preserve them.

Briefly report changes and remaining uncertainty.
