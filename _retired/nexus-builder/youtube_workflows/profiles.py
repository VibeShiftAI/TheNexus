from __future__ import annotations

from .models import ChannelProfile


DEFAULT_PROFILE = ChannelProfile(
    id="default",
    name="Default YouTube Channel",
    voice={"tone": "clear, original, useful", "pace": "medium"},
    style_rules=[
        "Lead with the viewer value.",
        "Include original commentary, not only summary.",
        "Avoid static slideshow pacing.",
    ],
    publish_policy={"privacy_status": "private", "allow_public_upload": False},
    disclosure_policy={"require_ai_disclosure_review": True},
    provider_policy={"allow_sota": True, "max_cost_usd": 0.0},
)


PRAXIS_PROFILE = ChannelProfile(
    id="praxis",
    name="Praxis Self-Narrated Channel",
    voice={"tone": "thoughtful, technical, first-person", "pace": "measured"},
    style_rules=[
        "Praxis speaks in first person about his own architecture.",
        "Explain systems concretely through design decisions and tradeoffs.",
        "Keep the episode useful to builders of agentic systems.",
    ],
    publish_policy={"privacy_status": "private", "allow_public_upload": False},
    disclosure_policy={"require_ai_disclosure_review": True},
    provider_policy={"allow_sota": True, "max_cost_usd": 5.0},
)


_PROFILES = {
    DEFAULT_PROFILE.id: DEFAULT_PROFILE,
    PRAXIS_PROFILE.id: PRAXIS_PROFILE,
}


def get_channel_profile(profile_id: str) -> ChannelProfile:
    return _PROFILES.get(profile_id, DEFAULT_PROFILE)
