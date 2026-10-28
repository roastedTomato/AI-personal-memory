# Query Router (M4.6.3)

`execute_query_plan(plan, db)` in `app/services/query_router.py` accepts a
`QueryPlan` or dictionary and returns a Pydantic `QueryResult`. Use
`result.model_dump(mode="json")` for JSON-compatible data. It does not call the
classifier or answer generator, expose an API, or execute future tools.

## Execution contract

- Revalidate the complete plan before retrieval. Clarification and future tools
  block the entire plan; no partial results are substituted.
- Execute relational stages: all structured filters, all keyword matches, all
  semantic matches, sorting, then limits. This is not a general sequential data
  pipeline: a serialized limit before a filter still limits the filtered results.
  `applied_operations` reports this execution order. The M4.6.2 schema is unchanged.
- Filters/matches combine with AND. Multiple sort keys retain input priority;
  NULLs sort last. Explicit sorting takes precedence over semantic relevance.
  Otherwise semantic matches rank by mean cosine similarity, with each match
  independently meeting the existing 0.25 threshold. IDs break ties. Multiple
  limits use their minimum; without a limit every match is returned.
- Each tool enforces LOCAL_USER_ID and states `confirmed` or `accepted`. Unknown
  states are excluded. There are no commits, writes, or automatic keyword fallbacks.
- SQLAlchemy binds all values and uses allowlisted columns/operators. Ordinary
  comparisons exclude SQL NULL; explicit null predicates are available. Dates,
  timezone-aware timestamps, and Decimal amounts use typed parameters.
- Keyword search reuses existing case-insensitive substring matching over title,
  confirmed content, category, and tags, adding confirmed image text. It excludes
  original/draft text and treats `%`, `_`, and backslash literally.
- Semantic search reuses embedding generation, text hashing, model/dimension/status
  eligibility, and pgvector cosine distance. Structured and keyword constraints
  apply before ranking; no implicit Top-K truncation is introduced.

## Example

```python
result = execute_query_plan({
    "version": "1",
    "operations": [
        {"operation": "filter", "field": "category", "operator": "eq", "value": "event"},
        {"operation": "filter", "field": "event_date", "operator": "gte", "value": "2026-10-29"},
        {"operation": "sort", "field": "event_date", "direction": "asc", "nulls": "last"},
        {"operation": "limit", "count": 1}
    ],
    "clarification_questions": []
}, db)
```

Illustrative results (IDs depend on stored records):

```json
{
  "status": "completed",
  "memories": [{"memory_id": 43, "title": "Community event", "citation": "[Memory 43]", "memory_url": "/memories/43", "source_type": "manual", "source_image_url": null, "confirmed_content": "Title: Community event\nContent: Reviewed event information\nCategory: event\nEvent date: 2026-11-01", "event_date": "2026-11-01", "due_date": null, "amount": null, "currency": null, "location": null, "reminder_at": null, "relevance": null}],
  "retrieval_method": ["structured_search"],
  "applied_operations": [
    {"operation": "filter", "field": "category", "operator": "eq", "value": "event"},
    {"operation": "filter", "field": "event_date", "operator": "gte", "value": "2026-10-29"},
    {"operation": "sort", "field": "event_date", "direction": "asc", "nulls": "last"},
    {"operation": "limit", "count": 1}
  ],
  "clarification_questions": [],
  "unsupported_capabilities": [],
  "error": null
}
```

Empty successful searches use `no_matches`. Other statuses are
`needs_clarification`, `requires_future_tools`, `invalid_plan`, and
`execution_failed`. Errors contain bounded codes/messages, never SQL, provider
output, or document content. Blocked/failed queries return no Memory records or
applied operations. Source URLs use existing owner-scoped endpoints, never local
file paths; citations retain the original Memory ID.

## Verification and next milestone

Run `.venv/bin/pytest -q tests/test_query_plan.py tests/test_query_router.py`.
Router tests use a disposable in-memory SQLite database, a local cosine function
for the pgvector operator, PostgreSQL SQL compilation checks, and mocked embedding
calls. They do not establish live PostgreSQL/pgvector integration or live model
accuracy. Database-dependent regression tests require an isolated PostgreSQL test
configuration; never run record-deleting tests against personal data.

Structured dates use typed columns only: legacy JSON-only dates remain absent.
Hash validation scans eligible records in Python, and unlimited plans can return
large result sets. The similarity threshold is still uncalibrated. Text tags
retain substring semantics. Amounts are compared as stored, without currency
conversion or inference of payment status. LOCAL_USER_ID remains local identity.

For M4.6.4, define how the Result Aggregator consumes confirmed content, structured
fields, scores, and citations while preserving empty/blocked/error statuses. Token
budgets and any pagination policy must be explicit; geographic, currency, and
aggregate operations remain blocked future capabilities. The existing Q&A endpoint
and Answer Generator have not been integrated or changed.
