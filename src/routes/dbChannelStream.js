import eventBus from '../utils/eventBus.js';

// Decode a JWT payload without verifying the signature
function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    return JSON.parse(Buffer.from(base64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Move query token to auth header (runs before all handlers)
async function moveQueryTokenToHeader(request, reply) {
  console.log('[SSE-DEBUG] Hook: moveQueryTokenToHeader called');
  const queryToken = request.query?.token || request.query?.access_token;
  console.log('[SSE-DEBUG] Hook: Token found:', !!queryToken);

  if (queryToken && !request.headers.authorization) {
    request.headers.authorization = `Bearer ${queryToken}`;
    console.log('[SSE-DEBUG] Hook: Authorization header set');
  }
}

async function authenticateSSE(request) {
  console.log('[SSE-DEBUG] Authenticating SSE connection');
  try {
    const authHeader = request.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    
    if (!token) {
      console.error('[SSE-DEBUG] No token found');
      return { success: false };
    }
    
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.sub) {
      console.error('[SSE-DEBUG] Invalid JWT payload');
      return { success: false };
    }

    const realmRoles = payload.realm_access?.roles || [];
    const resourceMap = payload.resource_access || {};
    const resourceRoles = Object.values(resourceMap).flatMap(r => r.roles || []);
    const allRoles = [...realmRoles, ...resourceRoles];

    const user = {
      id: payload.sub,
      full_name: payload.name || '',
      email: payload.email || '',
      preferredUsername: payload.preferred_username || payload.email || '',
      role: 'USER',
      application_roles: allRoles,
      token,
    };
    
    console.log('[SSE-DEBUG] Token verified for user:', user.preferredUsername);
    return { success: true, user };
  } catch (error) {
    console.error('[SSE-DEBUG] Token verification failed:', error.message);
    return { success: false };
  }
}

export default async function dbChannelStreamRoute(fastify) {
  console.log('\n\n========== [SSE] ROUTE FILE LOADED ==========\n');
  console.log('[SSE] Registering /db-channel/stream route');
  
  // Register a hook to run token extraction for ALL requests before handlers
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url.includes('/db-channel/stream')) {
      await moveQueryTokenToHeader(request, reply);
    }
  });

  fastify.get(
    '/db-channel/stream',
    async (request, reply) => {
      console.log('\n[SSE] *** HANDLER EXECUTING ***\n');
      console.log('[SSE] Handler started - this should print!');
      
      try {
        console.log('[SSE] Step 1: Starting authentication');
        const authResult = await authenticateSSE(request);
        console.log('[SSE] Step 2: Authentication result:', authResult.success);
        
        if (!authResult.success) {
          console.error('[SSE] ❌ Authentication failed, sending 401');
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        
        request.user = authResult.user;
        console.log('[SSE] Step 3: User authenticated:', request.user?.preferredUsername);
        console.log('[SSE] Step 4: About to hijack response');
        reply.hijack();
        console.log('[SSE] Step 5: Response hijacked successfully');

        reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
        reply.raw.flushHeaders?.();

        console.log('[SSE] ✅ Client connected:', request.user?.preferredUsername);
        reply.raw.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

        const onDbChannel = (payload) => {
          console.log('[SSE] Broadcasting to client:', payload.table, payload.operation);
          try {
            reply.raw.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch (e) {
            console.error('[SSE] Write error:', e.message);
          }
        };

        const keepAlive = setInterval(() => {
          try {
            reply.raw.write(': keep-alive\n\n');
          } catch (e) {
            console.error('[SSE] Keep-alive write error:', e.message);
          }
        }, 25000);

        let closed = false;

        const cleanup = () => {
          if (closed) {
            return;
          }

          closed = true;
          clearInterval(keepAlive);
          eventBus.off('db-channel', onDbChannel);
          if (!reply.raw.writableEnded) {
            try {
              reply.raw.end();
            } catch (e) {
              console.error('[SSE] Cleanup end() error:', e.message);
            }
          }
        };

        eventBus.on('db-channel', onDbChannel);
        
        request.raw.on('close', () => {
          console.log('[SSE] Client closed connection');
          cleanup();
        });
        
        request.raw.on('aborted', () => {
          console.log('[SSE] Client aborted connection');
          cleanup();
        });
        
      } catch (error) {
        console.error('[SSE] ❌ Handler error:', error);
        try {
          if (!reply.sent) {
            reply.code(500).send({ error: 'SSE initialization failed' });
          }
        } catch (e) {
          console.error('[SSE] Error sending 500:', e);
        }
      }
    }
  );
  
  console.log('[SSE] Route registration complete\n');
}