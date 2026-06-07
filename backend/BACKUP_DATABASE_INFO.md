# Database Backup Information

## Database Backup Location

When you run a backup, the database is backed up to:
```
{backup_path}/backup_YYYYMMDD_HHMMSS/database/database_YYYYMMDD_HHMMSS.dump
```

For example:
- Default location: `./backups/backup_20240101_120000/database/database_20240101_120000.dump`
- Custom location: `/home/user/my-backups/backup_20240101_120000/database/database_20240101_120000.dump`

## Database Backup Format

The database is backed up using PostgreSQL's `pg_dump` tool in **custom format** (`-F c`), which:
- Creates a compressed `.dump` file (not `.sql`)
- Allows selective restore of specific tables
- Is more efficient than plain SQL dumps
- Can be restored using `pg_restore`

## Verifying Database Backup

### Check if database backup exists:
```bash
# If using default location
ls -lh backend/backups/backup_*/database/

# If using custom BACKUP_PATH
ls -lh $BACKUP_PATH/backup_*/database/
```

### Check backup status in UI:
1. Go to Settings → Data Management tab
2. Scroll to "Recent Backups" section
3. Look for backup entries - they should show:
   - Status: "completed"
   - Files ✓ (if files were backed up)
   - Database ✓ (if database was backed up)

### Check backup logs:
```bash
docker compose logs backend | grep -i "database backup"
```

## Restoring Database Backup

To restore a database backup:

```bash
# Connect to PostgreSQL container
docker compose exec db psql -U postgres -d lai_db

# Or restore from backup file
docker compose exec -T db pg_restore -U postgres -d lai_db < /path/to/backup/database/database_YYYYMMDD_HHMMSS.dump
```

## Troubleshooting

### Database backup not appearing?

1. **Check if pg_dump is installed:**
   ```bash
   docker compose exec backend which pg_dump
   ```
   Should return: `/usr/bin/pg_dump`

2. **Check backup logs:**
   ```bash
   docker compose logs backend | grep -i "database\|pg_dump"
   ```

3. **Check backup directory:**
   ```bash
   docker compose exec backend ls -la /app/backups/backup_*/database/
   ```

4. **Common issues:**
   - `pg_dump: command not found` → Rebuild Docker image (postgresql-client added to Dockerfile)
   - `Connection refused` → Check database is running: `docker compose ps db`
   - `Permission denied` → Check backup directory permissions

### Rebuild Docker image to install pg_dump:
```bash
cd backend
docker compose build backend
docker compose up -d
```

## Backup Contents

Each backup contains:
- `database/` - PostgreSQL database dump(s)
- `projects/` - Incremental backup of project files (images, etc.)
- `.backup_manifest.json` - File manifest for incremental backups
- `.backup_metadata.json` - Backup metadata including status
