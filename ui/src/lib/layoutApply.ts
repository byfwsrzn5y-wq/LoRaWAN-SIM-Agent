/**
 * Layout apply revision model (orchestrator `validateLayoutApply` in simulator):
 * - `body.revision` must be the current global `layoutRevision` from GET /sim-state (stale values yield HTTP 409).
 * - `items[].revision` defaults to 0 in the backend; per-item revision is not enforced in applyLayout today.
 */
export function layoutRevisionFromState(layoutRevision: number | undefined): number {
  return Number.isFinite(layoutRevision) ? Number(layoutRevision) : 0
}
