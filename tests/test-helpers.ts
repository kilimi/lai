import { Page } from '@playwright/test';

/**
 * Helper to clear database before a test or test suite
 */
export async function clearDatabase(page: Page) {
  const apiUrl = process.env.TEST_API_URL || 'http://localhost:9999';
  
  const response = await page.request.delete(`${apiUrl}/database/clear`);
  
  if (!response.ok()) {
    throw new Error(`Failed to clear database: ${response.status()}`);
  }
  
  return await response.json();
}

/**
 * Helper to get database info
 */
export async function getDatabaseInfo(page: Page) {
  const apiUrl = process.env.TEST_API_URL || 'http://localhost:9999';
  
  const response = await page.request.get(`${apiUrl}/database/info`);
  
  if (!response.ok()) {
    throw new Error(`Failed to get database info: ${response.status()}`);
  }
  
  return await response.json();
}

/**
 * Helper to verify database is empty
 */
export async function verifyDatabaseIsEmpty(page: Page) {
  const info = await getDatabaseInfo(page);
  return info.database_info.total_records === 0;
}
