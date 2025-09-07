var isMovingLeft = false;
var isMovingRight = false;
var isMovingUp = false;
var isMovingDown = false;
var isMoving = false;

var finGuy;
var pigTailGirl;
var normalBoy;

var pathStartX = 0;
var pathEndX = 0;
var pathWidth = 4;
const GATE_PAD_TILES = 0.5;

// screen-exit window computed from your anchors (world X) + width (tiles)
var EXIT = null;

// ===== Characters registry ===================================================
var CHAR_DEFS = {
  finGuy: {
    folder: "finHairGuy", baseName: "finGuy",
    x: 0, y: 0, speed: 1.2, width: 40, height: 50,
    mode: "player" // controlled by your isMoving* flags
  },
  pigTailGirl: {
    folder: "pigTailGirl", baseName: "pigTailGirl",
    x: -80, y: -60, speed: 1.2, width: 40, height: 60,
    mode: "follow", followTarget: "finGuy",
    followOpts: { stopRange: [45, 80], jitterRadius: 12, repathEvery: 14, speedScale: 0.7, hysteresis: 2 }
  },
  normalBoy: {
    folder: "normalBoy", baseName: "normalBoy",
    x: -40, y: -40, speed: 1.0, width: 40, height: 60,
    mode: "follow", followTarget: "finGuy",
    followOpts: { stopRange: [80, 100], jitterRadius: 12, repathEvery: 7, speedScale: 0.5, hysteresis: 2 }
  },
  fatBoy: {
    folder: "fatGuy", baseName: "fatBoy",
    x: -40, y: -40, speed: 1.0, width: 60, height: 50,
    mode: "follow", followTarget: "finGuy",
    followOpts: { stopRange: [100, 120], jitterRadius: 12, repathEvery: 24, speedScale: 0.35, hysteresis: 2 }
  },
  parkGuy: {
    folder: "parkGuy", baseName: "parkGuy",
    x: -40, y: -40, speed: 1.0, width: 40, height: 60,
    mode: "follow", followTarget: "normalBoy",
    followOpts: { stopRange: [70, 80], jitterRadius: 2, repathEvery: 4, speedScale: 0.4, hysteresis: 2 }
  }
};

// Global handles (filled by createCharactersFromDefs)
var CHARACTERS = {}; // name -> walker (e.g., CHARACTERS.finGuy)
function allCharsArray() {
  var arr = [], k; for (k in CHARACTERS) arr.push(CHARACTERS[k]); return arr;
}

// Build directional sets from defs (for preloading)
function buildSetsFromDefs(defs) {
  var sets = [], k, d;
  for (k in defs) { d = defs[k]; sets.push(buildDirectionalSet(d.folder, d.baseName)); }
  return sets;
}

// Create walkers from defs (2-pass so follow targets resolve by name)
function createCharactersFromDefs(defs) {
  var k, d, w;
  // pass 1: instantiate
  for (k in defs) {
    d = defs[k];
    w = makeWalker({
      x: d.x, y: d.y, speed: d.speed, folder: d.folder, baseName: d.baseName,
      width: d.width, height: d.height
    });
    CHARACTERS[k] = w;
  }
  // pass 2: set modes
  for (k in defs) {
    d = defs[k]; w = CHARACTERS[k];
    if (d.mode === "player") w.followUserInput();
    else if (d.mode === "follow" && d.followTarget && CHARACTERS[d.followTarget]) {
      w.followSprite(CHARACTERS[d.followTarget], d.followOpts || {});
    }
  }
  // (optional) keep your old globals for convenience:
  finGuy      = CHARACTERS.finGuy;
  pigTailGirl = CHARACTERS.pigTailGirl;
  normalBoy   = CHARACTERS.normalBoy;
}

// One-liner to preload *all* characters in the registry
function preloadAllCharacters(defs) {
  return preloadDirectionalSets(buildSetsFromDefs(defs));
}

// ===== Stages ================================================================
var STAGES = [
  { pathWidth: 4, startXRatio: -1/6, startY: null, endXRatio:  +1/6, endY: null, wiggleAmp: 1,   wiggleStepProb: 0.25 },
  { pathWidth: 4, startXRatio:  0.00, startY: null, endXRatio:  0.00, endY: null, wiggleAmp: 0.6, wiggleStepProb: 0.20 },
  { pathWidth: 4, startXRatio: +1/5,  startY: null, endXRatio: -1/5,  endY: null, wiggleAmp: 1.0, wiggleStepProb: 0.25 },
  { pathWidth: 4, startXRatio: -1/3,  startY: null, endXRatio: -1/6,  endY: null, wiggleAmp: 0.8, wiggleStepProb: 0.22 },
  { pathWidth: 4, startXRatio: +1/6,  startY: null, endXRatio: +1/3,  endY: null, wiggleAmp: 0.6, wiggleStepProb: 0.18 }
];

var CURRENT_STAGE = 0;
var BG = null; // background sprite reuse

function resolveX(stage, keyX, keyRatio) {
  if (stage[keyX] != null) return stage[keyX];
  var ratio = (stage[keyRatio] != null) ? stage[keyRatio] : 0;
  return ratio * maxX; // ratio -1..+1 of the visible half-width
}
function resolveY(stage, keyY, edgeFallback) {
  if (stage[keyY] != null) return stage[keyY];
  return edgeFallback; // usually maxY for start, minY/-maxY for end
}

// Use stage values to compute EXIT (gates) and set globals
function setExitsFromStage(stage, startX, startY, endX, endY, pathWidthTiles) {
  var halfW = (pathWidthTiles * TILE_PX) / 2;
  EXIT = {
    top:    { y: startY, left: startX - halfW, right: startX + halfW },
    bottom: { y: endY,   left: endX   - halfW, right: endX   + halfW }
  };
  // Keep your convenient globals in sync (if you rely on them elsewhere)
  pathStartX = startX; pathEndX = endX; pathWidth = pathWidthTiles;
}

function renderMapToSprite_REUSE(map) {
  var h = map.length, w = map[0].length;
  var grass = makeGrassTile(), path = makePathTile();

  var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  canvas.width  = w * TILE_PX; canvas.height = h * TILE_PX;
  setSmoothing(ctx, false);

  for (var j=0;j<h;j++) for (var i=0;i<w;i++) {
    var t = (map[j][i] === 'P') ? path : grass;
    ctx.drawImage(t, i*TILE_PX, j*TILE_PX, TILE_PX, TILE_PX);
  }
  var url = canvas.toDataURL('image/png');

  if (!BG) { BG = new Image(); BG.x = 0; BG.y = 0; BG.sendToBack(); }
  BG.width = canvas.width; BG.height = canvas.height; BG.url = url;
  return BG;
}

function buildStage(stageIndex) {
  CURRENT_STAGE = stageIndex;
  var s = STAGES[stageIndex];
  var dims = screenTileDims(1); // fills the screen w/ padding tiles

  var startX = resolveX(s, "startX", "startXRatio");
  var endX   = resolveX(s, "endX",   "endXRatio");

  // If not specified, gates live on screen edges
  var startY = resolveY(s, "startY", maxY);
  var endY   = resolveY(s, "endY",   (typeof minY!=="undefined"?minY:-maxY));

  // Render map using only the X anchors + width
  var map = generateMapAnchored({
    w: dims.w, h: dims.h,
    pathWidth: s.pathWidth,
    startWorldX: startX, endWorldX: endX,
    wiggleAmp: (s.wiggleAmp != null ? s.wiggleAmp : 0),
    wiggleStepProb: (s.wiggleStepProb != null ? s.wiggleStepProb : 0.2)
  });
  renderMapToSprite_REUSE(map);

  // Gates are taken straight from the stage definition (no scanning)
  setExitsFromStage(s, startX, startY, endX, endY, s.pathWidth);
}

// Stage transitions when the player exits via a gate
function spawnAtGate(side /* "top"|"bottom" */) {
  var g = (side === "top") ? EXIT.top : EXIT.bottom;
  var cx = (g.left + g.right) / 2;
  var edgeY = g.y;
  var pad = (side === "top") ? - (finGuy.sprite.height/2) - 2
                             : + (finGuy.sprite.height/2) + 2;
  finGuy.sprite.x = cx; finGuy.sprite.y = edgeY + pad;
  if (pigTailGirl) { pigTailGirl.sprite.x = cx - 24; pigTailGirl.sprite.y = edgeY + pad - 24; }
  if (normalBoy)   { normalBoy.sprite.x   = cx + 24; normalBoy.sprite.y   = edgeY + pad - 12; }
}

function goToStage(nextIndex, enteredFrom /* "top"|"bottom" */) {
  if (nextIndex < 0 || nextIndex >= STAGES.length) return;
  buildStage(nextIndex);
  // if we came from top, spawn near bottom in the new stage, and vice versa
  spawnAtGate(enteredFrom === "top" ? "bottom" : "top");
}

function checkStageExit() {
  var topPassed    = (finGuy.sprite.y > EXIT.top.y    + finGuy.sprite.height/2);
  var bottomPassed = (finGuy.sprite.y < EXIT.bottom.y - finGuy.sprite.height/2);

  if (topPassed && CURRENT_STAGE < STAGES.length - 1) {
    goToStage(CURRENT_STAGE + 1, "top");
  } else if (bottomPassed && CURRENT_STAGE > 0) {
    goToStage(CURRENT_STAGE - 1, "bottom");
  }
}

function checkHorizontal(){
  let horizontal = 0;
  if (keysDown.includes('LEFT')){
    horizontal -= 1;
  }
  if (keysDown.includes('RIGHT')){
    horizontal += 1;
  }
  isMovingLeft = horizontal < 0;
  isMovingRight = horizontal > 0;
}
function checkVertical(){
  let vertical = 0;
  if (keysDown.includes('DOWN')){
    vertical -= 1;
  }
  if (keysDown.includes('UP')){
    vertical += 1;
  }
  isMovingDown = vertical < 0;
  isMovingUp = vertical > 0;
}


function checkUserInput(){
  //isMoving = false;
  checkHorizontal();
  checkVertical();
  //leftArrowDown();
  //rightArrowDown();
  //upArrowDown();
  //downArrowDown();
  //checkNoUserInput();
}

// ---- CONFIG (change per character) -----------------------------------------
const REPO_BASE = "https://github.com/finzifin-dev/sideScroller/blob/main";
const FRAME_COUNT = 4;          // you have 00..03
const FRAME_DELAY = 18;          // frames between animation steps (lower = faster)
const DEFAULT_SPEED = 2;        // world units per frame

// Build directional URL lists given a base folder and base name
function buildDirectionalSet(folder, baseName) {
  const mk = (dir) =>
    [...Array(FRAME_COUNT).keys()].map(i =>
      `${REPO_BASE}/${folder}/${baseName}_${dir}_0${i}.png?raw=true`
    );
  return {
    front: mk("front"), // facing DOWN on screen
    back:  mk("back"),  // facing UP
    left:  mk("left"),
    right: mk("right")
  };
}

// Helpers
function randBetween(min, max) { return min + Math.random() * (max - min); }
function chooseFacingFromVector(state, sprite, urls, dx, dy) {
  // vertical priority: up/down wins over left/right
  if (Math.abs(dy) >= Math.abs(dx)) {
    state.dir = dy > 0 ? "back" : "front"; // dy>0 is up
  } else {
    state.dir = dx < 0 ? "left" : "right";
  }
  sprite.url = urls[state.dir][state.frame];
}

// Create a reusable top-down walker with follow/player modes (no angle changes)
function makeWalker({ x, y, speed, folder, baseName, width, height }) {
  const urls = buildDirectionalSet(folder, baseName);

  const sprite = new Image();
  sprite.x = x;
  sprite.y = y;
  if (width)  sprite.width  = width;
  if (height) sprite.height = height;
  sprite.url = urls.front[0]; // start facing down

  const state = {
    dir: "front",            // 'front'(down), 'back'(up), 'left', 'right'
    moving: false,
    frame: 0,
    tick: 0,
    speed: speed || DEFAULT_SPEED,

    // controller
    mode: "player",          // 'player' | 'follow'
    follow: {
      target: null,          // walker or Image
      stopMin: 5,
      stopMax: 10,
      stopDist: 8,           // current chosen stop distance
      hysteresis: 2,         // resume margin to avoid jitter at boundary
      jitterRadius: 10,      // px offset around target
      repathEvery: 12,       // frames between jitter changes
      speedScale: 1.0,
      jitterX: 0,
      jitterY: 0,
      repathTick: 0,
      atRest: false
    }
  };

  function chooseIdleFrame() {
    state.frame = 0;
    sprite.url = urls[state.dir][state.frame];
  }
  
  function updateIdle() {
    state.moving = false;
    advanceFrameIfMoving(); // will hold frame 0 in the last facing dir
  }
  
  // 2) Stop/cancel follow: enter idle mode and clear follow target
  function stopFollowing() {
    state.mode = "idle";
    state.follow.target = null;
    state.follow.atRest = true;
    // optional: reset any chasing jitter so next follow picks a fresh offset
    state.follow.repathTick = 0;
    return api; // chaining
  }  

  function advanceFrameIfMoving() {
    if (!state.moving) {
      state.tick = 0;
      chooseIdleFrame();
      return;
    }
    state.tick += 1;
    if (state.tick % FRAME_DELAY === 0) {
      state.frame = (state.frame + 1) % urls[state.dir].length;
      sprite.url = urls[state.dir][state.frame];
    }
  }

  // --- Player controller (uses your global isMoving* flags) ---
  function updateFromKeys() {
    let dx = 0, dy = 0;
    if (isMovingLeft)  dx -= 1;
    if (isMovingRight) dx += 1;
    if (isMovingUp)    dy += 1;   // WoofJS Y+ is up
    if (isMovingDown)  dy -= 1;   // down is negative Y

    state.moving = (dx != 0 || dy != 0);

    if (state.moving) {
      var nx = sprite.x + dx * state.speed;
      var ny = sprite.y + dy * state.speed;
      var rad = (sprite.width || TILE_PX) / 2;      // padding so sprite doesn’t poke past edge
      var p = clampToScreenWithAnchoredExits(nx, ny, rad);
      sprite.x = p.x; sprite.y = p.y;
      chooseFacingFromVector(state, sprite, urls, dx, dy);
    }

    advanceFrameIfMoving();
  }

  // --- Follow controller (simple seek + wander + arrive) ---
  function getTargetXY(targetLike) {
    // Accept either a walker (with .sprite) or a plain Image
    const t = (targetLike && targetLike.sprite) ? targetLike.sprite : targetLike;
    return t ? { x: t.x, y: t.y } : null;
  }

  function updateFollow() {
    const f = state.follow;
    const tgt = getTargetXY(f.target);
    if (!tgt) { state.moving = false; advanceFrameIfMoving(); return; }

    // --- Arrival logic uses REAL target, not jitter ---
    const dxT = tgt.x - sprite.x;
    const dyT = tgt.y - sprite.y;
    const distToTarget = Math.hypot(dxT, dyT);

    if (f.atRest) {
      // stay resting until the real target pulls away beyond the band
      if (distToTarget > f.stopDist + f.hysteresis) {
        f.atRest = false; // resume chase
      } else {
        state.moving = false;
        advanceFrameIfMoving();
        return;
      }
    }

    // --- Steering uses jittered goal (only while moving) ---
    f.repathTick += 1;
    if (f.repathTick === 1 || (f.repathEvery > 0 && f.repathTick % f.repathEvery === 0)) {
      if (f.jitterRadius > 0) pickNewJitter();
    }

    const goalX = tgt.x + f.jitterX;
    const goalY = tgt.y + f.jitterY;

    let vx = goalX - sprite.x;
    let vy = goalY - sprite.y;
    let distToGoal = Math.hypot(vx, vy);
    if (distToGoal > 0) { vx /= distToGoal; vy /= distToGoal; }

    // Do not move beyond the stop ring relative to the REAL target
    let maxClose = distToTarget - f.stopDist;
    if (maxClose < 0) maxClose = 0;

    let step = state.speed * (f.speedScale || 1);
    step = Math.min(step, maxClose);

    if (step <= 0.0001) {
      // We’re at/inside the stop ring: rest here and pick a new future stop distance
      f.atRest = true;
      f.stopDist = randBetween(f.stopMin, f.stopMax);
      state.moving = false;
      advanceFrameIfMoving();
      return;
    }

    // Move and animate
    var nx = sprite.x + vx * step;
    var ny = sprite.y + vy * step;
    var rad = (sprite.width || TILE_PX) / 2;
    var p = clampToScreenWithAnchoredExits(nx, ny, rad);
    sprite.x = p.x; sprite.y = p.y;

    state.moving = true;
    chooseFacingFromVector(state, sprite, urls, vx, vy);
    advanceFrameIfMoving();
  }
  
  function pickNewJitter() {
    const ang = Math.random() * Math.PI * 2;
    state.follow.jitterX = Math.cos(ang) * state.follow.jitterRadius;
    state.follow.jitterY = Math.sin(ang) * state.follow.jitterRadius;
  }

  // --- Public API ---
  function followUserInput() {
    state.mode = "player";
    return api; // allow chaining
  }

  function followSprite(target, options) {
    state.mode = "follow";
    state.follow.target = target;

    if (options) {
      if (options.stopRange) {
        state.follow.stopMin = options.stopRange[0];
        state.follow.stopMax = options.stopRange[1];
      }
      if (options.jitterRadius != null) state.follow.jitterRadius = options.jitterRadius;
      if (options.repathEvery  != null) state.follow.repathEvery  = options.repathEvery;
      if (options.speedScale   != null) state.follow.speedScale   = options.speedScale;
      if (options.hysteresis   != null) state.follow.hysteresis   = options.hysteresis;
    }

    state.follow.atRest = false;
    state.follow.stopDist = randBetween(state.follow.stopMin, state.follow.stopMax);
    pickNewJitter();
    state.follow.repathTick = 0;

    return api; // chaining
  }
  
function update() {
  if (state.mode === "follow")        updateFollow();
  else if (state.mode === "player")   updateFromKeys();
  else                                updateIdle();   // 'idle'
}

  // The object we return
  const api = {
    sprite:sprite,
    urls:urls,
    state:state,
    update:update,
    updateFromKeys:updateFromKeys,
    followUserInput:followUserInput,
    followSprite:followSprite,
    stopFollowing:stopFollowing
  };

  // Also expose the mode switches on the sprite for your requested syntax
  sprite.followUserInput = followUserInput;
  sprite.followSprite = followSprite;
  sprite.update = update;

  return api;
}


// ===== IMAGE PRELOADER ======================================================
const IMAGE_CACHE = Object.create(null);

function preloadImages(urls) {
  const unique = [...new Set(urls)];
  let loaded = 0;

  return new Promise((resolve) => {
    if (unique.length === 0) resolve();

    function markDone() {
      loaded += 1;
      if (loaded >= unique.length) resolve();
    }

    unique.forEach((url) => {
      // Already cached & complete?
      const cached = IMAGE_CACHE[url];
      if (cached && cached.complete) {
        markDone();
        return;
      }

      // Create a plain DOM <img> for caching
      const img = document.createElement('img');
      IMAGE_CACHE[url] = img;
      img.onload = markDone;
      img.onerror = markDone; // don't block on errors
      img.decoding = 'async';
      // NOTE: avoid setting crossOrigin unless you need canvas access
      img.src = url;
    });
  });
}

function flattenDirectionalSet(set) {
  return [...set.front, ...set.back, ...set.left, ...set.right];
}

function preloadDirectionalSet(set) {
  return preloadImages(flattenDirectionalSet(set));
}

function preloadDirectionalSets(sets) {
  const all = sets.flatMap(flattenDirectionalSet);
  return preloadImages(all);
}

// ====== 8-bit tiles (SVG data URIs) =========================================
const TILE_PX = 32; // on-screen size per tile (scale factor; keep multiple of 16)

function worldStartX(w) { return -(w * TILE_PX) / 2 + TILE_PX / 2; }
function worldXToCol(x, w) {
  var i = Math.round((x - worldStartX(w)) / TILE_PX);
  if (i < 0) i = 0; if (i > w - 1) i = w - 1;
  return i;
}

function clampToScreenWithAnchoredExits(nextX, nextY, radiusPx) {
  var r = radiusPx || 0;
  var L = (typeof minX !== "undefined" ? minX : -maxX) + r;
  var R =  maxX - r;
  var B = (typeof minY !== "undefined" ? minY : -maxY) + r;
  var T =  maxY - r;

  var x = nextX, y = nextY;
  if (x < L) x = L;
  if (x > R) x = R;

  var PAD = (GATE_PAD_TILES || 0) * TILE_PX;

  // Top edge (maxY)
  if (y > T) {
    var isLast = (CURRENT_STAGE >= STAGES.length - 1);
    if (isLast) {
      y = T; // no exit at the top on the last stage
    } else {
      var gt = EXIT && EXIT.top;
      if (!gt || x < (gt.left  - PAD) + r || x > (gt.right + PAD) - r) y = T;
    }
  }

  // Bottom edge (minY)
  if (y < B) {
    var isFirst = (CURRENT_STAGE <= 0);
    if (isFirst) {
      y = B; // no exit at the bottom on stage 0
    } else {
      var gb = EXIT && EXIT.bottom;
      if (!gb || x < (gb.left  - PAD) + r || x > (gb.right + PAD) - r) y = B;
    }
  }

  return { x: x, y: y };
}


// Generate a mostly-grass map with a north–south path whose center
// is anchored at start (top row) and end (bottom row).
function generateMapAnchored(opts) {
  opts = opts || {};
  var w         = (opts.w != null) ? opts.w : 28;
  var h         = (opts.h != null) ? opts.h : 18;
  var pathWidth = (opts.pathWidth != null) ? opts.pathWidth : 2;

  // Either give start/end as tile columns...
  var startCol  = (opts.startCol != null) ? opts.startCol : null;
  var endCol    = (opts.endCol   != null) ? opts.endCol   : null;

  // ...or as world X (we'll convert to columns)
  if (opts.startWorldX != null) startCol = worldXToCol(opts.startWorldX, w);
  if (opts.endWorldX   != null) endCol   = worldXToCol(opts.endWorldX,   w);

  // Defaults if not provided
  if (startCol === null) startCol = Math.floor(w / 2);
  if (endCol   === null) endCol   = startCol;

  // Gentle “drift” wiggle in tiles (+/-)
  var wiggleAmp      = (opts.wiggleAmp      != null) ? opts.wiggleAmp      : 0;   // in tiles
  var wiggleStepProb = (opts.wiggleStepProb != null) ? opts.wiggleStepProb : 0.2; // chance per row to change drift

  // Exact pathWidth painter will need a safe center range:
  var half = Math.floor((pathWidth - 1) / 2);
  function clampCenter(c) {
    var minC = half;
    var maxC = (w - 1) - (pathWidth - 1 - half);
    if (c < minC) c = minC;
    if (c > maxC) c = maxC;
    return c;
  }
  startCol = clampCenter(startCol);
  endCol   = clampCenter(endCol);

  // Build grid
  var map = [];
  var drift = 0; // running offset for smooth wiggle

  for (var j = 0; j < h; j++) {
    map[j] = [];
    for (var i = 0; i < w; i++) map[j][i] = 'G';

    // Center column for this row (linear blend top→bottom)
    var t = (h === 1) ? 0 : j / (h - 1);
    var baseCenter = startCol + (endCol - startCol) * t;

    // Smooth drift within +/- wiggleAmp (optional)
    if (wiggleAmp > 0 && Math.random() < wiggleStepProb) {
      drift += (Math.random() < 0.5 ? -1 : 1);
      if (drift < -wiggleAmp) drift = -wiggleAmp;
      if (drift >  wiggleAmp) drift =  wiggleAmp;
    }

    var center = Math.round(baseCenter + drift);
    center = clampCenter(center);

    // Paint exactly pathWidth tiles centered at `center`
    var start = center - Math.floor((pathWidth - 1) / 2);
    for (var k = 0; k < pathWidth; k++) {
      var xi = start + k;
      if (xi < 0) xi = 0;
      if (xi > w - 1) xi = w - 1;
      map[j][xi] = 'P';
    }
  }

  // Optional metadata
  map._w = w; map._h = h;
  map._pathStartCol = startCol;
  map._pathEndCol   = endCol;
  return map;
}

// --- crisp scaling helper (once) ---
function setSmoothing(ctx, on) {
  ctx.imageSmoothingEnabled = !!on;
  // vendor flags for older browsers (harmless if unknown)
  ctx.mozImageSmoothingEnabled = !!on;
  ctx.webkitImageSmoothingEnabled = !!on;
  ctx.msImageSmoothingEnabled = !!on;
}

// Build 16x16 pixel tiles procedurally (no SVG decode cost)
function makeGrassTile() {
  var c = document.createElement('canvas'), ctx = c.getContext('2d');
  c.width = 16; c.height = 16; setSmoothing(ctx, false);
  ctx.fillStyle = '#4caf50'; ctx.fillRect(0,0,16,16);
  ctx.fillStyle = '#66bb6a'; ctx.fillRect(1,1,2,2);
  ctx.fillRect(5,3,2,2); ctx.fillRect(10,6,2,2);
  ctx.fillStyle = '#388e3c'; ctx.fillRect(3,10,2,2); ctx.fillRect(12,12,2,2);
  return c;
}
function makePathTile() {
  var c = document.createElement('canvas'), ctx = c.getContext('2d');
  c.width = 16; c.height = 16; setSmoothing(ctx, false);
  ctx.fillStyle = '#c8a86b'; ctx.fillRect(0,0,16,16);
  ctx.fillStyle = '#e0c48a'; ctx.fillRect(2,2,2,2); ctx.fillRect(12,11,2,2);
  ctx.fillStyle = '#a57c44'; ctx.fillRect(9,3,2,2); ctx.fillRect(5,8,1,1);
  return c;
}

// Get current canvas pixel size (fallbacks if needed)
function getCanvasSizePx() {
  var c = document.querySelector('canvas');
  if (c && c.width && c.height) return { w: c.width, h: c.height };
  return { w: (window.innerWidth || 800), h: (window.innerHeight || 600) };
}

// How many tiles do we need to cover the screen?
function screenTileDims(paddingTiles) {
  var pad = (paddingTiles == null) ? 1 : paddingTiles;
  var wTiles = Math.ceil((2 * maxX) / TILE_PX) + pad * 2;
  var hTiles = Math.ceil((2 * maxY) / TILE_PX) + pad * 2;
  return { w: wTiles, h: hTiles };
}
// Rebuild the current stage when the canvas size changes.
// This recalculates tile dims, path anchors (ratios → world X), EXIT gates,
// and repaints the single background sprite, then clamps characters once.
function rebuildStageOnResize() {
  buildStage(CURRENT_STAGE); // recompute dims from maxX/maxY, repaint BG, reset EXIT

  // snap everyone back inside the new screen box
  var arr = allCharsArray();
  for (var i = 0; i < arr.length; i++) {
    var s = arr[i].sprite, r = (s.width || TILE_PX) / 2;
    var p = clampToScreenWithAnchoredExits(s.x, s.y, r);
    s.x = p.x; s.y = p.y;
  }
}

window.addEventListener('resize', function () {
  clearTimeout(window.__stageResizeT);
  window.__stageResizeT = setTimeout(rebuildStageOnResize, 150);
});


ready(() => {
  console.log(100);
  pathStartX = 0 - (maxX / 6);
  pathEndX = 0 + (maxX / 6);

  buildStage(0);

  // Preload all characters declared in the registry, then create & run
  preloadAllCharacters(CHAR_DEFS).then(function () {
    createCharactersFromDefs(CHAR_DEFS);

    forever(function () {
      checkUserInput();
      var arr = allCharsArray(); for (var i=0;i<arr.length;i++) arr[i].update();
      checkStageExit();
    });
  });
});
