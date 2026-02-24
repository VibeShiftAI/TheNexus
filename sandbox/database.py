"""
Database connection pool.
"""

import os
import logging
import asyncpg
from typing import Optional

logger = logging.getLogger(__name__)

class Database:
    def __init__(self):
        self.pool: Optional[asyncpg.Pool] = None
        self.url = os.getenv("DATABASE_URL")

    async def connect(self):
        """Initialize database connection pool."""
        if not self.url:
            logger.warning("DATABASE_URL not set - running without persistence")
            return
            
        try:
            self.pool = await asyncpg.create_pool(
                self.url,
                statement_cache_size=0  # Disable prepared statements for PgBouncer
            )
            logger.info("Connected to database")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            raise

    async def disconnect(self):
        """Close database connection pool."""
        if self.pool:
            await self.pool.close()
            logger.info("Disconnected from database")

    async def fetch_one(self, query: str, *args):
        """Fetch a single row."""
        if not self.pool:
            return None
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(query, *args)

    async def fetch_all(self, query: str, *args):
        """Fetch all rows."""
        if not self.pool:
            return []
        async with self.pool.acquire() as conn:
            return await conn.fetch(query, *args)

    async def execute(self, query: str, *args):
        """Execute a query."""
        if not self.pool:
            return None
        async with self.pool.acquire() as conn:
            return await conn.execute(query, *args)

# Global database instance
db = Database()
