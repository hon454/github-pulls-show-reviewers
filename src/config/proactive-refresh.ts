export const PROACTIVE_REFRESH_ALARM_NAME =
  "github-pulls-show-reviewers.proactive-refresh";

export const PROACTIVE_REFRESH_PERIOD_MINUTES = 15;

// Must exceed the alarm period plus refresh latency so no expiry window slips
// between fires. Access tokens expire after ~8 hours, so refreshing 30 minutes
// early is not wasteful.
export const PROACTIVE_REFRESH_THRESHOLD_MS = 30 * 60 * 1_000;
