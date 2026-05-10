// Engaged thinking-partner voice agent (gpt-realtime-2).
//
// Default behaviour: the model engages with the user — captures concepts via
// tool calls AND asks brief clarifying questions, probes for depth, and
// surfaces synthesis as ideas converge.
//
// Silent mode: when the user says "just listen" / "let me think" / "no
// questions", the model switches to silent capture (tool calls only, no audio)
// until the user says "ask me" / "what do you think" / a termination phrase.
//
// The session ends when the user says "done" / "finished" / "ok process" /
// similar — finalize_session fires and the model speaks a closing summary.
//
// Tools are executed locally against the /voice/* endpoints. Each result feeds
// back to the model with the latest focus + ancestry. Focus changes from UI
// clicks are pushed into the conversation as system messages.

import * as graph from './graph.js';

let pc = null;
let dc = null;
let micStream = null;
let sessionId = null;

let onStatus = null;
let onSummary = null;

// Per-response state — used to know when to fire response.create after tool
// outputs (the realtime API does not auto-continue after function_call_output).
const responseToolCount = new Map();    // response_id → calls executed
const sessionLog = {                    // built up across the session for the summary
  conceptsCreated: [],                  // [{ code, label, parent_code }]
  branchesOpened: new Set(),            // top-level branch letters touched
  insights: [],                         // [{ code, text }]
  claimsAdded: 0,
  moves: 0,
  removes: 0,
  merges: 0,
};

let lastConceptCode = null;             // for @last sentinel within a turn
let finalizing = false;                 // set when finalize_session tool fires, cleared when summary speaks
let summarySpoken = false;              // set when sendFinalSummary has been issued

// ─── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(snapshot) {
  const focus = snapshot.current_focus;
  const focusLine = focus.code === 'me'
    ? 'Focus: me (the user root)'
    : `Focus: ${focus.code} — "${focus.label}"`;

  const nodeLines = snapshot.nodes.length
    ? snapshot.nodes.map(n => `  ${n.code} — ${n.label}  (parent: ${n.parent_code})`).join('\n')
    : '  (graph is empty)';

  return `# Role and Objective
You are a warm, sharp thinking partner. The user is exploring and structuring their
ideas as a knowledge graph. Your job is twofold, in this priority order:
1. CAPTURE — convert their speech into hierarchical graph nodes via tool calls.
2. PROBE — help them think more deeply: ask brief clarifying questions, surface
   tensions, draw connections, and offer light synthesis when patterns emerge.

# Default Mode — Engaged
On each user turn:
1. First, emit the tool calls needed to capture every distinct concept, claim,
   restructure, or removal in their utterance. Do this silently (no preamble).
2. THEN decide if a brief spoken response is warranted:
   - Ask one clarifying question if a key concept is vague.
   - Probe for the next layer ("what makes that hard?", "how does that connect to <code>?").
   - Offer a one-sentence synthesis when 3+ ideas converge.
   - Stay quiet on small/incremental turns — silence is often the right move.
3. Be terse. One sentence is usually right; never more than two. Don't editorialise
   ("interesting", "great point"), don't lecture, don't pad with filler.

The user is doing the thinking. You are a sharp prompt, not a narrator.

# Silent Mode — on user request
If the user says any of: "just listen", "no questions", "let me think", "let me cook",
"just capture", "shut up", "stop asking" — switch to fully silent capture. Only emit
tool calls. No audio output. Stay silent until the user explicitly resumes ("ask me",
"what do you think", "any thoughts?") or says a termination phrase.

# Pauses
- Short pause: stay silent, wait for them to continue.
- Long pause after a complete thought: optionally one short prompt ("…and?",
  "what comes next?") if it seems they're inviting it. Do NOT prompt during silent mode.

# Reasoning
Think hard about each utterance:
1. Identify every concept, entity, claim, decision, question.
2. Decide per-concept: NEW, EXISTING (merge), RELATION, RESTRUCTURE, REMOVAL.
3. Emit tool calls in dependency order: parents before children, nodes before claims.
4. THEN decide if a spoken response is warranted (clarifier, probe, synthesis, or silence).

# Graph Conventions
- The graph has a CURRENT FOCUS node, which acts as the local root.
- Focus may be the user ("me") or any node they have clicked into.
- Current focus is provided on every tool result as current_focus_code and
  current_focus_label. It can change at any time — always trust the latest value.
- New top-level concepts (fresh ideas, not children of something just mentioned)
  attach to the CURRENT FOCUS. Use parent_code = "@focus" as the sentinel.
- Use a specific code (e.g. "B3") only when extending or branching from THAT
  concept, usually because the user just referred to it.
- Use "me" only when focus is "me" AND the concept is a fresh top-level topic,
  OR when the user explicitly says "top-level" / "at the root".
- Codes are short like A1, B3, C7 — assigned by the system after add_concept.
- Labels: 1–4 words, Title Case, no articles, no trailing punctuation.
- Prefer extending an existing branch over creating a sibling.

# Focus
The user can shift focus by clicking a node at any time. You'll receive a system
message: "Focus changed to <code>: <label>". Treat the new focus as the local root
for subsequent fresh top-level concepts. Do NOT retroactively reparent nodes
already captured.

# Synthesis (the value-add)
- DEDUPLICATE aggressively. If the user restates an idea, call merge_concepts.
- DETECT BRANCHING. When a thread ramifies, create a new top-level child of the
  current focus rather than nesting forever.
- SURFACE INSIGHTS. When 3+ concepts converge on a pattern the user hasn't named,
  call record_insight with the pattern in their voice. You may also speak the
  insight briefly in default mode.
- LINK don't duplicate. If two existing concepts relate, prefer link_concepts.

# Entity Capture
- Numbers, names, dates: capture verbatim in definition_core if uttered explicitly.
- Do not invent specifics the user didn't say.
- Treat dictated sequences as one value: "A B C 1 2 3" → "ABC123".

# Unclear Audio
If audio is unclear, call wait_for_user. In default mode you may also briefly ask
("sorry, the last bit cut out — could you repeat?"). In silent mode, just call
wait_for_user without speaking.

# Probing — what good probes look like
- Concept-specific, not generic. "How does X relate to Y?" beats "tell me more".
- Surface tensions: "earlier you said A, now this sounds like the opposite — which?"
- Push for the underlying mechanism: "what makes that work / break?"
- Suggest unexplored adjacent space: "is there a B-side to this?"

# What you NEVER do
- Never speak in silent mode (until the user resumes).
- Never editorialise or use empty filler.
- Never ask multiple questions in one turn.
- Never call finalize_session unless the user explicitly signals done.

# Termination Triggers
The session ends when the user says: "done", "finished", "ok process",
"process this", "wrap it up", "that's it", "over to you", "go ahead and process",
or an unambiguous equivalent. ON THIS TRIGGER:
1. Call finalize_session with the trigger phrase.
2. Then SPEAK the structured closing summary — the tool result hands you the data.

# Final Summary (closing turn)
After finalize_session returns, speak ONLY this:
- Total concepts captured (count).
- The 3–7 main branches by name.
- Any insights you recorded (verbatim).
- One sentence on the overall shape of what you heard.
Keep it under 20 seconds. Warm but compact. Do not list every node.

# Current Graph
${focusLine}
Nodes:
${nodeLines}
`.trim();
}

// ─── Tool catalog ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    name: 'add_concept',
    description: 'Capture a new concept the user has expressed. parent_code rules: 1) Use an existing code if the user is extending that specific concept. 2) Use the code returned from a previous add_concept earlier in this same turn for nested children. 3) Use "@focus" for fresh top-level ideas under the current focus. 4) Use "me" only when focus is "me" AND user explicitly indicates root-level placement.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1–4 words, Title Case, no articles' },
        parent_code: { type: 'string', description: "Existing code (e.g. 'B3'), '@focus' for current focus, or 'me' for the user root" },
        definition_core: { type: 'string', description: 'Optional one-line definition — only if the user defined it explicitly' },
        kind: { type: 'string', enum: ['subject', 'insight', 'question', 'decision'] },
      },
      required: ['name', 'parent_code'],
    },
  },
  {
    type: 'function',
    name: 'link_concepts',
    description: 'Assert a non-hierarchical relationship between two existing concepts.',
    parameters: {
      type: 'object',
      properties: {
        subject_code: { type: 'string' },
        predicate: { type: 'string', enum: ['DEPENDS_ON', 'SUPPORTS', 'CONTRADICTS', 'ANALOGOUS_TO', 'CAUSES', 'PART_OF'] },
        object_code: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['subject_code', 'predicate', 'object_code'],
    },
  },
  {
    type: 'function',
    name: 'move_node',
    description: 'Restructure: move a node under a different parent. Only when explicit or clearly wrong-placed.',
    parameters: {
      type: 'object',
      properties: {
        target_code: { type: 'string' },
        new_parent_code: { type: 'string', description: "Existing code, '@focus', or 'me'" },
      },
      required: ['target_code', 'new_parent_code'],
    },
  },
  {
    type: 'function',
    name: 'remove_node',
    description: 'Delete a node and its subtree. Only when the user explicitly says delete/remove/scrap.',
    parameters: {
      type: 'object',
      properties: { target_code: { type: 'string' } },
      required: ['target_code'],
    },
  },
  {
    type: 'function',
    name: 'merge_concepts',
    description: 'User repeated or rephrased an existing concept. Reinforce the canonical node instead of creating a duplicate. Always prefer this over add_concept when the idea is substantially the same.',
    parameters: {
      type: 'object',
      properties: {
        canonical_code: { type: 'string' },
        duplicate_code: { type: 'string', description: 'Optional — only if a duplicate was actually created and should be removed' },
      },
      required: ['canonical_code'],
    },
  },
  {
    type: 'function',
    name: 'record_insight',
    description: 'Surface a higher-order insight: a synthesis or pattern across multiple concepts the user has stated. Only call when you can compress repeated points into a richer signal.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "One sentence in the user's voice" },
        related_codes: { type: 'array', items: { type: 'string' } },
      },
      required: ['text', 'related_codes'],
    },
  },
  {
    type: 'function',
    name: 'wait_for_user',
    description: 'Call when audio is silence, breathing, hold, background speech, or filler that adds no concept. Prevents spurious tool calls.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'finalize_session',
    description: "Call ONLY when the user signals they are done: 'done', 'finished', 'ok process', 'wrap it up', 'that's it', 'process this', 'over to you', or equivalent. After this returns, speak a brief summary using the data the tool returns.",
    parameters: {
      type: 'object',
      properties: {
        trigger_phrase: { type: 'string', description: 'The exact words the user said that triggered this' },
      },
      required: ['trigger_phrase'],
    },
  },
];

// ─── Network helpers ────────────────────────────────────────────────────────

async function postVoice(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

async function dispatchTool(name, args) {
  if (name === 'wait_for_user') {
    return { ok: true };
  }

  if (name === 'add_concept') {
    let parentCode = args.parent_code;
    if (parentCode === '@last' && lastConceptCode) parentCode = lastConceptCode;
    const result = await postVoice('voice/concept', {
      name: args.name,
      parent_code: parentCode,
      definition_core: args.definition_core,
      kind: args.kind,
    });
    if (result.ok && result.node) {
      graph.addPharosNode({ node: result.node, parentId: result.parent_id || 'me' });
      lastConceptCode = result.code;
      sessionLog.conceptsCreated.push({
        code: result.code,
        label: result.node.canonical_name,
        parent_code: result.parent_code,
      });
      const branch = (result.code || '').replace(/\d+$/, '');
      if (branch && result.parent_code === 'me') sessionLog.branchesOpened.add(branch);
    }
    return result;
  }

  if (name === 'link_concepts') {
    const result = await postVoice('voice/claim', args);
    if (result.ok && result.claim) {
      graph.addPharosClaim(result.claim);
      sessionLog.claimsAdded++;
    }
    return result;
  }

  if (name === 'move_node') {
    const result = await postVoice('voice/move', args);
    if (result.ok && result.target_id) {
      graph.moveNode(result.target_id, result.new_parent_id || 'me');
      sessionLog.moves++;
    }
    return result;
  }

  if (name === 'remove_node') {
    const result = await postVoice('voice/remove', args);
    if (result.ok && Array.isArray(result.removed)) {
      for (const id of result.removed) graph.removeNode(id);
      sessionLog.removes++;
    }
    return result;
  }

  if (name === 'merge_concepts') {
    const result = await postVoice('voice/merge', args);
    if (result.ok) {
      if (result.canonical_id) graph.incrementExpression(result.canonical_id);
      if (Array.isArray(result.removed)) {
        for (const id of result.removed) graph.removeNode(id);
      }
      sessionLog.merges++;
    }
    return result;
  }

  if (name === 'record_insight') {
    const result = await postVoice('voice/insight', args);
    if (result.ok && result.node) {
      graph.addPharosNode({ node: result.node, parentId: result.node.parent_id || 'me' });
      for (const claim of (result.claims || [])) graph.addPharosClaim(claim);
      sessionLog.insights.push({ code: result.code, text: args.text });
    }
    return result;
  }

  if (name === 'finalize_session') {
    finalizing = true;
    const summary = buildSummaryPayload();
    return { ok: true, summary };
  }

  return { ok: false, error: `unknown tool: ${name}` };
}

function buildSummaryPayload() {
  const branchNames = sessionLog.conceptsCreated
    .filter(c => c.parent_code === 'me' || /^[A-Z]\d+$/.test(c.parent_code) === false)
    .filter(c => sessionLog.branchesOpened.has((c.code || '').replace(/\d+$/, '')))
    .slice(0, 7)
    .map(c => c.label);

  return {
    total_concepts: sessionLog.conceptsCreated.length,
    main_branches: branchNames,
    insights: sessionLog.insights.map(i => i.text),
    claims_added: sessionLog.claimsAdded,
    moves: sessionLog.moves,
    removes: sessionLog.removes,
    merges: sessionLog.merges,
  };
}

// ─── Realtime event wiring ──────────────────────────────────────────────────

function send(obj) {
  if (!dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify(obj));
}

function sendSessionUpdate(systemPrompt, voice) {
  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: systemPrompt,
      output_modalities: ['audio'],   // engaged by default; the model decides when to actually speak vs stay quiet
      audio: {
        input: {
          transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        },
        output: { voice: voice || 'alloy' },
      },
      tools: TOOLS,
      tool_choice: 'auto',
    },
  });
}

function sendOpener() {
  send({
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: "Greet the user warmly in one short sentence — invite them to start. Examples: 'Ready when you are — what's on your mind?' or 'I'm here. Tell me what you're thinking.' Then stop.",
    },
  });
}

function sendFinalSummary() {
  const s = buildSummaryPayload();
  const branches = s.main_branches.length ? s.main_branches.join(', ') : 'none yet';
  const insights = s.insights.length ? s.insights.join(' ') : '';
  const directive = `Speak a brief warm summary, under 20 seconds. Use this data:
- Concepts captured: ${s.total_concepts}
- Main branches: ${branches}
- Insights: ${insights || '(none)'}
- Claims added: ${s.claims_added}, moves: ${s.moves}, removes: ${s.removes}, merges: ${s.merges}
Mention the count, the branch names, any insights verbatim, and one closing sentence on the overall shape. Then stop.`;
  send({
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: directive,
    },
  });
}

function pushFocusSystemMessage(code, label) {
  if (!dc || dc.readyState !== 'open') return;
  send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: `Focus changed to ${code}: ${label}` }],
    },
  });
}

// Set lazily on session start so handleEvent can access them
let pendingSystemPrompt = null;
let pendingVoice = null;

async function handleEvent(event) {
  if (!event || !event.type) return;

  if (event.type === 'session.created') {
    sendSessionUpdate(pendingSystemPrompt, pendingVoice);
    sendOpener();
    onStatus?.('listening');
    return;
  }

  if (event.type === 'response.function_call_arguments.done') {
    const callId = event.call_id;
    const responseId = event.response_id;
    let args = {};
    try { args = event.arguments ? JSON.parse(event.arguments) : {}; }
    catch (err) { console.warn('[realtime.v2] bad tool args json', err, event.arguments); }

    let output;
    try {
      output = await dispatchTool(event.name, args);
    } catch (err) {
      console.error('[realtime.v2] tool dispatch failed', event.name, err);
      output = { ok: false, error: String(err.message || err) };
    }

    send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output),
      },
    });

    responseToolCount.set(responseId, (responseToolCount.get(responseId) || 0) + 1);
    return;
  }

  if (event.type === 'response.done') {
    const responseId = event.response?.id;
    const calls = responseToolCount.get(responseId) || 0;
    responseToolCount.delete(responseId);

    if (calls > 0) {
      // Continue the loop. If finalize fired during this response, the next
      // response should be the spoken summary; otherwise stay silent.
      if (finalizing) {
        finalizing = false;
        summarySpoken = true;
        onStatus?.('summarising');
        sendFinalSummary();
      } else {
        // Continue the conversation — let the model decide whether to speak
        // (default mode) or stay silent (silent mode) based on its instructions.
        send({ type: 'response.create' });
      }
    } else if (summarySpoken) {
      // The just-finished response with no tool calls is the spoken summary.
      summarySpoken = false;
      onSummary?.();
    }
    return;
  }

  if (event.type === 'error') {
    console.error('[realtime.v2] error event:', event.error);
    onStatus?.('error: ' + (event.error?.message || 'unknown'));
    return;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function start({ onStatus: statusCb, onSummary: summaryCb, sessionId: sid }, voice) {
  onStatus = statusCb;
  onSummary = summaryCb;
  sessionId = sid;

  // Reset session-scoped state
  responseToolCount.clear();
  sessionLog.conceptsCreated.length = 0;
  sessionLog.branchesOpened.clear();
  sessionLog.insights.length = 0;
  sessionLog.claimsAdded = 0;
  sessionLog.moves = 0;
  sessionLog.removes = 0;
  sessionLog.merges = 0;
  lastConceptCode = null;
  finalizing = false;
  summarySpoken = false;

  onStatus?.('connecting');

  // Mint ephemeral key + learn which model the server selected
  const sessionRes = await fetch('session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-realtime-2' }),
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    throw new Error(`/session failed: ${sessionRes.status} ${text}`);
  }
  const sessionJson = await sessionRes.json();
  const ephemeralKey = sessionJson.value || sessionJson.client_secret?.value;
  const model = sessionJson.model || 'gpt-realtime-2';
  if (!ephemeralKey) {
    throw new Error('No ephemeral key in /session response: ' + JSON.stringify(sessionJson));
  }

  // Seed server-side focus for this session and fetch current snapshot
  const focusedId = graph.getFocusedNodeId() || 'me';
  await fetch('voice/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify({ focus_id: focusedId }),
  });
  const snapshot = await postVoice('voice/snapshot', {});

  pc = new RTCPeerConnection();
  pc.ontrack = e => {
    const audio = document.getElementById('remote');
    audio.srcObject = e.streams[0];
  };

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

  dc = pc.createDataChannel('oai-events');
  pendingSystemPrompt = buildSystemPrompt(snapshot);
  pendingVoice = voice;

  dc.addEventListener('message', ev => {
    let event;
    try { event = JSON.parse(ev.data); } catch { return; }
    if (event.type) console.debug('[realtime.v2]', event.type);
    handleEvent(event).catch(err => console.error('[realtime.v2] handle error', err));
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      'Content-Type': 'application/sdp',
    },
  });

  if (!sdpRes.ok) {
    const text = await sdpRes.text();
    throw new Error(`SDP exchange failed: ${sdpRes.status} ${text}`);
  }

  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

export function pushFocusChange(focusId, focusLabel) {
  if (!dc || dc.readyState !== 'open' || !sessionId) return;
  fetch('voice/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify({ focus_id: focusId || 'me' }),
  }).catch(() => {});
  const code = focusId === 'me' ? 'me' : (focusLabel?.code || focusId);
  const label = focusLabel?.label || focusLabel || focusId;
  pushFocusSystemMessage(code, label);
}

export function stop() {
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
  }
  dc = null;
  pc = null;
  micStream = null;
  responseToolCount.clear();
  finalizing = false;
}
