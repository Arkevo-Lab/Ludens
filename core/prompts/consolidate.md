Consolidate your experience using only file tools; do not interact with the
environment or invent observations.

Read your skills and memory. Check `ludens eval list` for the current evaluation
status of every workspace capability: only capabilities whose `@eval_capability`
is `verified` against the current `codeSHA` may be retained or promoted into
`skills/`. Unverified, stale, missing, or failed capabilities must either gain a
`@eval_capability` that passes `ludens eval run <id>`, or be removed from skills
until verified. Rewrite skills under the skill policy: resolve conflicting
versions in place, keep only reusable methods, and separate independent
capabilities with accurate descriptions. Update `memory/current.md` with the
latest actionable state and open questions. Do not move discarded experiment
histories into memory or other reference files; existing logs preserve them.

Briefly report changes and remaining uncertainty.
