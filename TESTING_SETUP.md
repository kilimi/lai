# Testing Setup Summary

## ✅ What's Been Set Up

Your project now has **complete test database isolation**:

### 1. **Separate Test Database**
- **Development DB**: `lai_db` on port `5432`
- **Test DB**: `lai_test_db` on port `5433`
- Different databases = no interference between dev and test data

### 2. **Automatic Database Cleanup**
- `tests/global-setup.ts` - Runs before ALL tests
- Clears database automatically
- Removes all test data
- Ensures clean state every test run

### 3. **Test Helpers**
- `tests/test-helpers.ts` - Utility functions
  - `clearDatabase()` - Manual database clearing
  - `getDatabaseInfo()` - Check database state
  - `verifyDatabaseIsEmpty()` - Verify clean state

### 4. **Easy Test Scripts**

```bash
# Quick start - just run tests
./run-tests.sh

# Reset database first (recommended for clean slate)
./run-tests.sh --reset-db

# Auto-start backend with test database
./run-tests.sh --with-backend

# Combine options
./run-tests.sh --reset-db --with-backend

# Pass Playwright arguments
./run-tests.sh --project=chromium -g "create project"
```

## 📋 Quick Start Guide

### First Time Setup
```bash
# 1. Start test database
npm run test:db:start

# 2. Start backend with test database (separate terminal)
npm run test:backend:test

# 3. Start frontend (another terminal)  
npm run dev

# 4. Run tests
npm run test:e2e
```

### Using the Helper Script (Easier!)
```bash
# Does everything for you
./run-tests.sh --reset-db --with-backend

# Then just run tests normally
npm run test:e2e
```

## 🎯 Available Commands

### Database Management
```bash
npm run test:db:start    # Start test database
npm run test:db:stop     # Stop test database
npm run test:db:reset    # Reset (destroys all data)
npm run test:full        # Reset DB + run tests
```

### Backend
```bash
npm run test:backend:test  # Run backend with test DB
```

### Testing
```bash
npm run test:e2e           # Run all tests
npm run test:e2e:ui        # Run with UI mode
npm run test:e2e:headed    # Run with browser visible
npm run test:e2e:debug     # Run in debug mode
npm run test:e2e:report    # View last test report
```

## 🔍 How It Works

### Before Tests Run
1. **Global Setup** (`global-setup.ts`) executes once
2. Calls `DELETE /database/clear` API endpoint
3. Database is wiped clean
4. Tests start with empty database

### During Tests
- Each test creates its own data
- Tests are independent
- No data from previous tests

### After Tests
- Database can be reset for next run
- Or keep data for debugging
- Your choice!

## 🛠 Troubleshooting

### "Tests are failing with existing data"
```bash
# Reset everything
npm run test:db:reset
./run-tests.sh --reset-db
```

### "Backend is using wrong database"
```bash
# Check current database
curl http://localhost:9999/database/connection | jq

# Should show:
# {
#   "database_name": "lai_test_db",
#   "database_type": "PostgreSQL",
#   "database_host": "localhost"
# }

# If wrong, restart backend with:
npm run test:backend:test
```

### "Port already in use"
```bash
# Check what's using ports
lsof -i :5433  # Test database
lsof -i :9999  # Backend
lsof -i :8080  # Frontend

# Kill if needed
kill -9 <PID>
```

## 📝 Best Practices

1. ✅ **Always use test database for tests**
   - Never run tests against development database
   
2. ✅ **Let global setup handle cleanup**
   - Don't manually clear in every test
   - Only clear if testing specific scenarios

3. ✅ **Create minimal test data**
   - Only create what the test needs
   - Faster tests = better developer experience

4. ✅ **Use meaningful names**
   - Makes debugging easier
   - Example: `Test AI Project` not `Project 1`

5. ✅ **Verify assumptions**
   - Use test helpers to check state
   - Don't assume database state

## 📚 Documentation

- **Full Guide**: [tests/TEST_SETUP.md](tests/TEST_SETUP.md)
- **Test Helpers**: [tests/test-helpers.ts](tests/test-helpers.ts)
- **Global Setup**: [tests/global-setup.ts](tests/global-setup.ts)
- **Example Test**: [tests/e2e/projects/create-project.spec.ts](tests/e2e/projects/create-project.spec.ts)

## 🎉 You're Ready!

Your tests now have:
- ✅ Separate test database
- ✅ Automatic cleanup before each run
- ✅ Easy-to-use helper scripts
- ✅ Complete isolation from dev data

Happy testing! 🚀
