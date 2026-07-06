"""
Cortex - Cognitive Mesh Think Tank Core Module
"""

from .llm_factory import LLMFactory, ModelRole, get_llm_for_role, LLMConfigurationError
from .config import settings

__all__ = [
    'LLMFactory', 
    'ModelRole', 
    'get_llm_for_role', 
    'LLMConfigurationError',
    'settings'
]
__version__ = '0.1.0'
