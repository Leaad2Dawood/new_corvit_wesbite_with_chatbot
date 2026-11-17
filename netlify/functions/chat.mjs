// Netlify Function: POST /.netlify/functions/chat
// Proxies chat messages to Dify (blocking mode). The API key stays on the server.
//
// Request body:  { "query": string, "conversation_id"?: string, "user"?: string }
// Success body:  { "answer": string, "conversation_id": string, "message_id": string }
// Error body:    { "error": string, "code": string, "details"?: string }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MAX_QUERY_LENGTH = 2000;
const MAX_BODY_BYTES = 10_000;
const DIFY_TIMEOUT_MS = 24_000;

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function fail(status, code, error, details) {
  return json(status, details ? { error, code, details } : { error, code });
}

// Builds the Dify API base URL.
// - Default: Dify Cloud API (https://api.dify.ai/v1)
// - DIFY_BASE_URL may be "https://dify.ai", "https://api.dify.ai/v1" or a self-hosted URL.
//   "/v1" is added when missing; the dify.ai marketing hosts map to api.dify.ai.
function resolveBaseUrl() {
  const raw = (process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname === 'dify.ai' || url.hostname === 'www.dify.ai') {
    url.hostname = 'api.dify.ai';
  }
  let base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  if (!/\/v1$/.test(base)) base += '/v1';
  return base;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return fail(405, 'method_not_allowed', 'Use POST for this endpoint.');
  }

  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    console.error('DIFY_API_KEY is not set in the Netlify environment.');
    return fail(500, 'missing_api_key', 'The chat service is not configured yet. Please contact the campus directly.');
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    console.error('DIFY_BASE_URL is not a valid URL.');
    return fail(500, 'invalid_base_url', 'The chat service is misconfigured. Please contact the campus directly.');
  }

  // Parse and validate the request body.
  let raw;
  try {
    raw = await req.text();
  } catch {
    return fail(400, 'invalid_request', 'Could not read the request body.');
  }
  if (raw.length > MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large', 'Message is too large.');
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return fail(400, 'missing_query', 'Please type a message.');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return fail(400, 'query_too_long', `Messages are limited to ${MAX_QUERY_LENGTH} characters.`);
  }

  const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id.trim().slice(0, 100) : '';
  const user = (typeof body?.user === 'string' ? body.user.trim() : '').replace(/[^\w.\-]/g, '').slice(0, 100) || 'corvit-student';

  // Call Dify.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIFY_TIMEOUT_MS);

  let difyRes;
  try {
    difyRes = await fetch(`${baseUrl}/chat-messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {},
        query,
        response_mode: 'blocking',
        conversation_id: conversationId || '',
        user,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      return fail(504, 'dify_timeout', 'The advisor took too long to answer. Please try again.');
    }
    console.error('Network error calling Dify:', err);
    return fail(502, 'dify_unreachable', 'Could not reach the AI service. Please try again shortly.');
  }
  clearTimeout(timer);

  let data = null;
  const text = await difyRes.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!difyRes.ok) {
    const difyMessage = data?.message || data?.error || text.slice(0, 300) || `HTTP ${difyRes.status}`;
    console.error(`Dify error ${difyRes.status}:`, difyMessage);

    // A stale conversation id: let the client start a fresh conversation.
    if (difyRes.status === 404 && conversationId) {
      return fail(404, 'conversation_not_found', 'That conversation expired. Starting a new one.', difyMessage);
    }
    if (difyRes.status === 401 || difyRes.status === 403) {
      return fail(502, 'dify_auth_failed', 'The chat service rejected its credentials. Please contact the campus directly.');
    }
    if (difyRes.status === 429) {
      return fail(429, 'rate_limited', 'The advisor is busy right now. Please try again in a moment.');
    }
    if (difyRes.status === 400) {
      return fail(400, 'dify_bad_request', 'The advisor could not process that message.', difyMessage);
    }
    return fail(502, 'dify_error', 'The AI service returned an error. Please try again.', difyMessage);
  }

  if (!data || typeof data.answer !== 'string') {
    console.error('Unexpected Dify response shape:', text.slice(0, 300));
    return fail(502, 'dify_bad_response', 'The AI service sent an unexpected reply. Please try again.');
  }

  return json(200, {
    answer: data.answer,
    conversation_id: data.conversation_id || conversationId || '',
    message_id: data.message_id || data.id || '',
  });
};
