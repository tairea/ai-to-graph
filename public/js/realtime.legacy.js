const MODEL = 'gpt-realtime-mini';

let pc = null;
let dc = null;
let micStream = null;
let lastAssistantText = '';

const INSTRUCTIONS = `
You are a curious, warm conversational partner. Have a natural spoken
conversation with the user about whatever they bring up. Ask short,
genuine follow-up questions and keep the energy going. Begin by warmly
greeting the user and asking what's on their mind today.

The user is building a PHAROS knowledge graph as you talk. They may give graph
commands like "move B1 to A2", "delete A4", "remove C3", or similar.
These are handled by a separate system — you do NOT need to act on them.
Just briefly acknowledge (e.g. "Done", "Got it", "On it") and continue naturally.
Do not ask what the codes mean.
`.trim();

function sendSessionUpdate(voice) {
  const update = {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: INSTRUCTIONS,
      audio: {
        input: {
          transcription: { model: 'whisper-1' }
        },
        output: {
          voice: voice || 'alloy'
        }
      }
    }
  };
  dc.send(JSON.stringify(update));
  console.log('[realtime] sent session.update with voice:', voice);
}

export async function start({ onTranscript, onStatus }, voice) {
  onStatus?.('connecting');

  const sessionRes = await fetch('session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL }),
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    throw new Error(`/session failed: ${sessionRes.status} ${text}`);
  }
  const sessionJson = await sessionRes.json();
  const ephemeralKey = sessionJson.value || sessionJson.client_secret?.value;
  if (!ephemeralKey) {
    throw new Error('No ephemeral key in /session response: ' + JSON.stringify(sessionJson));
  }

  pc = new RTCPeerConnection();
  pc.ontrack = e => {
    const audio = document.getElementById('remote');
    audio.srcObject = e.streams[0];
  };

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

  dc = pc.createDataChannel('oai-events');

  dc.addEventListener('message', ev => {
    let event;
    try { event = JSON.parse(ev.data); }
    catch { return; }

    if (event.type) console.debug('[realtime]', event.type);

    if (event.type === 'session.created') {
      sendSessionUpdate(voice);
      onStatus?.('live');
      return;
    }

    if (event.type === 'response.audio_transcript.done' || event.type === 'response.output_audio_transcript.done') {
      lastAssistantText = (event.transcript || '').trim();
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = (event.transcript || '').trim();
      if (transcript) {
        console.log('[realtime] transcript:', transcript);
        onTranscript?.({ transcript, assistantPrior: lastAssistantText });
      }
      return;
    }

    if (event.type === 'error') {
      console.error('[realtime] error event:', event.error);
      onStatus?.('error: ' + (event.error?.message || 'unknown'));
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(MODEL)}`, {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      'Content-Type': 'application/sdp'
    }
  });

  if (!sdpRes.ok) {
    const text = await sdpRes.text();
    throw new Error(`SDP exchange failed: ${sdpRes.status} ${text}`);
  }

  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
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
  lastAssistantText = '';
}
