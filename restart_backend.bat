@echo off
echo 🔄 Restarting backend with database annotation storage...

cd backend

echo 📦 Stopping existing containers...
docker-compose down

echo 🏗️ Building and starting containers...
docker-compose up --build -d

echo ⏳ Waiting for database to be ready...
timeout /t 10 /nobreak > nul

echo 🗃️ Running database migration...
docker-compose exec -T backend alembic upgrade head

echo 📊 Container status:
docker-compose ps

echo ✅ Backend restarted with database annotation storage!
echo 🌐 Backend is now available at http://localhost:9999
echo 📊 Database is available at localhost:5432

echo 📋 Recent backend logs:
docker-compose logs backend --tail=20
