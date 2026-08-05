# Orchestrator integration

xtctx provides local continuity fabric for an external orchestrator. It does
not create tasks, schedule harnesses, lock work, or persist generated handoff
summaries.

## Read-only handoff contract

Call `xtctx_handoff_manifest` when the control plane needs a project-scoped
snapshot of candidate handoffs.

```json
{
  "correlation_id": "orchestrator:task-42",
  "session_refs": ["codex:session-a"],
  "format": "json"
}
```

The response has schema version `xtctx/handoff-manifest/v1`. Each session has:

- `handoff_id`: the stable, project-scoped `session_ref`
- source tool, activity timestamps, and message count
- a `retrieve` pointer for `xtctx_session_detail`

`correlation_id` is supplied and owned by the caller. xtctx only echoes it in
the response. It never writes it into local state or infers task state from a
transcript.

## Recommended control-plane flow

1. Assign a harness and create the orchestrator's own task/correlation ID.
2. Call `xtctx_handoff_manifest` with that correlation ID and optional session
   or tool filters.
3. Give the selected harness the returned `retrieve` pointers.
4. The harness calls `xtctx_session_detail` for raw source material.
5. Persist task outcome, ownership, artifacts, and retry state in the
   orchestrator—not in xtctx.

The manifest is metadata. Raw transcript messages remain authoritative.

## Scope and limits

- Handoff IDs are unique within a project because they are session references.
- `tool_filter`, `session_refs`, and `limit` constrain manifest selection.
- xtctx does not supply durable task IDs, branch state, leases, scheduler
  status, approvals, or generated summaries. Those belong to the control
  plane.
- The manifest is generated from local indexed sessions and includes freshness
  metadata. A caller should treat `last_scan_at` as the source of truth for its
  retrieval window.
