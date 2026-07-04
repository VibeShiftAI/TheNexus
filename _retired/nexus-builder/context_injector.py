"""
Context Injector - Python Port from Node.js src/memory/ContextInjector.js

Phase 6: Memory & Context Systems
Handles:
- Context generation for AI prompts
- Preference-based scaffolding hints
- Rule application to operations

This replaces the Node.js push-model with a Python implementation
that integrates with the atomic node execution engine.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ═══════════════════════════════════════════════════════════════════════════
# TYPE DEFINITIONS
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class ContextBlock:
    """A block of context to inject into prompts."""
    type: str  # 'preferences', 'rules', 'patterns'
    content: str
    priority: int  # Higher = more important


@dataclass
class ScaffoldingHints:
    """Hints for project scaffolding based on learned preferences."""
    language: Optional[str] = None
    package_manager: Optional[str] = None
    styling: Optional[str] = None
    testing_framework: Optional[str] = None
    linting_tool: Optional[str] = None
    framework: Optional[str] = None
    formatting: Dict[str, Any] = field(default_factory=dict)
    rules: List[str] = field(default_factory=list)


@dataclass
class Preference:
    """A single preference with confidence score."""
    value: Any
    confidence: float
    source: str = "inferred"


# ═══════════════════════════════════════════════════════════════════════════
# CONTEXT INJECTOR CLASS
# ═══════════════════════════════════════════════════════════════════════════

class ContextInjector:
    """
    Injects learned preferences into prompts and scaffolding operations.
    
    Python port of src/memory/ContextInjector.js
    Phase 6: Memory & Context Systems
    """
    
    def __init__(self, supabase_client=None):
        """
        Initialize context injector.
        
        Args:
            supabase_client: Optional Supabase client for database access
        """
        self.supabase = supabase_client
        self.confidence_threshold = 0.6  # Minimum confidence to include preference
        
        # In-memory cache for preferences
        self._preferences_cache: Dict[str, Dict[str, Preference]] = {}
        self._rules_cache: List[Dict[str, Any]] = []
        self._patterns_cache: Dict[str, str] = {}
    
    def set_confidence_threshold(self, threshold: float) -> None:
        """Set the confidence threshold for including preferences."""
        self.confidence_threshold = max(0.0, min(1.0, threshold))
    
    async def generate_context_blocks(
        self,
        categories: Optional[List[str]] = None,
        include_rules: bool = True,
        include_patterns: bool = True,
        max_blocks: Optional[int] = None
    ) -> List[ContextBlock]:
        """
        Generate context blocks for injection into prompts.
        
        Args:
            categories: Specific categories to include
            include_rules: Include explicit rules
            include_patterns: Include patterns
            max_blocks: Maximum number of context blocks
        
        Returns:
            List of ContextBlock sorted by priority
        """
        blocks = []
        
        # Add preference blocks
        prefs = await self.get_high_confidence_preferences(categories)
        if prefs:
            blocks.append(ContextBlock(
                type="preferences",
                content=self._format_preferences_for_prompt(prefs),
                priority=2
            ))
        
        # Add explicit rules
        if include_rules:
            rules = await self._get_explicit_rules()
            if rules:
                blocks.append(ContextBlock(
                    type="rules",
                    content=self._format_rules_for_prompt(rules),
                    priority=3  # Higher priority
                ))
        
        # Add patterns
        if include_patterns:
            patterns = await self._get_all_patterns()
            if patterns:
                blocks.append(ContextBlock(
                    type="patterns",
                    content=self._format_patterns_for_prompt(patterns),
                    priority=1
                ))
        
        # Sort by priority (descending)
        blocks.sort(key=lambda b: b.priority, reverse=True)
        
        # Limit if requested
        if max_blocks and len(blocks) > max_blocks:
            return blocks[:max_blocks]
        
        return blocks
    
    async def generate_context_string(
        self,
        categories: Optional[List[str]] = None,
        include_rules: bool = True,
        include_patterns: bool = True
    ) -> str:
        """
        Generate a full context string for injection.
        
        Args:
            categories: Specific categories to include
            include_rules: Include explicit rules
            include_patterns: Include patterns
        
        Returns:
            Formatted context string
        """
        blocks = await self.generate_context_blocks(
            categories=categories,
            include_rules=include_rules,
            include_patterns=include_patterns
        )
        
        if not blocks:
            return ""
        
        sections = [block.content for block in blocks]
        return f"## User Preferences & Context\n\n{chr(10).join(sections)}"
    
    async def get_high_confidence_preferences(
        self,
        categories: Optional[List[str]] = None
    ) -> Dict[str, Dict[str, Any]]:
        """
        Get preferences above confidence threshold.
        
        Args:
            categories: Specific categories to include
        
        Returns:
            Dict of category -> {key -> value}
        """
        all_prefs = await self._get_all_preferences()
        result: Dict[str, Dict[str, Any]] = {}
        
        for category, prefs in all_prefs.items():
            # Skip if specific categories requested and this isn't one
            if categories and category not in categories:
                continue
            
            filtered_prefs = {}
            for key, pref in prefs.items():
                if pref.confidence >= self.confidence_threshold:
                    filtered_prefs[key] = pref.value
            
            if filtered_prefs:
                result[category] = filtered_prefs
        
        return result
    
    async def get_scaffolding_hints(self) -> ScaffoldingHints:
        """
        Get scaffolding hints based on learned preferences.
        
        Returns:
            ScaffoldingHints with recommended settings
        """
        hints = ScaffoldingHints()
        
        # Get language preference
        language = await self._get_preference("language", "primary")
        if language and language.confidence >= self.confidence_threshold:
            hints.language = language.value
        
        # Get package manager
        pkg_mgr = await self._get_preference("tooling", "packageManager")
        if pkg_mgr and pkg_mgr.confidence >= self.confidence_threshold:
            hints.package_manager = pkg_mgr.value
        
        # Get styling framework
        styling = await self._get_preference("styling", "framework")
        if styling and styling.confidence >= self.confidence_threshold:
            hints.styling = styling.value
        
        # Get testing framework
        testing = await self._get_preference("testing", "framework")
        if testing and testing.confidence >= self.confidence_threshold:
            hints.testing_framework = testing.value
        
        # Get linting tool
        linting = await self._get_preference("linting", "tool")
        if linting and linting.confidence >= self.confidence_threshold:
            hints.linting_tool = linting.value
        
        # Get application framework
        framework = await self._get_preference("framework", "primary")
        if framework and framework.confidence >= self.confidence_threshold:
            hints.framework = framework.value
        
        # Get formatting preferences
        formatting_prefs = await self._get_preferences_by_category("formatting")
        formatting = {}
        for key, pref in formatting_prefs.items():
            if pref.confidence >= self.confidence_threshold:
                formatting[key] = pref.value
        if formatting:
            hints.formatting = formatting
        
        # Get applicable explicit rules
        rules = await self._get_explicit_rules()
        if rules:
            hints.rules = [r.get("rule", "") for r in rules]
        
        return hints
    
    async def generate_package_json_suggestions(self) -> Dict[str, Any]:
        """
        Generate package.json suggestions based on preferences.
        
        Returns:
            Dict with dependencies, devDependencies, and scripts
        """
        hints = await self.get_scaffolding_hints()
        suggestions: Dict[str, Dict[str, str]] = {
            "dependencies": {},
            "devDependencies": {},
            "scripts": {}
        }
        
        # Language-based suggestions
        if hints.language == "typescript":
            suggestions["devDependencies"]["typescript"] = "^5.0.0"
            suggestions["devDependencies"]["@types/node"] = "^20.0.0"
        
        # Styling suggestions
        if hints.styling == "tailwind":
            suggestions["devDependencies"]["tailwindcss"] = "^3.0.0"
            suggestions["devDependencies"]["postcss"] = "^8.0.0"
            suggestions["devDependencies"]["autoprefixer"] = "^10.0.0"
        elif hints.styling == "sass":
            suggestions["devDependencies"]["sass"] = "^1.0.0"
        elif hints.styling == "styled-components":
            suggestions["dependencies"]["styled-components"] = "^6.0.0"
        
        # Testing suggestions
        if hints.testing_framework == "vitest":
            suggestions["devDependencies"]["vitest"] = "^1.0.0"
            suggestions["scripts"]["test"] = "vitest"
            suggestions["scripts"]["test:coverage"] = "vitest --coverage"
        elif hints.testing_framework == "jest":
            suggestions["devDependencies"]["jest"] = "^29.0.0"
            suggestions["scripts"]["test"] = "jest"
        
        # Linting suggestions
        if hints.linting_tool == "eslint":
            suggestions["devDependencies"]["eslint"] = "^8.0.0"
            suggestions["scripts"]["lint"] = "eslint ."
        elif hints.linting_tool == "biome":
            suggestions["devDependencies"]["@biomejs/biome"] = "^1.0.0"
            suggestions["scripts"]["lint"] = "biome check ."
        
        return suggestions
    
    async def prefers_value(self, category: str, key: str, value: Any) -> bool:
        """
        Check if preferences suggest a specific technology.
        
        Args:
            category: Category to check
            key: Key within category
            value: Value to match
        
        Returns:
            True if preference matches with sufficient confidence
        """
        pref = await self._get_preference(category, key)
        return (
            pref is not None and
            pref.confidence >= self.confidence_threshold and
            pref.value == value
        )
    
    async def get_recommendation_summary(self) -> str:
        """
        Get a recommendation summary for the user.
        
        Returns:
            Formatted recommendation string
        """
        hints = await self.get_scaffolding_hints()
        lines = ["Based on your previous projects, I recommend:"]
        
        if hints.language:
            lines.append(f"- Language: {hints.language}")
        if hints.framework:
            lines.append(f"- Framework: {hints.framework}")
        if hints.styling:
            lines.append(f"- Styling: {hints.styling}")
        if hints.testing_framework:
            lines.append(f"- Testing: {hints.testing_framework}")
        if hints.linting_tool:
            lines.append(f"- Linting: {hints.linting_tool}")
        if hints.package_manager:
            lines.append(f"- Package Manager: {hints.package_manager}")
        
        if len(lines) == 1:
            return "No preferences learned yet. Work on some projects and I'll learn your preferences!"
        
        return "\n".join(lines)
    
    # ═══════════════════════════════════════════════════════════════════════
    # PRIVATE METHODS - Database Access
    # ═══════════════════════════════════════════════════════════════════════
    
    async def _get_all_preferences(self) -> Dict[str, Dict[str, Preference]]:
        """Get all preferences from database or cache."""
        if self._preferences_cache:
            return self._preferences_cache
        
        if not self.supabase:
            return {}
        
        try:
            result = self.supabase.client.table("user_preferences").select("*").execute()
            if result.data:
                for row in result.data:
                    category = row.get("category", "general")
                    key = row.get("key", "default")
                    if category not in self._preferences_cache:
                        self._preferences_cache[category] = {}
                    self._preferences_cache[category][key] = Preference(
                        value=row.get("value"),
                        confidence=row.get("confidence", 0.5),
                        source=row.get("source", "inferred")
                    )
        except Exception as e:
            print(f"[ContextInjector] Error loading preferences: {e}")
        
        return self._preferences_cache
    
    async def _get_preference(self, category: str, key: str) -> Optional[Preference]:
        """Get a specific preference."""
        all_prefs = await self._get_all_preferences()
        return all_prefs.get(category, {}).get(key)
    
    async def _get_preferences_by_category(self, category: str) -> Dict[str, Preference]:
        """Get all preferences in a category."""
        all_prefs = await self._get_all_preferences()
        return all_prefs.get(category, {})
    
    async def _get_explicit_rules(self) -> List[Dict[str, Any]]:
        """Get explicit rules from database."""
        if self._rules_cache:
            return self._rules_cache
        
        if not self.supabase:
            return []
        
        try:
            result = self.supabase.client.table("user_rules").select("*").eq(
                "active", True
            ).execute()
            if result.data:
                self._rules_cache = result.data
        except Exception as e:
            print(f"[ContextInjector] Error loading rules: {e}")
        
        return self._rules_cache
    
    async def _get_all_patterns(self) -> Dict[str, str]:
        """Get all patterns from database."""
        if self._patterns_cache:
            return self._patterns_cache
        
        if not self.supabase:
            return {}
        
        try:
            result = self.supabase.client.table("code_patterns").select("*").execute()
            if result.data:
                for row in result.data:
                    self._patterns_cache[row.get("name", "")] = row.get("value", "")
        except Exception as e:
            print(f"[ContextInjector] Error loading patterns: {e}")
        
        return self._patterns_cache
    
    # ═══════════════════════════════════════════════════════════════════════
    # PRIVATE METHODS - Formatting
    # ═══════════════════════════════════════════════════════════════════════
    
    def _format_preferences_for_prompt(
        self,
        prefs: Dict[str, Dict[str, Any]]
    ) -> str:
        """Format preferences for prompt injection."""
        lines = ["### Learned Preferences"]
        
        for category, category_prefs in prefs.items():
            formatted_category = category.capitalize()
            items = ", ".join(
                f"{key}: {json.dumps(value)}"
                for key, value in category_prefs.items()
            )
            lines.append(f"- **{formatted_category}**: {items}")
        
        return "\n".join(lines)
    
    def _format_rules_for_prompt(self, rules: List[Dict[str, Any]]) -> str:
        """Format rules for prompt injection."""
        lines = ["### User Rules (Must Follow)"]
        
        for rule in rules:
            lines.append(f"- {rule.get('rule', '')}")
        
        return "\n".join(lines)
    
    def _format_patterns_for_prompt(self, patterns: Dict[str, str]) -> str:
        """Format patterns for prompt injection."""
        lines = ["### Code Patterns"]
        
        for name, value in patterns.items():
            # Convert camelCase to spaced words
            import re
            formatted_name = re.sub(r"([A-Z])", r" \1", name).strip()
            lines.append(f"- {formatted_name}: {value}")
        
        return "\n".join(lines)
