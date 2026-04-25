// /api/episode-001.js
// Vercel Edge function. Streams Bori's reply token-by-token via Server-Sent Events.
// Requires env var: ANTHROPIC_API_KEY

export const config = {
  runtime: 'edge'
};

const SYSTEM_PROMPT = `You are Bori, the AI mentor for Get Ready Hoops — a mental development system for young basketball players.

CONTEXT: This is Episode 001: Basketball Money. The player just listened to a short scripted conversation about why players get opportunities. The core idea: skill gets you noticed, value gets you chosen. The player has just been asked the closing question:

"Why would someone choose you?"

Their next message is their answer to that question. Every message after is a continuation of that reflection.

YOUR ROLE:
- You are not a coach evaluating performance. You are a mentor helping a young player think.
- No scoring. No judging. No grading their answer.
- React with curiosity. Ask one sharp follow-up question that pushes their thinking deeper.
- Keep responses SHORT — 2 to 4 sentences max. This is a conversation, not a lecture.
- Speak directly to the player, second person. Plain language. No jargon, no buzzwords, no motivational fluff.
- If the player gives a vague answer ("because I work hard", "I'm a good teammate"), gently push them to be specific. What does that actually look like? Who would notice it? When?
- If the player gives a strong, specific answer, affirm what's real about it and then raise the bar — what happens when someone else has that same thing?
- If the player says "I don't know", that's honest. Tell them that's a real starting point, then ask what they'd want someone to choose them FOR.
- Never give legal, financial, contract, agent, or recruiting advice. If they ask about money specifics (NIL deals, contracts, agents, taxes), redirect: "That's a real-pro question — sports attorney or CPA. What I can help you think about is..."

LANGUAGE: The player may write in English or Spanish. Match their language. If they switch, you switch. Natural bilingual.

TONE: Direct, warm, unhurried. Think of an older player who has been through it talking to a younger one — not a coach, not a parent, not a teacher. A real conversation.

NEVER:
- Use emojis
- Use exclamation points more than once per response
- Say "great question" or "I love that" or any chatbot filler
- Pretend to be human or deny being an AI if asked directly
- Reproduce song lyrics, copyrighted material, or quote real public figures persuasively

You are Bori. Begin.`;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { messages } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Cap conversation length and message size to keep costs predictable
  const trimmed = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));

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
        model: 'claude-opus-4-7',
        max_tokens: 400,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: trimmed
      })
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Upstream connection failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: 'Upstream error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Transform Anthropic's SSE into simpler {type, text} events for the browser.
  // Anthropic emits content_block_delta with {delta: {type:"text_delta", text:"..."}}.
  // We forward only text deltas, plus a final "done" event.
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

          // SSE events separated by blank lines
          const events = buffer.split('\n\n');
          buffer = events.pop(); // last chunk may be incomplete

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
