# Nexus Database Locations

The canonical local Nexus project/task database is:

```text
/Volumes/Projects/TheNexus/nexus.db
```

Both the Node.js backend and Python/LangGraph services should use this path through:

```text
NEXUS_DB_PATH=/Volumes/Projects/TheNexus/nexus.db
```

The workflow checkpoint database is separate and should remain in place:

```text
/Volumes/Projects/TheNexus/checkpoints.db
```

Backups belong under:

```text
/Volumes/Projects/TheNexus/backups/
```

Quarantined stale duplicate database files belong under:

```text
/Volumes/Projects/TheNexus/_db-quarantine/
```

Do not create or use nested duplicate Nexus databases such as:

```text
/Volumes/Projects/TheNexus/data/nexus.db
/Volumes/Projects/TheNexus/db/nexus.db
/Volumes/Projects/TheNexus/server/nexus.db
/Volumes/Projects/TheNexus/db/dev.db
```

Those paths have historically caused confusion because they look authoritative but are not used by the live Nexus services.
