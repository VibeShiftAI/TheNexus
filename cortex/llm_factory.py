"""
Vibe Coding OS — LLM Factory

The unified interface for model routing. Handles:
- YAML loading from model_registry.yaml
- Shuffle logic for anti-groupthink (random model selection from pools)
- Retry logic via tenacity for API rate limit handling
- Provider instantiation (OpenAI, Anthropic, Google, xAI)
"""

import yaml
import logging
import random
from typing import Optional, Dict, Any, List
from enum import Enum

from langchain_core.language_models import BaseChatModel
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI

from tenacity import retry, stop_after_attempt, wait_exponential

from cortex.config import settings

logger = logging.getLogger("LLMFactory")
logging.basicConfig(level=settings.log_level)


class ModelRole(str, Enum):
    """Logical roles for LLM agents in the Vibe Coding OS."""
    # Core workflow roles
    PROPOSER = "proposer"         # Lead Architect (heavy model)
    REVIEWER = "reviewer"         # Council reviewers (fast model)
    ROUTER = "router"             # Chat/Build intent detection (fast model)
    BROWSER = "browser"           # Recursive browser agent
    VISUAL_INTERPRETER = "visual_interpreter"  # Image analysis

    # Nexus Builder roles (downstream execution)
    ARCHITECT = "architect"       # Plan drafting (alias for PROPOSER in some configs)
    BUILDER = "builder"           # Code generation

    # Legacy — kept for backward compat with model_registry.yaml
    ENTITY_EXTRACTOR = "entity_extractor"
    ORCHESTRATOR = "orchestrator"


class LLMConfigurationError(Exception):
    """Raised when LLM configuration or instantiation fails."""
    pass


class LLMFactory:
    """Unified factory for creating LLM instances based on agent roles."""
    
    _instance: Optional['LLMFactory'] = None
    _registry: Dict[str, Any] = {}

    def __new__(cls, config_path: Optional[str] = None):
        if cls._instance is None:
            cls._instance = super(LLMFactory, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    @classmethod
    def get_instance(cls) -> 'LLMFactory':
        """Get or create the singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self, config_path: Optional[str] = None):
        if self._initialized:
            return
        self._initialized = True
        self._config_path = config_path or settings.model_registry_path
        self._load_registry()
        
    def _load_registry(self):
        try:
            with open(self._config_path, "r") as f:
                self._registry = yaml.safe_load(f)
            logger.info("✅ Model Registry Loaded")
        except FileNotFoundError:
            raise RuntimeError(f"❌ Config not found at {self._config_path}")

    def _is_model_available(self, model_id: str) -> bool:
        """Check if a model's required API key is configured."""
        model_def = self._registry.get("models", {}).get(model_id)
        if not model_def:
            return False
        provider = model_def.get("provider", "")
        key_map = {
            "openai": settings.openai_api_key,
            "anthropic": settings.anthropic_api_key,
            "google": settings.google_api_key,
            "xai": settings.xai_api_key,
        }
        key = key_map.get(provider)
        return key is not None

    def get_model(self, role: ModelRole) -> BaseChatModel:
        """Returns a configured LangChain ChatModel for the specified role."""
        role_key = role.value
        role_config = self._registry.get("roles", {}).get(role_key)
        
        if not role_config:
            raise ValueError(f"Role '{role_key}' not defined in registry")

        strategy = role_config.get("strategy", "fixed")
        
        if strategy == "shuffle":
            pool = role_config.get("pool", [])
            # Filter to models with configured API keys
            available = [m for m in pool if self._is_model_available(m)]
            if not available:
                raise ValueError(f"Role '{role_key}' has no available models (check API keys)")
            model_id = random.choice(available)
            logger.info(f"🎲 Shuffle: Selected '{model_id}' for role '{role_key}' (from {len(available)}/{len(pool)} available)")
        else:
            model_id = role_config.get("model")
            if not model_id:
                raise ValueError(f"Role '{role_key}' has fixed strategy but no model specified")

        model_def = self._registry.get("models", {}).get(model_id)
        if not model_def:
            raise ValueError(f"Model ID '{model_id}' not found in 'models' section")

        defaults = self._registry.get("defaults", {})
        final_temp = role_config.get("temperature", defaults.get("temperature", 0.7))
        max_retries = defaults.get("max_retries", 3)
        
        return self._create_driver(
            provider=model_def["provider"],
            model_name=model_def["model_name"],
            temperature=final_temp,
            retries=max_retries,
            role_key=role_key,
            model_id=model_id,
        )

    def get_unique_models(self, role: ModelRole, count: int) -> list:
        """Returns `count` unique LLM instances from a shuffle pool.
        
        If the pool has fewer models than `count`, cycles through the pool
        so every model is used before any repeats.
        """
        role_key = role.value
        role_config = self._registry.get("roles", {}).get(role_key)
        if not role_config:
            raise ValueError(f"Role '{role_key}' not defined in registry")

        strategy = role_config.get("strategy", "fixed")
        if strategy != "shuffle":
            # Fixed strategy: return the same model N times
            return [self.get_model(role) for _ in range(count)]

        pool = role_config.get("pool", [])
        if not pool:
            raise ValueError(f"Role '{role_key}' has shuffle strategy but empty pool")

        # Filter to models with configured API keys
        available = [m for m in pool if self._is_model_available(m)]
        if not available:
            raise ValueError(f"Role '{role_key}' has no available models (check API keys for: {pool})")
        
        skipped = set(pool) - set(available)
        if skipped:
            logger.warning(f"⚠️ Skipping unavailable models for '{role_key}': {skipped}")

        # Shuffle and pick unique models (cycle if available < count)
        shuffled = list(available)
        random.shuffle(shuffled)
        selected_ids = []
        for i in range(count):
            selected_ids.append(shuffled[i % len(shuffled)])

        defaults = self._registry.get("defaults", {})
        final_temp = role_config.get("temperature", defaults.get("temperature", 0.7))
        max_retries = defaults.get("max_retries", 3)

        models = []
        for model_id in selected_ids:
            model_def = self._registry.get("models", {}).get(model_id)
            if not model_def:
                raise ValueError(f"Model ID '{model_id}' not found in 'models' section")
            logger.info(f"🎲 Unique Shuffle: Selected '{model_id}' ({model_def['model_name']}) for role '{role_key}'")
            driver = self._create_driver(
                provider=model_def["provider"],
                model_name=model_def["model_name"],
                temperature=final_temp,
                retries=max_retries,
                role_key=role_key,
                model_id=model_id,
            )
            models.append(driver)

        return models

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
    def _create_driver(
        self, provider: str, model_name: str, temperature: float, retries: int,
        *, role_key: str = "unknown", model_id: str = "unknown",
    ) -> BaseChatModel:
        """Instantiates the specific LangChain provider with usage tracking."""
        # Phase 24: Inject usage tracking callback
        from cortex.usage_callback import CortexUsageCallback
        usage_cb = CortexUsageCallback(role=role_key, model_id=model_id, provider=provider)
        callbacks = [usage_cb]

        try:
            if provider == "openai":
                return ChatOpenAI(
                    model=model_name,
                    temperature=temperature,
                    max_retries=retries,
                    api_key=settings.openai_api_key.get_secret_value(),
                    callbacks=callbacks,
                )
            elif provider == "anthropic":
                if not settings.anthropic_api_key:
                    raise LLMConfigurationError("ANTHROPIC_API_KEY not configured")
                return ChatAnthropic(
                    model=model_name,
                    temperature=temperature,
                    max_retries=retries,
                    api_key=settings.anthropic_api_key.get_secret_value(),
                    callbacks=callbacks,
                )
            elif provider == "google":
                if not settings.google_api_key:
                    raise LLMConfigurationError("GOOGLE_API_KEY not configured")
                return ChatGoogleGenerativeAI(
                    model=model_name,
                    temperature=temperature,
                    max_retries=retries,
                    google_api_key=settings.google_api_key.get_secret_value(),
                    convert_system_message_to_human=True,
                    callbacks=callbacks,
                )
            elif provider == "xai":
                if not settings.xai_api_key:
                    raise LLMConfigurationError("XAI_API_KEY not configured")
                return ChatOpenAI(
                    model=model_name,
                    temperature=temperature,
                    max_retries=retries,
                    base_url="https://api.x.ai/v1",
                    api_key=settings.xai_api_key.get_secret_value(),
                    callbacks=callbacks,
                )
            else:
                raise ValueError(f"Unsupported provider: {provider}")
        except Exception as e:
            logger.error(f"Failed to create driver for {model_name}: {e}")
            raise LLMConfigurationError(f"Failed to create LLM for '{model_name}': {e}") from e

    def get_model_info(self, role: ModelRole) -> Dict[str, Any]:
        """Get information about the model configuration for a role."""
        role_key = role.value
        role_config = self._registry.get("roles", {}).get(role_key)
        if not role_config:
            raise ValueError(f"Role '{role_key}' not defined in registry")
        strategy = role_config.get("strategy", "fixed")
        if strategy == "shuffle":
            pool = role_config.get("pool", [])
            model_id = pool[0] if pool else None
        else:
            model_id = role_config.get("model")
        model_def = self._registry.get("models", {}).get(model_id, {})
        return {
            "role": role_key, "strategy": strategy, "model": model_id,
            "pool": role_config.get("pool") if strategy == "shuffle" else None,
            "provider": model_def.get("provider"), "temperature": role_config.get("temperature"),
            "description": role_config.get("description"), "context_window": model_def.get("context_window"),
            "capabilities": model_def.get("capabilities", []),
        }
    
    def estimate_cost(self, role: ModelRole, input_tokens: int, output_tokens: int) -> float:
        """Estimate cost for a given role invocation."""
        role_key = role.value
        role_config = self._registry.get("roles", {}).get(role_key)
        if not role_config:
            return 0.0
        strategy = role_config.get("strategy", "fixed")
        if strategy == "shuffle":
            pool = role_config.get("pool", [])
            model_id = pool[0] if pool else None
        else:
            model_id = role_config.get("model")
        model_def = self._registry.get("models", {}).get(model_id, {})
        input_cost = (input_tokens / 1000) * model_def.get("cost_per_1k_input", 0)
        output_cost = (output_tokens / 1000) * model_def.get("cost_per_1k_output", 0)
        return input_cost + output_cost

    def estimate_cost_by_model(self, model_id: str, input_tokens: int, output_tokens: int) -> float:
        """Estimate cost using the actual model_id (accurate for shuffle pools)."""
        model_def = self._registry.get("models", {}).get(model_id, {})
        input_cost = (input_tokens / 1000) * model_def.get("cost_per_1k_input", 0)
        output_cost = (output_tokens / 1000) * model_def.get("cost_per_1k_output", 0)
        return input_cost + output_cost

    @classmethod
    def reset_instance(cls):
        """Reset the singleton instance (primarily for testing)."""
        cls._instance = None


def get_llm_for_role(role: ModelRole, **kwargs) -> BaseChatModel:
    """Quick access to get an LLM for a specific role."""
    factory = LLMFactory()
    return factory.get_model(role)
