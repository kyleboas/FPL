# Preseason data

`2026-27.json` is a sanitized, manually maintained dataset of completed 2026-27 preseason matches. Every record points to a canonical official club match-report URL and report date through `source_id`/`source_url`.

`official-sources.json` is the human-maintained source manifest. It records the official club, completed match date, report date, URL, verified fact types, and the rule that total minutes are not inferred from substitution times.

Records are mapped to current FPL player IDs and contain lineup/start evidence. `minutes`, `goals`, and `assists` are `null` when the official report does not explicitly publish that fact. `entered_at_minute` and `substituted_at_minute` preserve published substitution timing without turning it into an inferred total. Coverage is deliberately partial: the dataset is not a season-wide or team-wide completeness claim.

`player-overrides.json` is reserved for reviewed source-name/team ambiguities. It is empty for this collection because the transcribed current-FPL names had no unresolved collision; the manual mapping remains reviewable in each record's `fpl_player_id` and source evidence.

Attribution: facts manually transcribed from the canonical official Chelsea FC and Liverpool FC match-report pages listed in `official-sources.json`. No API-Football data or third-party API is used.
