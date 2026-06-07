#!/bin/bash

# E2E Test Runner with Database Management
# This script helps run tests with proper database setup

set -e

echo "🧪 LAI E2E Test Runner"
echo "====================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check for port conflicts FIRST and stop dev backend if running
if lsof -Pi :9999 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo -e "${YELLOW}⚠  Port 9999 is in use${NC}"
    echo "   Stopping development backend to free port for tests..."
    docker stop backend-backend-1 2>/dev/null || true
    sleep 2
    echo -e "${GREEN}✓${NC} Port 9999 is now free"
    echo ""
fi

# Function to check if service is running
check_service() {
    local port=$1
    local name=$2
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 ; then
        echo -e "${GREEN}✓${NC} $name is running on port $port"
        return 0
    else
        echo -e "${RED}✗${NC} $name is NOT running on port $port"
        return 1
    fi
}

# Parse arguments
RESET_DB=false
RUN_BACKEND=false
PLAYWRIGHT_ARGS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --reset-db)
            RESET_DB=true
            shift
            ;;
        --with-backend)
            RUN_BACKEND=true
            shift
            ;;
        *)
            PLAYWRIGHT_ARGS="$PLAYWRIGHT_ARGS $1"
            shift
            ;;
    esac
done

echo "Step 1: Database Setup"
echo "----------------------"

if [ "$RESET_DB" = true ]; then
    echo "🔄 Resetting test database (destroying volumes)..."
    npm run test:db:reset
    echo "⏳ Waiting for database to be ready..."
    sleep 8
    echo "⏳ Waiting for backend to be ready..."
    sleep 3
else
    echo "🚀 Starting test database..."
    npm run test:db:start
    echo "⏳ Waiting for database to be ready..."
    sleep 3
    echo "⏳ Waiting for backend to be ready..."
    sleep 2
fi

# Check if test database is running
if docker ps | grep -q lai-test-db; then
    echo -e "${GREEN}✓${NC} Test database is running"
else
    echo -e "${RED}✗${NC} Test database failed to start"
    exit 1
fi

echo ""
echo "Step 2: Service Check"
echo "---------------------"

# Check frontend
check_service 8080 "Frontend (Vite)" || {
    echo -e "${YELLOW}⚠${NC} Frontend not running. Start with: npm run dev"
    echo ""
}

# Check backend
if check_service 9999 "Backend (FastAPI)"; then
    echo -e "${YELLOW}⚠${NC} Verifying backend is using TEST database..."
    DB_INFO=$(curl -s http://localhost:9999/database/connection 2>/dev/null || echo "")
    if echo "$DB_INFO" | grep -q "lai_test_db"; then
        echo -e "${GREEN}✓${NC} Backend is using TEST database (lai_test_db)"
    else
        echo -e "${RED}✗${NC} Backend might be using WRONG database!"
        echo "   Expected: lai_test_db"
        echo "   Current DB info:"
        echo "$DB_INFO" | jq '.' 2>/dev/null || echo "   Could not retrieve DB info"
        echo ""
        echo "   To fix: Restart test stack:"
        echo "   ${YELLOW}npm run test:db:reset${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗${NC} Backend is not running"
    echo ""
    echo "   The test backend should start automatically with:"
    echo "   ${YELLOW}npm run test:db:reset${NC}"
    echo ""
    echo "   Or manually:"
    echo "   ${YELLOW}docker compose -f docker-compose.test.yml up -d${NC}"
    exit 1
fi

echo ""
echo "Step 3: Running Tests"
echo "---------------------"

echo "🧹 Global setup will clear test database before tests..."
echo "🧪 Running Playwright tests$PLAYWRIGHT_ARGS..."
echo ""

# Run tests
npx playwright test $PLAYWRIGHT_ARGS

TEST_EXIT_CODE=$?

echo ""
echo "====================="
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✓ Tests completed successfully!${NC}"
else
    echo -e "${RED}✗ Tests failed with exit code $TEST_EXIT_CODE${NC}"
    echo ""
    echo "Troubleshooting:"
    echo "  - View test report: npm run test:e2e:report"
    echo "  - Check backend logs: tail -f backend-test.log"
    echo "  - Reset database: npm run test:db:reset"
fi

exit $TEST_EXIT_CODE
