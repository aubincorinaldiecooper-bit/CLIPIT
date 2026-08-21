import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { summariseLearning } from '../../db/repositories/clipRequests.js';
import type { LearningReportJob } from '../../queues/index.js';

/**
 * What the last day of use taught us, once a day, in the logs.
 *
 * Footage is deleted when a session ends, so this is the form the learning
 * takes: not a copy of anyone's video, but a record of what people asked for
 * and whether we could answer it. See docs/learning-loop.md.
 *
 * Nothing here changes a prompt or a threshold on its own, and it should not
 * until there are known-good videos to test a change against. A system that
 * rewrites itself from user reactions with no way to check the rewrite gets
 * quietly worse, and the same signal that caused the change is the only thing
 * measuring it.
 */
export async function handleLearningReport(job: Job<LearningReportJob>): Promise<void> {
  const log = logger.child({ job: 'learning-report', jobId: job.id });
  const summary = await summariseLearning(env.LEARNING_REPORT_HOURS);

  const answered = summary.answeredFromNotes + summary.answeredFromFootage;
  if (answered === 0 && summary.approved + summary.rejected === 0) {
    log.info('nothing to learn from yet', { hours: env.LEARNING_REPORT_HOURS });
    return;
  }

  log.info('what we learned', {
    hours: env.LEARNING_REPORT_HOURS,
    // Is reading at upload paying off? This is the number that says so.
    answeredFromMemory: summary.answeredFromNotes,
    answeredFromFootage: summary.answeredFromFootage,
    memoryShare: answered > 0 ? Number((summary.answeredFromNotes / answered).toFixed(2)) : null,
    // The notes were read and had nothing. Distinct from a video with no notes.
    notesSilent: summary.notesSilent,
    // People telling us we were wrong. The strongest signal we collect.
    corrections: summary.corrections,
    approved: summary.approved,
    rejected: summary.rejected,
    // If these two are close, confidence is decoration and the label a person
    // reads is not earning its authority.
    averageConfidenceApproved: summary.averageConfidenceApproved,
    averageConfidenceRejected: summary.averageConfidenceRejected,
  });

  // The part worth actually reading: things people wanted from their video
  // that nobody thought to write down at upload. A recurring subject here is a
  // line missing from the indexing prompt.
  if (summary.questionsNotesCouldNotAnswer.length > 0) {
    log.info('questions the notes could not answer', {
      questions: summary.questionsNotesCouldNotAnswer,
    });
  }
}
