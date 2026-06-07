# E2E Test Setup Guide

## Test Database Configuration

Tests use a **separate database** to avoid interfering with development data.

### Architecture

- **Development Database**: PostgreSQL on port `5432` (database: `lai_db`)
- **Test Database**: PostgreSQL on port `5433` (database: `lai_test_db`)

### Quick Start

```bash
# 1. Start test database
npm run test:db:start

# 2. Run backend with test database (in separate terminal)
npm run test:backend:test

# 3. Run tests (in another terminal)
npm run test:e2e

# Or run everything with fresh database
npm run test:full
```

## Database Cleanup

### Automatic Cleanup (Recommended)

Tests automatically clear the database before each test run using `global-setup.ts`:
- Runs once before all tests
- Deletes all records from all tables
- Removes uploaded files
- Ensures clean state for every test run

### Manual Cleanup Options

```bash
# Reset test database (destroys volumes and recreates)
npm run test:db:reset

# Clear database via API (keeps container running)
curl -X DELETE http://localhost:9999/database/clear

# Stop test database
npm run test:db:stop
```

## Test Helpers

Use the provided test helpers for database operations:

```typescript
import { clearDatabase, getDatabaseInfo, verifyDatabaseIsEmpty } from '../test-helpers';

test.beforeAll(async ({ page }) => {
  // Clear database before test suite
  await clearDatabase(page);
});

test('should have empty database', async ({ page }) => {
  const isEmpty = await verifyDatabaseIsEmpty(page);
  expect(isEmpty).toBe(true);
});
```

## Running Specific Tests

```bash
# Run single test file
npx playwright test tests/e2e/projects/create-project.spec.ts

# Run specific test by name
npx playwright test -g "should create project"

# Run in specific browser
npx playwright test --project=chromium

# Run with UI mode
npm run test:e2e:ui

# Debug mode
npm run test:e2e:debug
```

## Environment Variables

Create `backend/.env.test` for test-specific configuration:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/lai_test_db
REDIS_URL=redis://localhost:6380
MONGODB_URL=mongodb://localhost:27018/lai_test
```

## Test Data Isolation

Each test should:
1. ✅ Use the global setup for database cleanup
2. ✅ Create its own test data
3. ✅ Be independent of other tests
4. ✅ Clean up after itself (optional, global setup handles this)

## Troubleshooting

### Tests failing with existing data?
```bash
# Clear and restart everything
npm run test:db:reset
# Wait for database to be ready
sleep 5
# Run tests
npm run test:e2e
```

### Backend connected to wrong database?
Check that backend is started with test database URL:
```bash
# Verify correct database
curl http://localhost:9999/database/connection | jq
# Should show: lai_test_db on port 5433
```

### Port conflicts?
```bash
# Check what's using the ports
lsof -i :5433  # Test database
lsof -i :9999  # Backend
lsof -i :8080  # Frontend

# Stop conflicting services
npm run test:db:stop
```

## Best Practices

1. **Always use test database** - Never run tests against development database
2. **Let global setup handle cleanup** - Don't manually clear in every test
3. **Create minimal test data** - Only create what the test needs
4. **Use meaningful test data** - Makes debugging easier
5. **Verify assumptions** - Check database state when tests fail

## CI/CD Integration

For CI pipelines:

```yaml
# .github/workflows/test.yml
- name: Start test database
  run: npm run test:db:start

- name: Wait for database
  run: sleep 10

- name: Run tests
  run: npm run test:e2e
  env:
    CI: true
```
