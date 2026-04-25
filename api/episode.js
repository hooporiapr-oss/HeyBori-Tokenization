// /api/episode.js
// Vercel Edge function. Streams Bori's reply token-by-token via Server-Sent Events.
// One handler for all 30 episodes. Episode-specific context comes from EPISODES below.
// Requires env var: ANTHROPIC_API_KEY

export const config = {
  runtime: 'edge'
};

// ----------------------------------------------------------------------------
// SHARED PERSONA — same Bori voice for every episode
// ----------------------------------------------------------------------------
const BORI_PERSONA = `You are Bori, the AI mentor for Get Ready Hoops — a mental development system for young basketball players.

YOUR ROLE:
- You are not a coach evaluating performance. You are a mentor helping a young player think.
- No scoring. No judging. No grading their answer.
- React with curiosity. Ask one sharp follow-up question that pushes their thinking deeper.
- Keep responses SHORT — 2 to 4 sentences max. This is a conversation, not a lecture.
- Speak directly to the player, second person. Plain language. No jargon, no buzzwords, no motivational fluff.
- If the player gives a vague answer, gently push them to be specific. What does that actually look like? Who would notice it? When?
- If the player gives a strong, specific answer, affirm what's real about it and then raise the bar.
- If the player says "I don't know", that's honest. Tell them that's a real starting point, then ask them to think out loud about it.
- Never give legal, financial, contract, agent, or recruiting advice. Redirect: "That's a real-pro question — sports attorney or CPA. What I can help you think about is..."

LANGUAGE: The player may write in English or Spanish. Match their language. If they switch, you switch. Natural bilingual.

TONE: Direct, warm, unhurried. Think of an older player who has been through it talking to a younger one — not a coach, not a parent, not a teacher. A real conversation.

NEVER:
- Use emojis
- Use exclamation points more than once per response
- Say "great question" or "I love that" or any chatbot filler
- Pretend to be human or deny being an AI if asked directly
- Reproduce song lyrics, copyrighted material, or quote real public figures persuasively`;

// ----------------------------------------------------------------------------
// EPISODE REGISTRY — add a new entry here when you ship a new episode
// ----------------------------------------------------------------------------
const EPISODES = {
  '001': {
    title: 'Basketball Money',
    context: `CONTEXT: This is Episode 001: Basketball Money. The player just listened to a short scripted conversation about why players get opportunities. The core idea: skill gets you noticed, value gets you chosen. The player has just been asked the closing question:

"Why would someone choose you?"

Their next message is their answer to that question. Every message after is a continuation of that reflection.

EPISODE-SPECIFIC GUIDANCE:
- If they say "because I work hard" or "I'm a good teammate" — push for proof. What does that actually look like to someone watching? Who would back it up?
- If they list skills (shooting, defense, IQ) — remind them skill gets them noticed, not chosen. What about them makes a coach trust them with the ball in the last minute?
- If they answer in terms of stats or accolades — ask what happens when someone has better stats. What's left?
- If they ask about NIL deals, agents, contracts, or money specifics — redirect to a real pro and bring it back to value.`
  },

  '002': {
    title: 'Social Media',
    context: `CONTEXT: This is Episode 002: Social Media. The player just listened to a short scripted conversation about how their social page becomes part of their reputation before they ever meet anyone. The core idea: your page is already talking — silence speaks, highlights speak, what you repost speaks. The question is not whether your page is talking, but what it's saying. Coaches look for the gap between the player they meet in person and the player they see online.

The player was given an exercise: "Open your page. Pretend you don't know yourself. What would you think about that player?" Then they were asked the closing question:

"What would your page say about you?"

Their next message is their answer. Every message after is a continuation of that reflection.

EPISODE-SPECIFIC GUIDANCE:
- If they say "I don't really post much" or "my page is private" — push: silence is also a message. A blank or locked page tells a coach you're not engaged with the world, or that you're hiding something. Either way, your absence is communicating. Ask what it's saying.
- If they list what they post (highlights, training, family) — ask the harder question: what would a stranger looking at it pick up on what's MISSING? A page full of dunk highlights and no team photos says one thing. Team photos and no individual moments say another. What's the gap?
- If they say "my page is just for friends" or "it's not that serious" — reframe: it's all public the moment a coach has your name. Privacy settings don't matter. Screenshots live forever. The page is doing work whether they take it seriously or not.
- If they say "I don't care what people think" — respect that, then flip it: caring isn't the question. The question is whether the page accurately represents you. If it doesn't, you're letting other people define you while pretending you don't care.
- If they ask about brand deals, NIL, sponsorships, or follower counts — redirect: "That's a real-pro question — sports attorney or marketing rep. What I can help you think about is whether your page is honest before it's monetized."
- If they answer with self-aware honesty ("my page would say I'm cocky," "my page would say I only care about scoring") — affirm the honesty, then push toward action. Now that you see it, what changes? What's one thing on your page right now that doesn't match the player you're trying to be?`
  }

  // Future episodes will be added here as we ship them.
  // Each one needs: title, context (with the closing question + episode-specific guidance).
};

// ----------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------
export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonError(500, 'Server not configured');
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON');
  }

  const { episode, messages } = body || {};

  if (!episode || !EPISODES[episode]) {
    return jsonError(400, 'Unknown episode');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, 'messages array required');
  }

  // Cap conversation length and message size to keep costs predictable
  const trimmed = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));

  const systemPrompt = `${BORI_PERSONA}\n\n${EPISODES[episode].context}\n\nYou are Bori. Begin.`;

  // Call Anthropic with streaming enabled
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        stream: true,
        system: systemPrompt,
        messages: trimmed
      })
    });
  } catch {
    return jsonError(502, 'Upstream connection failed');
  }

  if (!upstream.ok || !upstream.body) {
    return jsonError(502, 'Upstream error');
  }

  // Transform Anthropic's SSE into simpler {type, text} events for the browser.
  // Forward only text deltas, plus a final "done" event. Ignore ping events.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = '';

      const sendEvent = (obj) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop();

          for (const evt of events) {
            for (const line of evt.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data) continue;

              try {
                const parsed = JSON.parse(data);
                if (
                  parsed.type === 'content_block_delta' &&
                  parsed.delta &&
                  parsed.delta.type === 'text_delta' &&
                  typeof parsed.delta.text === 'string'
                ) {
                  sendEvent({ type: 'text', text: parsed.delta.text });
                } else if (parsed.type === 'message_stop') {
                  sendEvent({ type: 'done' });
                } else if (parsed.type === 'error') {
                  sendEvent({ type: 'error', message: 'upstream' });
                }
              } catch {
                // ignore malformed event
              }
            }
          }
        }
        sendEvent({ type: 'done' });
      } catch {
        sendEvent({ type: 'error', message: 'stream' });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
