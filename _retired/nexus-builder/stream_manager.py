import asyncio
from typing import Dict, List, Any
import json
from datetime import datetime

def _langchain_encoder(obj):
    """Custom JSON encoder for LangChain message objects"""
    # Handle LangChain message types
    if hasattr(obj, 'content') and hasattr(obj, 'type'):
        # This is a LangChain message (HumanMessage, AIMessage, etc.)
        return {
            "type": obj.type,
            "content": obj.content,
            "id": getattr(obj, 'id', None)
        }
    # Handle datetime objects
    if isinstance(obj, datetime):
        return obj.isoformat()
    # Handle other non-serializable objects
    if hasattr(obj, '__dict__'):
        return obj.__dict__
    # Let the default encoder raise the error for truly unknown types
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

class StreamManager:
    """
    Manages Server-Sent Events (SSE) subscriptions for workflow runs.
    Allows multiple clients to subscribe to the same run_id.
    """
    
    def __init__(self):
        # run_id -> List[asyncio.Queue]
        self._subscriptions: Dict[str, List[asyncio.Queue]] = {}
        
    async def subscribe(self, run_id: str) -> asyncio.Queue:
        """Subscribe to events for a specific run_id"""
        if run_id not in self._subscriptions:
            self._subscriptions[run_id] = []
            
        queue = asyncio.Queue()
        self._subscriptions[run_id].append(queue)
        
        # specific log
        print(f"[StreamManager] Client subscribed to run {run_id} (Total: {len(self._subscriptions[run_id])})")
        
        return queue
        
    async def unsubscribe(self, run_id: str, queue: asyncio.Queue):
        """Unsubscribe a client"""
        if run_id in self._subscriptions:
            if queue in self._subscriptions[run_id]:
                self._subscriptions[run_id].remove(queue)
                print(f"[StreamManager] Client unsubscribed from run {run_id}")
                
            if not self._subscriptions[run_id]:
                del self._subscriptions[run_id]
                
    async def publish(self, run_id: str, event: Dict[str, Any]):
        """Publish an event to all subscribers of a run_id"""
        if run_id not in self._subscriptions:
            return
            
        # Add timestamp if not present
        if "timestamp" not in event:
            event["timestamp"] = datetime.utcnow().isoformat()
            
        message = json.dumps(event, default=_langchain_encoder)
        
        # Broadcast to all queues
        # We iterate a copy of the list in case it changes during iteration
        for queue in list(self._subscriptions[run_id]):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # Should not happen with unbounded queue, but good to know
                print(f"[StreamManager] Warning: Queue full for subscriber of {run_id}")
                
    async def broadcast_log(self, run_id: str, message: str, level: str = "info"):
        """Helper to broadcast a simple log message"""
        await self.publish(run_id, {
            "type": "log",
            "level": level,
            "message": message
        })
