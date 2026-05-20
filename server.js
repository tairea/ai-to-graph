import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './pharos-store.js';
import * as keys from './keys-store.js';
import { resolve as pharosResolve } from './pharos-resolver.js';

const execFile = promisify(_execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'gpt-4.1-mini';

// ─── /session — OpenAI Realtime ──────────────────────────────────────────────
// Returns the OpenAI client_secrets payload plus a `model` field so the client
// SDP-handshakes against the same model the server requested. Flip
// REALTIME_MODEL in env to revert to gpt-realtime-mini for the legacy pipeline.

const ALLOWED_REALTIME_MODELS = new Set(['gpt-realtime-2', 'gpt-realtime-mini', 'gpt-realtime']);

app.post('/session', async (req, res) => {
  const openaiKey = keys.getKey('openai');
  if (!openaiKey) {
    return res.status(500).json({ error: 'OpenAI key not set. Add it under the key icon (OpenRouter does not support the realtime API).' });
  }
  // Client passes the model it wants to SDP-handshake against (driven by the
  // pipeline pill in the UI). Falls back to env, then sane default.
  const requested = req.body?.model;
  const model = (requested && ALLOWED_REALTIME_MODELS.has(requested))
    ? requested
    : REALTIME_MODEL;
  try {
    const upstream = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ session: { type: 'realtime', model } })
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
    }
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    body.model = model;
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ─── /voice/* — direct graph mutation endpoints for the realtime agent ───────
// Used by realtime.v2.js (gpt-realtime-2 silent listener). The legacy pipeline
// goes through /ingest → pharos-resolver instead. Per-session focus is tracked
// here so the model can emit `parent_code: "@focus"` and have it resolve to
// whatever the user has clicked into at request time.

const sessionFocus = new Map(); // sessionId → focusedNodeId

function getSessionFocusId(req) {
  const sid = req.headers['x-session-id'] || 'default';
  return sessionFocus.get(sid) || 'me';
}

function resolveParentCode(code, req) {
  if (!code || code === 'me') return 'me';
  if (code === '@focus') return getSessionFocusId(req);
  const node = store.findByCode(code);
  return node ? node.id : 'me';
}

function codeOfId(id) {
  if (!id || id === 'me') return 'me';
  return store.getNode(id)?.code || 'me';
}

function getAncestry(id) {
  const out = [];
  let cur = id;
  let safety = 0;
  while (cur && cur !== 'me' && safety++ < 200) {
    const n = store.getNode(cur);
    if (!n) break;
    out.unshift({ code: n.code || null, label: n.canonical_name, id: cur });
    cur = n.parent_id;
  }
  out.unshift({ code: 'me', label: 'me', id: 'me' });
  return out;
}

function focusContext(req) {
  const fid = getSessionFocusId(req);
  if (fid === 'me') return { current_focus_code: 'me', current_focus_label: 'me' };
  const node = store.getNode(fid);
  return {
    current_focus_code: node?.code || 'me',
    current_focus_label: node?.canonical_name || 'me',
  };
}

function voiceRandId() {
  return Math.random().toString(36).slice(2, 8);
}

app.post('/voice/snapshot', (req, res) => {
  const fid = getSessionFocusId(req);
  const focusNode = fid === 'me' ? null : store.getNode(fid);
  const nodes = store.getAllNodes()
    .filter(n => n.code)
    .map(n => ({
      code: n.code,
      label: n.canonical_name,
      parent_code: codeOfId(n.parent_id),
      kind: n.type || 'subject',
    }));
  res.json({
    current_focus: focusNode
      ? { code: focusNode.code || 'me', label: focusNode.canonical_name, id: focusNode.id }
      : { code: 'me', label: 'me', id: 'me' },
    nodes,
  });
});

app.post('/voice/focus', (req, res) => {
  const sid = req.headers['x-session-id'] || 'default';
  const focusId = req.body?.focus_id || 'me';
  if (focusId !== 'me' && !store.getNode(focusId)) {
    sessionFocus.set(sid, 'me');
  } else {
    sessionFocus.set(sid, focusId);
  }
  res.json({ ok: true, ...focusContext(req) });
});

app.post('/voice/concept', (req, res) => {
  const { name, parent_code, definition_core, kind } = req.body || {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'name required' });
  const parentId = resolveParentCode(parent_code, req);
  const nodeId = `node-voice-${Date.now()}-${voiceRandId()}`;
  store.addNode({
    id: nodeId,
    canonical_name: trimmed,
    definition_core: definition_core || '',
    type: kind || 'subject',
    resonance_state: 'active',
    confidence: 'seed',
    top: '', bottom: '', front: '', back: '', left: '', right: '',
    parent_id: parentId,
  });
  const code = store.assignCode(nodeId, parentId);
  const persisted = { ...store.getNode(nodeId), code };
  res.json({
    ok: true,
    code,
    node: persisted,
    parent_id: parentId,
    parent_code: codeOfId(parentId),
    ancestry: getAncestry(nodeId),
    ...focusContext(req),
  });
});

app.post('/voice/claim', (req, res) => {
  const { subject_code, predicate, object_code, reasoning } = req.body || {};
  const subjNode = store.findByCode(subject_code);
  const objNode = store.findByCode(object_code);
  if (!subjNode || !objNode) {
    return res.status(400).json({ error: 'subject_code or object_code not found', ...focusContext(req) });
  }
  const claim = store.addClaim({
    id: `claim-voice-${Date.now()}-${voiceRandId()}`,
    predicate: (predicate || 'SUPPORTS').toUpperCase(),
    subject_node: subjNode.id,
    object_node: objNode.id,
    confidence: 'medium',
    reasoning: reasoning || 'voice agent inference',
  });
  res.json({ ok: true, claim, ...focusContext(req) });
});

app.post('/voice/move', (req, res) => {
  const { target_code, new_parent_code } = req.body || {};
  const targetNode = store.findByCode(target_code);
  if (!targetNode) return res.status(400).json({ error: 'target_code not found' });
  const newParentId = resolveParentCode(new_parent_code, req);
  store.moveNode(targetNode.id, newParentId);
  res.json({
    ok: true,
    target_id: targetNode.id,
    target_code,
    new_parent_id: newParentId,
    new_parent_code: codeOfId(newParentId),
    ...focusContext(req),
  });
});

app.post('/voice/remove', (req, res) => {
  const { target_code } = req.body || {};
  const targetNode = store.findByCode(target_code);
  if (!targetNode) return res.status(400).json({ error: 'target_code not found' });
  const result = store.removeNode(targetNode.id);
  res.json({
    ok: true,
    target_id: targetNode.id,
    target_code,
    removed: result.removed,
    ...focusContext(req),
  });
});

app.post('/voice/merge', (req, res) => {
  const { canonical_code, duplicate_code } = req.body || {};
  const canonical = store.findByCode(canonical_code);
  if (!canonical) return res.status(400).json({ error: 'canonical_code not found' });
  store.incrementExpression(canonical.id);
  let removed = [];
  if (duplicate_code) {
    const dup = store.findByCode(duplicate_code);
    if (dup && dup.id !== canonical.id) {
      removed = store.removeNode(dup.id).removed;
    }
  }
  res.json({
    ok: true,
    canonical_id: canonical.id,
    canonical_code,
    new_expression_count: store.getNode(canonical.id)?.expressionCount,
    removed,
    ...focusContext(req),
  });
});

app.post('/voice/insight', (req, res) => {
  const { text, related_codes } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'text required' });
  const focusId = getSessionFocusId(req);
  const nodeId = `node-insight-${Date.now()}-${voiceRandId()}`;
  store.addNode({
    id: nodeId,
    canonical_name: trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed,
    definition_core: trimmed,
    type: 'insight',
    resonance_state: 'synthesized',
    confidence: 'medium',
    top: '', bottom: '', front: '', back: '', left: '', right: '',
    parent_id: focusId,
  });
  const code = store.assignCode(nodeId, focusId);
  const persisted = { ...store.getNode(nodeId), code };
  const claims = [];
  if (Array.isArray(related_codes)) {
    for (const rc of related_codes) {
      const target = store.findByCode(rc);
      if (!target) continue;
      claims.push(store.addClaim({
        id: `claim-insight-${Date.now()}-${voiceRandId()}`,
        predicate: 'SUPPORTS',
        subject_node: nodeId,
        object_node: target.id,
        confidence: 'medium',
        reasoning: 'insight derived from these concepts',
      }));
    }
  }
  res.json({
    ok: true,
    code,
    node: persisted,
    claims,
    parent_code: codeOfId(focusId),
    ...focusContext(req),
  });
});

// ─── /ingest — PHAROS CubeCodex identity resolution ──────────────────────────

app.post('/ingest', async (req, res) => {
  const anthropicKey = keys.getKey('anthropic');
  const openrouterKey = keys.getKey('openrouter');
  if (!anthropicKey && !openrouterKey) {
    return res.status(500).json({ error: 'Anthropic key not set (and no OpenRouter fallback). Add one under the key icon.' });
  }

  const { transcript, assistantPrior, focusedParentId } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'transcript (string) required' });
  }

  try {
    // Create context object for this ingest call
    const contextId = `ctx-${new Date().toISOString().slice(0,10)}-${Date.now()}`;
    store.addContext({
      id: contextId,
      object_class: 'context',
      time: new Date().toISOString().slice(0,10),
      epistemic_mode: 'observation',
      session_id: req.headers['x-session-id'] || 'default',
      created: new Date().toISOString()
    });

    const result = await pharosResolve(transcript, assistantPrior || '', contextId, focusedParentId, {
      anthropicKey,
      openrouterKey,
    });
    res.json({ context_id: contextId, ...result });
  } catch (err) {
    console.error('[ingest] error', err);
    res.status(502).json({ error: String(err) });
  }
});

// ─── /ingest/state — return current store state ───────────────────────────────

app.get('/ingest/state', (_req, res) => {
  res.json({
    nodes: store.getAllNodes(),
    claims: store.getAllClaims(),
    identity: store.getIdentity(),
    peers: store.getPeerList(),
    publicSpaces: store.getPublicSpaces(),
  });
});

// ─── /ingest/identity — return DID and profile only ──────────────────────────

app.get('/ingest/identity', (_req, res) => {
  res.json(store.getIdentity());
});

// ─── /ingest/keys — manage stored API keys (encrypted on Gun) ────────────────

app.get('/ingest/keys', (_req, res) => {
  res.json(keys.getMaskedKeys());
});

app.post('/ingest/keys', async (req, res) => {
  try {
    const patch = req.body || {};
    const allowed = ['openai', 'anthropic', 'openrouter'];
    const filtered = {};
    for (const k of allowed) {
      if (typeof patch[k] === 'string') filtered[k] = patch[k];
    }
    await keys.setKeys(filtered);
    res.json(keys.getMaskedKeys());
  } catch (err) {
    console.error('[keys] save failed', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ─── /ingest/share — make subtree public / share with peer / link to avatar ──

app.post('/ingest/share', async (req, res) => {
  const { nodeId, mode, recipientDID } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId required' });
  try {
    let spaceId;
    if (mode === 'public') {
      spaceId = store.makePublic(nodeId);
    } else if (mode === 'specific') {
      if (!recipientDID) return res.status(400).json({ error: 'recipientDID required for specific mode' });
      spaceId = await store.shareWithSpecific(nodeId, recipientDID);
    } else if (mode === 'avatar') {
      spaceId = store.linkToAvatar(nodeId);
    } else {
      return res.status(400).json({ error: 'mode must be "public" | "specific" | "avatar"' });
    }
    res.json({ spaceId });
  } catch (err) {
    console.error('[share] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete('/ingest/share/:spaceId', (req, res) => {
  try {
    store.stopPublic(req.params.spaceId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ─── /ingest/node/:id — delete a node and its subtree ────────────────────────

app.delete('/ingest/node/:id', (req, res) => {
  try {
    const result = store.removeNode(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ─── /ingest/node — manually create a node + connections ─────────────────────

function randId() {
  return Math.random().toString(36).slice(2, 8);
}

// ─── /ingest/github — clone a repo, graph its file/folder DAG ────────────────

const GH_IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.pytest_cache',
  '.turbo', '.cache', 'vendor', '.gradle', '.mvn', 'bin', 'obj',
  '.terraform', '.serverless'
]);
const GH_IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'poetry.lock',
  '.DS_Store', 'Thumbs.db'
]);

const TIER_CONFIG = {
  small:  { cap: 300,            depth: 5  },
  medium: { cap: 1000,           depth: 8  },
  full:   { cap: Infinity,       depth: Infinity },
};

function repoNameFromUrl(url) {
  const m = url.match(/[\/:]([^\/:]+?)(?:\.git)?\/?$/);
  return m ? m[1] : 'repo';
}

function repoSlug(url) {
  // pull "owner/repo" from common forms; fallback to repo name
  const cleaned = url.replace(/\.git\/?$/, '').replace(/\/$/, '');
  const m = cleaned.match(/[\/:]([^\/:]+\/[^\/:]+)$/);
  if (m) return m[1].toLowerCase();
  return repoNameFromUrl(url).toLowerCase();
}

function isValidRepoUrl(url) {
  if (typeof url !== 'string') return false;
  return /^(https?:\/\/|git@|git:\/\/|ssh:\/\/)\S+/.test(url.trim());
}

function ghPathId(slug, relPath) {
  const hash = createHash('sha1').update(`${slug}::${relPath}`).digest('hex').slice(0, 12);
  return `node-gh-${hash}`;
}

function makeRepoNode(id, name, parentId, definitionCore) {
  return {
    id,
    canonical_name: name,
    definition_core: definitionCore,
    type: 'subject',
    resonance_state: 'active',
    confidence: 'seed',
    top: '', bottom: '', front: '', back: '', left: '', right: '',
    parent_id: parentId,
  };
}

async function ingestRepoTree(url, focusParentId, tier) {
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.small;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-gh-'));

  try {
    await execFile('git', [
      'clone', '--depth=1', '--single-branch', '--no-tags',
      url, tmpRoot,
    ], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

    const repoName = repoNameFromUrl(url);
    const slug = repoSlug(url);

    const resolvedParent = focusParentId && store.getNode(focusParentId) ? focusParentId : 'me';
    const repoId = ghPathId(slug, '');

    const created = [];
    let count = 0;
    let truncated = false;

    function persist(node, parentId) {
      const existing = store.getNode(node.id);
      if (existing) {
        const code = store.assignCode(node.id, parentId);
        created.push({ ...existing, code });
        return existing;
      }
      if (count >= cfg.cap) { truncated = true; return null; }
      count++;
      const stored = store.addNode(node);
      const code = store.assignCode(node.id, parentId);
      created.push({ ...store.getNode(node.id), code });
      return stored;
    }

    persist(makeRepoNode(repoId, repoName, resolvedParent, `repo: ${slug}`), resolvedParent);

    async function walk(absDir, relDir, parentId, depth) {
      if (depth > cfg.depth) return;
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch { return; }
      // Sort: directories first, then alphabetical
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
      for (const ent of entries) {
        if (count >= cfg.cap) { truncated = true; return; }
        if (ent.isDirectory()) {
          if (GH_IGNORE_DIRS.has(ent.name)) continue;
          const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
          const id = ghPathId(slug, rel);
          const made = persist(makeRepoNode(id, ent.name, parentId, `dir: ${rel}`), parentId);
          if (!made) return;
          await walk(path.join(absDir, ent.name), rel, id, depth + 1);
        } else if (ent.isFile()) {
          if (GH_IGNORE_FILES.has(ent.name)) continue;
          const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
          const id = ghPathId(slug, rel);
          persist(makeRepoNode(id, ent.name, parentId, `file: ${rel}`), parentId);
        }
      }
    }

    await walk(tmpRoot, '', repoId, 1);

    return {
      repoName,
      rootId: repoId,
      rootParentId: resolvedParent,
      nodes: created,
      claims: [],
      tier,
      truncated,
      nodeCount: count,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

app.post('/ingest/github', async (req, res) => {
  const { url, parent_id, tier = 'small' } = req.body || {};
  if (!isValidRepoUrl(url)) return res.status(400).json({ error: 'invalid repo url' });
  if (!TIER_CONFIG[tier]) return res.status(400).json({ error: `invalid tier: ${tier}` });
  try {
    const result = await ingestRepoTree(url.trim(), parent_id, tier);
    res.json(result);
  } catch (err) {
    console.error('[github] error', err);
    const msg = err.stderr?.toString?.() || err.message || String(err);
    res.status(500).json({ error: msg.split('\n').slice(0, 3).join(' ').slice(0, 400) });
  }
});

app.post('/ingest/node', (req, res) => {
  try {
    const { name, parent_id, connections } = req.body || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return res.status(400).json({ error: 'name (string) required' });

    const resolvedParent = parent_id && store.getNode(parent_id) ? parent_id : 'me';
    const otherIds = Array.isArray(connections)
      ? connections.filter(id => typeof id === 'string' && id !== resolvedParent && store.getNode(id))
      : [];

    const nodeId = `node-manual-${Date.now()}-${randId()}`;
    const node = store.addNode({
      id: nodeId,
      canonical_name: trimmed,
      definition_core: '',
      type: 'subject',
      resonance_state: 'active',
      confidence: 'seed',
      top: '', bottom: '', front: '', back: '', left: '', right: '',
      parent_id: resolvedParent,
    });
    const code = store.assignCode(nodeId, resolvedParent);
    const persistedNode = { ...store.getNode(nodeId), code };

    const claims = [];
    for (const otherId of otherIds) {
      const claim = store.addClaim({
        id: `claim-manual-${Date.now()}-${randId()}`,
        predicate: 'DEPENDS_ON',
        subject_node: nodeId,
        object_node: otherId,
        confidence: 'medium',
        reasoning: 'manually connected',
      });
      claims.push(claim);
    }

    res.json({ node: persistedNode, parentId: resolvedParent, claims });
  } catch (err) {
    console.error('[manual-node] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ─── /ingest/peers — peer management ─────────────────────────────────────────

app.get('/ingest/peers', (_req, res) => {
  res.json(store.getPeerList());
});

app.post('/ingest/peers', (req, res) => {
  const { did: peerDID, name, relayAddress } = req.body || {};
  if (!peerDID) return res.status(400).json({ error: 'did required' });
  const entry = store.addPeer(peerDID, { name, relayAddress });
  res.json(entry);
});

app.delete('/ingest/peers/:did', (req, res) => {
  store.removePeer(req.params.did);
  res.json({ ok: true });
});

// ─── /ingest/events — SSE stream for live remote shared nodes/claims ─────────

app.get('/ingest/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`: connected\n\n`);

  const nodeUnsub = store.onRemoteNode(({ node, spaceId }) => {
    res.write(`event: node\ndata: ${JSON.stringify({ node, spaceId })}\n\n`);
  });
  const claimUnsub = store.onRemoteClaim(({ claim, spaceId }) => {
    res.write(`event: claim\ndata: ${JSON.stringify({ claim, spaceId })}\n\n`);
  });

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);

  req.on('close', () => {
    clearInterval(ping);
    nodeUnsub();
    claimUnsub();
  });
});

// ─── /extract — legacy shim (OpenAI, original behaviour) ─────────────────────

const extractionSchema = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['move', 'remove'] },
          target: { type: 'string' },
          new_parent: { type: 'string' }
        },
        required: ['type', 'target', 'new_parent'],
        additionalProperties: false
      }
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          parent_label: { type: 'string' },
          reasoning: { type: 'string' }
        },
        required: ['label', 'parent_label', 'reasoning'],
        additionalProperties: false
      }
    }
  },
  required: ['operations', 'concepts'],
  additionalProperties: false
};

function buildExtractionSystemPrompt(existingLabels) {
  const existing = existingLabels.length > 0 ? existingLabels.join('\n  ') : '(none yet)';
  return `You process a user's spoken utterance and output TWO things:
1. "operations" — graph edit commands (move/remove) the user issued verbally.
2. "concepts" — new concepts to add to a hierarchical knowledge graph rooted at the user ("me").

Every existing node has a short code like "A1", "B3". Codes:
  ${existing}

=== OPERATIONS ===
If the user says "move B4 to A2", "remove C3", "delete that", emit an operation.
  - {"type":"move","target":"B4","new_parent":"A2"}
  - {"type":"remove","target":"C3","new_parent":""}
  - "move X to me" → new_parent:"me"

=== CONCEPTS ===
Decompose utterance into EVERY noteworthy concept. Err on the side of MORE concepts.
- parent_label: "me" for fresh top-level topics; existing CODE to extend; label of another concept in this response when nested.
- Order parents before children.
- NEVER duplicate an existing concept — reference its code as parent_label instead.
- Labels: 1–4 words, Title Case, no articles.
- Filler/greetings/yes-no → {"operations":[],"concepts":[]}.`;
}

app.post('/extract', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server' });
  }

  const { transcript, assistantPrior, nodes } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'transcript (string) required' });
  }

  const existingLabels = Array.isArray(nodes)
    ? nodes.filter(n => typeof n === 'string' && n.trim()).slice(0, 200)
    : [];

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages: [
          { role: 'system', content: buildExtractionSystemPrompt(existingLabels) },
          {
            role: 'user',
            content: assistantPrior
              ? `Assistant just said: "${assistantPrior}"\n\nUser replied: "${transcript}"\n\nExtract concepts from the user's reply.`
              : `User said: "${transcript}"\n\nExtract concepts.`
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'concepts_extraction', schema: extractionSchema, strict: true }
        }
      })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }

    const data = await upstream.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'no content in extract response', raw: data });

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { return res.status(500).json({ error: 'failed to parse extract JSON', raw: content }); }

    res.json(parsed);
  } catch (err) {
    console.error('[extract] fetch failed', err);
    res.status(502).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;

// Wait for GUN to bootstrap from persisted data before accepting requests
store.awaitBootstrap().then(() => {
  app.listen(port, () => {
    console.log(`PHAROS graph-space listening on http://localhost:${port}`);
  });
});
