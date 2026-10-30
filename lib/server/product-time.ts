export function startOfTodayInShanghai(now = new Date()): string {
  const chinaOffsetMilliseconds = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + chinaOffsetMilliseconds);
  const utcStartOfShiftedDay = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(utcStartOfShiftedDay - chinaOffsetMilliseconds).toISOString();
}
