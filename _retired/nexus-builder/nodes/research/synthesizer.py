"""
Synthesizer Node - Research compilation agent.

Extracted from researcher/agent.py::synthesizer_node
Compiles research findings into a coherent dossier.
"""

from ..core.fleet import FleetAgentNode
from researcher.agent import synthesizer_node


class SynthesizerNode(FleetAgentNode):
    """
    Phase 4 of Research Fleet: Dossier Compilation.
    
    Takes all research findings from the execution phase and
    compiles them into a structured RESEARCH_DOSSIER.md document.
    """
    
    type_id = "research_synthesizer"
    display_name = "Research Synthesizer"
    description = "Compiles research findings into coherent dossier"
    category = "research"
    icon = "📋"
    fleet_origin = "research"
    levels = ["project", "task"]
    
    # Bind the legacy function
    legacy_function = staticmethod(synthesizer_node)
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Output Format",
                "name": "output_format",
                "type": "options",
                "default": "markdown",
                "options": [
                    {"name": "Markdown", "value": "markdown"},
                    {"name": "JSON", "value": "json"}
                ],
                "description": "Format for the research dossier"
            }
        ]
