// BUG: no dedupe.
export const jobs = [];
export function scheduleDaily(hour, minute, fn) {
  jobs.push({ hour, minute, fn }); // BUG: duplicates allowed
}
