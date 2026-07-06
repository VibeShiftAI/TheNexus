import os
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

DB_PATH = "data/cortex_state.db"

# Register custom types that appear in LangGraph checkpoints.
# Without this, deserialization emits warnings like:
#   "Deserializing unregistered type cortex.schemas.state.MarkdownPlan from checkpoint"
_ALLOWED_MODULES = [
    ("cortex.schemas.state", "MarkdownPlan"),
    ("cortex.schemas.state", "VoteReceipt"),
    ("cortex.schemas.state", "LineComment"),
    ("cortex.schemas.state", "ProjectPlan"),
    ("cortex.schemas.state", "WorkflowNode"),
]


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
            
            # Create serializer with registered custom types
            serde = JsonPlusSerializer(allowed_msgpack_modules=_ALLOWED_MODULES)
            
            cls._saver = AsyncSqliteSaver(wrapped_conn, serde=serde)
            
        return cls._saver
