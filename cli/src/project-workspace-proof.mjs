import { requireProject as need } from './project-source.mjs';

export function verifyWorkspaceSequence(flow, facts, changes) {
  const author = flow.authorFinal,
    reviewer = flow.reviewerFinal;
  need(changes.length > 0, 'The workspace candidate has no source changes.');
  need(
    author?.decision === 'submit' &&
      reviewer?.decision === 'approve' &&
      author.revisionId === flow.candidate &&
      reviewer.revisionId === flow.candidate,
    'Workspace change lacks submission and independent approval of the same candidate.'
  );
  need(
    facts.some(
      (f) =>
        f.role === 'author' &&
        f.tool === 'run_check' &&
        f.revision === flow.candidate &&
        f.id === author.checkId &&
        f.outcome === 'passed'
    ),
    'Workspace author lacks its passing candidate check.'
  );
  const review = facts.filter(
    (f) =>
      f.role === 'reviewer' &&
      f.attemptId === reviewer.evidence.attemptId &&
      f.revision === flow.candidate
  );
  need(
    review.some((f) => f.tool === 'changed_files') &&
      changes.every((change) =>
        review.some(
          (f) =>
            f.tool === 'read_file' &&
            f.path === change.path &&
            f.at === (change.after ? 'candidate' : 'base')
        )
      ) &&
      review.some(
        (f) => f.tool === 'run_check' && f.id === reviewer.checkId && f.outcome === 'passed'
      ),
    'Independent review lacks the actual changed source reads or its own candidate check.'
  );
  return true;
}
