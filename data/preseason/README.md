# Preseason data

`2026-27.json` is generated from completed Premier League preseason fixtures returned by API-Football. It contains only normalized player records and coverage metadata. The root-installed broker keeps authenticated raw responses in the root-only `/var/cache/fpl-preseason-api/` directory.

The checked-in `player-overrides.json` is the manual collision/transfer map. Keys may be `api-football-player:<id>`, a normalized player name, or `normalized name::normalized team name`; values are current FPL player IDs. Team overrides map a current FPL team name to its API-Football team name.

Attribution: Data provided by [API-Football](https://www.api-football.com/).
