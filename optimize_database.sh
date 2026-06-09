#!/bin/bash
# Script to optimize database performance in Docker container
# Run this from the project root directory

echo "🚀 Optimizing Database Performance in Docker..."
echo "=============================================="

# Check if Docker container is running
if ! docker ps | grep -q "lai-backend"; then
    echo "❌ Docker container 'lai-backend' is not running!"
    echo "Please start the container first with: docker-compose up -d"
    exit 1
fi

echo "✅ Docker container is running"

# Run the database optimization script inside the container
echo "📊 Running database performance analysis and optimization..."
docker cp scripts/archive/backend/add_database_indexes.py lai-backend-1:/tmp/add_database_indexes.py
docker exec -it lai-backend-1 python /tmp/add_database_indexes.py

if [ $? -eq 0 ]; then
    echo "✅ Database optimization completed successfully!"
    echo ""
    echo "🏃‍♂️ Performance improvements:"
    echo "  • Added database indexes for faster annotation queries"
    echo "  • Optimized compound indexes for common query patterns"
    echo "  • Analyzed tables for query optimization"
    echo ""
    echo "📈 Expected improvements:"
    echo "  • Annotation loading should be 10-100x faster"
    echo "  • Dataset view should load much quicker"
    echo "  • Reduced memory usage for large datasets"
    echo ""
    echo "🔄 Please restart your backend to see the full benefits:"
    echo "   docker-compose restart backend"
else
    echo "❌ Database optimization failed!"
    echo "Check the Docker logs for more details:"
    echo "   docker logs lai-backend-1"
fi
