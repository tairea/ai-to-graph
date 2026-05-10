import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
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
let graphChangeCb = null;
let focusedNodeId = 'me';

function notifyGraphChange() {
  if (graphChangeCb) graphChangeCb();
}

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
  store: 'folder-mappings',
  stores: 'folder-mappings',
  api: 'folder-api',
  apis: 'folder-api',
  tests: 'folder-test',
  test: 'folder-test',
  __tests__: 'folder-test',
  spec: 'folder-test',
  e2e: 'folder-test',
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
    // Draw the generic fallback into THIS texture's own canvas so any
    // material already referencing it picks up the change.
    const fallback = iconName.startsWith('folder') ? 'folder' : 'file';
    const fbImg = new Image();
    fbImg.crossOrigin = 'anonymous';
    fbImg.onload = () => {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(fbImg, 0, 0, size, size);
      texture.needsUpdate = true;
    };
    fbImg.src = `${ICON_BASE}/${fallback}.svg`;
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
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(w * LABEL_SCALE, h * LABEL_SCALE, 1);
  // Render after opaque scene so transparent edges blend correctly, but with
  // depthTest: true the ship (and other opaque geometry between camera and
  // label) correctly occludes the label.
  sprite.renderOrder = 1;
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
    .onNodeClick(node => {
      if (shipState.active) return;
      focusOnNode(node);
    })
    .onBackgroundClick(event => {
      if (shipState.active) return;
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
  notifyGraphChange();
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
  notifyGraphChange();
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
  notifyGraphChange();
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
  notifyGraphChange();
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

export function onGraphChange(cb) {
  graphChangeCb = cb;
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

export function getNeighbors(id) {
  const data = graph.graphData();
  let parent = null;
  const children = [];
  for (const l of data.links) {
    if (l.predicate !== 'PARENT') continue;
    if (linkEndId(l.target) === id) {
      const pid = linkEndId(l.source);
      parent = data.nodes.find(n => n.id === pid) || null;
    }
    if (linkEndId(l.source) === id) {
      const cid = linkEndId(l.target);
      const c = data.nodes.find(n => n.id === cid);
      if (c) children.push(c);
    }
  }
  children.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  return { parent, firstChild: children[0] || null };
}

// ─── Spaceship mode (mini-game) ──────────────────────────────────────────────
// Loads a low-poly spaceship (Quaternius CC0 OBJ) and lets the user fly it
// around the graph. Mouse steers; W/S accelerate/reverse; Space boosts; the
// ship banks/rolls into turns to feel alive.

const shipState = {
  active: false,
  ship: null,
  thrusters: null,
  trails: null,
  trailsInitialized: false,
  raf: null,
  keys: null,
  keyDown: null,
  keyUp: null,
  mouseMove: null,
  onExit: null,
  mouseNX: 0,
  mouseNY: 0,
  velocity: null,
  yaw: 0,
  pitch: 0,
  roll: 0,
};

const TRAIL_POINTS = 960;     // ~16 seconds of trail at 60fps

const SHIPS = ['Spaceship', 'Spaceship2', 'Spaceship3', 'Spaceship4', 'Spaceship5'];
let currentShipIdx = 2;       // default = Spaceship3

const TRAIL_COLORS = [
  0x88d4ff, // electric cyan
  0xff44dd, // hot pink magenta
  0x44ff88, // acid lime
  0xffaa33, // neon orange
  0xc488ff, // ultraviolet
];
let currentColorIdx = 0;

function bakeTrailColors(colors, hex) {
  const c = new THREE.Color(hex);
  for (let i = 0; i < TRAIL_POINTS; i++) {
    const t = 1 - (i / (TRAIL_POINTS - 1));
    const a = t * t; // squared falloff: bright near head, soft long tail
    colors[i * 3]     = c.r * a;
    colors[i * 3 + 1] = c.g * a;
    colors[i * 3 + 2] = c.b * a;
  }
}

function makeTrailLine(colorHex) {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(TRAIL_POINTS * 3);
  const colors = new Float32Array(TRAIL_POINTS * 3);
  bakeTrailColors(colors, colorHex);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

  // Tell three the buffer is going to change every frame so it doesn't try to
  // optimise it for static use.
  geom.attributes.position.setUsage(THREE.DynamicDrawUsage);

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    linewidth: 2,
  });
  const line = new THREE.Line(geom, mat);
  // The bounding sphere is computed once at construction time and never moves
  // with our shifting vertices. Disable frustum culling so the line is always
  // drawn even when the ship has flown far from the scene origin.
  line.frustumCulled = false;
  return line;
}

function fillTrailWith(trail, pos) {
  const arr = trail.geometry.attributes.position.array;
  for (let i = 0; i < TRAIL_POINTS; i++) {
    arr[i * 3]     = pos.x;
    arr[i * 3 + 1] = pos.y;
    arr[i * 3 + 2] = pos.z;
  }
  trail.geometry.attributes.position.needsUpdate = true;
}

function pushTrailPoint(trail, pos) {
  const arr = trail.geometry.attributes.position.array;
  // Shift everything one slot back (oldest gets dropped).
  for (let i = TRAIL_POINTS - 1; i > 0; i--) {
    arr[i * 3]     = arr[(i - 1) * 3];
    arr[i * 3 + 1] = arr[(i - 1) * 3 + 1];
    arr[i * 3 + 2] = arr[(i - 1) * 3 + 2];
  }
  arr[0] = pos.x;
  arr[1] = pos.y;
  arr[2] = pos.z;
  trail.geometry.attributes.position.needsUpdate = true;
}

// One promise per ship-name → resolves to the normalised OBJ (centered/scaled).
// We hand a fresh wrapping Group on every call so callers can transform it
// freely; the shared OBJ child is reparented automatically when added.
const _shipObjPromises = {};
function loadShipObj(name) {
  if (!_shipObjPromises[name]) {
    _shipObjPromises[name] = new Promise((resolve, reject) => {
      const mtlLoader = new MTLLoader().setPath('models/');
      mtlLoader.load(`${name}.mtl`, (mtl) => {
        mtl.preload();
        const objLoader = new OBJLoader().setMaterials(mtl).setPath('models/');
        objLoader.load(`${name}.obj`, (obj) => {
          const box = new THREE.Box3().setFromObject(obj);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const targetSize = 5;
          const scale = targetSize / maxDim;
          obj.position.sub(center);
          obj.scale.setScalar(scale);
          resolve(obj);
        }, undefined, reject);
      }, undefined, reject);
    });
  }
  return _shipObjPromises[name].then(obj => {
    const wrap = new THREE.Group();
    wrap.add(obj); // reparents from any previous wrap
    return wrap;
  });
}

function makeThrusterFlare() {
  // Two small additive sprites attached behind the ship, scaled by velocity.
  const group = new THREE.Group();
  const tex = makeFlareTexture();
  const make = () => {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0x88c8ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(2, 2, 1);
    return sp;
  };
  const a = make();
  const b = make();
  a.position.set(-0.9, -0.5, -3.0);
  b.position.set(0.9, -0.5, -3.0);
  group.add(a, b);
  group.userData.sprites = [a, b];
  return group;
}

let _flareTex = null;
function makeFlareTexture() {
  if (_flareTex) return _flareTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(180,220,255,0.85)');
  g.addColorStop(0.6, 'rgba(80,160,255,0.35)');
  g.addColorStop(1, 'rgba(40,90,200,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
  ctx.fill();
  _flareTex = new THREE.CanvasTexture(c);
  _flareTex.colorSpace = THREE.SRGBColorSpace;
  return _flareTex;
}

const SHIP_KEYS = {
  forward: ['w', 'arrowup'],
  back:    ['s', 'arrowdown'],
  boost:   [' '],
};

function shipPressed(keys, action) {
  for (const k of SHIP_KEYS[action]) if (keys.has(k)) return true;
  return false;
}

function withDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * (a - dz) / (1 - dz);
}

export async function startSpaceshipMode(opts = {}) {
  if (shipState.active) return false;
  const scene = graph.scene?.();
  const camera = graph.camera?.();
  const controls = graph.controls?.();
  if (!scene || !camera) return false;

  let ship;
  try {
    ship = await loadShipObj(SHIPS[currentShipIdx]);
  } catch (err) {
    console.warn('[ship] failed to load model:', err);
    return false;
  }
  if (shipState.active) return false; // re-entered while loading

  shipState.active = true;
  shipState.onExit = opts.onExit || null;
  if (controls) controls.enabled = false;

  // Spawn at current view target, oriented along the camera's view direction.
  const spawnPos = controls?.target ? controls.target.clone() : new THREE.Vector3();
  // When a node is focused the camera is zoomed in tight on it — spawning at
  // the target hides the ship inside the node mesh. Pull the spawn halfway
  // back toward the camera so the ship sits between camera and node, visible.
  if (focusedNodeId && focusedNodeId !== 'me' && controls?.target) {
    const fromCam = new THREE.Vector3().subVectors(spawnPos, camera.position);
    if (fromCam.lengthSq() > 1e-4) {
      spawnPos.sub(fromCam.multiplyScalar(0.5));
    }
  }
  ship.position.copy(spawnPos);
  const dx = spawnPos.x - camera.position.x;
  const dz = spawnPos.z - camera.position.z;
  shipState.yaw = Math.atan2(dx, dz);
  shipState.pitch = 0;
  shipState.roll = 0;
  ship.rotation.order = 'YXZ';
  ship.rotation.set(0, shipState.yaw, 0, 'YXZ');
  scene.add(ship);
  shipState.ship = ship;

  // Add thruster flares behind the ship.
  const thrusters = makeThrusterFlare();
  ship.add(thrusters);
  shipState.thrusters = thrusters;

  // Two world-space trails — one per thruster.
  const initialColor = TRAIL_COLORS[currentColorIdx];
  const trailL = makeTrailLine(initialColor);
  const trailR = makeTrailLine(initialColor);
  scene.add(trailL);
  scene.add(trailR);
  shipState.trails = [trailL, trailR];
  shipState.trailsInitialized = false;

  // Make sure the flare sprites match the active color too.
  applyShipColor(currentColorIdx);

  shipState.velocity = new THREE.Vector3();
  shipState.mouseNX = 0;
  shipState.mouseNY = 0;

  const keys = new Set();
  shipState.keys = keys;

  shipState.keyDown = (e) => {
    if (e.key === 'Escape') { stopSpaceshipMode(); return; }
    if (e.key === '1') { cycleShip(); return; }
    if (e.key === '2') { cycleShipColor(); return; }
    const k = e.key.toLowerCase();
    keys.add(k);
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      e.preventDefault();
    }
  };
  shipState.keyUp = (e) => keys.delete(e.key.toLowerCase());
  shipState.mouseMove = (e) => {
    shipState.mouseNX = (e.clientX / window.innerWidth) * 2 - 1;
    shipState.mouseNY = -((e.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener('keydown', shipState.keyDown);
  window.addEventListener('keyup', shipState.keyUp);
  window.addEventListener('mousemove', shipState.mouseMove);
  document.body.classList.add('is-ship-mode');

  // Movement / damping constants
  const ACCEL = 0.06;
  const REVERSE = 0.045;
  const MAX_SPEED = 1.6;
  const BOOST_MAX = 3.4;
  const FRICTION = 0.97;
  const YAW_RATE = 0.022;
  const PITCH_RATE = 0.018;
  const PITCH_LIMIT = 1.0;

  const tick = () => {
    if (!shipState.active) return;
    // Re-read each frame so cycleShip()'s swap is picked up automatically;
    // otherwise the tick would keep flying the orphaned old ship.
    const ship = shipState.ship;
    if (!ship) {
      shipState.raf = requestAnimationFrame(tick);
      return;
    }

    // --- mouse steering ---
    const yawIn = withDeadzone(shipState.mouseNX, 0.06);
    const pitchIn = withDeadzone(shipState.mouseNY, 0.06);
    shipState.yaw -= yawIn * YAW_RATE;
    // Mouse up (mouseNY > 0) ⇒ nose tips up. With YXZ Euler on a ship facing
    // +Z, that's a NEGATIVE pitch around X.
    shipState.pitch -= pitchIn * PITCH_RATE;
    shipState.pitch = THREE.MathUtils.clamp(shipState.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    // Bank into turns + slight pitch-aware lean (mouse-right banks right)
    const targetRoll = yawIn * 0.7 - pitchIn * 0.05;
    shipState.roll += (targetRoll - shipState.roll) * 0.08;
    ship.rotation.set(shipState.pitch, shipState.yaw, shipState.roll, 'YXZ');

    // --- thrust ---
    const fwd = new THREE.Vector3(0, 0, 1).applyEuler(ship.rotation);
    const boost = shipPressed(keys, 'boost');
    const accel = shipPressed(keys, 'forward');
    const reverse = shipPressed(keys, 'back');
    if (accel)   shipState.velocity.add(fwd.clone().multiplyScalar(ACCEL * (boost ? 2 : 1)));
    if (reverse) shipState.velocity.add(fwd.clone().multiplyScalar(-REVERSE));

    // Cap speed (different cap when boosting)
    const cap = boost ? BOOST_MAX : MAX_SPEED;
    if (shipState.velocity.length() > cap) {
      shipState.velocity.setLength(cap);
    }
    // Friction so the ship coasts to a stop when no thrust
    shipState.velocity.multiplyScalar(FRICTION);
    ship.position.add(shipState.velocity);

    // Thruster flare brightness scales with speed (and pops during boost).
    const speed = shipState.velocity.length();
    const flareScale = Math.min(1, speed / cap) * (boost ? 1.6 : 1.0);
    const sprites = shipState.thrusters?.userData.sprites;
    if (sprites) {
      for (const s of sprites) {
        s.material.opacity = 0.25 + flareScale * 0.75;
        const jitter = 0.85 + Math.random() * 0.3;
        const w = 1.5 + flareScale * 1.4;
        const l = 1.5 + flareScale * (boost ? 5 : 3) * jitter;
        s.scale.set(w, l, 1);
      }
    }

    // Camera follows from behind + slightly above
    const camOffset = new THREE.Vector3(0, 5, -22).applyEuler(ship.rotation);
    const targetCamPos = ship.position.clone().add(camOffset);
    camera.position.lerp(targetCamPos, 0.1);
    camera.lookAt(ship.position);

    // Trails — sample the two thruster sprites' world positions and push them
    // onto each trail. Shift one slot per frame, oldest fades to zero (which
    // is invisible under additive blending), newest is at the ship.
    if (shipState.trails && sprites) {
      ship.updateMatrixWorld();
      const wL = new THREE.Vector3();
      const wR = new THREE.Vector3();
      sprites[0].getWorldPosition(wL);
      sprites[1].getWorldPosition(wR);
      if (!shipState.trailsInitialized) {
        fillTrailWith(shipState.trails[0], wL);
        fillTrailWith(shipState.trails[1], wR);
        shipState.trailsInitialized = true;
      } else {
        pushTrailPoint(shipState.trails[0], wL);
        pushTrailPoint(shipState.trails[1], wR);
      }
    }

    shipState.raf = requestAnimationFrame(tick);
  };
  tick();

  return true;
}

function applyShipColor(idx) {
  const len = TRAIL_COLORS.length;
  currentColorIdx = ((idx % len) + len) % len;
  const hex = TRAIL_COLORS[currentColorIdx];
  const c = new THREE.Color(hex);
  // Flare sprites
  const sprites = shipState.thrusters?.userData.sprites;
  if (sprites) {
    for (const sp of sprites) {
      sp.material.color.copy(c);
      sp.material.needsUpdate = true;
    }
  }
  // Trail color buffers — re-bake the gradient on the fly.
  if (shipState.trails) {
    for (const trail of shipState.trails) {
      const arr = trail.geometry.attributes.color.array;
      bakeTrailColors(arr, hex);
      trail.geometry.attributes.color.needsUpdate = true;
    }
  }
}

export function cycleShipColor() {
  if (!shipState.active) return;
  applyShipColor(currentColorIdx + 1);
}

export async function cycleShip() {
  if (!shipState.active) return;
  const scene = graph.scene?.();
  if (!scene) return;
  currentShipIdx = (currentShipIdx + 1) % SHIPS.length;
  let newShip;
  try {
    newShip = await loadShipObj(SHIPS[currentShipIdx]);
  } catch (err) {
    console.warn('[ship] failed to load alternate model:', err);
    return;
  }
  if (!shipState.active) return;
  const oldShip = shipState.ship;
  if (!oldShip) return;
  // Inherit transform from the old ship so the swap is seamless.
  newShip.position.copy(oldShip.position);
  newShip.rotation.copy(oldShip.rotation);
  newShip.rotation.order = 'YXZ';
  // Move thrusters from old ship to new ship.
  if (shipState.thrusters) {
    oldShip.remove(shipState.thrusters);
    newShip.add(shipState.thrusters);
  }
  scene.remove(oldShip);
  scene.add(newShip);
  shipState.ship = newShip;
}

export function stopSpaceshipMode() {
  if (!shipState.active) return;
  shipState.active = false;

  const scene = graph.scene?.();
  const controls = graph.controls?.();

  if (shipState.raf) cancelAnimationFrame(shipState.raf);
  shipState.raf = null;

  if (shipState.keyDown) window.removeEventListener('keydown', shipState.keyDown);
  if (shipState.keyUp)   window.removeEventListener('keyup', shipState.keyUp);
  if (shipState.mouseMove) window.removeEventListener('mousemove', shipState.mouseMove);
  shipState.keyDown = shipState.keyUp = shipState.mouseMove = null;

  if (shipState.ship && scene) scene.remove(shipState.ship);
  shipState.ship = null;
  shipState.thrusters = null;
  shipState.keys = null;
  shipState.velocity = null;

  if (shipState.trails && scene) {
    for (const trail of shipState.trails) {
      scene.remove(trail);
      trail.geometry.dispose();
      trail.material.dispose();
    }
  }
  shipState.trails = null;
  shipState.trailsInitialized = false;
  document.body.classList.remove('is-ship-mode');

  if (controls) {
    controls.enabled = true;
    try { controls.update(); } catch {}
  }

  // Frame the whole graph so the user gets oriented after exiting the ship.
  try { graph.zoomToFit(700, 80); } catch (e) { console.warn('[ship] zoomToFit failed', e); }

  const onExit = shipState.onExit;
  shipState.onExit = null;
  if (onExit) onExit();
}

export function isSpaceshipMode() {
  return shipState.active;
}
