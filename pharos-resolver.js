import Anthropic from '@anthropic-ai/sdk';
import { buildPHAROSSystemPrompt, ingestToolSchema } from './pharos-prompt.js';
import * as store from './pharos-store.js';

const RESOLVE_MODEL = process.env.RESOLVE_MODEL || 'claude-sonnet-4-6';
// OpenRouter exposes Claude via the Anthropic SDK if you point baseURL at
// https://openrouter.ai/api/v1 — model names are namespaced "anthropic/…".
const OPENROUTER_MODEL = process.env.OPENROUTER_RESOLVE_MODEL || `anthropic/${RESOLVE_MODEL}`;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function buildClient({ anthropicKey, openrouterKey }) {
  if (anthropicKey) {
    return { client: new Anthropic({ apiKey: anthropicKey }), model: RESOLVE_MODEL };
  }
  if (openrouterKey) {
    return {
      client: new Anthropic({ apiKey: openrouterKey, baseURL: OPENROUTER_BASE }),
      model: OPENROUTER_MODEL,
    };
  }
  throw new Error('No Anthropic or OpenRouter key available');
}

export async function resolve(transcript, assistantPrior, contextId, focusedParentId, keys = {}) {
  const { client, model } = buildClient(keys);
  const existingNodes = store.getStoreSummary();
  const systemPrompt = buildPHAROSSystemPrompt(existingNodes);

  const userContent = assistantPrior
    ? `Assistant said: "${assistantPrior}"\n\nUser said: "${transcript}"\n\nResolve the user's utterance. Use the assistant's prior turn only to resolve references (pronouns, "that", "yes", etc.).`
    : `User said: "${transcript}"\n\nResolve this utterance against the PHAROS graph.`;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ],
    tools: [ingestToolSchema],
    tool_choice: { type: 'tool', name: 'pharos_ingest' },
    messages: [{ role: 'user', content: userContent }]
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call pharos_ingest tool');

  const raw = toolUse.input;

  // Apply results to store and enrich with codes
  const processed = [];

  const hasFocus = focusedParentId && focusedParentId !== 'me' && store.getNode(focusedParentId);

  for (const result of raw.results || []) {
    if (result.outcome === 'new' && result.node) {
      // Strict-override: when a node is focused, route any new top-level concept
      // (parent_id 'me' or missing) under the focused node. Explicit AI-chosen
      // parents under specific other nodes are preserved.
      if (hasFocus && (!result.node.parent_id || result.node.parent_id === 'me')) {
        result.node.parent_id = focusedParentId;
      }
      const node = store.addNode(result.node);
      const parentId = result.node.parent_id || 'me';
      const code = store.assignCode(node.id, parentId);
      processed.push({ ...result, node: { ...node, code }, parentId });

    } else if ((result.outcome === 'related' || result.outcome === 'conflicting') && result.claim) {
      store.addClaim({ ...result.claim, context_id: contextId });
      processed.push(result);

    } else if (result.outcome === 'same' && result.expression) {
      store.incrementExpression(result.expression.source_node);
      processed.push(result);
    }
  }

  // Resolve verbal operations against store
  const resolvedOps = [];
  for (const op of raw.operations || []) {
    const targetNode = store.resolveRef(op.target);
    if (!targetNode) {
      console.warn('[resolver] operation target not found:', op.target);
      continue;
    }
    const newParentNode = op.new_parent && op.new_parent !== 'me'
      ? store.resolveRef(op.new_parent)
      : null;
    const resolvedNewParentId = newParentNode ? newParentNode.id : (op.new_parent === 'me' ? 'me' : '');

    // Actually mutate the store — without this, voice deletes/moves only
    // edit the browser graph and reappear on reload.
    if (op.type === 'remove') {
      store.removeNode(targetNode.id);
    } else if (op.type === 'move' && resolvedNewParentId) {
      store.moveNode(targetNode.id, resolvedNewParentId);
    }

    resolvedOps.push({
      type: op.type,
      target_id: targetNode.id,
      target_code: targetNode.code || op.target,
      new_parent_id: resolvedNewParentId,
      new_parent_code: newParentNode ? (newParentNode.code || op.new_parent) : op.new_parent
    });
  }

  return { results: processed, operations: resolvedOps };
}
