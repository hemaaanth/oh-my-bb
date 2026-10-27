/** Default usage limits. Zod-free so the app bundle can import it without the schema library. */
export const defaultLimits = {
  turnsPerHour: 30,
  turnsPerDay: 300,
  minutesPerTurn: 20,
  concurrentForks: 2,
};
