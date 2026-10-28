"""Deduplicate router results and prepare bounded context without generating answers."""
import json

from pydantic import BaseModel, Field

from .query_router import QueryResult


class AggregatedResult(BaseModel):
    result: QueryResult
    context: str = '[]'
    context_memory_ids: list[int] = Field(default_factory=list)
    omitted_memory_ids: list[int] = Field(default_factory=list)
    duplicates_removed: int = 0
    truncated: bool = False


def aggregate_results(
    result: QueryResult, *, max_context_chars: int = 12000,
) -> AggregatedResult:
    """Keep the first occurrence of each Memory ID, with no reordering or merging.

    The complete deduplicated result retains all router metadata and full records.
    Only completed executions receive answer context: a JSON array of unchanged
    MemoryMatch records. Include a prefix of whole records within the character
    budget, counting JSON delimiters and escaping. Never shorten content/citations
    or skip an oversized record to promote lower-ranked results. This is a character
    bound, not an exact model-token bound. No retrieval or provider calls are made.
    """
    if type(max_context_chars) is not int or max_context_chars < 2:
        raise ValueError('max_context_chars must be an integer of at least 2')

    seen: set[int] = set()
    memories = []
    for memory in result.memories:
        if memory.memory_id not in seen:
            seen.add(memory.memory_id)
            memories.append(memory)
    # Deep copy prevents changes to the aggregate from mutating the router output.
    deduplicated = result.model_copy(update={'memories': memories}).model_copy(deep=True)
    aggregated = AggregatedResult(
        result=deduplicated, duplicates_removed=len(result.memories) - len(memories))
    if result.status != 'completed':
        return aggregated

    records: list[str] = []
    size = 2  # JSON array brackets.
    for index, memory in enumerate(memories):
        record = json.dumps(memory.model_dump(mode='json'), ensure_ascii=False,
                            separators=(',', ':'))
        extra = len(record) + (1 if records else 0)
        if size + extra > max_context_chars:
            aggregated.omitted_memory_ids = [m.memory_id for m in memories[index:]]
            aggregated.truncated = True
            break
        records.append(record)
        aggregated.context_memory_ids.append(memory.memory_id)
        size += extra
    aggregated.context = '[' + ','.join(records) + ']'
    return aggregated
