import os
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

DB_PATH = "data/cortex_state.db"


class ConnectionWrapper:
    """Proxy for aiosqlite.Connection to add missing is_alive method required by langgraph."""
    def __init__(self, conn):
        self._conn = conn
        
    def __getattr__(self, name):
        return getattr(self._conn, name)
        
    def is_alive(self):
        return True
    
    # Forward async context manager methods
    async def __aenter__(self):
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return await self._conn.__aexit__(exc_type, exc_val, exc_tb)

class CheckpointFactory:
    _saver = None
    _conn = None 

    @classmethod
    async def get_saver(cls):
        """
        Returns a singleton AsyncSqliteSaver.
        Initializes connection on first use to bind to the correct event loop.
        """
        if cls._saver is None:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            
            # Manually manage connection to fix compatibility issues
            import aiosqlite
            
            # Create connection but don't enter context manager yet (we want it persistent)
            # Actually, to start it we need to await it or use __aenter__
            # aiosqlite.connect returns a context manager that yields the Connection
            cls._conn_cm = aiosqlite.connect(DB_PATH)
            conn = await cls._conn_cm.__aenter__()
            
            # Use wrapper to inject is_alive
            wrapped_conn = ConnectionWrapper(conn)
            
            cls._saver = AsyncSqliteSaver(wrapped_conn)
            
        return cls._saver
