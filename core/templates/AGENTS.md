# Workspace

Use this as a normal coding workspace. Write programs, collect data, build training
environments, train models, and install dependencies as needed.

- `baseware.json`: device schemas. Discover and invoke capabilities with `ludens controller list` and `ludens controller <id> --help`, or Python's `ludens_tools.Client`. Pass the declared parameter object with `--args` or the API.
- Python functions compose through normal imports. `@capability` marks sensing or action functions; add `@record` to save a result envelope to the shared timeline. Use task packages and `ludens bench --help` for evaluations; a Shiori-managed Python program can register evidence with `ludens_tools.current_trial()`.
- `perception.py:Perception`: persistent `sample()` samples at `sample_hz` (default 30; tune as needed); mark it with `@capability` and `@record` to retain observations. Load changes with `ludens perception reload`. The loop reads the latest; `observe` / `ludens observe --help` can inspect earlier records or another capability.
- `action.py:Action`: persistent `step()` runs during auto at `step_hz` (default 30); mark it with `@capability`, optionally `@record`. Use `Client.observe()` for history and `ludens action status/reload/stop` for lifecycle. Stop/reload clears current device inputs; step errors stop the loop.
- `skills/<name>/SKILL.md`: reusable methods, with `name` and `description` frontmatter. `memory/current.md`: current state and next steps.
- `.ludens/timeline/`: shared recorded capability results; other components reference them. `logs/`: run and benchmark records. `ludens.json`: launch settings. Organize other files as needed.

Keep the supplied control epoch unchanged; human takeover ends device access.
