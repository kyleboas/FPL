function number(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function defensiveContributionThreshold(positionName) {
  if (positionName === "DEF") return 10;
  if (positionName === "MID" || positionName === "FWD") return 12;
  return null;
}

export function recentDefensiveContributionHitRate(rows, positionName) {
  const threshold = defensiveContributionThreshold(positionName);
  if (!threshold) return 0;

  const matches = rows.filter((row) => number(row.minutes, 0) > 0);
  if (!matches.length) return 0;

  const hits = matches.filter((row) => {
    const contribution = row.defensive_contribution !== null
      && row.defensive_contribution !== undefined
      && row.defensive_contribution !== ""
      ? number(row.defensive_contribution, 0)
      : number(row.clearances_blocks_interceptions, 0)
        + number(row.tackles, 0)
        + (positionName === "DEF" ? 0 : number(row.recoveries, 0));
    return contribution >= threshold;
  }).length;

  return hits / matches.length;
}
