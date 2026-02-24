"""
HashtagManager - Bidirectional #hashtag ↔ Neo4j Entity sync.

Normalizes entity names from the knowledge graph into #hashtag tokens,
and converts #hashtags back to search terms for Neo4j queries.

Maintains a local manifest (hashtags.json) for fast lookups.
"""
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set

logger = logging.getLogger("HashtagManager")


def _normalize_to_hashtag(name: str) -> str:
    """
    Convert a Neo4j entity name to a #hashtag token.
    
    Examples:
        "Entity Extraction" → "#entity_extraction"
        "Neo4j Database"    → "#neo4j_database"
        "LLM"              → "#llm"
    """
    return "#" + re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def _hashtag_to_search_term(tag: str) -> str:
    """
    Convert a #hashtag token back to a search term for Neo4j queries.
    
    Underscores are converted back to spaces for natural matching.
    
    Examples:
        "#entity_extraction" → "entity extraction"
        "#neo4j_database"    → "neo4j database"
    """
    return tag.lstrip('#').replace('_', ' ')


class HashtagManager:
    """
    Synchronizes #hashtag tokens with Neo4j Entity nodes.
    
    The manifest (hashtags.json) maps each hashtag to:
    - node_id: The Neo4j Entity UUID
    - entity_name: The original entity name
    - last_synced: When this mapping was last verified
    
    Usage:
        manager = HashtagManager(manifest_path)
        await manager.sync_from_graph(neo4j_driver)  # Pull entities
        tags = manager.extract_hashtags("Use #entity_extraction for NLP")
        valid = manager.validate_hashtags(tags)
    """
    
    def __init__(self, manifest_path: Path = None):
        """
        Initialize the HashtagManager.
        
        Args:
            manifest_path: Path to hashtags.json manifest.
                           Defaults to TheCortex/data/blackboard/hashtags.json
        """
        if manifest_path is None:
            _module_dir = Path(__file__).resolve().parent
            _cortex_root = _module_dir.parent.parent.parent
            manifest_path = _cortex_root / "data" / "blackboard" / "hashtags.json"
        
        self.manifest_path = manifest_path
        self._mappings: Dict[str, dict] = {}
        self._load_manifest()
    
    def _load_manifest(self):
        """Load hashtag-to-node mappings from disk."""
        if self.manifest_path.exists():
            try:
                with open(self.manifest_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._mappings = data.get("hashtags", {})
            except (json.JSONDecodeError, KeyError):
                self._mappings = {}
        else:
            self._mappings = {}
    
    def _save_manifest(self):
        """Persist hashtag-to-node mappings to disk."""
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "hashtags": self._mappings,
            "last_synced": datetime.now().isoformat(),
            "count": len(self._mappings),
        }
        with open(self.manifest_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    
    async def sync_from_graph(self, neo4j_driver) -> int:
        """
        Pull all Entity node names from Neo4j and update the manifest.
        
        Args:
            neo4j_driver: Neo4j async driver instance
            
        Returns:
            Number of hashtags synced
        """
        query = "MATCH (n:Entity) RETURN n.uuid AS uuid, n.name AS name"
        
        async with neo4j_driver.session() as session:
            result = await session.run(query)
            records = await result.data()
        
        synced_count = 0
        for record in records:
            name = record.get("name", "")
            uuid = record.get("uuid", "")
            if not name or not uuid:
                continue
            
            hashtag = _normalize_to_hashtag(name)
            self._mappings[hashtag] = {
                "node_id": uuid,
                "entity_name": name,
                "last_synced": datetime.now().isoformat(),
            }
            synced_count += 1
        
        self._save_manifest()
        logger.info(f"Synced {synced_count} hashtags from Neo4j")
        return synced_count
    
    def extract_hashtags(self, text: str) -> List[str]:
        """
        Parse #hashtag tokens from text.
        
        Args:
            text: Source text to scan
            
        Returns:
            List of unique hashtags found (with # prefix)
        """
        return list(set(re.findall(r'#\w+', text)))
    
    def validate_hashtags(self, tags: List[str]) -> Dict[str, bool]:
        """
        Check which hashtags exist in the manifest.
        
        Args:
            tags: List of hashtags to validate
            
        Returns:
            Dict mapping each tag to True/False
        """
        return {tag: tag in self._mappings for tag in tags}
    
    def register_hashtag(self, tag: str, node_id: str, entity_name: str = ""):
        """
        Manually register a hashtag-to-node mapping.
        
        Args:
            tag: The hashtag (with # prefix)
            node_id: Neo4j Entity UUID
            entity_name: Original entity name
        """
        self._mappings[tag] = {
            "node_id": node_id,
            "entity_name": entity_name or _hashtag_to_search_term(tag),
            "last_synced": datetime.now().isoformat(),
        }
        self._save_manifest()
    
    def get_node_id(self, hashtag: str) -> Optional[str]:
        """
        Get the Neo4j UUID for a hashtag.
        
        Args:
            hashtag: The hashtag (with # prefix)
            
        Returns:
            UUID string or None if not mapped
        """
        mapping = self._mappings.get(hashtag)
        return mapping["node_id"] if mapping else None
    
    def get_search_terms(self, hashtags: List[str]) -> List[str]:
        """
        Convert a list of hashtags into search terms for Neo4j queries.
        
        Uses _hashtag_to_search_term for conversion (underscores → spaces).
        
        Args:
            hashtags: List of hashtags to convert
            
        Returns:
            List of lowercased search terms
        """
        return [_hashtag_to_search_term(tag) for tag in hashtags]
    
    @property
    def available_hashtags(self) -> Set[str]:
        """Return set of all known hashtags."""
        return set(self._mappings.keys())
    
    @property
    def count(self) -> int:
        """Number of registered hashtag mappings."""
        return len(self._mappings)
    
    async def backfill_hashtags(self, session_dir: Path, llm=None):
        """
        Retroactively tag .md files in a session directory using LLM.
        
        Scans all .md files, extracts content, and asks the LLM
        to identify relevant hashtags from the available set.
        
        Args:
            session_dir: Path to the session directory
            llm: LangChain chat model for entity extraction
                 (uses entity_extractor role if None)
        """
        if not self._mappings:
            logger.warning("No hashtags available for backfilling")
            return
        
        if llm is None:
            try:
                from cortex.llm_factory import get_llm_for_role
                llm = get_llm_for_role("entity_extractor")
            except Exception as e:
                logger.error(f"Could not load entity_extractor LLM: {e}")
                return
        
        available = ", ".join(sorted(self._mappings.keys()))
        
        md_files = list(session_dir.glob("**/*.md"))
        for md_file in md_files:
            try:
                content = md_file.read_text(encoding="utf-8")
                
                # Skip files that already have hashtags
                existing = self.extract_hashtags(content)
                if existing:
                    continue
                
                prompt = (
                    f"Given the following content, identify relevant hashtags "
                    f"from this list: {available}\n\n"
                    f"Content:\n{content[:2000]}\n\n"
                    f"Return ONLY the matching hashtags separated by spaces. "
                    f"If none match, return 'NONE'."
                )
                
                response = await llm.ainvoke(prompt)
                text = response.content if hasattr(response, 'content') else str(response)
                
                if text.strip() == "NONE":
                    continue
                
                tags = self.extract_hashtags(text)
                valid = [t for t, ok in self.validate_hashtags(tags).items() if ok]
                
                if valid:
                    # Append tags to end of file
                    tag_line = f"\n\n---\nTags: {' '.join(valid)}\n"
                    with open(md_file, "a", encoding="utf-8") as f:
                        f.write(tag_line)
                    logger.info(f"Backfilled {md_file.name} with {valid}")
                    
            except Exception as e:
                logger.warning(f"Backfill failed for {md_file}: {e}")
