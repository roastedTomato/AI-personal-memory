from dataclasses import dataclass


@dataclass
class MockAIResult:
    summary: str
    category: str
    tags: list[str]
    warnings: list[str]


def generate_draft(original_text: str, operations: list[str]) -> MockAIResult:
    """Deterministic local substitute for an external AI provider."""
    text = " ".join(original_text.split())
    summary = text[:160] + ("…" if len(text) > 160 else "")
    category = "personal"
    if any(word in text.lower() for word in ("work", "project", "meeting", "deadline")):
        category = "work"
    tags = ["mock-ai", category]
    warnings = ["This is a synthetic draft and is not verified fact."]
    return MockAIResult(summary=summary, category=category, tags=tags, warnings=warnings)
