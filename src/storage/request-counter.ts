import { getLocalStorage, setLocalStorage } from './storage-helpers';

const TOTAL_REQUESTS_KEY = 'mellowtel_total_requests';
const DAILY_REQUESTS_HISTORY_KEY = 'mellowtel_daily_requests_history';

interface DailyRequestsHistory {
  [date: string]: number; // date in YYYY-MM-DD format as key, count as value
}

interface RequestCountData {
  total: number;
  daily: number;
  dailyHistory: DailyRequestsHistory;
}

/**
 * Gets the current date as a string in YYYY-MM-DD format
 */
function getCurrentDate(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Gets the daily requests history object from storage
 */
function getDailyHistory(): DailyRequestsHistory {
  return (getLocalStorage(DAILY_REQUESTS_HISTORY_KEY) as DailyRequestsHistory) || {};
}

/**
 * Increments both total and daily request counters for the current date
 */
export function incrementRequestCount(): void {
  const today = getCurrentDate();
  
  // Increment total requests
  const totalRequests = (getLocalStorage(TOTAL_REQUESTS_KEY) as number) || 0;
  setLocalStorage(TOTAL_REQUESTS_KEY, totalRequests + 1);

  // Increment daily requests for today
  const dailyHistory = getDailyHistory();
  dailyHistory[today] = (dailyHistory[today] || 0) + 1;
  setLocalStorage(DAILY_REQUESTS_HISTORY_KEY, dailyHistory);
}

/**
 * Gets the total number of requests processed
 * @returns The total request count
 */
export function getTotalRequestCount(): number {
  return (getLocalStorage(TOTAL_REQUESTS_KEY) as number) || 0;
}

/**
 * Gets the number of requests processed today
 * @returns The daily request count for today
 */
export function getDailyRequestCount(): number {
  const today = getCurrentDate();
  const dailyHistory = getDailyHistory();
  return dailyHistory[today] || 0;
}

/**
 * Gets the number of requests processed on a specific date
 * @param date - The date in YYYY-MM-DD format
 * @returns The request count for that date
 */
export function getRequestCountForDate(date: string): number {
  const dailyHistory = getDailyHistory();
  return dailyHistory[date] || 0;
}

/**
 * Gets all daily request counts with their dates
 * @returns An object with dates as keys and counts as values
 */
export function getDailyRequestsHistory(): DailyRequestsHistory {
  return getDailyHistory();
}

/**
 * Gets request counts for a specific date range
 * @param startDate - Start date in YYYY-MM-DD format
 * @param endDate - End date in YYYY-MM-DD format
 * @returns An object with dates as keys and counts as values for the specified range
 */
export function getRequestCountsInRange(startDate: string, endDate: string): DailyRequestsHistory {
  const dailyHistory = getDailyHistory();
  const result: DailyRequestsHistory = {};
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  for (const date in dailyHistory) {
    const current = new Date(date);
    if (current >= start && current <= end) {
      result[date] = dailyHistory[date];
    }
  }
  
  return result;
}

/**
 * Gets both total and daily request counts along with the history
 * @returns An object containing total, daily (today), and dailyHistory
 */
export function getRequestCounts(): RequestCountData {
  return {
    total: getTotalRequestCount(),
    daily: getDailyRequestCount(),
    dailyHistory: getDailyHistory()
  };
}

/**
 * Resets both total and daily request counts (useful for testing or manual reset)
 */
export function resetRequestCounts(): void {
  setLocalStorage(TOTAL_REQUESTS_KEY, 0);
  setLocalStorage(DAILY_REQUESTS_HISTORY_KEY, {});
}

