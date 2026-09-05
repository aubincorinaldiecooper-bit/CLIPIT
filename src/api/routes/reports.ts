import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { HttpError } from '../../lib/errors.js';
import { getVideo } from '../../db/repositories/videos.js';
import { getClipRequest } from '../../db/repositories/clipRequests.js';
import { listClipsForRequest } from '../../db/repositories/clips.js';
import { listPlatformReports, markReportHandedOff, recordPlatformReport } from '../../db/repositories/platformReports.js';
import { handOffToGitHub, reportSchema, snapshotContext } from '../../services/reports/platformReports.js';
import { assertOwnership, ownerScope, requireSession } from '../auth.js';
import { enforceRateLimits, HOUR, MINUTE } from '../rateLimit.js';
import { parse } from '../validation.js';

function ownerEmails(): string[] {
  return (env.EVAL_OWNER_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

/**
 * Problems with Clipit, reported from the page they happened on.
 *
 * The report is kept with what the server knew about the video and the
 * question at that moment — only for rows the person owns; an id that is
 * not theirs is dropped, never refused, because the words still matter —
 * and handed off to be fixed where configuration says (see
 * services/reports/platformReports.ts). The owner's listing is gated the
 * way the evaluation is: by sign-in address, 404 for everyone else.
 */
export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/reports', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'reports', perSession: env.RATE_LIMIT_REPORTS_PER_SESSION_HOURLY, windowSeconds: HOUR },
    ]);
    const body = parse(reportSchema, request.body);
    const scope = ownerScope(request);

    let video = body.videoId ? await getVideo(body.videoId) : null;
    if (video) {
      try {
        assertOwnership(request, video, 'Video');
      } catch {
        video = null;
      }
    }
    let clipRequest = body.clipRequestId ? await getClipRequest(body.clipRequestId) : null;
    if (clipRequest) {
      try {
        assertOwnership(request, clipRequest, 'Clip request');
      } catch {
        clipRequest = null;
      }
    }
    const clips = clipRequest ? await listClipsForRequest(clipRequest.id) : [];

    const report = await recordPlatformReport({
      sessionId: scope.sessionId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      page: body.page,
      message: body.message,
      videoId: video?.id ?? null,
      clipRequestId: clipRequest?.id ?? null,
      context: snapshotContext({ viewport: body.viewport, video, clipRequest, clips }) as unknown as Record<string, unknown>,
      userAgent: body.userAgent,
    });

    // The log line is the one channel that needs no configuration.
    logger.info('platform report received', {
      reportId: report.id,
      page: report.page,
      videoId: report.videoId,
      clipRequestId: report.clipRequestId,
      sessionId: report.sessionId,
      chars: report.message.length,
    });

    let handedOffTo: string | null = null;
    try {
      handedOffTo = await handOffToGitHub(report);
      if (handedOffTo) await markReportHandedOff(report.id, handedOffTo);
    } catch (error) {
      // The report is safe in the database; only the hand-off failed.
      logger.error('platform report could not be handed off', { reportId: report.id, err: error });
    }

    return reply.code(201).send({ report: { id: report.id, handedOff: handedOffTo !== null } });
  });

  app.get('/api/reports', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);
    const owners = ownerEmails();
    const email = request.principal?.email?.trim().toLowerCase() ?? null;
    if (owners.length === 0 || !email || !owners.includes(email)) {
      throw HttpError.notFound('Not found');
    }
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), request.query ?? {}, 'query parameters');
    const reports = await listPlatformReports(limit);
    return reply.send({
      reports: reports.map((report) => ({
        ...report,
        createdAt: report.createdAt.toISOString(),
        resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
      })),
    });
  });
}
