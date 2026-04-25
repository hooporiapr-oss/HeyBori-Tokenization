// /api/access.js
// Vercel Edge function. Handles access token issuance and validation.
// Stripe is the source of truth (Option A): every check looks up purchases in Stripe.
//
// Three flows:
//   POST /api/access  with {action: "verify_session", session_id}
//     → Used after Stripe checkout success redirect.
//     → Verifies session paid, returns access token + unlocks.
//
//   POST /api/access  with {action: "recover", email}
//     → Used on the "lost my access" recovery flow.
//     → Looks up customer in Stripe, emails magic link if purchases exist.
//
//   POST /api/access  with {action: "validate", token}
//     → Used by episode pages to verify a stored access token.
//     → Returns what tiers it unlocks.
//
// Required env:
//   STRIPE_SECRET_KEY     — Stripe API key
//   ACCESS_TOKEN_SECRET   — 32+ char random string for signing tokens
//   RESEND_API_KEY        — for sending magic-link emails (optional until recover flow used)
//   EMAIL_FROM            — verified sender address (e.g. "Get Ready Hoops <hi@getreadyhoops.com>")

export const config = {
  runtime: 'edge'
};

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const TOKEN_VERSION = 'v1';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year — buyers re-verify yearly via email

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------
export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.ACCESS_TOKEN_SECRET) {
    return jsonError(500, 'Server not configured');
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON');
  }

  const { action } = body || {};

  if (action === 'verify_session') return verifySession(body);
  if (action === 'recover')        return recoverAccess(body, req);
  if (action === 'validate')       return validateToken(body);

  return jsonError(400, 'Unknown action');
}

// ---------------------------------------------------------------------------
// FLOW 1 — Verify Stripe session and issue access token
// Called by /access.html after redirect from Stripe checkout success
// ---------------------------------------------------------------------------
async function verifySession({ session_id }) {
  if (!session_id || typeof session_id !== 'string') {
    return jsonError(400, 'session_id required');
  }

  const session = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(session_id)}`);
  if (!session) return jsonError(404, 'Session not found');

  if (session.payment_status !== 'paid') {
    return jsonError(402, 'Payment not completed');
  }

  const unlocks = (session.metadata && session.metadata.unlocks) || '';
  const email = (session.customer_details && session.customer_details.email) ||
                session.customer_email || '';

  if (!unlocks || !email) {
    return jsonError(500, 'Incomplete session data');
  }

  const tiers = unlocks.split(',').map(s => s.trim()).filter(Boolean);
  const token = await signToken({ email: email.toLowerCase(), tiers });

  return jsonOK({ token, tiers, email });
}

// ---------------------------------------------------------------------------
// FLOW 2 — Recover access by email lookup
// Buyer types email on /access.html, we check Stripe for past purchases,
// email them a fresh magic link if any are found.
// ---------------------------------------------------------------------------
async function recoverAccess({ email }, req) {
  if (!email || typeof email !== 'string') {
    return jsonError(400, 'email required');
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return jsonError(400, 'invalid email');
  }

  // Always return success regardless of whether the email exists.
  // This prevents email enumeration. The actual email only sends if there's a purchase.
  const ack = jsonOK({ ok: true });

  // Background-style: fire off the lookup but don't block the response.
  // Edge runtime doesn't have ctx.waitUntil here cleanly, so we await briefly
  // but cap to keep the response fast.
  try {
    await processRecovery(normalized, req);
  } catch (err) {
    console.error('Recovery error:', err);
    // Still return ack — don't reveal whether email exists
  }

  return ack;
}

async function processRecovery(email, req) {
  // 1. Find Stripe customer(s) with this email
  const customersRes = await stripeGet(`/v1/customers?email=${encodeURIComponent(email)}&limit=10`);
  if (!customersRes || !customersRes.data || customersRes.data.length === 0) {
    return; // No customer with that email — silently no-op
  }

  // 2. For each customer, list their successful checkout sessions and collect unlocks
  const allTiers = new Set();
  for (const customer of customersRes.data) {
    const sessions = await stripeGet(
      `/v1/checkout/sessions?customer=${encodeURIComponent(customer.id)}&limit=100`
    );
    if (!sessions || !sessions.data) continue;

    for (const s of sessions.data) {
      if (s.payment_status === 'paid' && s.metadata && s.metadata.unlocks) {
        s.metadata.unlocks.split(',').forEach(t => {
          const trimmed = t.trim();
          if (trimmed) allTiers.add(trimmed);
        });
      }
    }
  }

  if (allTiers.size === 0) {
    return; // Customer exists but no paid purchases — silently no-op
  }

  // 3. Mint a token covering all tiers this email has ever purchased
  const tiers = Array.from(allTiers);
  const token = await signToken({ email, tiers });

  // 4. Build the magic link
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const magicLink = `${origin}/access.html?token=${encodeURIComponent(token)}`;

  // 5. Email it
  await sendMagicLinkEmail(email, magicLink, tiers);
}

// ---------------------------------------------------------------------------
// FLOW 3 — Validate an existing access token
// Called by paid episode pages on load to confirm access is still valid.
// ---------------------------------------------------------------------------
async function validateToken({ token }) {
  if (!token || typeof token !== 'string') {
    return jsonError(400, 'token required');
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return jsonError(401, 'invalid or expired token');
  }

  return jsonOK({ tiers: payload.tiers, email: payload.email });
}

// ---------------------------------------------------------------------------
// TOKEN SIGNING — HMAC-SHA256 signed JSON, base64url encoded
// Format: <base64url(payload)>.<base64url(signature)>
// ---------------------------------------------------------------------------
async function signToken({ email, tiers }) {
  const payload = {
    v: TOKEN_VERSION,
    email,
    tiers,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payloadJson));
  const sig = await hmacSign(payloadB64, process.env.ACCESS_TOKEN_SECRET);
  return `${payloadB64}.${sig}`;
}

async function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  const expectedSig = await hmacSign(payloadB64, process.env.ACCESS_TOKEN_SECRET);
  if (!constantTimeEqual(sig, expectedSig)) return null;

  try {
    const json = new TextDecoder().decode(b64urlDecode(payloadB64));
    const payload = JSON.parse(json);
    if (payload.v !== TOKEN_VERSION) return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.email || !Array.isArray(payload.tiers)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

function b64urlEncode(bytes) {
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ---------------------------------------------------------------------------
// STRIPE HELPER
// ---------------------------------------------------------------------------
async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
    }
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    const txt = await res.text();
    console.error('Stripe API error:', res.status, txt);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// EMAIL — Resend
// ---------------------------------------------------------------------------
async function sendMagicLinkEmail(email, magicLink, tiers) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.warn('Email not configured; would have sent:', email, magicLink);
    return;
  }

  const tierLabels = tiers.map(t => {
    if (t === 'level2') return 'Level 2: Separation';
    if (t === 'level3') return 'Level 3: Mastery';
    return t;
  }).join(' & ');

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:32px;background:#07070b;font-family:Arial,sans-serif;color:#f4f1e8;">
  <div style="max-width:560px;margin:0 auto;background:#101018;border-radius:16px;padding:32px;">
    <div style="font-weight:900;letter-spacing:2px;font-size:18px;text-transform:uppercase;margin-bottom:24px;">
      Get Ready <span style="color:#e8b94a;">Hoops</span>
    </div>
    <h1 style="font-size:24px;margin:0 0 12px;color:#f4f1e8;">Your Access Link</h1>
    <p style="color:#b9b4a8;font-size:15px;line-height:1.55;margin:0 0 24px;">
      Click below to unlock <strong style="color:#e8b94a;">${tierLabels}</strong>. This link is tied to your purchase.
    </p>
    <a href="${magicLink}" style="display:inline-block;background:#e8b94a;color:#111;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:800;letter-spacing:1px;text-transform:uppercase;font-size:14px;">
      Unlock My Access
    </a>
    <p style="color:#858585;font-size:13px;line-height:1.5;margin:32px 0 0;">
      If you didn't request this, you can ignore this email. The link expires in 1 year — request a new one any time at getreadyhoops.com/access.html
    </p>
  </div>
  <div style="max-width:560px;margin:16px auto 0;text-align:center;color:#555;font-size:11px;">
    © 2026 Get Ready Hoops · Educational content only.
  </div>
</body></html>`.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: email,
        subject: 'Your Get Ready Hoops Access Link',
        html
      })
    });
    if (!res.ok) {
      console.error('Resend error:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

// ---------------------------------------------------------------------------
// RESPONSE HELPERS
// ---------------------------------------------------------------------------
function jsonOK(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
