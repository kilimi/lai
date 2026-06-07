/**
 * Format a duration between two timestamps as a human-readable string.
 * @param start - ISO timestamp string for start time
 * @param end - Optional ISO timestamp string for end time (defaults to now)
 * @returns Formatted duration string (e.g., "1h 30m", "45m 12s", "30s")
 */
export function formatDuration(start: string, end?: string): string {
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date();
  const duration = endDate.getTime() - startDate.getTime();
  
  const hours = Math.floor(duration / (1000 * 60 * 60));
  const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((duration % (1000 * 60)) / 1000);
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
