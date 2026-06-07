# Backup Path Configuration Guide

## How Backup Paths Work

The backup system is designed to store backups on your **host machine** (outside Docker), not inside the container.

### Docker Volume Mount

The `docker-compose.yml` file includes this volume mount:
```yaml
volumes:
  - ./backups:/app/backups
```

This means:
- **Inside container**: `/app/backups/` 
- **On your host machine**: `./backups/` (relative to where you run docker-compose)

### Path Configuration

When configuring backups in the Settings page:

1. **Empty path** (default): Backups stored in `./backups/` on your host
2. **Relative path** (e.g., `"daily"`): Backups stored in `./backups/daily/` on your host
3. **Relative path** (e.g., `"backups/2024"`): Backups stored in `./backups/backups/2024/` on your host

### Examples

| UI Input | Container Path | Host Path (on your machine) |
|----------|---------------|----------------------------|
| (empty)  | `/app/backups/` | `./backups/` |
| `daily`  | `/app/backups/daily/` | `./backups/daily/` |
| `backups/2024` | `/app/backups/backups/2024/` | `./backups/backups/2024/` |

### Finding Your Backups

After running a backup, you can find the files on your host machine:

```bash
cd /path/to/lai/backend
ls -la backups/
```

The backups directory will contain:
- `backup_YYYYMMDD_HHMMSS/` - Each backup snapshot
  - `database/` - PostgreSQL database dumps
  - `projects/` - Incremental backup of your project files
  - `.backup_manifest.json` - File manifest for incremental backups
  - `.backup_metadata.json` - Backup metadata

### Important Notes

- **Always use relative paths** in the UI (or leave empty)
- Backups are **automatically stored on your host machine** via the volume mount
- The path you enter is **relative to `./backups/`** on your host
- You can access backups directly from your file system without entering the container
