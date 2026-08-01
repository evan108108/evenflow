// Vendored GitHub webhook payloads, imported as modules.
//
// Recorded against the shapes documented at
// docs.github.com/en/webhooks/webhook-events-and-payloads. Fields we never
// read are kept deliberately — the point of a vendored fixture is that it
// is realistic, so a test that passes here passes against a real delivery.
//
// Imported as modules rather than read with node:fs. The original reason given
// here — "there is no node type surface to lean on" — was wrong (EFB-68):
// vitest pulls @types/node into this program transitively, so node:fs would
// typecheck. The real reasons to keep importing them are better ones: the JSON
// is type-checked and shape-checked at compile time rather than parsed blindly
// at runtime, and the fixtures resolve identically whatever the type surface
// happens to be.

import prOpened from "./pull_request.opened.json";
import prOpenedDraft from "./pull_request.opened_draft.json";
import prOpenedNoRef from "./pull_request.opened_no_ref.json";
import prOpenedExplicitOverride from "./pull_request.opened_explicit_override.json";
import prSynchronize from "./pull_request.synchronize.json";
import prReopened from "./pull_request.reopened.json";
import prConvertedToDraft from "./pull_request.converted_to_draft.json";
import prReadyForReview from "./pull_request.ready_for_review.json";
import prClosedMerged from "./pull_request.closed_merged.json";
import prClosedUnmerged from "./pull_request.closed_unmerged.json";
import reviewApproved from "./pull_request_review.submitted_approved.json";
import reviewChangesRequested from "./pull_request_review.submitted_changes_requested.json";
import reviewCommented from "./pull_request_review.submitted_commented.json";
import checkSuccess from "./check_run.completed_success.json";
import checkFailure from "./check_run.completed_failure.json";
import checkNeutral from "./check_run.completed_neutral.json";

export const FIXTURES = {
  "pull_request.opened": prOpened,
  "pull_request.opened_draft": prOpenedDraft,
  "pull_request.opened_no_ref": prOpenedNoRef,
  "pull_request.opened_explicit_override": prOpenedExplicitOverride,
  "pull_request.synchronize": prSynchronize,
  "pull_request.reopened": prReopened,
  "pull_request.converted_to_draft": prConvertedToDraft,
  "pull_request.ready_for_review": prReadyForReview,
  "pull_request.closed_merged": prClosedMerged,
  "pull_request.closed_unmerged": prClosedUnmerged,
  "pull_request_review.submitted_approved": reviewApproved,
  "pull_request_review.submitted_changes_requested": reviewChangesRequested,
  "pull_request_review.submitted_commented": reviewCommented,
  "check_run.completed_success": checkSuccess,
  "check_run.completed_failure": checkFailure,
  "check_run.completed_neutral": checkNeutral,
} as const;

export type FixtureName = keyof typeof FIXTURES;

/**
 * A deep copy of the named fixture. Copying matters: tests mutate payloads
 * (retargeting refs at a real short id), and a shared module object would
 * leak those edits into every later test in the file.
 */
export const fixture = (name: FixtureName): Record<string, unknown> =>
  structuredClone(FIXTURES[name]) as Record<string, unknown>;
