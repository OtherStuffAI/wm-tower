/**
 * SSE stream endpoint for advisory record/group change notifications.
 *
 * GET /api/v4/workspaces/:ownerNpub/stream?token=<base64>&last_event_id=<cursor>
 *
 * Phase 1 rule: streams are actor-visible, not owner-broadcast. The
 * subscription is rejected before the stream opens unless the resolved
 * actor identity is authorized for the requested workspace under the
 * rule defined in services/stream-access.ts:
 *
 *   - the actor is the workspace owner, OR
 *   - the actor signed with a valid ws_key_npub registered for that
 *     workspace AND is a current member of at least one readable group
 *     in the workspace.
 *
 * Events themselves remain advisory: they tell clients what to refresh,
 * but read access is enforced when clients pull via GET /api/v4/records.
 *
 * Auth: NIP-98 token passed as query param (signed by the actor's
 * workspace session key, or by the workspace owner directly). The token
 * is validated once on connect; the stream stays open without re-auth.
 *
 * See wingman-fd/docs/design/sse-updates.md for full design.
 */

import { Hono } from 'hono';
import { jsonAgentChatError } from '../agent-chat-errors';
import { verifyNip98AuthHeader } from '../auth';
import { resolveStreamAccess } from '../services/stream-access';
import { sseHub } from '../sse-hub';
import type { SSEClient } from '../sse-hub';

export const streamRouter = new Hono();

streamRouter.get('/:ownerNpub/stream', async (c) => {
  const ownerNpub = c.req.param('ownerNpub');
  const tokens = new URL(c.req.raw.url).searchParams.getAll('token');
  const token = tokens[0];
  const lastEventIdParam = c.req.query('last_event_id');

  if (tokens.length !== 1 || !token) {
    return c.text('Missing token', 401);
  }

  // Validate NIP-98 token from query param.
  // Build a synthetic Authorization header for the existing verifier.
  const authHeader = `Nostr ${token}`;
  const signerNpub = await verifyNip98AuthHeader(authHeader, c.req.raw, {
    excludedQueryParams: ['token'],
  });
  if (!signerNpub) {
    return c.text('Invalid or expired token', 401);
  }

  // Phase 1 actor-visible authorization. Reject before opening the stream.
  const access = await resolveStreamAccess(signerNpub, ownerNpub);
  if (!access.ok) {
    // Diagnostic line distinguishes the three identities so audit trails
    // never conflate workspace_owner_npub, actor_npub, and ws_key_npub.
    console.warn(
      '[stream] subscription rejected',
      JSON.stringify({
        workspace_owner_npub: access.ownerNpub,
        actor_npub: access.actorNpub,
        ws_key_npub: access.wsKeyNpub,
        reason: access.reason,
        reason_code: access.reasonCode,
      }),
    );
    return jsonAgentChatError(
      c,
      403,
      'sse_stream_forbidden',
      'SSE stream subscription is forbidden for this actor',
      {
        reason_code: access.reasonCode,
        workspace_owner_npub: access.ownerNpub,
        actor_npub: access.actorNpub,
        ws_key_npub: access.wsKeyNpub,
        details: {
          stream_access_reason: access.reason,
        },
      },
    );
  }

  const { actorNpub, wsKeyNpub } = access;
  console.log(
    '[stream] subscription opened',
    JSON.stringify({
      workspace_owner_npub: ownerNpub,
      actor_npub: actorNpub,
      ws_key_npub: wsKeyNpub,
    }),
  );

  // Check connection limits keyed by the resolved actor identity.
  const check = sseHub.canConnect(actorNpub, ownerNpub);
  if (!check.ok) {
    return c.text(check.reason || 'Connection limit reached', 429);
  }

  // Parse last_event_id for replay
  const lastEventId = lastEventIdParam ? parseInt(lastEventIdParam, 10) : null;

  // Hoist the client reference so cancel() can clean up on disconnect.
  let client: SSEClient | null = null;

  const stream = new ReadableStream({
    start(controller) {
      client = {
        userNpub: actorNpub,
        ownerNpub,
        controller,
        connectedAt: Date.now(),
        heartbeatTimer: null,
        lifetimeTimer: null,
      };

      sseHub.addClient(client);

      // Handle replay or catch-up-required
      if (lastEventId != null && !isNaN(lastEventId)) {
        if (sseHub.canReplay(lastEventId)) {
          sseHub.replayFrom(ownerNpub, actorNpub, lastEventId, controller);
        } else {
          // Cursor has been evicted from ring buffer
          const catchUpPayload = `event: catch-up-required\ndata: ${JSON.stringify({ reason: 'cursor_evicted' })}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(catchUpPayload));
          } catch {
            // client already gone
          }
        }
      }

      // Send initial connected event
      const connectedPayload = `event: connected\ndata: ${JSON.stringify({ event_id: sseHub.getCurrentEventId() })}\n\n`;
      try {
        controller.enqueue(new TextEncoder().encode(connectedPayload));
      } catch {
        // client already gone
      }
    },
    cancel() {
      // Stream closed by client — explicitly remove from hub to clear
      // timers and connection counts immediately rather than waiting
      // for the next failed sendRaw.
      if (client) sseHub.removeClient(client);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
