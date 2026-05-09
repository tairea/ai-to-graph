import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { getAvatar } from './avatar.js';
import { getUserName } from './user.js';

const fontReady = document.fonts.ready;

let graph;
let tipEl;
let mouse = { x: 0, y: 0 };

let cachedAvatarTexture = null;
let cachedAvatarUrl = null;
let lastNodeId = null;
let fitTimer = null;
let branchCounters = {};
let nextBranchCharCode = 65;
let meHoverCb = null;
let nodeRightClickCb = null;
let backgroundClickCb = null;
let focusChangeCb = null;
let focusedNodeId = 'me';

const AVATAR_TEXTURE_SIZE = 256;
const AVATAR_SPRITE_SIZE = 28;
const CONCEPT_NODE_RADIUS = 4;

// ─── resonance state colours ─────────────────────────────────────────────────

const RESONANCE_COLORS = {
  latent:      0x2a3050,
  emerging:    0x4a5780,
  active:      0x6f86ff,
  deepening:   0x8a6fff,
  integrating: 0x5adf8a,
  resolving:   0xdfb050,
  synthesized: 0xffd700,
  transmuted:  0xff9060
};

function resonanceColor(state) {
  return RESONANCE_COLORS[state] || RESONANCE_COLORS.active;
}

// ─── predicate colours ────────────────────────────────────────────────────────

const CUBE_PREDICATES = new Set([
  'EXPRESSES','ORIGINATES_FROM','CONTEXTUALIZES','OPERATIONALIZES',
  'INSTANCES','GROUNDS','EMBEDS_IN','ENACTS',
  'APPEARS_IN','PRODUCES','EMERGES_FROM','GENERATES'
]);

function predicateColor(predicate) {
  if (!predicate || predicate === 'PARENT') return 'rgba(180,200,255,0.5)';
  if (predicate === 'CONTRADICTS')   return 'rgba(255,60,80,0.85)';
  if (predicate === 'EQUIVALENT_TO') return 'rgba(60,220,255,0.75)';
  if (predicate === 'IS_ANALOGOUS_TO') return 'rgba(80,255,180,0.65)';
  if (predicate === 'DEPENDS_ON')    return 'rgba(255,200,60,0.7)';
  if (predicate === 'PART_OF' || predicate === 'SUBTYPE_OF') return 'rgba(180,140,255,0.65)';
  if (CUBE_PREDICATES.has(predicate)) return 'rgba(140,180,255,0.6)';
  return 'rgba(180,200,255,0.4)';
}

function predicateWidth(predicate) {
  if (predicate === 'CONTRADICTS') return 2.5;
  if (predicate === 'EQUIVALENT_TO') return 2;
  return 1.2;
}

// ─── avatar texture ───────────────────────────────────────────────────────────

function drawFallbackAvatar(ctx, size) {
  const cx = size / 2;
  const bg = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  bg.addColorStop(0, '#141e35');
  bg.addColorStop(1, '#0a0f1c');
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(80,140,255,0.2)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
  ctx.clip();

  const headR = size * 0.14;
  const headY = size * 0.35;
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120,170,255,0.35)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,170,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const bodyTop = size * 0.56;
  ctx.beginPath();
  ctx.ellipse(cx, bodyTop + size * 0.2, size * 0.3, size * 0.26, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120,170,255,0.25)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,170,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

function getAvatarTexture(dataUrl) {
  if (cachedAvatarTexture && cachedAvatarUrl === dataUrl) return cachedAvatarTexture;
  const size = AVATAR_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  drawFallbackAvatar(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (dataUrl && !dataUrl.endsWith('.png')) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();
      const srcSize = Math.min(img.width, img.height);
      const sx = (img.width - srcSize) / 2;
      const sy = (img.height - srcSize) / 2;
      ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
      ctx.restore();
      texture.needsUpdate = true;
    };
    img.src = dataUrl;
  }
  cachedAvatarUrl = dataUrl;
  cachedAvatarTexture = texture;
  return texture;
}

// ─── developer file/folder icons (material-icon-theme via jsdelivr) ──────────

const ICON_BASE = 'https://cdn.jsdelivr.net/npm/material-icon-theme@latest/icons';
const ICON_TEXTURE_SIZE = 128;

const FILE_ICON_BY_NAME = {
  'package.json': 'nodejs',
  'package-lock.json': 'nodejs',
  'pnpm-lock.yaml': 'nodejs',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'tsconfig.json': 'tsconfig',
  'jsconfig.json': 'tsconfig',
  'readme.md': 'readme',
  'license': 'certificate',
  'license.md': 'certificate',
  'license.txt': 'certificate',
  'dockerfile': 'docker',
  '.dockerignore': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.env': 'tune',
  '.env.example': 'tune',
  '.env.local': 'tune',
  'vite.config.js': 'vite',
  'vite.config.ts': 'vite',
  'webpack.config.js': 'webpack',
  'rollup.config.js': 'rollup',
  'babel.config.js': 'babel',
  '.babelrc': 'babel',
  '.eslintrc': 'eslint',
  '.eslintrc.js': 'eslint',
  '.eslintrc.json': 'eslint',
  '.prettierrc': 'prettier',
  '.prettierrc.json': 'prettier',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
  'go.mod': 'go-mod',
  'go.sum': 'go-mod',
  'requirements.txt': 'python-misc',
  'pipfile': 'python-misc',
  'gemfile': 'gemfile',
  'makefile': 'makefile',
  'cmakelists.txt': 'cmake',
};

const FILE_ICON_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'react_ts',
  jsx: 'react',
  py: 'python', pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  h: 'h', hpp: 'h',
  cs: 'csharp',
  php: 'php',
  html: 'html', htm: 'html',
  css: 'css',
  scss: 'sass', sass: 'sass',
  less: 'less',
  json: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  md: 'markdown', mdx: 'markdown',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  txt: 'document',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image',
  svg: 'svg',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio',
  zip: 'zip', tar: 'zip', gz: 'zip', '7z': 'zip', rar: 'zip',
  sql: 'database', db: 'database', sqlite: 'database',
  graphql: 'graphql', gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  prisma: 'prisma',
  proto: 'proto',
  lock: 'lock',
};

const FOLDER_ICON_BY_NAME = {
  src: 'folder-src',
  source: 'folder-src',
  lib: 'folder-lib',
  libs: 'folder-lib',
  public: 'folder-public',
  static: 'folder-public',
  assets: 'folder-resource',
  images: 'folder-images',
  img: 'folder-images',
  fonts: 'folder-font',
  styles: 'folder-css',
  style: 'folder-css',
  css: 'folder-css',
  scss: 'folder-css',
  components: 'folder-components',
  component: 'folder-components',
  pages: 'folder-views',
  views: 'folder-views',
  layouts: 'folder-layout',
  routes: 'folder-routes',
  controllers: 'folder-controller',
  controller: 'folder-controller',
  models: 'folder-database',
  schemas: 'folder-database',
  services: 'folder-mappings',
  service: 'folder-mappings',
  middleware: 'folder-middleware',
  utils: 'folder-utils',
  util: 'folder-utils',
  helpers: 'folder-helper',
  helper: 'folder-helper',
  hooks: 'folder-hook',
  store: 'folder-redux',
  stores: 'folder-redux',
  api: 'folder-api',
  apis: 'folder-api',
  tests: 'folder-test',
  test: 'folder-test',
  __tests__: 'folder-test',
  spec: 'folder-test',
  e2e: 'folder-e2e',
  docs: 'folder-docs',
  doc: 'folder-docs',
  config: 'folder-config',
  configs: 'folder-config',
  scripts: 'folder-scripts',
  bin: 'folder-scripts',
  dist: 'folder-dist',
  build: 'folder-dist',
  out: 'folder-dist',
  target: 'folder-dist',
  node_modules: 'folder-node',
  '.git': 'folder-git',
  '.github': 'folder-github',
  '.vscode': 'folder-vscode',
  '.idea': 'folder-idea',
};

function getFileIconName(filename) {
  if (!filename) return 'file';
  const lower = filename.toLowerCase();
  if (FILE_ICON_BY_NAME[lower]) return FILE_ICON_BY_NAME[lower];
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'file';
  const ext = lower.slice(dot + 1);
  return FILE_ICON_BY_EXT[ext] || 'file';
}

function getFolderIconName(name) {
  const lower = (name || '').toLowerCase();
  return FOLDER_ICON_BY_NAME[lower] || 'folder';
}

const iconTextureCache = new Map();

function getIconTexture(iconName) {
  const cached = iconTextureCache.get(iconName);
  if (cached) return cached;

  const size = ICON_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  iconTextureCache.set(iconName, texture);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    texture.needsUpdate = true;
  };
  img.onerror = () => {
    if (iconName === 'file' || iconName === 'folder') return;
    const fallback = iconName.startsWith('folder') ? 'folder' : 'file';
    iconTextureCache.delete(iconName);
    const fbTex = getIconTexture(fallback);
    iconTextureCache.set(iconName, fbTex);
  };
  img.src = `${ICON_BASE}/${iconName}.svg`;
  return texture;
}

function nodeIconKind(node) {
  const def = node.definitionCore || '';
  if (def.startsWith('file:')) return 'file';
  if (def.startsWith('dir:')) return 'dir';
  if (def.startsWith('repo:')) return 'repo';
  return null;
}

// ─── focus ring texture (for the avatar/me node) ─────────────────────────────

let _focusRingTexture = null;
function getFocusRingTexture() {
  if (_focusRingTexture) return _focusRingTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const grad = ctx.createRadialGradient(cx, cx, size * 0.34, cx, cx, size * 0.5);
  grad.addColorStop(0, 'rgba(120,180,255,0)');
  grad.addColorStop(0.78, 'rgba(120,180,255,0.55)');
  grad.addColorStop(0.92, 'rgba(120,180,255,0.25)');
  grad.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  _focusRingTexture = new THREE.CanvasTexture(canvas);
  _focusRingTexture.colorSpace = THREE.SRGBColorSpace;
  return _focusRingTexture;
}

// ─── text sprite ──────────────────────────────────────────────────────────────

const LABEL_PAD = 16;
const LABEL_SCALE = 0.12;
const LABEL_INNER_PAD = LABEL_PAD * LABEL_SCALE;

function makeTextSprite({ label, code = '' }) {
  const labelSize = 44;
  const codeSize = 26;
  const lineGap = 6;

  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d');
  mctx.font = `300 ${labelSize}px 'Sora', system-ui, sans-serif`;
  const labelWidth = Math.ceil(mctx.measureText(label).width);
  let codeWidth = 0;
  if (code) {
    mctx.font = `400 ${codeSize}px 'Sora', system-ui, sans-serif`;
    codeWidth = Math.ceil(mctx.measureText(code).width);
  }
  const w = Math.max(labelWidth, codeWidth) + LABEL_PAD * 2;
  const h = code
    ? LABEL_PAD + labelSize + lineGap + codeSize + LABEL_PAD
    : labelSize + LABEL_PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fillStyle = 'rgba(8,14,28,0.6)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(100,150,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = `300 ${labelSize}px 'Sora', system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(200,215,240,0.9)';
  if (code) {
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, w / 2, LABEL_PAD + labelSize * 0.78);
    ctx.font = `400 ${codeSize}px 'Sora', system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(140,180,230,0.5)';
    ctx.fillText(code, w / 2, LABEL_PAD + labelSize + lineGap + codeSize * 0.78);
  } else {
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, h / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(w * LABEL_SCALE, h * LABEL_SCALE, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function makeExpressionBadge(count) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size/2, size/2, size/2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(80,200,160,0.85)';
  ctx.fill();
  ctx.font = 'bold 32px system-ui';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(count), size/2, size/2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 3, 1);
  sprite.position.set(CONCEPT_NODE_RADIUS, CONCEPT_NODE_RADIUS, 0);
  sprite.renderOrder = 1000;
  return sprite;
}

// ─── node 3D object ───────────────────────────────────────────────────────────

const ICON_SPRITE_SIZE = 11;
const ICON_FILE_SPRITE_SIZE = 9;

function buildNodeObject(node) {
  const group = new THREE.Group();
  const isFocused = node.id === focusedNodeId;
  const iconKind = node.id === 'me' ? null : nodeIconKind(node);

  if (node.id === 'me') {
    const mat = new THREE.SpriteMaterial({
      map: getAvatarTexture(node.avatar || getAvatar()),
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(AVATAR_SPRITE_SIZE, AVATAR_SPRITE_SIZE, 1);
    group.add(sprite);

    if (isFocused) {
      const ringMat = new THREE.SpriteMaterial({
        map: getFocusRingTexture(),
        transparent: true,
        depthWrite: false,
      });
      const ring = new THREE.Sprite(ringMat);
      ring.scale.set(AVATAR_SPRITE_SIZE * 1.4, AVATAR_SPRITE_SIZE * 1.4, 1);
      group.add(ring);
    }
  } else if (iconKind) {
    const name = node.canonicalName || node.label || '';
    const iconName = iconKind === 'file'
      ? getFileIconName(name)
      : iconKind === 'repo'
        ? 'folder-git'
        : getFolderIconName(name);
    const tex = getIconTexture(iconName);
    const size = iconKind === 'file' ? ICON_FILE_SPRITE_SIZE : ICON_SPRITE_SIZE;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(size, size, 1);
    group.add(sprite);

    if (isFocused) {
      const ringMat = new THREE.SpriteMaterial({
        map: getFocusRingTexture(),
        transparent: true,
        depthWrite: false,
      });
      const ring = new THREE.Sprite(ringMat);
      ring.scale.set(size * 1.7, size * 1.7, 1);
      group.add(ring);
    }
  } else {
    const isShared = !!node.sharedSpace;
    const color = isShared ? 0xffd700 : resonanceColor(node.resonanceState || 'active');
    const geom = new THREE.SphereGeometry(CONCEPT_NODE_RADIUS, 16, 16);
    const mat = new THREE.MeshLambertMaterial({ color, emissive: isShared ? 0x664400 : 0x000000 });
    group.add(new THREE.Mesh(geom, mat));

    // Gold halo for shared nodes
    if (isShared) {
      const haloGeom = new THREE.SphereGeometry(CONCEPT_NODE_RADIUS + 1.2, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 0.22,
        side: THREE.BackSide,
      });
      group.add(new THREE.Mesh(haloGeom, haloMat));
    }

    // Contradiction halo
    if (node.hasContradiction) {
      const haloGeom = new THREE.SphereGeometry(CONCEPT_NODE_RADIUS + 1.5, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xff3c50,
        transparent: true,
        opacity: 0.3,
        side: THREE.BackSide
      });
      group.add(new THREE.Mesh(haloGeom, haloMat));
    }

    // Expression count badge
    if (node.expressionCount > 0) {
      group.add(makeExpressionBadge(node.expressionCount));
    }

    // Focus halo
    if (isFocused) {
      const haloGeom = new THREE.SphereGeometry(CONCEPT_NODE_RADIUS + 1.6, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0x6f86ff,
        transparent: true,
        opacity: 0.32,
        side: THREE.BackSide,
      });
      group.add(new THREE.Mesh(haloGeom, haloMat));
    }
  }

  const labelText = node.id === 'me'
    ? (node.label || 'wayfinder')
    : (node.label || node.canonicalName || '');
  const codeText = node.id === 'me' ? '' : (node.code || '');

  if (labelText) {
    const label = makeTextSprite({ label: labelText, code: codeText });
    let nodeBottom;
    if (node.id === 'me') nodeBottom = AVATAR_SPRITE_SIZE / 2;
    else if (iconKind) nodeBottom = (iconKind === 'file' ? ICON_FILE_SPRITE_SIZE : ICON_SPRITE_SIZE) / 2;
    else nodeBottom = CONCEPT_NODE_RADIUS;
    // Position so the visible top of the label text sits ~1 unit below the node bottom.
    const yOffset = -(nodeBottom + 1) - label.scale.y / 2 + LABEL_INNER_PAD;
    label.position.set(0, yOffset, 0);
    group.add(label);
  }

  return group;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function scheduleFit() {
  // When the user has explicitly focused a node, don't auto-fit — it would
  // yank the camera away from their chosen subject as new children arrive.
  if (focusedNodeId && focusedNodeId !== 'me') return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    try { graph.zoomToFit(600, 80); } catch (e) { console.warn('[graph] zoomToFit failed', e); }
  }, 600);
}

function allocBranch() {
  const letter = String.fromCharCode(nextBranchCharCode++);
  if (nextBranchCharCode > 90) nextBranchCharCode = 65;
  branchCounters[letter] = 0;
  return letter;
}

function nextCodeInBranch(branch) {
  branchCounters[branch] = (branchCounters[branch] || 0) + 1;
  return `${branch}${branchCounters[branch]}`;
}

function refreshNodeVisuals() {
  graph.nodeThreeObject(graph.nodeThreeObject());
}

function linkEndId(end) {
  return typeof end === 'object' && end !== null ? end.id : end;
}

function collectDescendants(rootId, links) {
  const out = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of links) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      if (out.has(s) && !out.has(t)) { out.add(t); changed = true; }
    }
  }
  return out;
}

function findNode(ref, nodes) {
  if (!ref) return null;
  const lower = String(ref).toLowerCase();
  if (lower === 'me') return nodes.find(n => n.id === 'me') || null;
  return nodes.find(n =>
    String(n.id || '').toLowerCase() === lower ||
    String(n.code || '').toLowerCase() === lower ||
    String(n.label || '').toLowerCase() === lower ||
    String(n.canonicalName || '').toLowerCase() === lower
  ) || null;
}

// ─── tooltip content ──────────────────────────────────────────────────────────

function buildNodeTip(node) {
  const name = node.canonicalName || node.label || node.id;
  let html = `<strong>${name}</strong>`;
  if (node.sharedSpace) {
    const owner = node.ownerDID ? node.ownerDID.slice(0, 24) + '…' : 'remote';
    html += `<div class="tip-shared">shared from ${owner}</div>`;
  }
  if (node.definitionCore) html += `<br><em>${node.definitionCore}</em>`;
  if (node.resonanceState) html += `<div class="tip-state">${node.resonanceState} · ${node.confidence || 'seed'}</div>`;
  if (node.cubeTop || node.cubeBottom) {
    html += `<div class="tip-cube">`;
    if (node.cubeTop)    html += `<span>↑ why:</span> ${node.cubeTop}<br>`;
    if (node.cubeBottom) html += `<span>↓ ground:</span> ${node.cubeBottom}<br>`;
    if (node.cubeFront)  html += `<span>→ expresses:</span> ${node.cubeFront}`;
    html += `</div>`;
  }
  return html;
}

function buildLinkTip(link) {
  let html = '';
  if (link.predicate && link.predicate !== 'PARENT') {
    html += `<div class="tip-predicate">${link.predicate}</div>`;
  }
  if (link.reasoning) html += link.reasoning;
  return html || null;
}

// ─── init ─────────────────────────────────────────────────────────────────────

export function init(container, tip) {
  tipEl = tip;
  lastNodeId = null;
  branchCounters = {};
  nextBranchCharCode = 65;

  graph = ForceGraph3D({ controlType: 'orbit' })(container)
    .backgroundColor('#07090f')
    .nodeRelSize(6)
    .nodeThreeObjectExtend(false)
    .nodeThreeObject(buildNodeObject)
    .linkColor(link => {
      if (link.sharedSpace) return 'rgba(255, 215, 0, 0.7)';
      const src = link.source, tgt = link.target;
      if (src && typeof src === 'object' && src.sharedSpace &&
          tgt && typeof tgt === 'object' && tgt.sharedSpace) {
        return 'rgba(255, 215, 0, 0.7)';
      }
      return predicateColor(link.predicate);
    })
    .linkWidth(link => predicateWidth(link.predicate))
    .onNodeRightClick((node, event) => {
      if (!nodeRightClickCb || !node) return;
      event.preventDefault?.();
      nodeRightClickCb(node, event);
    })
    .onNodeClick(node => focusOnNode(node))
    .onBackgroundClick(event => {
      if (backgroundClickCb && event) backgroundClickCb(event);
    })
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(1.5)
    .onLinkHover(link => {
      if (link) {
        const html = buildLinkTip(link);
        if (html) {
          tipEl.innerHTML = html;
          tipEl.hidden = false;
          positionTip();
          return;
        }
      }
      tipEl.hidden = true;
    })
    .onNodeHover(node => {
      if (node && node.id !== 'me') {
        tipEl.innerHTML = buildNodeTip(node);
        tipEl.hidden = false;
        positionTip();
      } else {
        tipEl.hidden = true;
      }
      if (meHoverCb) {
        if (node && node.id === 'me') {
          const coords = graph.graph2ScreenCoords(node.x, node.y, node.z);
          meHoverCb({ x: coords.x, y: coords.y });
        } else {
          meHoverCb(null);
        }
      }
    });

  graph.d3Force('charge').strength(-220);
  graph.d3Force('link').distance(40);

  graph.graphData({
    nodes: [{ id: 'me', label: getUserName() || 'wayfinder', avatar: getAvatar() }],
    links: []
  });

  graph.cameraPosition({ x: 0, y: 0, z: 250 });

  fontReady.then(() => {
    graph.nodeThreeObject(graph.nodeThreeObject());
  });

  container.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!tipEl.hidden) positionTip();
  });

  const resize = () => {
    graph.width(container.clientWidth);
    graph.height(container.clientHeight);
  };
  window.addEventListener('resize', resize);
  resize();
}

function positionTip() {
  const pad = 14;
  tipEl.style.left = (mouse.x + pad) + 'px';
  tipEl.style.top = (mouse.y + pad) + 'px';
}

// ─── public API ───────────────────────────────────────────────────────────────

export function setAvatar(dataUrl) {
  cachedAvatarTexture = null;
  cachedAvatarUrl = null;
  const data = graph.graphData();
  const me = data.nodes.find(n => n.id === 'me');
  if (me) {
    me.avatar = dataUrl;
    graph.nodeThreeObject(graph.nodeThreeObject());
  }
}

export function setMyName(name) {
  const data = graph.graphData();
  const me = data.nodes.find(n => n.id === 'me');
  if (me) {
    me.label = name;
    graph.nodeThreeObject(graph.nodeThreeObject());
  }
}

export function getNodeLabels() {
  const data = graph.graphData();
  return data.nodes
    .filter(n => n.id !== 'me')
    .map(n => `${n.code || n.id}: ${n.label || n.canonicalName}`);
}

// Add a full PHAROS node to the graph
export function addPharosNode({ node, parentId, sharedSpaceId, ownerDid }) {
  const data = graph.graphData();
  const sharedSpace = sharedSpaceId || node._sharedSpace || null;
  const ownerDID = ownerDid || node._owner_did || null;

  // Check if already in graph (by PHAROS id)
  const existing = data.nodes.find(n => n.id === node.id);
  if (existing) {
    // Update resonance state in case it changed
    existing.resonanceState = node.resonance_state || existing.resonanceState;
    existing.expressionCount = (existing.expressionCount || 0);
    if (sharedSpace && !existing.sharedSpace) {
      existing.sharedSpace = sharedSpace;
      existing.ownerDID = ownerDID;
    }
    refreshNodeVisuals();
    lastNodeId = node.id;
    return;
  }

  const resolvedParentId = node.parent_id || parentId || 'me';
  const parentNode = findNode(resolvedParentId, data.nodes) || data.nodes.find(n => n.id === 'me');
  const branch = parentNode.id === 'me' ? allocBranch() : (parentNode.branch || allocBranch());
  const code = node.code || nextCodeInBranch(branch);

  data.nodes.push({
    id: node.id,
    label: node.canonical_name,
    canonicalName: node.canonical_name,
    definitionCore: node.definition_core,
    resonanceState: node.resonance_state,
    confidence: node.confidence,
    nodeType: node.type,
    cubeTop: node.top,
    cubeBottom: node.bottom,
    cubeFront: node.front,
    cubeBack: node.back,
    cubeLeft: node.left,
    cubeRight: node.right,
    branch,
    code,
    expressionCount: 0,
    hasContradiction: false,
    sharedSpace,
    ownerDID,
  });

  data.links.push({
    source: parentNode.id,
    target: node.id,
    predicate: 'PARENT',
    reasoning: node.definition_core,
    sharedSpace,
  });

  graph.graphData(data);
  lastNodeId = node.id;
  scheduleFit();
  console.log(`[graph] +node ${code}: ${node.canonical_name}${sharedSpace ? ' [shared:' + sharedSpace + ']' : ''}`);
}

// Add a typed PHAROS claim edge
export function addPharosClaim(claim) {
  const data = graph.graphData();

  const subjectNode = data.nodes.find(n => n.id === claim.subject_node);
  const objectNode  = data.nodes.find(n => n.id === claim.object_node);

  if (!subjectNode || !objectNode) {
    console.warn('[graph] addPharosClaim: node(s) not found', claim.subject_node, claim.object_node);
    return;
  }

  // Mark contradicted nodes
  if (claim.predicate === 'CONTRADICTS') {
    subjectNode.hasContradiction = true;
    objectNode.hasContradiction = true;
    refreshNodeVisuals();
  }

  // Avoid duplicate edges for same predicate pair
  const exists = data.links.find(l =>
    linkEndId(l.source) === claim.subject_node &&
    linkEndId(l.target) === claim.object_node &&
    l.predicate === claim.predicate
  );
  if (exists) return;

  data.links.push({
    source: claim.subject_node,
    target: claim.object_node,
    predicate: claim.predicate,
    reasoning: claim.reasoning,
    confidence: claim.confidence,
    sharedSpace: claim._sharedSpace || null,
  });

  graph.graphData(data);
  console.log(`[graph] +claim ${claim.subject_node} —[${claim.predicate}]→ ${claim.object_node}`);
}

// Increment expression count badge on a node
export function incrementExpression(nodeId) {
  const data = graph.graphData();
  const node = data.nodes.find(n => n.id === nodeId);
  if (node) {
    node.expressionCount = (node.expressionCount || 0) + 1;
    refreshNodeVisuals();
    console.log(`[graph] expression++ on ${nodeId} (total: ${node.expressionCount})`);
  }
}

// Legacy: add simple concept (used by /extract shim)
export function addConcept({ id, label, reasoning, parentLabel }) {
  const data = graph.graphData();
  const existing = data.nodes.find(n =>
    n.id !== 'me' && String(n.label || '').toLowerCase() === String(label).toLowerCase()
  );
  if (existing) { lastNodeId = existing.id; return; }

  let parentNode = findNode(parentLabel, data.nodes);
  if (!parentNode && lastNodeId) parentNode = data.nodes.find(n => n.id === lastNodeId);
  if (!parentNode) parentNode = data.nodes.find(n => n.id === 'me');

  const branch = parentNode.id === 'me' ? allocBranch() : parentNode.branch;
  const code = nextCodeInBranch(branch);

  data.nodes.push({ id, label, canonicalName: label, branch, code, expressionCount: 0 });
  data.links.push({ source: parentNode.id, target: id, predicate: 'PARENT', reasoning });
  graph.graphData(data);
  lastNodeId = id;
  scheduleFit();
}

export function removeNode(ref) {
  const data = graph.graphData();
  const node = findNode(ref, data.nodes);
  if (!node || node.id === 'me') { console.warn('[graph] removeNode: not found or root', ref); return false; }
  const doomed = collectDescendants(node.id, data.links);
  const nodes = data.nodes.filter(n => !doomed.has(n.id));
  const links = data.links.filter(l => !doomed.has(linkEndId(l.source)) && !doomed.has(linkEndId(l.target)));
  graph.graphData({ nodes, links });
  if (doomed.has(lastNodeId)) lastNodeId = null;
  scheduleFit();
  console.log(`[graph] -removed ${node.code || node.id} + ${doomed.size - 1} descendants`);
  return true;
}

export function moveNode(ref, newParentRef) {
  const data = graph.graphData();
  const node = findNode(ref, data.nodes);
  const newParent = findNode(newParentRef, data.nodes);
  if (!node || node.id === 'me') { console.warn('[graph] moveNode: target not found', ref); return false; }
  if (!newParent) { console.warn('[graph] moveNode: new parent not found', newParentRef); return false; }
  const subtree = collectDescendants(node.id, data.links);
  if (subtree.has(newParent.id)) { console.warn('[graph] moveNode: cannot move into own subtree'); return false; }

  // Remove the existing parent link to node (keep all other links)
  const links = data.links.filter(l => linkEndId(l.target) !== node.id);

  const newBranch = newParent.id === 'me' ? allocBranch() : newParent.branch;
  const order = [];
  const seen = new Set();
  const walk = id => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const l of data.links) {
      if (linkEndId(l.source) === id && subtree.has(linkEndId(l.target))) walk(linkEndId(l.target));
    }
  };
  walk(node.id);
  for (const nid of order) {
    const n = data.nodes.find(x => x.id === nid);
    const oldCode = n.code;
    n.branch = newBranch;
    n.code = nextCodeInBranch(newBranch);
    console.log(`[graph] recode ${oldCode} → ${n.code}`);
  }

  links.push({ source: newParent.id, target: node.id, predicate: 'PARENT', reasoning: `moved under ${newParent.code || 'me'}` });
  graph.graphData({ nodes: data.nodes, links });
  refreshNodeVisuals();
  scheduleFit();
  return true;
}

export function onMeHover(cb) {
  meHoverCb = cb;
}

export function onNodeRightClick(cb) {
  nodeRightClickCb = cb;
}

export function onBackgroundClick(cb) {
  backgroundClickCb = cb;
}

export function onFocusChange(cb) {
  focusChangeCb = cb;
}

export function getFocusedNodeId() {
  return focusedNodeId;
}

export function getFocusedNode() {
  const data = graph.graphData();
  return data.nodes.find(n => n.id === focusedNodeId) || null;
}

export function setFocusedNode(idOrNode) {
  const id = typeof idOrNode === 'string' ? idOrNode : (idOrNode?.id || 'me');
  const data = graph.graphData();
  const node = data.nodes.find(n => n.id === id) || data.nodes.find(n => n.id === 'me');
  if (!node) return;
  focusOnNode(node, { animate: id !== 'me' });
}

function focusOnNode(node, opts = {}) {
  if (!node) return;
  const animate = opts.animate !== false;
  focusedNodeId = node.id;
  refreshNodeVisuals();
  if (focusChangeCb) focusChangeCb(node);
  if (!animate) return;

  // Pan-only: keep current camera distance/angle, just re-center on the node.
  const cam = graph.camera?.();
  const controls = graph.controls?.();
  const target = controls?.target || { x: 0, y: 0, z: 0 };
  const camPos = cam?.position || { x: 0, y: 0, z: 250 };
  const offset = {
    x: camPos.x - target.x,
    y: camPos.y - target.y,
    z: camPos.z - target.z,
  };
  const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
  graph.cameraPosition(
    { x: nx + offset.x, y: ny + offset.y, z: nz + offset.z },
    { x: nx, y: ny, z: nz },
    700
  );
}

export function listNodesForPicker() {
  const data = graph.graphData();
  return data.nodes.map(n => ({
    id: n.id,
    code: n.code || (n.id === 'me' ? 'me' : null),
    label: n.id === 'me' ? (n.label || 'me') : (n.canonicalName || n.label || n.id),
  }));
}
