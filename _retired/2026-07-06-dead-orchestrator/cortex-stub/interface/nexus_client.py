import httpx
from cortex.config import settings
from typing import Dict, Any, Union, List

class NexusClient:
    """
    The Adapter for The Nexus Control Plane.
    
    Handles communication with the Nexus Node.js API (Rest)
    and uses Service Key auth with Impersonation to ensure
    created resources are owned by the correct user.
    """
    def __init__(self):
        self.base_url = settings.nexus_api_url
        self._headers = None

    @property
    def headers(self):
        if self._headers is None:
            service_key = settings.nexus_service_key or settings.supabase_service_key
            key_value = service_key.get_secret_value() if service_key else ""
            self._headers = {
                "Authorization": f"Bearer {key_value}",
                "apikey": key_value,
                "x-impersonate-user": settings.nexus_user_id or "",
                "Content-Type": "application/json"
            }
        return self._headers


    async def _get(self, endpoint: str) -> Union[Dict, List, Any]:
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.get(
                    f"{self.base_url}{endpoint}",
                    headers=self.headers,
                    timeout=10.0
                )
                resp.raise_for_status()
                return resp.json()
            except httpx.ConnectError:
                raise ConnectionRefusedError(f"The Nexus server is offline at {self.base_url}.")

    async def _post(self, endpoint: str, data: Dict[str, Any]) -> Union[Dict, List, Any]:
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.post(
                    f"{self.base_url}{endpoint}", 
                    json=data, 
                    headers=self.headers,
                    timeout=10.0
                )
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPStatusError as e:
                print(f"❌ HTTP Error: {e.response.status_code} - {e.response.text}")
                raise e
            except httpx.ConnectError:
                raise ConnectionRefusedError(f"The Nexus server is offline at {self.base_url}.")

    async def list_projects(self) -> List[Dict]:
        """
        [HARDENING] List active projects to verify Read Access.
        Prevents 'Blind Agents' from creating duplicates.
        """
        # GET /api/projects
        data = await self._get("/projects")
        # Ensure list
        return data if isinstance(data, list) else []

    async def create_project(self, name: str, goal: str, type: str = "tool") -> str:
        """
        Creates a new Project.
        """
        payload = {
            "name": name,
            "description": goal,
            "type": type,
            # 'supervisor' field in scaffold triggers doc generation.
            # We can optionally pass a minimal supervisor object if we want docs.
            # For now, let's keep it simple or maybe map goal to supervisor.concept?
            # Let's just pass description.
        }
        data = await self._post("/projects/scaffold", payload)
        # Handle API returning array vs object vs just object
        
        if not isinstance(data, dict) or not data.get('id'):
            print(f"DEBUG: create_project response missing ID. Attempting fallback lookup for '{name}'...")
            # Fallback: scaffold might not return ID in older server versions.
            # Look it up by name.
            all_projects = await self.list_projects()
            for p in all_projects:
                if p.get('name') == name:
                    print(f"DEBUG: Found project '{name}' with ID: {p.get('id')}")
                    return p.get('id')
            
            print(f"DEBUG: Could not find project '{name}' after creation.")
            return None

        return data.get('id')

    async def add_task(self, project_id: str, title: str, description: str = "", template_id: str = None) -> str:
        """
        Adds a high-level task to the project.
        """
        payload = {
            "project_id": project_id, 
            "title": title,
            "description": description,
            "status": "idea",
            "priority": "high"
        }
        if template_id:
            payload["templateId"] = template_id
        data = await self._post("/tasks", payload)
        # db.createTask returns `data` directly.
        return data.get('id') if isinstance(data, dict) else (data[0]['id'] if isinstance(data, list) and data else None)

    async def push_artifact(self, artifact_type: str, payload: Dict[str, Any]) -> bool:
        """
        Push an artifact to the Nexus UI via WebSocket broadcast.
        
        This is a fire-and-forget notification - the UI will receive
        the artifact and render it appropriately.
        """
        try:
            # POST to the broadcast endpoint
            data = await self._post("/broadcast", {
                "type": "ARTIFACT_PUSH",
                "payload": {
                    "artifact_type": artifact_type,
                    "content": payload,
                    "timestamp": __import__('datetime').datetime.now().isoformat()
                }
            })
            print(f"📡 Artifact pushed to Nexus: {artifact_type}")
            return True
        except Exception as e:
            # Non-critical - UI just won't see the update
            print(f"⚠️ Failed to push artifact: {e}")
            return False

# Singleton
nexus = NexusClient()
