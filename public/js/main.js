import * as graph from './graph.js';
import * as realtime from './realtime.js';
import { setAvatarFromFile } from './avatar.js';
import { getUserName, setUserName } from './user.js';

const VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo',
  'marin', 'sage', 'shimmer', 'verse', 'cedar'
];

const statusEl = document.getElementById('status');
const statusPill = document.getElementById('status-pill');
const micBtn = document.getElementById('mic-btn');
const micArea = document.getElementById('mic-area');
const avatarInput = document.getElementById('avatar-input');
const avatarEdit = document.getElementById('avatar-edit');
const graphEl = document.getElementById('graph');
const tipEl = document.getElementById('tip');
const infoBtn = document.getElementById('info-btn');
const infoPanel = document.getElementById('info-panel');
const voiceBtn = document.getElementById('voice-btn');
const voiceModal = document.getElementById('voice-modal');
const voiceGrid = document.getElementById('voice-grid');
const voiceModalClose = document.getElementById('voice-modal-close');
const dropZone = document.getElementById('drop-zone');
const mdInput = document.getElementById('md-input');
const toast = document.getElementById('toast');
const peersBtn = document.getElementById('peers-btn');
const peersPanel = document.getElementById('peers-panel');
const peersList = document.getElementById('peers-list');
const peersDidBadge = document.getElementById('peers-did');
const peerAddBtn = document.getElementById('peer-add-btn');
const keysBtn = document.getElementById('keys-btn');
const keysPanel = document.getElementById('keys-panel');
const keysForm = document.getElementById('keys-form');
const keyOpenaiInput = document.getElementById('key-openai');
const keyAnthropicInput = document.getElementById('key-anthropic');
const keyOpenrouterInput = document.getElementById('key-openrouter');
const keyOpenaiStatus = document.getElementById('key-openai-status');
const keyAnthropicStatus = document.getElementById('key-anthropic-status');
const keyOpenrouterStatus = document.getElementById('key-openrouter-status');
const keysCancelBtn = keysPanel?.querySelector('[data-action="cancel"]');
const processingPill = document.getElementById('processing-pill');
const modeRow = document.getElementById('mode-row');
const modeButtons = modeRow ? Array.from(modeRow.querySelectorAll('.mode-btn')) : [];
const textInputForm = document.getElementById('text-input-form');
const textInput = document.getElementById('text-input');
const githubInputForm = document.getElementById('github-input-form');
const githubInput = document.getElementById('github-input');
const focusPill = document.getElementById('focus-pill');
const focusTargetEl = document.getElementById('focus-target');
const focusClearBtn = document.getElementById('focus-clear');

let live = false;
let processingCount = 0;
let inputMode = 'voice';

function beginProcessing() {
  processingCount++;
  if (processingCount === 1) processingPill?.classList.add('is-active');
}

function endProcessing() {
  processingCount = Math.max(0, processingCount - 1);
  if (processingCount === 0) processingPill?.classList.remove('is-active');
}

function getSelectedVoice() {
  return localStorage.getItem('pharos-voice') || 'alloy';
}

function buildVoiceGrid() {
  voiceGrid.innerHTML = '';
  const selected = getSelectedVoice();
  for (const voice of VOICES) {
    const btn = document.createElement('button');
    btn.className = 'voice-option' + (voice === selected ? ' selected' : '');
    btn.textContent = voice;
    btn.dataset.voice = voice;
    btn.addEventListener('click', () => {
      localStorage.setItem('pharos-voice', voice);
      document.querySelectorAll('.voice-option').forEach(el => el.classList.remove('selected'));
      btn.classList.add('selected');
      voiceModal.hidden = true;
    });
    voiceGrid.appendChild(btn);
  }
}

function openVoiceModal() {
  buildVoiceGrid();
  voiceModal.hidden = false;
  voiceBtn.setAttribute('aria-expanded', 'true');
}

function closeVoiceModal() {
  voiceModal.hidden = true;
  voiceBtn.setAttribute('aria-expanded', 'false');
}

function closeOtherPanels(except) {
  if (except !== 'info' && infoPanel && !infoPanel.hidden) {
    infoPanel.hidden = true;
    infoBtn?.setAttribute('aria-expanded', 'false');
  }
  if (except !== 'peers' && peersPanel && !peersPanel.hidden) {
    peersPanel.hidden = true;
    peersBtn?.setAttribute('aria-expanded', 'false');
  }
  if (except !== 'keys' && keysPanel && !keysPanel.hidden) {
    keysPanel.hidden = true;
    keysBtn?.setAttribute('aria-expanded', 'false');
  }
}

infoBtn.addEventListener('click', () => {
  const willOpen = infoPanel.hidden;
  infoPanel.hidden = !willOpen;
  infoBtn.setAttribute('aria-expanded', willOpen);
  if (willOpen) closeOtherPanels('info');
});

voiceBtn.addEventListener('click', () => {
  if (voiceModal.hidden) {
    openVoiceModal();
  } else {
    closeVoiceModal();
  }
});

voiceModalClose.addEventListener('click', closeVoiceModal);
voiceModal.addEventListener('click', (e) => {
  if (e.target === voiceModal) closeVoiceModal();
});

function setStatus(s) {
  statusEl.textContent = s;
  micBtn.dataset.state = s;
  const isLive = s === 'connected' || s === 'listening' || s === 'live';
  statusPill.dataset.live = isLive;
}

graph.init(graphEl, tipEl);

graph.onMeHover((screenPos) => {
  if (screenPos) {
    avatarEdit.hidden = false;
    avatarEdit.style.left = (screenPos.x + 14) + 'px';
    avatarEdit.style.top = (screenPos.y - 14) + 'px';
  } else {
    avatarEdit.hidden = true;
  }
});

avatarEdit.addEventListener('click', () => avatarInput.click());

window.addEventListener('avatar-changed', e => {
  graph.setAvatar(e.detail);
});

avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files?.[0];
  if (!file) return;
  try {
    await setAvatarFromFile(file);
  } catch {
    setStatus('error');
  }
});

async function handleTranscript({ transcript, assistantPrior }) {
  beginProcessing();
  try {
    const res = await fetch('ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': getSessionId()
      },
      body: JSON.stringify({ transcript, assistantPrior, focusedParentId: graph.getFocusedNodeId() })
    });

    if (!res.ok) {
      console.error('[ingest] failed', res.status, await res.text());
      return;
    }

    const { results, operations } = await res.json();

    // Apply operations first (move/remove)
    if (Array.isArray(operations)) {
      for (const op of operations) {
        if (op.type === 'remove') {
          graph.removeNode(op.target_id || op.target_code);
        } else if (op.type === 'move') {
          graph.moveNode(op.target_id || op.target_code, op.new_parent_id || op.new_parent_code || 'me');
        }
      }
    }

    // Apply identity resolution results
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r.outcome === 'new' && r.node) {
          graph.addPharosNode({ node: r.node, parentId: r.parentId || r.node.parent_id || 'me' });
        } else if ((r.outcome === 'related' || r.outcome === 'conflicting') && r.claim) {
          graph.addPharosClaim(r.claim);
        } else if (r.outcome === 'same' && r.expression) {
          graph.incrementExpression(r.expression.source_node);
        }
      }
    }
  } catch (err) {
    console.error('[ingest] error', err);
  } finally {
    endProcessing();
  }
}

micBtn.addEventListener('click', async () => {
  if (live) {
    realtime.stop();
    live = false;
    micBtn.dataset.live = 'false';
    setStatus('ready');
    return;
  }

  micBtn.disabled = true;
  try {
    const voice = getSelectedVoice();
    await realtime.start({ onTranscript: handleTranscript, onStatus: setStatus }, voice);
    live = true;
    micBtn.dataset.live = 'true';
  } catch (err) {
    console.error(err);
    setStatus('error');
    realtime.stop();
  } finally {
    micBtn.disabled = false;
  }
});

// ─── Input mode (voice / text / github) ──────────────────────────────────────

function setInputMode(mode) {
  if (!['voice', 'text', 'github', 'file'].includes(mode)) return;
  if (mode === inputMode) return;
  inputMode = mode;

  // Stop voice when switching away
  if (mode !== 'voice' && live) {
    realtime.stop();
    live = false;
    micBtn.dataset.live = 'false';
    setStatus('ready');
  }

  if (micArea) micArea.hidden = mode !== 'voice';
  micBtn.hidden = mode !== 'voice';
  if (textInputForm) textInputForm.hidden = mode !== 'text';
  if (githubInputForm) githubInputForm.hidden = mode !== 'github';
  if (dropZone) dropZone.hidden = mode !== 'file';

  for (const btn of modeButtons) {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  }

  if (mode === 'text') textInput?.focus();
  else if (mode === 'github') githubInput?.focus();

  localStorage.setItem('pharos-input-mode', mode);
}

for (const btn of modeButtons) {
  btn.addEventListener('click', () => setInputMode(btn.dataset.mode));
}

textInputForm?.addEventListener('submit', e => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  handleTranscript({ transcript: text, assistantPrior: '' });
});

// ─── GitHub repo ingest ─────────────────────────────────────────────────────

async function ingestRepo(url, tier = 'small') {
  beginProcessing();
  try {
    const res = await fetch('ingest/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        parent_id: graph.getFocusedNodeId(),
        tier,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      showToast('Repo failed: ' + err.slice(0, 140), 'error');
      return;
    }
    const result = await res.json();
    const { nodes = [], rootParentId, repoName, truncated, tier: resolvedTier, nodeCount } = result;

    // Add parents before children using the order returned (root → walk order)
    for (const node of nodes) {
      graph.addPharosNode({ node, parentId: node.parent_id || rootParentId || 'me' });
    }

    if (truncated && resolvedTier === 'small') {
      showActionToast(
        `+${nodeCount} from ${repoName} (capped at 300)`,
        'continue → 1000',
        () => ingestRepo(url, 'medium'),
        'success',
        10000,
      );
    } else if (truncated && resolvedTier === 'medium') {
      showActionToast(
        `+${nodeCount} from ${repoName} (capped at 1000)`,
        'continue → all',
        () => ingestRepo(url, 'full'),
        'success',
        12000,
      );
    } else {
      showToast(`+${nodeCount} from ${repoName}`, 'success');
    }
  } catch (err) {
    console.error('[github] error', err);
    showToast('Repo failed: ' + err.message, 'error');
  } finally {
    endProcessing();
  }
}

githubInputForm?.addEventListener('submit', e => {
  e.preventDefault();
  const url = githubInput.value.trim();
  if (!url) return;
  githubInput.value = '';
  ingestRepo(url, 'small');
});

const savedMode = localStorage.getItem('pharos-input-mode');
if (savedMode === 'text' || savedMode === 'github' || savedMode === 'file') setInputMode(savedMode);

function getSessionId() {
  if (!sessionStorage.pharosSessionId) {
    sessionStorage.pharosSessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }
  return sessionStorage.pharosSessionId;
}

// ─── Drop Zone ───────────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className = type || '';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function showActionToast(msg, actionLabel, onAction, type = '', timeoutMs = 8000) {
  toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  toast.appendChild(span);
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.addEventListener('click', () => {
    clearTimeout(toastTimer);
    toast.hidden = true;
    onAction();
  });
  toast.appendChild(btn);
  toast.className = (type ? type + ' ' : '') + 'has-action';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, timeoutMs);
}

// ─── Focus pill (current parent indicator) ──────────────────────────────────

function updateFocusPill(node) {
  if (!focusPill || !focusTargetEl) return;
  const isMe = !node || node.id === 'me';
  if (isMe) {
    focusPill.hidden = true;
    return;
  }
  const code = node.code ? `${node.code}: ` : '';
  const name = node.canonicalName || node.label || node.id;
  focusTargetEl.textContent = `${code}${name}`;
  focusPill.hidden = false;
}

graph.onFocusChange(node => updateFocusPill(node));

focusClearBtn?.addEventListener('click', () => {
  graph.setFocusedNode('me');
  updateFocusPill(graph.getFocusedNode());
});

async function ingestMdFile(text, filename) {
  beginProcessing();
  try {
    const res = await fetch('ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': getSessionId()
      },
      body: JSON.stringify({
        transcript: text,
        assistantPrior: `[file: ${filename}]`,
        focusedParentId: graph.getFocusedNodeId(),
      })
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const { results, operations } = await res.json();

    const newNodes = [];
    if (Array.isArray(operations)) {
      for (const op of operations) {
        if (op.type === 'remove') {
          graph.removeNode(op.target_id || op.target_code);
        } else if (op.type === 'move') {
          graph.moveNode(op.target_id || op.target_code, op.new_parent_id || op.new_parent_code || 'me');
        }
      }
    }

    if (Array.isArray(results)) {
      for (const r of results) {
        if (r.outcome === 'new' && r.node) {
          graph.addPharosNode({ node: r.node, parentId: r.parentId || r.node.parent_id || 'me' });
          newNodes.push(r.node);
        } else if ((r.outcome === 'related' || r.outcome === 'conflicting') && r.claim) {
          graph.addPharosClaim(r.claim);
        } else if (r.outcome === 'same' && r.expression) {
          graph.incrementExpression(r.expression.source_node);
        }
      }
    }

    const count = newNodes.length;
    showToast(count > 0 ? `+${count} node${count !== 1 ? 's' : ''} from ${filename}` : `Parsed ${filename}`, 'success');
  } catch (err) {
    console.error('[md-ingest] error', err);
    showToast('Failed to parse ' + filename, 'error');
  } finally {
    endProcessing();
  }
}

function handleMdFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.md') && file.type !== 'text/markdown') {
    showToast('.md files only', 'error');
    return;
  }
  dropZone.classList.add('processing');
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      await ingestMdFile(e.target.result, file.name);
    } finally {
      dropZone.classList.remove('processing');
    }
  };
  reader.onerror = () => {
    dropZone.classList.remove('processing');
    showToast('Failed to read file', 'error');
  };
  reader.readAsText(file);
}

function handleMdFiles(files) {
  if (!files || files.length === 0) return;
  const mdFiles = Array.from(files).filter(f =>
    f.name.endsWith('.md') || f.type === 'text/markdown'
  );
  if (mdFiles.length === 0) {
    showToast('No .md files found', 'error');
    return;
  }
  if (mdFiles.length < files.length) {
    showToast('Some files skipped (not .md)', 'error');
  }
  if (mdFiles.length === 1) {
    handleMdFile(mdFiles[0]);
    return;
  }
  dropZone.classList.add('processing');
  let processed = 0, failed = 0;
  for (const file of mdFiles) {
    const reader = new FileReader();
    reader.onload = e => {
      ingestMdFile(e.target.result, file.name).then(() => {
        processed++;
        checkDone();
      }).catch(() => {
        failed++;
        checkDone();
      });
    };
    reader.onerror = () => {
      failed++;
      checkDone();
    };
    reader.readAsText(file);
  }
  function checkDone() {
    if (processed + failed === mdFiles.length) {
      dropZone.classList.remove('processing');
      if (failed === 0) {
        showToast(`+${processed} files ingested`, 'success');
      } else {
        showToast(`${processed} ok, ${failed} failed`, 'error');
      }
    }
  }
}

// Click to open file picker
dropZone.addEventListener('click', () => mdInput.click());
mdInput.addEventListener('change', () => {
  handleMdFiles(mdInput.files);
  mdInput.value = '';
});

// Keyboard accessibility
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    mdInput.click();
  }
});

// Drag and drop
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleMdFiles(e.dataTransfer?.files);
});

// ─── P2P: identity, peer management, context menu, SSE ──────────────────────

let myDid = null;

async function loadIdentity() {
  try {
    const res = await fetch('ingest/identity');
    if (!res.ok) return;
    const ident = await res.json();
    myDid = ident.did;
    if (peersDidBadge) {
      peersDidBadge.textContent = ident.did;
      peersDidBadge.title = 'Click to copy your DID';
    }
  } catch (err) {
    console.warn('[identity] load failed', err);
  }
}

async function loadPeers() {
  try {
    const res = await fetch('ingest/peers');
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

function renderPeerList(list) {
  if (!peersList) return;
  peersList.innerHTML = '';
  if (!list.length) {
    peersList.innerHTML = '<div class="peer-empty">No peers yet. Add one to share subtrees with.</div>';
    return;
  }
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'peer-row';
    row.innerHTML = `
      <div class="peer-info">
        <div class="peer-name">${p.name || '(unnamed)'}</div>
        <div class="peer-did" title="${p.did}">${p.did.slice(0, 36)}…</div>
      </div>
      <button class="peer-remove" data-did="${p.did}" aria-label="Remove peer">×</button>
    `;
    row.querySelector('.peer-remove').addEventListener('click', async () => {
      await fetch(`ingest/peers/${encodeURIComponent(p.did)}`, { method: 'DELETE' });
      const peers = await loadPeers();
      renderPeerList(peers);
    });
    peersList.appendChild(row);
  }
}

if (peersBtn && peersPanel) {
  peersBtn.addEventListener('click', async () => {
    const willOpen = peersPanel.hidden;
    peersPanel.hidden = !willOpen;
    peersBtn.setAttribute('aria-expanded', willOpen);
    if (willOpen) {
      closeOtherPanels('peers');
      const peers = await loadPeers();
      renderPeerList(peers);
    }
  });
}

// ─── API keys panel ─────────────────────────────────────────────────────────

function setKeyStatus(el, status) {
  if (!el || !status) return;
  el.className = 'key-status';
  if (status.source === 'stored') {
    el.classList.add('is-set');
    el.textContent = `saved · ${status.masked}`;
  } else if (status.source === 'env') {
    el.classList.add('is-env');
    el.textContent = `env · ${status.masked}`;
  } else {
    el.textContent = 'not set';
  }
}

async function loadKeysStatus() {
  try {
    const res = await fetch('ingest/keys');
    if (!res.ok) return;
    const data = await res.json();
    setKeyStatus(keyOpenaiStatus, data.openai);
    setKeyStatus(keyAnthropicStatus, data.anthropic);
    setKeyStatus(keyOpenrouterStatus, data.openrouter);
    if (keyOpenaiInput) keyOpenaiInput.value = '';
    if (keyAnthropicInput) keyAnthropicInput.value = '';
    if (keyOpenrouterInput) keyOpenrouterInput.value = '';
  } catch (err) {
    console.warn('[keys] load failed', err);
  }
}

if (keysBtn && keysPanel) {
  keysBtn.addEventListener('click', async () => {
    const willOpen = keysPanel.hidden;
    keysPanel.hidden = !willOpen;
    keysBtn.setAttribute('aria-expanded', willOpen);
    if (willOpen) {
      closeOtherPanels('keys');
      await loadKeysStatus();
    }
  });
}

keysCancelBtn?.addEventListener('click', () => {
  if (!keysPanel) return;
  keysPanel.hidden = true;
  keysBtn?.setAttribute('aria-expanded', 'false');
});

keysForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  if (keyOpenaiInput?.value.trim())     patch.openai     = keyOpenaiInput.value.trim();
  if (keyAnthropicInput?.value.trim())  patch.anthropic  = keyAnthropicInput.value.trim();
  if (keyOpenrouterInput?.value.trim()) patch.openrouter = keyOpenrouterInput.value.trim();
  if (Object.keys(patch).length === 0) {
    showToast('No changes to save', 'error');
    return;
  }
  try {
    const res = await fetch('ingest/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      showToast('Save failed: ' + (await res.text()).slice(0, 140), 'error');
      return;
    }
    const data = await res.json();
    setKeyStatus(keyOpenaiStatus, data.openai);
    setKeyStatus(keyAnthropicStatus, data.anthropic);
    setKeyStatus(keyOpenrouterStatus, data.openrouter);
    if (keyOpenaiInput) keyOpenaiInput.value = '';
    if (keyAnthropicInput) keyAnthropicInput.value = '';
    if (keyOpenrouterInput) keyOpenrouterInput.value = '';
    if (keysPanel) {
      keysPanel.hidden = true;
      keysBtn?.setAttribute('aria-expanded', 'false');
    }
    showToast('Keys saved', 'success');
  } catch (err) {
    console.error('[keys] save error', err);
    showToast('Save failed: ' + err.message, 'error');
  }
});

if (peersDidBadge) {
  peersDidBadge.addEventListener('click', () => {
    if (!myDid) return;
    navigator.clipboard?.writeText(myDid);
    showToast('DID copied to clipboard', 'success');
  });
}

if (peerAddBtn) {
  peerAddBtn.addEventListener('click', () => showPeerAddModal());
}

function showPeerAddModal() {
  const overlay = document.createElement('div');
  overlay.className = 'p2p-modal-overlay';
  overlay.innerHTML = `
    <div class="p2p-modal">
      <h3>Add a peer</h3>
      <p>Paste their DID (and optional name) to subscribe to their shared subtrees.</p>
      <input class="p2p-input" id="peer-did-input" type="text" placeholder="did:gun:…" autocomplete="off" />
      <input class="p2p-input" id="peer-name-input" type="text" placeholder="Name (optional)" autocomplete="off" />
      <div class="p2p-actions">
        <button class="p2p-btn-secondary" data-action="cancel">Cancel</button>
        <button class="p2p-btn-primary" data-action="add">Add peer</button>
      </div>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-action="add"]').addEventListener('click', async () => {
    const did = overlay.querySelector('#peer-did-input').value.trim();
    const name = overlay.querySelector('#peer-name-input').value.trim() || null;
    if (!did) { showToast('DID required', 'error'); return; }
    await fetch('ingest/peers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did, name }),
    });
    close();
    const peers = await loadPeers();
    renderPeerList(peers);
    showToast('Peer added', 'success');
  });
  document.body.appendChild(overlay);
  overlay.querySelector('#peer-did-input').focus();
}

// ─── Context menu on right-click ────────────────────────────────────────────

function closeContextMenu() {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
}

graph.onNodeRightClick((node, event) => {
  closeContextMenu();
  const isMe = node.id === 'me';
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = isMe
    ? `
      <button data-action="make-public">🌐 Share entire graph publicly</button>
      <button data-action="share-specific">🔐 Share entire graph with…</button>
      <button data-action="link-avatar">🔗 Link entire graph to peers</button>
    `
    : `
      <button data-action="make-public">🌐 Make public</button>
      <button data-action="share-specific">🔐 Share with…</button>
      <button data-action="link-avatar">🔗 Link to my avatar</button>
      <button data-action="remove" class="ctx-danger">🗑 Remove node</button>
    `;
  menu.style.left = (event.clientX + 6) + 'px';
  menu.style.top = (event.clientY + 6) + 'px';
  document.body.appendChild(menu);

  const labelOf = isMe
    ? 'Entire graph'
    : (node.canonicalName || node.label || node.id);

  menu.querySelector('[data-action="make-public"]').addEventListener('click', async () => {
    closeContextMenu();
    const r = await postShare({ nodeId: node.id, mode: 'public' });
    if (r?.spaceId) showToast(`${labelOf} made public`, 'success');
  });

  menu.querySelector('[data-action="share-specific"]').addEventListener('click', () => {
    closeContextMenu();
    showShareSpecificModal(node);
  });

  menu.querySelector('[data-action="link-avatar"]').addEventListener('click', async () => {
    closeContextMenu();
    const r = await postShare({ nodeId: node.id, mode: 'avatar' });
    if (r?.spaceId) showToast(`${labelOf} linked to your avatar`, 'success');
  });

  menu.querySelector('[data-action="remove"]')?.addEventListener('click', async () => {
    closeContextMenu();
    if (!confirm(`Remove "${labelOf}" and everything under it?`)) return;
    try {
      const res = await fetch(`ingest/node/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast('Remove failed: ' + await res.text(), 'error');
        return;
      }
      const { removed = [] } = await res.json();
      for (const id of removed) graph.removeNode(id);
      showToast(`Removed ${removed.length} node${removed.length !== 1 ? 's' : ''}`, 'success');
    } catch (err) {
      showToast('Remove failed: ' + err.message, 'error');
    }
  });
});

document.addEventListener('click', e => {
  if (!e.target.closest('.ctx-menu')) closeContextMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeContextMenu(); });

async function postShare(body) {
  try {
    const res = await fetch('ingest/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      showToast('Share failed: ' + err, 'error');
      return null;
    }
    return await res.json();
  } catch (err) {
    showToast('Share failed: ' + err.message, 'error');
    return null;
  }
}

function showShareSpecificModal(node) {
  const overlay = document.createElement('div');
  overlay.className = 'p2p-modal-overlay';
  overlay.innerHTML = `
    <div class="p2p-modal">
      <h3>Share "${node.canonicalName || node.id}"</h3>
      <p>Paste the recipient's DID. The subtree will be encrypted end-to-end.</p>
      <input class="p2p-input" id="share-did-input" type="text" placeholder="did:gun:…" autocomplete="off" />
      <div class="p2p-actions">
        <button class="p2p-btn-secondary" data-action="cancel">Cancel</button>
        <button class="p2p-btn-primary" data-action="share">Share</button>
      </div>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-action="share"]').addEventListener('click', async () => {
    const did = overlay.querySelector('#share-did-input').value.trim();
    if (!did) { showToast('DID required', 'error'); return; }
    const r = await postShare({ nodeId: node.id, mode: 'specific', recipientDID: did });
    close();
    if (r?.spaceId) showToast('Shared (encrypted)', 'success');
  });
  document.body.appendChild(overlay);
  overlay.querySelector('#share-did-input').focus();
}

// ─── manual node add (click empty space) ────────────────────────────────────

const addNodePopover = document.getElementById('add-node-popover');
const addNodeForm = document.getElementById('add-node-form');
const addNodeName = document.getElementById('add-node-name');
const addNodeConnections = document.getElementById('add-node-connections');
const addNodeCancelBtn = addNodePopover?.querySelector('[data-action="cancel"]');

let addNodeMarker = null;
let addNodeSelected = []; // ordered array of node ids; first is parent

function closeAddNode() {
  if (!addNodePopover) return;
  addNodePopover.classList.remove('is-open');
  setTimeout(() => { addNodePopover.hidden = true; }, 180);
  if (addNodeMarker) {
    addNodeMarker.remove();
    addNodeMarker = null;
  }
  addNodeSelected = [];
  if (addNodeForm) addNodeForm.reset();
}

function renderConnectionList() {
  if (!addNodeConnections) return;
  const all = graph.listNodesForPicker();
  addNodeConnections.innerHTML = '';
  if (!all.length) {
    addNodeConnections.innerHTML = '<div class="add-node-empty">no nodes yet — saved as a top-level concept</div>';
    return;
  }
  for (const n of all) {
    const idx = addNodeSelected.indexOf(n.id);
    const isSelected = idx !== -1;
    const isParent = idx === 0;
    const row = document.createElement('div');
    row.className = 'add-node-conn-row' + (isSelected ? ' is-selected' : '') + (isParent ? ' is-parent' : '');
    row.dataset.id = n.id;
    row.innerHTML = `
      <span class="add-node-conn-code">${n.code || '·'}</span>
      <span class="add-node-conn-name">${n.label}</span>
      ${isParent ? '<span class="add-node-conn-tag">parent</span>' : ''}
    `;
    row.addEventListener('click', () => {
      const i = addNodeSelected.indexOf(n.id);
      if (i === -1) addNodeSelected.push(n.id);
      else addNodeSelected.splice(i, 1);
      renderConnectionList();
    });
    addNodeConnections.appendChild(row);
  }
}

function placeAddNodePopover(clientX, clientY) {
  if (!addNodePopover) return;
  const popW = 280;
  const popH = 320; // approximate
  const margin = 12;
  let left = clientX + margin;
  let top = clientY + margin;
  if (left + popW > window.innerWidth - margin) left = clientX - popW - margin;
  if (top + popH > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - popH - margin);
  if (left < margin) left = margin;
  if (top < margin) top = margin;
  addNodePopover.style.left = left + 'px';
  addNodePopover.style.top = top + 'px';
}

function openAddNode(clientX, clientY) {
  if (!addNodePopover) return;
  addNodeSelected = [];
  renderConnectionList();
  placeAddNodePopover(clientX, clientY);
  addNodePopover.hidden = false;
  requestAnimationFrame(() => addNodePopover.classList.add('is-open'));

  if (addNodeMarker) addNodeMarker.remove();
  addNodeMarker = document.createElement('div');
  addNodeMarker.id = 'add-node-marker';
  addNodeMarker.style.left = clientX + 'px';
  addNodeMarker.style.top = clientY + 'px';
  document.body.appendChild(addNodeMarker);

  setTimeout(() => addNodeName?.focus(), 60);
}

graph.onBackgroundClick(event => {
  if (!event) return;
  if (addNodePopover && !addNodePopover.hidden) { closeAddNode(); return; }
  closeContextMenu();
  openAddNode(event.clientX, event.clientY);
});

addNodeCancelBtn?.addEventListener('click', closeAddNode);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && addNodePopover && !addNodePopover.hidden) closeAddNode();
});

// click anywhere outside popover (and outside graph background, which already handles toggle) closes
document.addEventListener('mousedown', e => {
  if (!addNodePopover || addNodePopover.hidden) return;
  if (e.target.closest('#add-node-popover')) return;
  if (e.target.closest('#graph')) return; // background-click handler manages this
  closeAddNode();
});

addNodeForm?.addEventListener('submit', async e => {
  e.preventDefault();
  const name = addNodeName.value.trim();
  if (!name) return;
  const parent_id = addNodeSelected[0] || 'me';
  const connections = addNodeSelected.slice(1);
  beginProcessing();
  try {
    const res = await fetch('ingest/node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id, connections }),
    });
    if (!res.ok) {
      showToast('Add failed: ' + (await res.text()), 'error');
      return;
    }
    const { node, parentId, claims = [] } = await res.json();
    graph.addPharosNode({ node, parentId });
    for (const claim of claims) graph.addPharosClaim(claim);
    showToast(`+${name}`, 'success');
    closeAddNode();
  } catch (err) {
    console.error('[manual-add] error', err);
    showToast('Add failed: ' + err.message, 'error');
  } finally {
    endProcessing();
  }
});

// ─── SSE: ingest live remote shared nodes/claims ────────────────────────────

function startSSE() {
  let events;
  try {
    events = new EventSource('ingest/events');
  } catch (err) {
    console.warn('[sse] could not open', err);
    return;
  }
  events.addEventListener('node', e => {
    try {
      const { node, spaceId } = JSON.parse(e.data);
      graph.addPharosNode({
        node,
        parentId: node.parent_id || 'me',
        sharedSpaceId: spaceId,
        ownerDid: node._owner_did,
      });
    } catch (err) { console.warn('[sse] node parse', err); }
  });
  events.addEventListener('claim', e => {
    try {
      const { claim, spaceId } = JSON.parse(e.data);
      graph.addPharosClaim({ ...claim, _sharedSpace: spaceId });
    } catch (err) { console.warn('[sse] claim parse', err); }
  });
  events.onerror = () => {
    // EventSource will auto-reconnect — just log once
    console.warn('[sse] connection error, will retry');
  };
}

async function hydrateState() {
  try {
    const res = await fetch('ingest/state');
    if (!res.ok) return;
    const { nodes = [], claims = [] } = await res.json();

    // Add parents before children so PARENT links resolve correctly
    const sorted = [...nodes].sort((a, b) => {
      const ta = a.created ? new Date(a.created).getTime() : 0;
      const tb = b.created ? new Date(b.created).getTime() : 0;
      return ta - tb;
    });

    for (const node of sorted) {
      graph.addPharosNode({ node, parentId: node.parent_id || 'me' });
    }
    for (const claim of claims) {
      graph.addPharosClaim(claim);
    }
  } catch (err) {
    console.warn('[hydrate] failed', err);
  }
}

// ─── welcome screen (first-run name capture) ────────────────────────────────

(function initWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  const form = document.getElementById('welcome-form');
  const input = document.getElementById('welcome-name');
  if (!overlay) return;

  const existing = getUserName();
  if (existing) {
    overlay.hidden = true;
    return;
  }

  setTimeout(() => input?.focus(), 700);

  form?.addEventListener('submit', e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    setUserName(name);
    graph.setMyName(name);
    overlay.classList.add('fade-out');
    setTimeout(() => { overlay.hidden = true; }, 750);
  });
})();

loadIdentity();
hydrateState();
startSSE();
