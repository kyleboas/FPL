import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  defensiveContributionThreshold,
  recentDefensiveContributionHitRate,
} from "../autoresearch-fpl/defensive-contribution.mjs";

test("uses official defensive-contribution thresholds by position", () => {
  assert.equal(defensiveContributionThreshold("DEF"), 10);
  assert.equal(defensiveContributionThreshold("MID"), 12);
  assert.equal(defensiveContributionThreshold("FWD"), 12);
  assert.equal(defensiveContributionThreshold("GK"), null);
});

test("calculates recent hit rate from the official aggregate", () => {
  const rows = [
    { minutes: 90, defensive_contribution: 9 },
    { minutes: 90, defensive_contribution: 10 },
    { minutes: 45, defensive_contribution: 12 },
    { minutes: 0, defensive_contribution: 15 },
  ];

  assert.equal(recentDefensiveContributionHitRate(rows, "DEF"), 2 / 3);
  assert.equal(recentDefensiveContributionHitRate(rows, "MID"), 1 / 3);
});

test("falls back to component stats when the aggregate is absent", () => {
  const defenderRows = [
    { minutes: 90, clearances_blocks_interceptions: 8, tackles: 2, recoveries: 7 },
  ];
  const midfielderRows = [
    { minutes: 90, clearances_blocks_interceptions: 5, tackles: 2, recoveries: 5 },
  ];

  assert.equal(recentDefensiveContributionHitRate(defenderRows, "DEF"), 1);
  assert.equal(recentDefensiveContributionHitRate(midfielderRows, "MID"), 1);
  assert.equal(recentDefensiveContributionHitRate(midfielderRows, "GK"), 0);
});

test("vendors defensive contributions from the pinned historical source", async () => {
  const url = new URL(
    "../autoresearch-fpl/historical-defensive-contributions.json",
    import.meta.url,
  );
  const snapshot = JSON.parse(await readFile(url, "utf8"));

  assert.equal(
    snapshot._source.commit,
    "b446cf27a0931a5ef91a45bb7e70d980600474d9",
  );
  assert.deepEqual(snapshot._source.completed_gameweeks, [1, 33]);
  assert.equal(Object.keys(snapshot.gameweeks).length, 33);
  assert.ok(
    Object.values(snapshot.gameweeks).some((gameweek) => Object.keys(gameweek).length > 200),
  );
});
