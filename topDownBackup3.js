var DT = 0, K = 1, _k = 1;
var MAX_DT = 0.05;     // clamp to 50 ms
var K_SMOOTH = 0.25;   // smoothing amount

var isMovingLeft = false;
var isMovingRight = false;
var isMovingUp = false;
var isMovingDown = false;
var isMoving = false;

var finGuy;
var pigTailGirl;
var normalBoy;

var pathWidth = 4;
const GATE_PAD_TILES = 0.5;

// screen-exit window computed from your anchors (world X) + width (tiles)
var EXIT = null;


var DEBUG_CHAT = false;
// --- Chat state
var CHAT = {
  chatTarget: null,
  chattingWith: null,
  _prevTarget: null,
  baseRadius: 0,
  marker: null,        // floating "?"
  promptText: null     // bottom-center hint
};

// Sprite utils (shared across modes)
function safeDelete(s) {
  if (!s) return;
  if (typeof s.delete === "function") {
    try { s.delete(); } catch (e) { s.visible = false; }
  } else {
    s.visible = false;
  }
}

setBackdropColor('black');


// ===== Mode Manager =========================================================
var Game = (function () {
  var modes = Object.create(null);
  var snapshots = Object.create(null);
  var currentId = null;

  function isFn(f){ return typeof f === "function"; }

  return {
    register: function (id, mode) { mode.id = id; modes[id] = mode; },
    switchTo: function (id, opts) {
      opts = opts || {};
      var soft = (opts.soft !== false); // default soft=true

      // save + leave current
      if (currentId && modes[currentId]) {
        var cur = modes[currentId];
        if (isFn(cur.save)) snapshots[currentId] = cur.save();
        if (soft && isFn(cur.hide)) cur.hide();
        else if (isFn(cur.unload)) cur.unload();
        else if (isFn(cur.hide)) cur.hide();
        if (isFn(cur.exit)) cur.exit(id, opts);
      }

      // enter next
      var next = modes[id];
      if (!next) return;
      if (!next.__inited && isFn(next.init)) { next.init(); next.__inited = true; }
      if (snapshots[id] && isFn(next.load)) { next.load(snapshots[id]); }
      if (soft && isFn(next.show)) next.show();
      if (isFn(next.enter)) next.enter(currentId, opts);

      currentId = id;
    },
    tick: function (dt) {
      var m = modes[currentId];
      if (m && isFn(m.tick)) m.tick(dt);
    },
    current: function(){ return currentId; },
    getSnapshot: function(id){ return snapshots[id]; }
  };
})();

// ===== World snapshot + hide/show helpers ===================================
function hideSprite(s){ if (!s) return; if (s.hide) s.hide(); else s.visible = false; }
function showSprite(s){ if (!s) return; if (s.show) s.show(); else s.visible = true; }

function captureWorldSnapshotLight(){
  var chars = {};
  for (var name in CHARACTERS){
    var w = CHARACTERS[name];
    chars[name] = {
      x: w.sprite.x, y: w.sprite.y,
      dir: w.state.dir, mode: w.state.mode,
      inv: (w.inventory ? w.inventory.toJSON() : null)
    };
  }
  return { stageIndex: CURRENT_STAGE, chars: chars };
}

function restoreFromSnapshotLight(snap){
  if (!snap) return;
  if (snap.stageIndex != null && snap.stageIndex !== CURRENT_STAGE) {
    buildStage(snap.stageIndex);
  }
  for (var name in snap.chars){
    var d = snap.chars[name];
    var w = CHARACTERS[name];
    if (!w) continue;

    // position/mode restore (your existing code) ...
    w.sprite.x = d.x; 
    w.sprite.y = d.y;
    w.state.dir = d.dir || w.state.dir;
    if (d.mode === "player") w.followUserInput();
    else if (d.mode === "follow") w.state.mode = "follow";
    else if (d.mode === "npc") w.state.mode = "npc";
    else w.stopFollowing();

    // inventory restore
    ensureInventory(w);
    if (d.inv) { w.inventory.fromJSON(d.inv); }

    // clamp, visibility (your existing code) ...
    var r = (w.sprite.width || TILE_PX)/2;
    var p = clampToScreenWithAnchoredExits(w.sprite.x, w.sprite.y, r);
    w.sprite.x = p.x; 
    w.sprite.y = p.y;
  }
  syncNPCVisibilityToStage();
}

// ===== WorldMode: adapts your current world =================================
var WorldMode = {
  ready: false,

  init: function () {
    // Build stage 0 and paint BG
    buildStage(0);

    // Preload characters defined in CHAR_DEFS, then create them
    preloadAllCharacters(CHAR_DEFS).then(function () {
      createCharactersFromDefs(CHAR_DEFS);
      setNPCDialogues();
      initChatInteract();
      WorldMode.ready = true;
    });
  },

  enter: function () { /* optional */ },

  show: function () {
    if (BG) showSprite(BG);
    syncNPCVisibilityToStage();
    // if returning from chat, clear flags
    if (CHAT && CHAT.chattingWith) this.endChat();
    if (CHAT.marker) hideSprite(CHAT.marker);
    if (CHAT.promptText) { CHAT.promptText.text = ""; hideSprite(CHAT.promptText); }
  },


  hide: function () {
    if (BG) hideSprite(BG);
    var arr = allCharsArray(); for (var i=0;i<arr.length;i++) hideSprite(arr[i].sprite);
  },

  save: function () {
    return captureWorldSnapshotLight();
  },

  load: function (snap) {
    // Ensure stage rebuilt (handles resize-affected tile dims & EXIT)
    if (snap && snap.stageIndex != null) buildStage(snap.stageIndex);
    restoreFromSnapshotLight(snap);
    syncNPCVisibilityToStage();
  },

  // If you truly want to drop memory, implement unloading; otherwise hide() is fine.
  unload: function () {
    this.hide();
    // (Optional) null BG & clear CHARACTERS if you ever re-init fresh:
    // BG = null; CHARACTERS = {}; finGuy = pigTailGirl = normalBoy = null;
    // WorldMode.ready = false;
  },
  
  // pick nearest eligible NPC and highlight it
  updateChatTarget: function () {
    if (!finGuy || !finGuy.sprite) return;

    var best = null, bestDist = Infinity;
    var p = finGuy.sprite;

    for (var name in CHARACTERS) {
      var w = CHARACTERS[name];
      if (!w || !w.sprite) continue;
      var s = w.sprite;

      // chat only when not following, is visible, same/current stage, allowed to chat
      var sameStage = (getWalkerStageIndex(w) == null) || (getWalkerStageIndex(w) === CURRENT_STAGE);
      var eligible  = s.canChat && !s.isChatting && sameStage && w.state.mode === "npc";

      if (!eligible) continue;

      var d = p.distanceTo(s); // WoofJS API
      var r = s.chatRadius || CHAT.baseRadius || 0;
      if (d <= r && d < bestDist) { best = w; bestDist = d; }
    }

    // unhighlight previous
    if (CHAT._prevTarget && CHAT._prevTarget !== best) {
      try { CHAT._prevTarget.sprite.brightness = 100; } catch(e){}
    }

    CHAT.chatTarget = best || null;
    CHAT._prevTarget = best || null;
    
    // Update UI: floating marker + bottom hint
    if (best && best.sprite) {
      var s = best.sprite;
      // place the "?" a bit above the head (Y+ is up in Woof)
      var h = (s.height || TILE_PX);
      CHAT.marker.x = s.x;
      CHAT.marker.y = s.y + (h / 2) + 20;
      showSprite(CHAT.marker);

      // bottom prompt
      var who = (best.label || best.__name || "them");
      CHAT.promptText.text = "Press C to chat with " + who;
      CHAT.promptText.x = 0;                 // center
      CHAT.promptText.y = minY + 30;         // keep glued to bottom if resized
      showSprite(CHAT.promptText);
    } else {
      // no target → hide UI
      if (CHAT.marker) hideSprite(CHAT.marker);
      if (CHAT.promptText) { CHAT.promptText.text = ""; hideSprite(CHAT.promptText); }
    }    

    // highlight new
    if (best) {
      try { best.sprite.brightness = 140; } catch(e){}
    }

    // ---- DEBUG HUD + console
    if (DEBUG_CHAT) {
      var label = "(none)";
      if (best) {
        var distStr = "";
        try { distStr = finGuy.sprite.distanceTo(best.sprite).toFixed(1); } catch(e){}
        label = best.__name + "  d=" + distStr + "  r=" + (best.sprite.chatRadius|0);
      }
      if (CHAT.debugText) CHAT.debugText.text = "chatTarget: " + label;
      if (best) console.log("[CHAT] target:", best.__name, "dist:", bestDist.toFixed(2));
    }
  },

  // start a chat -> mark flags and jump to MenuMode (placeholder)
  startChatWith: function (w) {
    if (!w || !w.sprite) return;
    CHAT.chattingWith = w;
    w.sprite.isChatting = true;
    if (finGuy && finGuy.sprite) finGuy.sprite.isChatting = true;
    if (CHAT.marker) hideSprite(CHAT.marker);
    if (CHAT.promptText) { CHAT.promptText.text = ""; hideSprite(CHAT.promptText); }
    // optional: freeze movement/AI here if needed
    Game.switchTo('chat', { soft:true, partner: w });
  },

  // clear chat flags & visuals when we come back to the world
  endChat: function () {
    if (CHAT.chattingWith && CHAT.chattingWith.sprite) {
      CHAT.chattingWith.sprite.isChatting = false;
      try { CHAT.chattingWith.sprite.brightness = 100; } catch(e){}
    }
    if (finGuy && finGuy.sprite) finGuy.sprite.isChatting = false;
    if (CHAT.marker) hideSprite(CHAT.marker);
    if (CHAT.promptText) { CHAT.promptText.text = ""; hideSprite(CHAT.promptText); }
    CHAT.chattingWith = null;
  },

  tick: function () {
    if (!this.ready) return;

    checkUserInput();
    var arr = allCharsArray(); for (var i=0;i<arr.length;i++) arr[i].update();
    checkStageExit();

    this.updateChatTarget();
    
    // keep prompt glued to bottom
    if (CHAT.promptText) CHAT.promptText.y = minY + 30;

    // Press C (upper or lower) to chat with the highlighted target
    var cDown = keysDown.includes('C') || keysDown.includes('c');
    if (CHAT.chatTarget && cDown) {
      this.startChatWith(CHAT.chatTarget);
      return; // switching modes
    }

    if (keysDown.includes('I')) Game.switchTo('menu', { soft:true });
    if (keysDown.includes('S')) Game.switchTo('sideShooter', { soft:true });
  },
};

var MenuMode = {
  sprites: [],

  init: function () {
    // build your menu UI here (images, etc.)
    setBackdropColor("black");
    var overlay = new Rectangle(); 
    overlay.width = maxX; 
    overlay.height = maxY; 
    overlay.x = 0; 
    overlay.y = 0;
    overlay.color = "blue"; 
    overlay.opacity = 50; // quick dimmer
    this.sprites.push(overlay);
    this.hide(); // start hidden; ModeManager will show on first enter
  },

  show: function(){ for (var i=0;i<this.sprites.length;i++) showSprite(this.sprites[i]); },
  hide: function(){ for (var i=0;i<this.sprites.length;i++) hideSprite(this.sprites[i]); },

  // Save/load whatever this mode cares about (cursor selection, etc.)
  save: function(){ return { /* menu state */ }; },
  load: function(snap){ /* restore if needed */ },

  tick: function(){
    // simple return to world on SPACE
    if (keysDown.includes('SPACE')) Game.switchTo('world', { soft:true });
  }
};

// ===== Characters registry ===================================================
var CHAR_DEFS = {
  finGuy: {
    label: "Fin",
    folder: "finHairGuy", baseName: "finGuy",
    x: 0, y: 0, speed: 13, width: 36, height: 58,
    mode: "player" // controlled by your isMoving* flags
  },
  pigTailGirl: {
    label: "Petra",
    folder: "pigTailGirl", baseName: "pigTailGirl",
    x: -80, y: -60, speed: 3, width: 36, height: 62,
    followTarget: "finGuy", canChat: true,
    followOpts: { stopRange: [45, 80], jitterRadius: 12, repathEvery: 14, speedScale: 0.7, hysteresis: 2 },
    mode: "npc",
    npcBounds: { stageIndex: 2, left: minX, right: 80, bottom: minY + 20, top: 40 },
    npcOpts:   { pauseRange: [0.8, 2.0], walkRange: [1.0, 2.2], speedScale: 0.85 }
  },
  normalBoy: {
    label: "David",
    folder: "normalBoy", baseName: "normalBoy",
    x: -40, y: -40, speed: 3, width: 36, height: 55,
    mode: "npc", followTarget: "finGuy", canChat: true,
    npcBounds: { stageIndex: 1, left: maxX, right: 80, bottom: minY + 20, top: 40 },
    npcOpts:   { pauseRange: [0.8, 2.0], walkRange: [1.0, 2.2], speedScale: 0.85 },
    followOpts: { stopRange: [80, 100], jitterRadius: 12, repathEvery: 7, speedScale: 0.5, hysteresis: 2 }
  },
  fatBoy: {
    label: "Finlay",
    folder: "fatGuy", baseName: "fatBoy",
    x: -40, y: -40, speed: 3, width: 43, height: 56,
    mode: "follow", followTarget: "pigTailGirl",
    followOpts: { stopRange: [20, 80], jitterRadius: 12, repathEvery: 24, speedScale: 0.35, hysteresis: 2 }
  },
  parkGuy: {
    label: "Jonno",
    folder: "parkGuy", baseName: "parkGuy",
    x: -140, y: -140, speed: 3, width: 32, height: 48,
    mode: "npc", followTarget: "finGuy", canChat: true,
    npcBounds: { stageIndex: 0, left: maxX, right: 0, bottom: minY + 20, top: 40 },
    npcOpts:   { pauseRange: [0.8, 2.0], walkRange: [1.0, 2.2], speedScale: 0.85 },
    followOpts: { stopRange: [70, 80], jitterRadius: 2, repathEvery: 4, speedScale: 0.4, hysteresis: 2 },
    startingInv: [{ key:"coin", count:3 }, { key:"burger", count:1 }]
  }
};

function setNPCDialogues() {
  // PigTailGirl
  if (CHARACTERS.pigTailGirl) attachDialogue(CHARACTERS.pigTailGirl, {
    onEnter: function (ctx) {
      if (!ctx.npcFlags.met) { ctx.npcFlags.met = true; }
    },
    topics: [
      {
        id: "hello",
        text: "Hey!",
        when: function (ctx) { return !ctx.npcFlags.greeted; },
        responses: [
          { text: "Oh! Hi there.", do: function (ctx) { ctx.npcFlags.greeted = true; } }
        ]
      },
      {
        id: "ask_follow",
        text: "Want to join me?",
        when: function (ctx) { return !ctx.isInParty(); },
        responses: [
          { text: "Sure, I’ll follow you.", do: function (ctx) { npcJoinParty(ctx.npc); } }
        ]
      },
      {
        id: "dismiss",
        text: "You can take a break now.",
        when: function (ctx) { return ctx.isInParty(); },
        responses: [
          { text: "Okay, I’ll wander around here.", do: function (ctx) { npcLeaveParty(ctx.npc); } }
        ]
      },
      {
        id: "about",
        text: "What is this place?",
        responses: [
          { text: "Just a quiet path. Keep an eye on the gates.", do: function () {} }
        ]
      },
      {
        id: "bye",
        text: "See you.",
        responses: [
          { text: "Bye!", do: function () {}, close: true }
        ]
      }
    ]
  });

  // ParkGuy (simple example)
  if (CHARACTERS.parkGuy) attachDialogue(CHARACTERS.parkGuy, {
    topics: [
      {
        id: "quip",
        text: "Nice weather, huh?",
        responses: [
          { text: "Best breeze in Stage " + (CURRENT_STAGE + 1) + ".", do: function () {} }
        ]
      },
      {
        id: "bye",
        text: "Later.",
        responses: [
          { text: "Later.", do: function () {}, close: true }
        ]
      }
    ]
  });

  // NormalBoy (joins/leaves party)
  if (CHARACTERS.normalBoy) attachDialogue(CHARACTERS.normalBoy, {
    topics: [
      {
        id: "hello",
        text: "Sup?",
        when: function (ctx) { return !ctx.npcFlags.met; },
        responses: [
          { text: "Sup.", do: function (ctx) { ctx.npcFlags.met = true; } }
        ]
      },
      {
        id: "join",
        text: "Want to tag along?",
        when: function (ctx) { return !ctx.isInParty(); },
        responses: [
          { text: "Okay, why not.", do: function (ctx) { npcJoinParty(ctx.npc); } }
        ]
      },
      {
        id: "leave",
        text: "You can head back.",
        when: function (ctx) { return ctx.isInParty(); },
        responses: [
          { text: "Catch you later.", do: function (ctx) { npcLeaveParty(ctx.npc); } }
        ]
      },
      {
        id: "bye",
        text: "Bye.",
        responses: [
          { text: "Bye.", do: function () {}, close: true }
        ]
      }
    ]
  });
}

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
    
    // createCharactersFromDefs: after makeWalker(...)

    ensureInventory(w);
    if (d.startingInv && !w._seededInv) {
      seedStartingInventory(w, d.startingInv);  // uses addItem → fires onAdd hooks
      w._seededInv = true; // guard against double-seeding on rebuilds
    }
    
    // remember original home setup so callbacks can restore it later
    w._home = {
      bounds: (d.npcBounds ? { left:d.npcBounds.left, right:d.npcBounds.right, bottom:d.npcBounds.bottom, top:d.npcBounds.top } : null),
      npcOpts: d.npcOpts || null,
      followOpts: d.followOpts || null,
      stageIndex: (d.mode === "npc" && d.npcBounds && d.npcBounds.stageIndex != null) ? d.npcBounds.stageIndex : null
    };
    
    // default: where they were created
    w.state.stageIndex = (typeof CURRENT_STAGE !== "undefined") ? CURRENT_STAGE : 0;
    w.__name = k;
    w.sprite.__name = k;
    // display label (fallbacks to key if not provided)
    w.label = (d.label != null ? d.label : k);
    w.sprite.label = w.label;
    // sensible defaults; can override per sprite later
    w.sprite.canChat = (d.mode === "npc");    // NPCs can chat by default
    w.sprite.isChatting = false;

    // if this is an NPC and you provided npcBounds.stageIndex, copy it to both slots
    if (d.mode === "npc" && d.npcBounds && d.npcBounds.stageIndex != null) {
      if (!w.state.npc) w.state.npc = {};
      w.state.npc.stageIndex = d.npcBounds.stageIndex;
      w.state.stageIndex = d.npcBounds.stageIndex;
    }

    CHARACTERS[k] = w;
  }

  // pass 2: wire modes/targets and finalize stageIndex for followers
  for (k in defs) {
    d = defs[k]; w = CHARACTERS[k];

    if (d.mode === "player") {
      w.followUserInput();
      w.state.stageIndex = CURRENT_STAGE; // player lives on current stage
    }
    else if (d.mode === "follow" && d.followTarget && CHARACTERS[d.followTarget]) {
      var leader = CHARACTERS[d.followTarget];
      w.followSprite(leader, d.followOpts || {});
      // If the chain ends at an NPC, inherit that NPC's stage; else default stays.
      var term = getFollowLeader(w);
      var si = getWalkerStageIndex(term);
      if (si != null) w.state.stageIndex = si;
    }
    else if (d.mode === "npc") {
      // nothing extra here; already stamped in pass 1 (if npcBounds.stageIndex existed)
      w.state.mode = "npc";
      if (!w.state.npc) w.state.npc = {};
      // you likely also set w.state.npc.bounds in your npc setup; omitted for brevity
    }
  }

  // keep your convenient globals:
  finGuy      = CHARACTERS.finGuy;
  pigTailGirl = CHARACTERS.pigTailGirl;
  normalBoy   = CHARACTERS.normalBoy;

  // Make initial visibility correct immediately after creation
  syncNPCVisibilityToStage();
}

// One-liner to preload *all* characters in the registry
function preloadAllCharacters(defs) {
  return preloadDirectionalSets(buildSetsFromDefs(defs));
}

function initChatInteract() {
  if (!finGuy || !finGuy.sprite) return;

  // Base radius ≈ 2x the bigger player sprite dimension
  CHAT.baseRadius = Math.max(finGuy.sprite.width || TILE_PX,
                             finGuy.sprite.height || TILE_PX) * 1.5;

  // Stamp a per-sprite chatRadius once
  for (var name in CHARACTERS) {
    var w = CHARACTERS[name]; if (!w || !w.sprite) continue;
    if (w.sprite.chatRadius == null) w.sprite.chatRadius = CHAT.baseRadius;
  }
  
    // Floating "?" above current target (hidden by default)
  if (!CHAT.marker) {
    CHAT.marker = new Text({
      text: "?",
      size: 40,
      x: 0, y: 0,
      layer: 1000,
      textAlign: "center",
      fontFamily: "poppins",
      color: "white"
    });
    hideSprite(CHAT.marker);
  }

  // Bottom-center prompt (hidden by default)
  if (!CHAT.promptText) {
    CHAT.promptText = new Text({
      text: "",
      size: 25,
      x: 0,
      y: minY + 30,      // bottom center
      layer: 1000,
      textAlign: "center",
      fontFamily: "poppins",
      color: "white"
    });
    hideSprite(CHAT.promptText);
  }

  // Optional on-screen HUD for quick debugging
  if (DEBUG_CHAT && !CHAT.debugText) {
    CHAT.debugText = new Text({
      text: "chatTarget: (none)",
      size: 14,
      x: minX + 10, y: maxY - 30,
      layer: 999,
      textAlign: "left",
      fontFamily: "monospace",
      color: "yellow"
    });
  }
  if (DEBUG_CHAT) {
    console.log("[CHAT] baseRadius =", CHAT.baseRadius);
    for (var n in CHARACTERS) {
      var w = CHARACTERS[n];
      if (w && w.sprite) console.log("[CHAT] radius", n, "=", w.sprite.chatRadius, "canChat:", !!w.sprite.canChat, "mode:", w.state.mode);
    }
  }
}
// === Stage HUD (top-right) ==================================================
var StageHUD = {
  __inited: false,
  padX: 12,
  padY: 12,
  bg: null,
  label: null,

  init: function () {
    if (this.__inited) return;

    // small dark pill in the corner
    this.bg = new Rectangle();
    this.bg.width = 120;
    this.bg.height = 28;
    this.bg.color = rgb(30,30,30);

    this.label = new Text({
      text: "Stage —",
      size: 16,
      x: 0, y: 0,
      color: "white",
      fontFamily: "poppins",
      textAlign: "right"
    });

    this.__inited = true;
    this.relayout();
    showSprite(this.bg);
    showSprite(this.label);
    if (this.bg.sendToFront) this.bg.sendToFront();
    if (this.label.sendToFront) this.label.sendToFront();

    var self = this;
    this._onResize = function () { self.relayout(); };
    window.addEventListener('resize', this._onResize);
  },

  relayout: function () {
    if (!this.__inited) return;
    var right =  maxX - this.padX;
    var top   =  maxY - this.padY;

    // sprites are centered: offset by half-size
    this.bg.x = right - this.bg.width  / 2;
    this.bg.y = top   - this.bg.height / 2;

    this.label.x = right - 8;       // small inner padding
    this.label.y = this.bg.y;       // vertically centered
  },

  set: function (stageIdOrIndex) {
    if (!this.__inited) this.init();
    this.label.text = "Stage " + stageIdOrIndex;
    // keep on top
    if (this.bg.sendToFront) this.bg.sendToFront();
    if (this.label.sendToFront) this.label.sendToFront();
  },

  hide: function () {
    if (!this.__inited) return;
    hideSprite(this.bg);
    hideSprite(this.label);
  },

  show: function () {
    if (!this.__inited) return;
    showSprite(this.bg);
    showSprite(this.label);
  },

  destroy: function () {
    if (!this.__inited) return;
    hideSprite(this.bg); hideSprite(this.label);
    safeDelete(this.bg); safeDelete(this.label);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this.bg = this.label = null;
    this.__inited = false;
  }
};
// ===== Stages ================================================================
var STAGES = [
  {
    id: 1,
    path: {
      width: 4,
      start: { rx: 0, ry: -1 },
      segments: [
        { angle: 0,  dist: 0.35 },
        { angle: 90, dist: 0.25 },
        { angle: 0,  dist: 1 }
      ]
    },
    links: { top: 2 } // up to stage 2
  },
  {
    id: 2,
    path: {
      width: 4,
      start: { rx: 0, ry: -1 },
      segments: [{ angle: 0, dist: 1 }],
      branches: [
        {
          id: "S2_EAST",
          at: 0.5,
          width: 4,
          exit: "right",       // creates EXIT.right at branch end
          segments: [{ angle: 90, dist: 1 }]
        }
      ]
    },
    links: { bottom: 1, top: 3, right: 5 } // vertical + branch to 5
  },
  {
    id: 3,
    path: { width: 4, start: { rx: 0, ry: -1 }, segments: [{ angle: 0, dist: 1 }] },
    links: { bottom: 2, top: 4 }
  },
  {
    id: 4,
    path: { width: 4, start: { rx: 0, ry: -1 }, segments: [{ angle: 0, dist: 0.8 }] },
    links: { bottom: 3 } // no top link → dead-end at the top
  },
  {
    id: 5,
    path: {
      width: 4,
      start: { rx: -1, ry: -0.3 }, // enter from left edge, mid-height
      segments: [
        { angle: 90, dist: 0.2 },
        { angle: 45, dist: 0.5 },
        { angle: 0,  dist: 0.1 }
      ]
    },
    links: { left: 2 }
  }
];


// ===== New path-based stage builder =========================================

// World rect in your coordinate system
function screenRect() {
  return { left: -maxX, right: maxX, bottom: -maxY, top: maxY };
}

// 0° = up, +90° = right, −90° = left
function maxTravelToEdge(x, y, angleDeg, rect) {
  var rad = angleDeg * Math.PI / 180;
  var dx = Math.sin(rad), dy = Math.cos(rad);
  var t = Infinity;

  if (dx > 0)  t = Math.min(t, (rect.right  - x) / dx);
  if (dx < 0)  t = Math.min(t, (rect.left   - x) / dx);
  if (dy > 0)  t = Math.min(t, (rect.top    - y) / dy);
  if (dy < 0)  t = Math.min(t, (rect.bottom - y) / dy);

  return (t === Infinity || t <= 0) ? 0 : t;
}

function resolveStartPos(start) {
  // start may be {x,y} absolute OR {rx,ry} in [-1..+1] ratios
  if (!start) return { x: 0, y: -maxY }; // bottom-center default
  if (start.rx != null || start.ry != null) {
    return { x: (start.rx||0) * maxX, y: (start.ry||-1) * maxY };
  }
  return { x: (start.x!=null?start.x:0), y: (start.y!=null?start.y:-maxY) };
}

// Build a polyline: [{x,y}, ...] from path {start, segments:[{angle,dist}], width}
function buildPolylineFromPath(path) {
  var rect = screenRect();
  var pts = [];
  var p = resolveStartPos(path.start);
  pts.push({ x: p.x, y: p.y });

  for (var i = 0; i < path.segments.length; i++) {
    var seg = path.segments[i] || {};
    var ang = +seg.angle || 0;
    var dMax = maxTravelToEdge(p.x, p.y, ang, rect);
    // dist can be:
    // - number in [0..1] → ratio of remaining room to edge
    // - {px:n}          → pixels
    // (you can add tiles etc later if you want)
    var lenPx = (typeof seg.dist === "number")
      ? Math.max(0, Math.min(1, seg.dist)) * dMax
      : (seg.dist && typeof seg.dist.px === "number") ? seg.dist.px : 0;

    var rad = ang * Math.PI / 180;
    var nx = p.x + Math.sin(rad) * lenPx;
    var ny = p.y + Math.cos(rad) * lenPx;

    // clamp to edge (can add a flag if you want to allow overshoot)
    var reach = maxTravelToEdge(p.x, p.y, ang, rect);
    if (lenPx > reach) { nx = p.x + Math.sin(rad) * reach; ny = p.y + Math.cos(rad) * reach; }

    p = { x: nx, y: ny };
    pts.push(p);
  }
  return pts;
}

// Distance from point to segment
function _distPointToSeg(px, py, ax, ay, bx, by) {
  var vx = bx - ax, vy = by - ay;
  var wx = px - ax, wy = py - ay;
  var vv = vx*vx + vy*vy;
  var t = vv > 0 ? (wx*vx + wy*vy) / vv : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  var cx = ax + t*vx, cy = ay + t*vy;
  var dx = px - cx, dy = py - cy;
  return Math.sqrt(dx*dx + dy*dy);
}

// Rasterize polyline to a tile map of 'P' (path) / 'G' (grass)
function rasterizePolylineToMap(pts, pathWidthTiles, dims) {
  var w = dims.w, h = dims.h, map = new Array(h);
  var halfWpx = (pathWidthTiles * TILE_PX) / 2;

  var halfCanvasW = (w * TILE_PX) / 2;
  var halfCanvasH = (h * TILE_PX) / 2;

  for (var j = 0; j < h; j++) {
    map[j] = new Array(w);
    for (var i = 0; i < w; i++) {
      // tile center in world coords (0,0 at screen center; +y is up)
      var x = (i + 0.5) * TILE_PX - halfCanvasW;
      var y = halfCanvasH - (j + 0.5) * TILE_PX;

      var dMin = Infinity;
      for (var k = 0; k < pts.length - 1; k++) {
        var a = pts[k], b = pts[k+1];
        var d = _distPointToSeg(x, y, a.x, a.y, b.x, b.y);
        if (d < dMin) dMin = d;
        if (dMin <= halfWpx) break;
      }
      map[j][i] = (dMin <= halfWpx) ? 'P' : 'G';
    }
  }
  return map;
}

function _polylineLength(pts){
  var L = 0;
  for (var i=0;i<pts.length-1;i++){
    var dx=pts[i+1].x-pts[i].x, dy=pts[i+1].y-pts[i].y;
    L += Math.hypot(dx,dy);
  }
  return L;
}
function _pointAtT(pts, t){
  // t in [0..1] along total length
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  t = Math.max(0, Math.min(1, t));
  var total = _polylineLength(pts);
  var target = t * total, acc = 0;
  for (var i=0;i<pts.length-1;i++){
    var a=pts[i], b=pts[i+1];
    var seg = Math.hypot(b.x-a.x, b.y-a.y);
    if (acc + seg >= target){
      var u = (seg > 0) ? (target - acc)/seg : 0;
      return { x: a.x + (b.x - a.x)*u, y: a.y + (b.y - a.y)*u };
    }
    acc += seg;
  }
  return { x: pts[pts.length-1].x, y: pts[pts.length-1].y };
}

function _makeVerticalGatesFromPolyline(pts, halfWpx) {
  var a = pts[0], b = pts[pts.length-1];
  var top    = (a.y >= b.y) ? a : b; // larger y is screen “top”
  var bottom = (a.y >= b.y) ? b : a;
  return {
    top:    { y: top.y,    left: top.x    - halfWpx, right: top.x    + halfWpx },
    bottom: { y: bottom.y, left: bottom.x - halfWpx, right: bottom.x + halfWpx }
  };
}

function findStageIndexById(id) {
  for (var i = 0; i < STAGES.length; i++) {
    if (STAGES[i] && STAGES[i].id === id) return i;
  }
  return -1;
}

// Build an id→index map; ensure every stage has an id and links object
function _buildIdIndex() {
  var idx = {};
  for (var i = 0; i < STAGES.length; i++) {
    var s = STAGES[i] || {};
    if (s.id == null) s.id = i;      // ensure id present
    if (!s.links) s.links = {};      // ensure links obj
    idx[s.id] = i;
  }
  return idx;
}

// Resolve a link reference to a stage INDEX (numbers refer to id first, then array index)
function _stageIndexFrom(ref, idIndex) {
  if (ref == null) return null;
  if (typeof ref === "number") {
    if (idIndex.hasOwnProperty(ref)) return idIndex[ref]; // treat as id
    if (ref >= 0 && ref < STAGES.length) return ref;      // fallback: array index
  }
  return null;
}

function _extendVerticalGate(side, x, halfWpx) {
  var seg = { y: (EXIT[side] && EXIT[side].y != null ? EXIT[side].y : (side === "top" ? screenRect().top : screenRect().bottom)),
              left: x - halfWpx, right: x + halfWpx };
  if (!EXIT[side]) { EXIT[side] = seg; return; }
  // Merge spans if already present
  EXIT[side].left  = Math.min(EXIT[side].left,  seg.left);
  EXIT[side].right = Math.max(EXIT[side].right, seg.right);
}

function _extendSideGate(side, y, halfWpx, rect) {
  var seg = { x: (side === "left" ? rect.left : rect.right),
              bottom: y - halfWpx, top: y + halfWpx };
  if (!EXIT[side]) { EXIT[side] = seg; return; }
  // Merge spans if something already set (e.g., branch + endpoint)
  EXIT[side].bottom = Math.min(EXIT[side].bottom, seg.bottom);
  EXIT[side].top    = Math.max(EXIT[side].top,    seg.top);
}

// Normalize: keep only explicit links, and auto-insert reverse links (don’t overwrite)
function normalizeLinksBidirectional() {
  var idIndex = _buildIdIndex();

  for (var i = 0; i < STAGES.length; i++) {
    var s = STAGES[i], links = s.links || {};
    ["top","bottom","left","right"].forEach(function(dir){
      var ref = links[dir];
      if (ref == null) return;

      var j = _stageIndexFrom(ref, idIndex);
      if (j == null) {
        console.warn("Stage", s.id, "link", dir, "points to unknown", ref);
        delete links[dir];
        return;
      }

      var opp = oppositeGate(dir);
      var t = STAGES[j];
      if (!t.links) t.links = {};
      if (t.links[opp] == null) {
        t.links[opp] = s.id;         // auto back-link by source id
      } else {
        // If it exists but points elsewhere, keep it and warn
        var backIdx = _stageIndexFrom(t.links[opp], idIndex);
        if (backIdx !== i) {
          console.warn("Back-link mismatch:", t.id, opp, "->", t.links[opp], "(expected", s.id, ")");
        }
      }
    });
  }
}

function normalizeLink(val) {
  if (val == null) return null;

  if (typeof val === "number") {
    // treat as index if in range; else as stage id
    if (val >= 0 && val < STAGES.length) return val;
    var byId = findStageIndexById(val);
    return (byId >= 0) ? byId : null;
  }

  if (typeof val === "string") {
    // allow "5" or string ids
    var n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (n >= 0 && n < STAGES.length) return n;
      var byIdN = findStageIndexById(n);
      if (byIdN >= 0) return byIdN;
    }
    var byIdS = findStageIndexById(val);
    return (byIdS >= 0) ? byIdS : null;
  }

  if (typeof val === "object" && val.id != null) {
    return normalizeLink(val.id);
  }

  return null;
}

function resolveNextIndex(side, curIdx) {
  var links = (STAGES[curIdx] && STAGES[curIdx].links) || {};
  var idx = normalizeLink(links[side]);
  if (idx != null) return idx;

  // sensible defaults for vertical travel if not explicitly linked
  if (side === "top" && curIdx + 1 < STAGES.length)    return curIdx + 1;
  if (side === "bottom" && curIdx - 1 >= 0)            return curIdx - 1;
  return null; // left/right have no default
}

function buildStage(stageIndex) {
  CURRENT_STAGE = stageIndex;
  EXIT = { top:null, bottom:null, left:null, right:null };

  const s = STAGES[stageIndex];
  if (!s || !s.path) return;

  const dims = screenTileDims(1);
  const rect = screenRect();
  const eps  = TILE_PX * 0.75;                 // edge tolerance

  // 1) Build ALL polylines (main + branches) in one list
  const mainW   = (s.path.width != null) ? s.path.width : 4;
  const mainPts = buildPolylineFromPath({
    start: s.path.start,
    segments: s.path.segments || [{ angle: 0, dist: 1 }]
  });

  const allPaths = [{ pts: mainPts, width: mainW, exit: null }];

  if (Array.isArray(s.path.branches)) {
    for (let bi = 0; bi < s.path.branches.length; bi++) {
      const b  = s.path.branches[bi] || {};
      const at = (typeof b.at === "number") ? Math.max(0, Math.min(1, b.at)) : 0.5;
      const p0 = _pointAtT(mainPts, at);

      const bPts = buildPolylineFromPath({
        start: { x: p0.x, y: p0.y },          // absolute start
        segments: b.segments || []
      });

      allPaths.push({ pts: bPts, width: (b.width != null ? b.width : mainW), exit: b.exit || null });
    }
  }

  // 2) Rasterize all paths into one map
  let map = rasterizePolylineToMap(mainPts, mainW, dims);
  for (let i = 1; i < allPaths.length; i++) {
    const pMap = rasterizePolylineToMap(allPaths[i].pts, allPaths[i].width, dims);
    for (let y = 0; y < pMap.length; y++) {
      for (let x = 0; x < pMap[y].length; x++) {
        if (pMap[y][x] === 'P') map[y][x] = 'P';
      }
    }
  }

  // 3) Endpoints → gates (runs ALWAYS, regardless of branches)
  for (let k = 0; k < allPaths.length; k++) {
    const { pts, width, exit } = allPaths[k];
    const halfWpx = (width * TILE_PX) / 2;

    const ends = [ pts[0], pts[pts.length - 1] ];
    for (let e = 0; e < ends.length; e++) {
      const p = ends[e];

      // touch side edges?
      if (Math.abs(p.x - rect.left)  <= eps) _extendSideGate("left",  p.y, halfWpx, rect);
      if (Math.abs(p.x - rect.right) <= eps) _extendSideGate("right", p.y, halfWpx, rect);

      // touch top/bottom?
      if (Math.abs(p.y - rect.top)    <= eps) _extendVerticalGate("top",    p.x, halfWpx);
      if (Math.abs(p.y - rect.bottom) <= eps) _extendVerticalGate("bottom", p.x, halfWpx);
    }

    // explicit exit hint (ensures a gate even if we’re a hair off-edge)
    if (exit) {
      const end = pts[pts.length - 1];
      if (exit === "right")  _extendSideGate("right",  end.y, halfWpx, rect);
      if (exit === "left")   _extendSideGate("left",   end.y, halfWpx, rect);
      if (exit === "top")    _extendVerticalGate("top",    end.x, halfWpx);
      if (exit === "bottom") _extendVerticalGate("bottom", end.x, halfWpx);
    }
  }
  
  // right after gates are built:
  console.log("all endpoints",
  allPaths.map(p => [p.pts[0], p.pts[p.pts.length-1]]));
  console.log("EXIT", EXIT);

  // (Optional) HUD
  const st = STAGES[stageIndex] || {};
  StageHUD.set(st.id != null ? st.id : stageIndex);

  renderMapToSprite_REUSE(map);
  syncNPCVisibilityToStage();
}



var CURRENT_STAGE = 0;
var EXIT = { top: null, bottom: null };
var BG = null; // background sprite reuse

// --- Concrete footpath tiles (cached variants) ---
var _CONCRETE_CACHE = null;

function makeConcreteTiles() {
  if (_CONCRETE_CACHE) return _CONCRETE_CACHE;
  var arr = [];
  for (var k = 0; k < 4; k++) arr.push(_makeConcreteTileVariant(k));
  _CONCRETE_CACHE = arr;
  return arr;
}

function _makeConcreteTileVariant(seed) {
  var S = TILE_PX;
  var c = document.createElement('canvas');
  c.width = S; c.height = S;
  var ctx = c.getContext('2d');
  setSmoothing(ctx, false);

  // base slab
  ctx.fillStyle = 'rgb(194,196,198)';        // light concrete
  ctx.fillRect(0, 0, S, S);

  // subtle vignette (edges slightly darker)
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = 'rgba(150,150,150,0.6)';
  ctx.fillRect(0, 0, S, 2);                  // top
  ctx.fillRect(0, S-2, S, 2);                // bottom
  ctx.fillRect(0, 0, 2, S);                  // left
  ctx.fillRect(S-2, 0, 2, S);                // right
  ctx.globalAlpha = 1;

  // seeded RNG (LCG) for repeatable speckle & cracks
  var rng = (seed * 1103515245 + 12345) >>> 0;
  function rand() { rng = (rng * 1664525 + 1013904223) >>> 0; return (rng & 0xffff) / 65535; }

  // speckle (tiny dark/light dots)
  var dots = Math.floor(S * S * 0.02);       // ~2% coverage
  for (var i = 0; i < dots; i++) {
    var x = (rand() * S) | 0, y = (rand() * S) | 0;
    var d = (rand() < 0.5) ? 180 + (rand()*30)|0 : 210 + (rand()*25)|0;
    ctx.fillStyle = 'rgb(' + d + ',' + d + ',' + d + ')';
    ctx.globalAlpha = 0.25 + rand()*0.2;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.globalAlpha = 1;

  // faint hairline crack(s) (very subtle)
  var crackCount = (rand() < 0.35) ? 1 : 0;
  for (var cidx = 0; cidx < crackCount; cidx++) {
    var x0 = rand()*S, y0 = rand()*S;
    var len = S * (0.4 + rand()*0.4);
    var ang = (rand()*Math.PI*2);
    var x1 = x0 + Math.cos(ang) * len;
    var y1 = y0 + Math.sin(ang) * len;
    ctx.strokeStyle = 'rgba(120,120,120,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // faint joint inset (1px inside edges)
  ctx.strokeStyle = 'rgba(170,170,170,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(1.5, 1.5, S-3, S-3);

  return c;
}

function renderMapToSprite_REUSE(map) {
  var h = map.length, w = map[0].length;
  var grass = makeGrassTile();
  var concreteVariants = makeConcreteTiles(); // 4 variants

  var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  canvas.width  = w * TILE_PX; canvas.height = h * TILE_PX;
  setSmoothing(ctx, false);

  // Draw base tiles
  for (var j = 0; j < h; j++) {
    for (var i = 0; i < w; i++) {
      var x = i * TILE_PX, y = j * TILE_PX;
      if (map[j][i] === 'P') {
        // pick variant deterministically
        var idx = ((i * 928371 + j * 1237) >>> 0) & 3;
        ctx.drawImage(concreteVariants[idx], x, y, TILE_PX, TILE_PX);
      } else {
        ctx.drawImage(grass, x, y, TILE_PX, TILE_PX);
      }
    }
  }

  // Kerb: draw thin white-ish edge where path borders grass
  var kerb1 = 'rgba(240,240,240,0.9)';  // highlight line
  var kerb2 = 'rgba(150,150,150,0.35)'; // shadow line just inside
  var t = 2; // kerb thickness in px

  for (var jj = 0; jj < h; jj++) {
    for (var ii = 0; ii < w; ii++) {
      if (map[jj][ii] !== 'P') continue;

      var X = ii * TILE_PX, Y = jj * TILE_PX;
      // neighbor checks
      var up    = (jj > 0      && map[jj-1][ii] === 'P');
      var down  = (jj < h - 1  && map[jj+1][ii] === 'P');
      var left  = (ii > 0      && map[jj][ii-1] === 'P');
      var right = (ii < w - 1  && map[jj][ii+1] === 'P');

      // top kerb (touches grass above)
      if (!up) {
        ctx.fillStyle = kerb1; ctx.fillRect(X, Y, TILE_PX, t);
        ctx.fillStyle = kerb2; ctx.fillRect(X, Y + t, TILE_PX, 1);
      }
      // bottom kerb
      if (!down) {
        ctx.fillStyle = kerb1; ctx.fillRect(X, Y + TILE_PX - t, TILE_PX, t);
        ctx.fillStyle = kerb2; ctx.fillRect(X, Y + TILE_PX - t - 1, TILE_PX, 1);
      }
      // left kerb
      if (!left) {
        ctx.fillStyle = kerb1; ctx.fillRect(X, Y, t, TILE_PX);
        ctx.fillStyle = kerb2; ctx.fillRect(X + t, Y, 1, TILE_PX);
      }
      // right kerb
      if (!right) {
        ctx.fillStyle = kerb1; ctx.fillRect(X + TILE_PX - t, Y, t, TILE_PX);
        ctx.fillStyle = kerb2; ctx.fillRect(X + TILE_PX - t - 1, Y, 1, TILE_PX);
      }
    }
  }

  var url = canvas.toDataURL('image/png');
  if (!BG) { BG = new Image(); BG.x = 0; BG.y = 0; BG.sendToBack(); }
  BG.width = canvas.width; BG.height = canvas.height; BG.url = url;
  return BG;
}


// Show NPCs only on their home stage.
// Followers show if they are in the party; otherwise they show on their leader's (or own) home stage.
function syncNPCVisibilityToStage() {
  var k;
  for (k in CHARACTERS) {
    var w = CHARACTERS[k];
    if (!w || !w.state || !w.sprite) continue;

    var mode = w.state.mode;

    if (mode === "npc") {
      var siNpc = getWalkerStageIndex(w);
      if (siNpc != null && siNpc !== CURRENT_STAGE) hideSprite(w.sprite);
      else showSprite(w.sprite);
      continue;
    }

    if (mode === "follow") {
      if (isWalkerInParty(w)) {
        showSprite(w.sprite);
      } else {
        var lead = getFollowLeader(w);
        var siLead = getWalkerStageIndex(lead);
        var siSelf = getWalkerStageIndex(w);
        var showHere = (siLead != null ? siLead : siSelf);
        if (showHere != null && showHere !== CURRENT_STAGE) hideSprite(w.sprite);
        else showSprite(w.sprite);
      }
      continue;
    }

    // players (and anything else)
    showSprite(w.sprite);
  }
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

function gateClampXWithinPath(side, x, radiusPx) {
  var g = (side === "top") ? EXIT.top : EXIT.bottom;
  if (!g) return x;
  var PAD = (GATE_PAD_TILES || 0) * TILE_PX;
  var L = g.left  - PAD + radiusPx;
  var R = g.right + PAD - radiusPx;
  if (x < L) x = L;
  if (x > R) x = R;
  return x;
}

function oppositeGate(side){
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  if (side === "right") return "left";
  return "bottom";
}


function spawnPartyAtGate(side) {
  var g = EXIT && EXIT[side];
  if (!g) return;

  var party = getPartyWalkers();
  if (!party || party.length === 0) return;

  // Extra buffer inside the screen beyond EPS + half-size
  var MARGIN = Math.max(8, Math.floor(TILE_PX * 0.5));

  // Simple formation helpers
  function formationOffset(i) {
    if (i === 0) return {dx: 0, dy: 0};
    var row = Math.floor(i / 2);
    var sign = (i % 2 === 1) ? -1 : +1;
    return { dx: sign * (24 + row * 14), dy: -12 * row };
  }

  // ---- Vertical gates (TOP/BOTTOM) ----
  if (side === "top" || side === "bottom") {
    var cx = (g.left + g.right) / 2;

    for (var i = 0; i < party.length; i++) {
      var s = party[i].sprite; if (!s) continue;
      var halfH = (s.height || TILE_PX) / 2;

      // Place center Y strictly inside (outside hit range):
      // Top gate triggers when sy >= EXIT.top.y - EPS, so we place sy < EXIT.top.y - EPS
      // Bottom gate triggers when sy <= EXIT.bottom.y + EPS, so we place sy > EXIT.bottom.y + EPS
      var safeY = (side === "top")
        ? (g.y - GATE_EPS - MARGIN - halfH)      // inside from top edge
        : (g.y + GATE_EPS + MARGIN + halfH);     // inside from bottom edge

      var off = formationOffset(i);
      s.x = cx + off.dx;
      s.y = safeY + off.dy;

      // Optional: clamp but this should already be inside bounds
      if (typeof clampToScreenWithAnchoredExits === "function") {
        var p = clampToScreenWithAnchoredExits(s.x, s.y, (s.width||TILE_PX)/2);
        s.x = p.x; s.y = p.y;
      }
    }
    return;
  }

  // ---- Horizontal gates (LEFT/RIGHT) ----
  // Right gate triggers when sprite's right edge >= EXIT.right.x - EPS.
  // So we place center x so that right edge < EXIT.right.x - EPS.
  // Left gate triggers when sprite's left edge <= EXIT.left.x + EPS.
  // So we place center x so that left edge  > EXIT.left.x + EPS.
  var cy = (g.bottom + g.top) / 2;

  for (var j = 0; j < party.length; j++) {
    var sj = party[j].sprite; if (!sj) continue;

    var halfW = (sj.width || TILE_PX) / 2;
    var halfH = (sj.height || TILE_PX) / 2;

    var safeX = (side === "right")
      ? (g.x - GATE_EPS - MARGIN - halfW)  // inside from right edge
      : (g.x + GATE_EPS + MARGIN + halfW); // inside from left edge

    var off2 = formationOffset(j);
    // For horizontal gates, stagger vertically and nudge slightly inward horizontally
    sj.x = safeX + Math.max(0, off2.dx * 0.5);
    sj.y = cy    + off2.dy;

    // Optional clamp (keeps us on-screen but won't cross the threshold we just respected)
    if (typeof clampToScreenWithAnchoredExits === "function") {
      var p2 = clampToScreenWithAnchoredExits(sj.x, sj.y, halfW);
      sj.x = p2.x; sj.y = p2.y;
    }
  }
}



function goToStage(nextIndex, enteredFrom /* "top"|"bottom"|"left"|"right" */) {
  if (nextIndex < 0 || nextIndex >= STAGES.length) return;

  buildStage(nextIndex);
  spawnPartyAtGate(oppositeGate(enteredFrom));
  updatePartyStageIndex(CURRENT_STAGE);
  syncNPCVisibilityToStage();
}

function _inRange(v, a, b){ return v >= Math.min(a,b) && v <= Math.max(a,b); }

function checkStageExit() {
  var s = finGuy.sprite;
  var stage = STAGES[CURRENT_STAGE] || {};
  var links = stage.links || {};

  // tiny tolerance so we can trigger even if clamp stops us a pixel shy
  var EPS = Math.max(2, Math.floor(TILE_PX * 0.25));

  var sxL = s.x - s.width/2;
  var sxR = s.x + s.width/2;
  var sy  = s.y;

  // ---- TOP ----
  if (EXIT.top && links.top != null) {
    var hitTop = (sy >= EXIT.top.y - EPS) &&
                 _inRange(s.x, EXIT.top.left - EPS, EXIT.top.right + EPS);
    if (hitTop) {
      var idxTop = _stageIndexFrom(links.top, _buildIdIndex());
      if (idxTop != null) { goToStage(idxTop, "top"); return; }
    }
  }

  // ---- BOTTOM ----
  if (EXIT.bottom && links.bottom != null) {
    var hitBottom = (sy <= EXIT.bottom.y + EPS) &&
                    _inRange(s.x, EXIT.bottom.left - EPS, EXIT.bottom.right + EPS);
    if (hitBottom) {
      var idxBottom = _stageIndexFrom(links.bottom, _buildIdIndex());
      if (idxBottom != null) { goToStage(idxBottom, "bottom"); return; }
    }
  }

  // ---- RIGHT ----
  if (EXIT.right && links.right != null) {
    var hitRight = (sxR >= EXIT.right.x - EPS) &&
                   _inRange(sy, EXIT.right.bottom - EPS, EXIT.right.top + EPS);
    if (hitRight) {
      var idxRight = _stageIndexFrom(links.right, _buildIdIndex());
      if (idxRight != null) { goToStage(idxRight, "right"); return; }
    }
  }

  // ---- LEFT ----
  if (EXIT.left && links.left != null) {
    var hitLeft = (sxL <= EXIT.left.x + EPS) &&
                  _inRange(sy, EXIT.left.bottom - EPS, EXIT.left.top + EPS);
    if (hitLeft) {
      var idxLeft = _stageIndexFrom(links.left, _buildIdIndex());
      if (idxLeft != null) { goToStage(idxLeft, "left"); return; }
    }
  }
}




// --- Party resolution helpers (leader + followers who ultimately follow leader) ---
function isWalker(obj) {
  return obj && obj.sprite && obj.state;
}

function isLeader(w) {
  return isWalker(w) && w.state.mode === "player";
}

function getLeaderWalker() {
  var k, first = null;
  for (k in CHARACTERS) {
    var w = CHARACTERS[k];
    if (!first && isWalker(w)) first = w;
    if (isLeader(w)) return w;
  }
  // fallback: named finGuy if present, else first any walker
  if (typeof finGuy !== "undefined" && isWalker(finGuy)) return finGuy;
  return first;
}

// If a walker is following another walker, return that walker; else null.
// (If target was a plain Image, we stop the chain.)
function getFollowTargetWalker(w) {
  if (!isWalker(w)) return null;
  var t = w.state && w.state.follow && w.state.follow.target;
  // target is a walker if it has a .sprite (Image) AND a .state
  return isWalker(t) ? t : null;
}

// Does this walker’s follow chain eventually reach the leader?
function resolvesToLeader(w, leader) {
  if (!isWalker(w) || !isWalker(leader)) return false;
  var cur = w;
  var hops = 0;             // guard against cycles
  var MAX_HOPS = 32;
  while (cur && hops < MAX_HOPS) {
    if (cur === leader) return true;
    cur = getFollowTargetWalker(cur);
    hops += 1;
  }
  return false;
}

// Terminal leader in a follow chain (walker or null)
function getFollowLeader(w) {
  var cur = w, guard = 0;
  while (cur && cur.state && cur.state.mode === "follow" &&
         cur.state.follow && cur.state.follow.target && guard < 32) {
    // follow.target is a walker (your code passes walkers, not sprites)
    cur = cur.state.follow.target;
    guard += 1;
  }
  return cur;
}

// Party = chains ending at a player
function isWalkerInParty(w) {
  var lead = getFollowLeader(w);
  return !!(lead && lead.state && lead.state.mode === "player");
}

// Uniform way to fetch a walker's "home" stageIndex (if any)
function getWalkerStageIndex(w) {
  if (!w || !w.state) return null;
  if (w.state.mode === "npc" && w.state.npc && w.state.npc.stageIndex != null) {
    return w.state.npc.stageIndex;
  }
  if (w.state.stageIndex != null) return w.state.stageIndex;
  return null;
}

// After a stage change, stamp the party with the new stageIndex
function updatePartyStageIndex(si) {
  var k;
  for (k in CHARACTERS) {
    var w = CHARACTERS[k];
    if (!w || !w.state) continue;
    if (w.state.mode === "player" || (w.state.mode === "follow" && isWalkerInParty(w))) {
      w.state.stageIndex = si;
    }
  }
}

// Optional: use the same rule to list party members
function getPartyWalkers() {
  var arr = [], k;
  for (k in CHARACTERS) {
    var w = CHARACTERS[k];
    if (w && isWalkerInParty(w)) arr.push(w);
  }
  return arr;
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

// Create a reusable top-down walker with player/follow/npc modes (no angle changes)
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
    mode: "player",          // 'player' | 'follow' | 'npc'

    // follow controller
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
    },

    // npc controller
    npc: {
      bounds: null,          // { left,right,bottom,top } in world coords
      speedScale: 1.0,
      pauseMin: 0.8,         // seconds
      pauseMax: 2.0,
      walkMin:  0.8,         // seconds to keep walking toward a goal (soft limit)
      walkMax:  2.2,
      timer: 0,              // counts down pause/walk time
      movingPhase: false,    // false = paused, true = walking
      targetX: null,
      targetY: null,
      stageIndex: null       // optional bookkeeping if you want to tag what stage they belong to
    }
  };

  function chooseIdleFrame() {
    state.frame = 0;
    sprite.url = urls[state.dir][state.frame];
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

  function updateIdle() {
    state.moving = false;
    advanceFrameIfMoving(); // will hold frame 0 in the last facing dir
  }
  
  function isChatFrozen() {
    if (!CHAT) return false;
    return (CHAT.chatTarget === api) || (CHAT.chattingWith === api) || sprite.isChatting;
  }

  // ---- PLAYER --------------------------------------------------------------
  function updateFromKeys() {
    let dx = 0, dy = 0;
    if (isMovingLeft)  dx -= 1;
    if (isMovingRight) dx += 1;
    if (isMovingUp)    dy += 1;   // WoofJS Y+ is up
    if (isMovingDown)  dy -= 1;   // down is negative Y

    state.moving = (dx != 0 || dy != 0);

    if (state.moving) {
      var nx = sprite.x + dx * state.speed * K;
      var ny = sprite.y + dy * state.speed * K;
      var rad = (sprite.width || TILE_PX) / 2;
      var p = clampToScreenWithAnchoredExits(nx, ny, rad);
      // if npc bounds are set (e.g., you keep them for non-npc too), clamp to them too
      if (state.npc.bounds) p = clampToRect(p.x, p.y, rad, state.npc.bounds);
      sprite.x = p.x; sprite.y = p.y;
      chooseFacingFromVector(state, sprite, urls, dx, dy);
    }

    advanceFrameIfMoving();
  }

  // ---- FOLLOW --------------------------------------------------------------
  function getTargetXY(targetLike) {
    const t = (targetLike && targetLike.sprite) ? targetLike.sprite : targetLike;
    return t ? { x: t.x, y: t.y } : null;
  }

  // ---- FOLLOW --------------------------------------------------------------
  function updateFollow() {
    const f = state.follow;
    const tgt = getTargetXY(f.target);
    if (!tgt) { state.moving = false; advanceFrameIfMoving(); return; }

    const dxT = tgt.x - sprite.x;
    const dyT = tgt.y - sprite.y;
    const distToTarget = Math.hypot(dxT, dyT);

    if (f.atRest) {
      if (distToTarget > f.stopDist + f.hysteresis) {
        f.atRest = false;
      } else {
        state.moving = false;
        advanceFrameIfMoving();
        return;
      }
    }

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

    let maxClose = distToTarget - f.stopDist;
    if (maxClose < 0) maxClose = 0;

    let step = state.speed * (f.speedScale || 1) * K;
    step = Math.min(step, maxClose);

    if (step <= 0.0001) {
      f.atRest = true;
      f.stopDist = randBetween(f.stopMin, f.stopMax);
      state.moving = false;
      advanceFrameIfMoving();
      return;
    }

    var nx = sprite.x + vx * step;
    var ny = sprite.y + vy * step;
    var rad = (sprite.width || TILE_PX) / 2;

    // followers: clamp ONLY to screen/exit gates
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

  // ---- NPC (wander within rect, with pauses) -------------------------------
  function clampToRect(nextX, nextY, radiusPx, rect) {
    var r = radiusPx || 0;
    var x = nextX, y = nextY;
    if (rect) {
      if (x < rect.left   + r) x = rect.left   + r;
      if (x > rect.right  - r) x = rect.right  - r;
      if (y < rect.bottom + r) y = rect.bottom + r;
      if (y > rect.top    - r) y = rect.top    - r;
    }
    return { x: x, y: y };
  }

  function randomInRect(rect) {
    var rx = randBetween(rect.left, rect.right);
    var ry = randBetween(rect.bottom, rect.top);
    return { x: rx, y: ry };
  }

  function chooseNPCTarget() {
    var b = state.npc.bounds;
    if (!b) return;
    var t = randomInRect(b);
    state.npc.targetX = t.x;
    state.npc.targetY = t.y;
  }

  function beginPause() {
    var pMin = state.npc.pauseMin, pMax = state.npc.pauseMax;
    state.npc.timer = randBetween(pMin, pMax);
    state.npc.movingPhase = false;
    state.moving = false;
    chooseIdleFrame();
  }

  function beginWalk() {
    if (!state.npc.bounds) return beginPause();
    chooseNPCTarget();
    var wMin = state.npc.walkMin, wMax = state.npc.walkMax;
    state.npc.timer = randBetween(wMin, wMax);
    state.npc.movingPhase = true;
  }

  function updateNPC() {
      // If we’re the current chat target (or actively chatting), stop moving.
    if (isChatFrozen()) {
      state.npc.movingPhase = false;
      state.npc.timer = Math.max(state.npc.timer, 0.25);
      state.moving = false;
      chooseIdleFrame();
      return;
    }
    
    // ensure bounds; default to the current screen box if not provided
    if (!state.npc.bounds) {
      state.npc.bounds = { left: (typeof minX!=="undefined"?minX:-maxX), right: maxX, bottom: (typeof minY!=="undefined"?minY:-maxY), top: maxY };
    }

    // drive a simple finite state machine: pause -> walk -> pause ...
    var dtSec = (typeof DT === "number" ? DT : 1/60);
    state.npc.timer -= dtSec;

    if (!state.npc.movingPhase) {
      // paused
      state.moving = false;
      if (state.npc.timer <= 0) beginWalk();
      advanceFrameIfMoving();
      return;
    }

    // walking toward target
    var tx = state.npc.targetX, ty = state.npc.targetY;
    if (tx == null || ty == null) { beginPause(); return; }

    var vx = tx - sprite.x;
    var vy = ty - sprite.y;
    var dist = Math.hypot(vx, vy);
    if (dist > 0) { vx /= dist; vy /= dist; }

    var step = state.speed * (state.npc.speedScale || 1) * K;
    var rad  = (sprite.width || TILE_PX) / 2;

    var nx = sprite.x + vx * step;
    var ny = sprite.y + vy * step;

    // clamp to screen, then to npc rect
    var p = clampToScreenWithAnchoredExits(nx, ny, rad);
    p = clampToRect(p.x, p.y, rad, state.npc.bounds);

    sprite.x = p.x; sprite.y = p.y;

    state.moving = true;
    chooseFacingFromVector(state, sprite, urls, vx, vy);
    advanceFrameIfMoving();

    // arrival or walked “long enough” → pause again
    var arrived = (dist <= step + 0.5);
    var timeUp  = (state.npc.timer <= 0);
    // also consider if we got clamped hard against the rect (stuck on edge)
    var clampedEdge = (
      (sprite.x <= state.npc.bounds.left   + rad + 0.01) ||
      (sprite.x >= state.npc.bounds.right  - rad - 0.01) ||
      (sprite.y <= state.npc.bounds.bottom + rad + 0.01) ||
      (sprite.y >= state.npc.bounds.top    - rad - 0.01)
    );

    if (arrived || timeUp || clampedEdge) beginPause();
  }

  // ---- Public API ----------------------------------------------------------
  function followUserInput() {
    state.mode = "player";
    return api; // chaining
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

  // cancel follow / force idle
  function stopFollowing() {
    state.mode = "idle";
    state.follow.target = null;
    state.follow.atRest = true;
    state.follow.repathTick = 0;
    return api;
  }

  function setNPCBounds(rect /* {left,right,bottom,top} */) {
    state.npc.bounds = rect;
    return api;
  }

  function wanderWithin(rect, options) {
    state.mode = "npc";
    if (rect) state.npc.bounds = rect;

    if (options) {
      if (options.pauseRange) {
        state.npc.pauseMin = options.pauseRange[0];
        state.npc.pauseMax = options.pauseRange[1];
      }
      if (options.walkRange) {
        state.npc.walkMin = options.walkRange[0];
        state.npc.walkMax = options.walkRange[1];
      }
      if (options.speedScale != null) state.npc.speedScale = options.speedScale;
      if (options.stageIndex != null) state.npc.stageIndex = options.stageIndex;
    }

    // start with a short pause so they don't pop
    state.npc.timer = randBetween(state.npc.pauseMin, state.npc.pauseMax);
    state.npc.movingPhase = false;
    state.npc.targetX = null; state.npc.targetY = null;

    return api;
  }

  function stopNPC() {
    if (state.mode === "npc") {
      state.npc.movingPhase = false;
      state.npc.timer = 0.5;
      state.npc.targetX = null; state.npc.targetY = null;
    }
    state.mode = "idle";
    return api;
  }

  function update() {
    if (state.mode === "follow")        updateFollow();
    else if (state.mode === "player")   updateFromKeys();
    else if (state.mode === "npc")      updateNPC();
    else                                updateIdle();   // 'idle'
  }

  const api = {
    sprite: sprite,
    urls: urls,
    state: state,
    update: update,

    // controls
    updateFromKeys: updateFromKeys,
    followUserInput: followUserInput,
    followSprite: followSprite,
    stopFollowing: stopFollowing,

    // npc controls
    wanderWithin: wanderWithin,
    setNPCBounds: setNPCBounds,
    stopNPC: stopNPC
  };

  // Also expose on the sprite for your requested syntax
  sprite.followUserInput = followUserInput;
  sprite.followSprite = followSprite;
  sprite.update = update;
  sprite.wanderWithin = wanderWithin;
  sprite.setNPCBounds = setNPCBounds;

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
var GATE_EPS = Math.max(2, Math.floor(TILE_PX * 0.25));  // same EPS your checks use

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


// == SideShooter ==========================================================================
// Register with:  Game.register('sideShooter', SideShooterMode)
// Switch to it:   Game.switchTo('sideShooter', { soft:false })

// =========================== SideShooter Mode ===============================
var sideShooter = (function () {
  // ---- small utilities (safe for WoofJS) -----------------------------------
  function nn(v, d) { return (v != null) ? v : d; }    // null/undefined only
  function ssSafeDelete(s) {
    if (!s) return;
    if (typeof safeDelete === "function") { safeDelete(s); return; }
    if (s.delete) s.delete();
  }
  function ssShow(s) {
    if (!s) return;
    if (typeof showSprite === "function") { showSprite(s); return; }
    if (s.show) s.show(); else s.visible = true;
  }
  function ssHide(s) {
    if (!s) return;
    if (typeof hideSprite === "function") { hideSprite(s); return; }
    if (s.hide) s.hide(); else s.visible = false;
  }
  function aabbOverlap(a, b) {
    return Math.abs(a.x - b.x) * 2 < (a.width + b.width) &&
           Math.abs(a.y - b.y) * 2 < (a.height + b.height);
  }

  // ---- static assets/config -------------------------------------------------
  var FAR_URL  = "https://github.com/finzifin-dev/7D-Game/blob/635c4635f5920e67873aadbebe91527b7e0a9adb/stars2_far_1.png?raw=true";
  var MID_URL  = "https://github.com/finzifin-dev/7D-Game/blob/635c4635f5920e67873aadbebe91527b7e0a9adb/stars2_mid_1.png?raw=true";
  var NEAR_URL = "https://github.com/finzifin-dev/7D-Game/blob/635c4635f5920e67873aadbebe91527b7e0a9adb/stars2_near_1.png?raw=true";

  var SHIP_URLS = {
    forward: "https://raw.githubusercontent.com/finzifin-dev/7D-Game/main/player_ship1.png",
    idle:    "https://raw.githubusercontent.com/finzifin-dev/7D-Game/main/player_ship2.png",
    back:    "https://raw.githubusercontent.com/finzifin-dev/7D-Game/main/player_ship3.png"
  };

  var LASER_URL = "https://github.com/finzifin-dev/7D-Game/blob/main/laser.gif?raw=true";

  var GH = "https://raw.githubusercontent.com/finzifin-dev/7D-Game/main/";
  var ENEMY_DEFS = [
    { name:"Scout",   url: GH+"enemy_ship1.png", speed: 4,   pattern:"straight", fireInterval: 3,   bulletSpeed: -12,   points: 100, strength: 1, explosionUrl: GH+"explosion1.png", h: 48, stages: [1,2,3] },
    { name:"Waver",   url: GH+"enemy_ship2.png", speed: 4.5, pattern:"sine",     fireInterval: 3.5, bulletSpeed: -13.5, points: 150, strength: 1, explosionUrl: GH+"explosion2.png", h: 54, amp: 50, freq: 0.7, stages: [1,2,3,4] },
    { name:"Drifter", url: GH+"enemy_ship4.png", speed: 5.5, pattern:"driftDown",fireInterval: 1.7, bulletSpeed: -12.5, points: 220, strength: 1, explosionUrl: GH+"explosion4.png", h: 60, vy: 0.6, stages: [3,4,5] },
    { name:"Floater", url: GH+"enemy_ship5.png", speed: 6,   pattern:"driftUp",  fireInterval: 2,   bulletSpeed: -11.8, points: 250, strength: 1, explosionUrl: GH+"explosion5.png", h: 58, vy: 0.6, stages: [4,5] },
    { name:"Dasher",  url: GH+"enemy_ship6.png", speed: 10,  pattern:"sine",     fireInterval: 50,  bulletSpeed: -14,   points: 300, strength: 1, explosionUrl: GH+"explosion6.png", h: 56, amp: 30, freq: 1.5, stages: [5] }
  ];

  var LIVES_MAX = 3;
  var LIVES_URL = "https://github.com/finzifin-dev/7D-Game/blob/main/player_ship4.png?raw=true";
  var PLAYER_EXPLOSION_URL = "https://github.com/finzifin-dev/7D-Game/blob/main/explosion_transparent_once.gif?raw=true";

  // ---- mode object ----------------------------------------------------------
  var api = {
    id: "sideShooter",
    __inited: false,
    ready: false,

    // sprites/state containers
    bgTiles: [],         // background star images (2 per layer)
    layers: [],          // { step, setSpeed, left, right }
    hudLeft: null,
    hudCenter: null,
    titlePrompt: null,
    titleSprites: [],
    banner: null,

    ship: null,
    lasers: [],
    enemies: [],
    enemyBullets: [],
    livesIcons: [],

    // game state
    gameActive: false,
    waitingForStart: false,
    enterPrev: false,
    blinkTimer: 0,          // for title prompt blink
    distTimer: 0,           // +1 distance every 5s
    spawnCooldown: 0,
    onDone: null,           // banner queue completion

    // tuning
    HOME: { x: 0, y: -100 },
    returnHome: false,
    returnSpeed: 10,

    idleDrift: 1,
    driftSpeed: 1,
    shipSpeed: 12,

    LASER_SPEED: 18,
    LASER_H: 5,
    LASER_LAYER: 80,
    MUZZLE_XOFF: 4,
    MUZZLE_YOFF: 0,
    MAX_LASERS: 3,

    ENEMY_SPAWN_EVERY: 3,
    ENEMY_BULLET_W: 8,
    ENEMY_BULLET_H: 2,

    ENEMY_BULLET_SPEED_MUL: 1.5,
    ENEMY_FIRE_RATE_MUL: 1.4,

    stage: 0,
    score: 0,
    distance: 0,
    lives: LIVES_MAX,
    MAX_STAGES: 5,
    STAGE_GOALS: [1000, 2000, 3500, 5000, 7000],
    STAGE_MODS: [
      { num: 1, spawnRate: 1,   bulletSpeed: 1,   enemySpeed: 1,   bulletRate: 1   },
      { num: 1, spawnRate: 1.5, bulletSpeed: 1.2, enemySpeed: 1.2, bulletRate: 1.2 },
      { num: 1, spawnRate: 2,   bulletSpeed: 1.4, enemySpeed: 1.4, bulletRate: 1.3 },
      { num: 1, spawnRate: 2.5, bulletSpeed: 1.6, enemySpeed: 1.6, bulletRate: 1.6 },
      { num: 2, spawnRate: 3,   bulletSpeed: 1.8, enemySpeed: 1.8, bulletRate: 1.8 }
    ],

    // ---------------------------- lifecycle ---------------------------------
    init: function () {
      // (optional) tiny preloads
      new Image({ url: PLAYER_EXPLOSION_URL, width: 1, height: 1, brightness: 0, layer: -999 });
      new Image({ url: SHIP_URLS.forward, width: 1, height: 1, brightness: 0, layer: -999 });
      new Image({ url: SHIP_URLS.back,    width: 1, height: 1, brightness: 0, layer: -999 });
      new Image({ url: LASER_URL, x: maxX, y: minY, width: 1, height: 1, brightness: 0, layer: -999 });

      // build backgrounds (each creates two Image sprites)
      this.layers = [];
      this.bgTiles = [];
      this.layers.push(this.makeStarLayer(FAR_URL,  1, 0));
      this.layers.push(this.makeStarLayer(MID_URL,  2, 0));
      this.layers.push(this.makeStarLayer(NEAR_URL, 3, 0));

      // HUD
      this.hudLeft = new Text({
        text: "",
        size: 18,
        x: minX, y: maxY - 20,
        layer: 200,
        textAlign: "left",
        fontFamily: "poppins",
        color: rgb(180, 50, 140)
      });
      this.hudCenter = new Text({
        text: "",
        size: 24,
        x: 0, y: maxY - 20,
        layer: 200,
        textAlign: "center",
        fontFamily: "poppins",
        color: rgb(180, 50, 140)
      });

      // ship
      this.ship = new Image({
        url: SHIP_URLS.idle, x: this.HOME.x, y: this.HOME.y, height: 70, layer: 100
      });

      this.hide(); // start hidden; ModeManager will show on first enter
      this.__inited = true;
      this.ready = true;
    },

    enter: function () {
      // fresh title screen each time unless a snapshot restores active play
      if (!this._loadedFromSnapshot) {
        this.initGame("start");
      }
      this._loadedFromSnapshot = false;
    },

    show: function () {
      var i;
      for (i = 0; i < this.bgTiles.length; i++) ssShow(this.bgTiles[i]);
      ssShow(this.hudLeft); ssShow(this.hudCenter);
      if (this.titleSprites) for (i = 0; i < this.titleSprites.length; i++) ssShow(this.titleSprites[i]);
      if (this.banner) ssShow(this.banner);
      if (this.ship) ssShow(this.ship);
      for (i = 0; i < this.lasers.length; i++) if (this.lasers[i] && this.lasers[i].sprite) ssShow(this.lasers[i].sprite);
      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssShow(this.enemies[i].sprite);
      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssShow(this.enemyBullets[i].sprite);
      for (i = 0; i < this.livesIcons.length; i++) ssShow(this.livesIcons[i]);
    },

    hide: function () {
      var i;
      for (i = 0; i < this.bgTiles.length; i++) ssHide(this.bgTiles[i]);
      if (this.hudLeft) ssHide(this.hudLeft);
      if (this.hudCenter) ssHide(this.hudCenter);
      if (this.titleSprites) for (i = 0; i < this.titleSprites.length; i++) ssHide(this.titleSprites[i]);
      if (this.banner) ssHide(this.banner);
      if (this.ship) ssHide(this.ship);
      for (i = 0; i < this.lasers.length; i++) if (this.lasers[i] && this.lasers[i].sprite) ssHide(this.lasers[i].sprite);
      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssHide(this.enemies[i].sprite);
      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssHide(this.enemyBullets[i].sprite);
      for (i = 0; i < this.livesIcons.length; i++) ssHide(this.livesIcons[i]);
    },

    unload: function () {
      // hard clear of sprites/arrays
      var i;
      for (i = 0; i < this.bgTiles.length; i++) ssSafeDelete(this.bgTiles[i]);
      this.bgTiles = []; this.layers = [];

      if (this.hudLeft) ssSafeDelete(this.hudLeft); this.hudLeft = null;
      if (this.hudCenter) ssSafeDelete(this.hudCenter); this.hudCenter = null;
      if (this.banner) { ssSafeDelete(this.banner); this.banner = null; }

      if (this.ship) { ssSafeDelete(this.ship); this.ship = null; }

      for (i = 0; i < this.lasers.length; i++) if (this.lasers[i] && this.lasers[i].sprite) ssSafeDelete(this.lasers[i].sprite);
      this.lasers = [];

      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssSafeDelete(this.enemies[i].sprite);
      this.enemies = [];

      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssSafeDelete(this.enemyBullets[i].sprite);
      this.enemyBullets = [];

      for (i = 0; i < this.livesIcons.length; i++) ssSafeDelete(this.livesIcons[i]);
      this.livesIcons = [];

      for (i = 0; i < this.titleSprites.length; i++) ssSafeDelete(this.titleSprites[i]);
      this.titleSprites = [];

      this.ready = false;
      this.__inited = false;
    },

    save: function () {
      // snapshot dynamic state so we can unload safely and restore later
      var i;
      var lasersSnap = [];
      for (i = 0; i < this.lasers.length; i++) {
        if (this.lasers[i] && this.lasers[i].sprite) {
          lasersSnap.push({ x: this.lasers[i].sprite.x, y: this.lasers[i].sprite.y });
        }
      }
      var enemiesSnap = [];
      for (i = 0; i < this.enemies.length; i++) {
        var e = this.enemies[i];
        if (!e || !e.sprite) continue;
        enemiesSnap.push({
          name: (e.def && e.def.name) ? e.def.name : null,
          x: e.sprite.x, y: e.sprite.y,
          hp: nn(e.hp, 1),
          t: nn(e.t, 0),
          baseY: nn(e.baseY, e.sprite.y),
          fireTimer: nn(e.fireTimer, 1),
          moveSpeed: nn(e.moveSpeed, (e.def && e.def.speed) ? e.def.speed : 1),
          bulletSpeed: nn(e.bulletSpeed, (e.def && e.def.bulletSpeed) ? e.def.bulletSpeed : -10)
        });
      }
      var bulletsSnap = [];
      for (i = 0; i < this.enemyBullets.length; i++) {
        var b = this.enemyBullets[i]; if (!b || !b.sprite) continue;
        bulletsSnap.push({ x: b.sprite.x, y: b.sprite.y, vx: nn(b.vx, -10) });
      }
      var livesCount = this.lives; // icons rebuilt from value

      return {
        gameActive: this.gameActive,
        waitingForStart: this.waitingForStart,
        stage: this.stage,
        score: this.score,
        distance: this.distance,
        lives: livesCount,
        spawnCooldown: this.spawnCooldown,
        ship: this.ship ? { x: this.ship.x, y: this.ship.y, state: this._shipState } : null,
        lasers: lasersSnap,
        enemies: enemiesSnap,
        bullets: bulletsSnap,
        bannerQueue: this._bannerQueue ? this._bannerQueue.slice(0) : [],
        returnHome: this.returnHome
      };
    },

    load: function (snap) {
      this._loadedFromSnapshot = true;
      if (!snap) return;

      // rebuild HUD if destroyed (defensive)
      if (!this.hudLeft || !this.hudCenter) {
        this.hudLeft = new Text({ text: "", size: 18, x: minX, y: maxY - 20, layer: 200, textAlign: "left", fontFamily: "poppins", color: rgb(180,50,140) });
        this.hudCenter = new Text({ text: "", size: 24, x: 0, y: maxY - 20, layer: 200, textAlign: "center", fontFamily: "poppins", color: rgb(180,50,140) });
      }

      this.gameActive = !!snap.gameActive;
      this.waitingForStart = !!snap.waitingForStart;
      this.stage = nn(snap.stage, 1);
      this.score = nn(snap.score, 0);
      this.distance = nn(snap.distance, 0);
      this.lives = nn(snap.lives, LIVES_MAX);
      this.spawnCooldown = nn(snap.spawnCooldown, 0);
      this.returnHome = !!snap.returnHome;

      // rebuild lives icons
      this.rebuildLivesIcons(this.lives);

      // ship
      if (!this.ship) this.ship = new Image({ url: SHIP_URLS.idle, x: 0, y: 0, height: 70, layer: 100 });
      if (snap.ship) { this.ship.x = snap.ship.x; this.ship.y = snap.ship.y; }
      this.setShipBoost("idle"); // will adjust with input

      // lasers
      var i;
      for (i = 0; i < this.lasers.length; i++) if (this.lasers[i] && this.lasers[i].sprite) ssSafeDelete(this.lasers[i].sprite);
      this.lasers = [];
      for (i = 0; i < snap.lasers.length; i++) {
        var ls = snap.lasers[i];
        var spr = new Image({ url: LASER_URL, x: ls.x, y: ls.y, height: this.LASER_H, layer: this.LASER_LAYER });
        this.lasers.push({ sprite: spr });
      }

      // enemies
      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssSafeDelete(this.enemies[i].sprite);
      this.enemies = [];
      for (i = 0; i < snap.enemies.length; i++) {
        var es = snap.enemies[i];
        var def = this.findEnemyDef(es.name);
        if (!def) def = ENEMY_DEFS[0];
        var eSprite = new Image({ url: def.url, x: es.x, y: es.y, height: nn(def.h, 56) });
        this.enemies.push({
          sprite: eSprite,
          def: def,
          hp: nn(es.hp, nn(def.strength, 1)),
          t: nn(es.t, 0),
          baseY: nn(es.baseY, es.y),
          fireTimer: nn(es.fireTimer, nn(def.fireInterval, 2)),
          fireInterval: nn(def.fireInterval, 2) / (nn(this.getStageMods().bulletRate, 1) * nn(this.ENEMY_FIRE_RATE_MUL, 1)),
          moveSpeed: nn(es.moveSpeed, nn(def.speed, 1) * nn(this.getStageMods().enemySpeed, 1)),
          bulletSpeed: nn(es.bulletSpeed, nn(def.bulletSpeed, -12) * nn(this.getStageMods().bulletSpeed, 1) * nn(this.ENEMY_BULLET_SPEED_MUL, 1))
        });
      }

      // bullets
      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssSafeDelete(this.enemyBullets[i].sprite);
      this.enemyBullets = [];
      for (i = 0; i < snap.bullets.length; i++) {
        var bs = snap.bullets[i];
        var rect = new Rectangle({ x: bs.x, y: bs.y, width: this.ENEMY_BULLET_W, height: this.ENEMY_BULLET_H, color: "red" });
        this.enemyBullets.push({ sprite: rect, vx: nn(bs.vx, -10) });
      }

      this.updateHUD();
    },

    // ---------------------------- helpers -----------------------------------
    makeStarLayer: function (imageUrl, speed, y) {
      var W = (maxX - minX);
      var H = (maxY - minY);

      var left = new Image({ url: imageUrl, width: W, height: H, x: minX + W / 2,           y: y, layer: 10 });
      var right= new Image({ url: imageUrl, width: W, height: H, x: minX + W / 2 + W,       y: y, layer: 10 });
      this.bgTiles.push(left); this.bgTiles.push(right);

      var lastW = W;
      var layerRef = this;

      function step() {
        var w = (maxX - minX), h = (maxY - minY);
        left.width = w; right.width = w; left.height = h; right.height = h;
        if (w !== lastW) { right.x = left.x + w; lastW = w; }

        left.x  -= speed * K;
        right.x -= speed * K;

        if (left.x  <= minX - w / 2)  left.x  += 2 * w;
        if (right.x <= minX - w / 2)  right.x += 2 * w;
      }
      function setSpeed(newSpeed){ speed = newSpeed; }

      return { step: step, setSpeed: setSpeed, left: left, right: right };
    },

    getStageIndex: function () {
      var idx = (this.stage - 1) | 0;
      if (idx < 0) idx = 0;
      if (idx >= this.STAGE_MODS.length) idx = this.STAGE_MODS.length - 1;
      return idx;
    },
    getStageMods: function () {
      return this.STAGE_MODS[this.getStageIndex()];
    },
    getStageGoal: function () {
      return this.STAGE_GOALS[this.getStageIndex()];
    },
    findEnemyDef: function (name) {
      var i;
      for (i = 0; i < ENEMY_DEFS.length; i++) if (ENEMY_DEFS[i].name === name) return ENEMY_DEFS[i];
      return null;
    },
    updateHUD: function () {
      if (!this.hudLeft || !this.hudCenter) return;
      this.hudLeft.text   = "Stage " + this.stage + " of " + this.MAX_STAGES +
                            " | Goal: " + this.getStageGoal() + "pts\nDistance: " + this.distance + " light years";
      this.hudCenter.text = "Score: " + this.score;
    },

    // ---------------------------- title/init --------------------------------
    initGame: function (mode) {
      var i;

      this.gameActive = false;

      // clear enemies & bullets
      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssSafeDelete(this.enemies[i].sprite);
      this.enemies = [];
      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssSafeDelete(this.enemyBullets[i].sprite);
      this.enemyBullets = [];

      // clear lasers
      for (i = this.lasers.length - 1; i >= 0; i--) if (this.lasers[i] && this.lasers[i].sprite) ssSafeDelete(this.lasers[i].sprite);
      this.lasers = [];

      // reset ship
      this.returnHome = false;
      this.ship.x = this.HOME.x; this.ship.y = this.HOME.y;
      this.setShipBoost("idle");

      // HUD/lives reset visuals
      if (this.livesIcons) { for (i = 0; i < this.livesIcons.length; i++) ssSafeDelete(this.livesIcons[i]); }
      this.livesIcons = [];
      this.hudLeft.text = ""; this.hudCenter.text = "";

      // clear old title sprites
      for (i = 0; i < this.titleSprites.length; i++) ssSafeDelete(this.titleSprites[i]);
      this.titleSprites = [];

      // title overlay
      var titleText = (mode === "gameover") ? "GAME OVER" : "SPACE RUNNER";
      var subText   = "A game by Finzi Fin";

      var titleLabel = new Text({ text: titleText, size: 48, x: 0, y: maxY - 50, layer: 500, color: "white", fontFamily: "poppins", textAlign: "center" });
      var infoLabel  = new Text({
        text: "Controls:\n← → ↑ ↓ to move\nSPACE or F to fire\n\nGoal:\nScore points, survive waves,\nreach the Stage Goal to advance.",
        size: 22, x: 0, y: maxY - 200, layer: 500, color: "white", fontFamily: "poppins", textAlign: "center"
      });
      var bylineLabel = new Text({ text: subText, size: 20, x: 0, y: minY + 80, layer: 500, color: rgb(180, 50, 140), fontFamily: "poppins", textAlign: "center" });
      this.titlePrompt = new Text({ text: "Press ENTER to start", size: 24, x: 0, y: minY + 120, layer: 1000, color: "white", fontFamily: "poppins", textAlign: "center" });

      this.titleSprites.push(titleLabel, infoLabel, bylineLabel, this.titlePrompt);

      this.waitingForStart = true;
      this.blinkTimer = 0;
    },

    maybeStartOnEnter: function () {
      if (!this.waitingForStart) return;
      var enterDown = keysDown.includes("ENTER") || keysDown.includes("RETURN");
      if (enterDown && !this.enterPrev) {
        // clear title
        var i;
        for (i = 0; i < this.titleSprites.length; i++) ssSafeDelete(this.titleSprites[i]);
        this.titleSprites = [];
        this.titlePrompt = null;
        this.waitingForStart = false;
        this.startNewGame();
      }
      this.enterPrev = enterDown;
    },

    // ---------------------------- lives/score/stage -------------------------
    rebuildLivesIcons: function (count) {
      var i;
      for (i = 0; i < this.livesIcons.length; i++) ssSafeDelete(this.livesIcons[i]);
      this.livesIcons = [];
      for (i = 0; i < count; i++) {
        var icon = new Image({ url: LIVES_URL, height: 20, width: 40, x: 0, y: 0, layer: 220 });
        icon.turnLeft(90);
        this.livesIcons.push(icon);
      }
      this.positionLivesIcons();
    },
    positionLivesIcons: function () {
      var LIFE_H = 20, LIFE_W = 40, LIFE_GAP = 5, LIFE_MARGIN = 30;
      var startX = maxX - LIFE_MARGIN - (LIFE_W / 2);
      var i;
      for (i = 0; i < this.livesIcons.length; i++) {
        var icon = this.livesIcons[i];
        icon.y = maxY - 25;
        icon.x = startX - i * (LIFE_H + LIFE_GAP);
      }
    },
    startNewGame: function () {
      this.lives = LIVES_MAX;
      this.score = 0;
      this.distance = 0;
      this.stage = 1;
      this.rebuildLivesIcons(this.lives);
      this.updateHUD();
      this.startStage(1);
      this.ship.brightness = 100;
    },
    endStage: function () {
      this.gameActive = false;
      var i;
      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssSafeDelete(this.enemies[i].sprite);
      this.enemies = [];
      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssSafeDelete(this.enemyBullets[i].sprite);
      this.enemyBullets = [];
      this.returnHome = true;
      this.setShipBoost("idle");
    },
    startStage: function (n) {
      this.queueBanner("Stage " + n, 2);
      var self = this;
      this.onDone = function () {
        if (self.stage < self.MAX_STAGES) {
          self.stage = n;
          self.gameActive = true;
          self.spawnCooldown = 0;
          self.updateHUD();
        }
      };
    },
    nextStage: function () {
      this.endStage();
      if (this.stage < this.MAX_STAGES) {
        if (this.stage !== 0) this.queueBanner("Stage " + this.stage + " complete!", 1);
      } else {
        this.queueBanner("GAME OVER - YOU WIN!!", 5);
      }
      var self = this;
      this.onDone = function () {
        if (self.stage < self.MAX_STAGES) self.startStage(self.stage + 1);
      };
    },
    addScore: function (amt) {
      this.score += amt;
      this.updateHUD();
      if (this.score >= this.getStageGoal()) this.nextStage();
    },
    subtractScore: function (amt) {
      this.score -= amt;
      if (this.score < 0) {
        this.score = 0;
        this.killPlayer("No points left to lose\nYou lost a life instead!");
      }
      this.updateHUD();
    },
    killPlayer: function (msg) {
      if (!this.gameActive) return;
      if (this.lives > 0) {
        this.lives -= 1;
        // remove rightmost life icon
        if (this.livesIcons.length > 0) {
          var icon = this.livesIcons[this.livesIcons.length - 1];
          this.livesIcons.pop();
          ssSafeDelete(icon);
        }
      }
      this.updateHUD();
      if (this.lives === 0) { this.endGameLose(); return; }
      this.endStage();
      this.playerHit(msg);
    },
    gainLife: function () {
      if (this.lives >= LIVES_MAX) return;
      this.lives += 1;
      // add a new rightmost icon
      var icon = new Image({ url: LIVES_URL, height: 20, width: 40, x: 0, y: 0, layer: 220 });
      icon.turnLeft(90);
      this.livesIcons.push(icon);
      this.positionLivesIcons();
      this.updateHUD();
    },
    endGameLose: function () {
      this.gameActive = false;
      var i;
      for (i = 0; i < this.enemies.length; i++) if (this.enemies[i] && this.enemies[i].sprite) ssSafeDelete(this.enemies[i].sprite);
      this.enemies = [];
      for (i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i] && this.enemyBullets[i].sprite) ssSafeDelete(this.enemyBullets[i].sprite);
      this.enemyBullets = [];
      this.queueBanner("GAME OVER — YOU LOSE", 4);
      var self = this;
      this.returnHome = true;
      this.setShipBoost("idle");
      this.onDone = function () { self.initGame("gameover"); };
    },
    playerHit: function (message) {
      this.queueBanner(message || "You got hit", 2);
      var self = this;
      this.onDone = function () { self.startStage(self.stage); };
    },

    // ---------------------------- banners -----------------------------------
    _bannerQueue: [],
    _bannerActive: false,
    queueBanner: function (msg, seconds) {
      this._bannerQueue.push({ msg: msg, seconds: nn(seconds, 5) });
      if (!this._bannerActive) this._runBannerQueue();
    },
    _runBannerQueue: function () {
      var self = this;
      if (this._bannerQueue.length === 0) {
        this._bannerActive = false;
        if (this.onDone) { var cb = this.onDone; this.onDone = null; cb(); }
        return;
      }
      this._bannerActive = true;
      if (!this.banner) this.banner = new Text({ text: "", size: 36, color: "white", x: 0, y: 100, layer: 600 });
      var item = this._bannerQueue.shift();
      this.banner.text = item.msg;
      // emulate timed hide using an internal timer in tick:
      this._bannerTimer = nn(this._bannerTimer, 0) + item.seconds;
      this._bannerShowingFor = item.seconds; // marker
    },

    // ---------------------------- ship & input ------------------------------
    _shipState: "idle",
    setShipBoost: function (next) {
      if (next !== this._shipState) {
        this._shipState = next;
        this.ship.url = SHIP_URLS[next];
      }
    },
    setShipState: function () {
      if (!this.gameActive) return;
      var rightHeld = keysDown.includes("RIGHT");
      var leftHeld  = keysDown.includes("LEFT");
      var upHeld    = keysDown.includes("UP");
      var downHeld  = keysDown.includes("DOWN");

      var axisX = (rightHeld ? 1 : 0) - (leftHeld ? 1 : 0);
      var axisY = (upHeld    ? 1 : 0) - (downHeld ? 1 : 0);

      var velX = axisX * this.shipSpeed;
      if (axisX < 0) velX -= this.driftSpeed;

      this.ship.x += velX * K;
      this.ship.y += (axisY * this.shipSpeed) * K;

      if (this.gameActive && axisX === 0 && this.ship.x > minX + this.ship.width / 2) {
        this.ship.x -= this.idleDrift * K;
      }

      if (axisX > 0)      this.setShipBoost("forward");
      else if (axisX < 0) this.setShipBoost("back");
      else                this.setShipBoost("idle");

      var worldWidth = maxX - minX;
      var leftLimit  = minX + this.ship.width / 2;
      var rightLimit = maxX - 0.15 * worldWidth - this.ship.width / 2;
      this.ship.x = Math.max(leftLimit, Math.min(rightLimit, this.ship.x));

      var bottomLimit = minY + this.ship.height / 2;
      var topLimit    = maxY - 50 - this.ship.height / 2;
      this.ship.y = Math.max(bottomLimit, Math.min(topLimit, this.ship.y));
    },
    returnToHome: function () {
      if (!this.gameActive && this.returnHome) {
        var dxh = this.HOME.x - this.ship.x;
        var dyh = this.HOME.y - this.ship.y;
        var d2  = dxh*dxh + dyh*dyh;
        if (d2 <= 1) {
          this.ship.x = this.HOME.x;
          this.ship.y = this.HOME.y;
          this.returnHome = false;
        } else {
          var d = Math.sqrt(d2);
          var step = Math.min(this.returnSpeed * K, d);
          this.ship.x += (dxh / d) * step;
          this.ship.y += (dyh / d) * step;
        }
      }
    },

    // ---------------------------- lasers ------------------------------------
    prevFire: false,
    fireLaser: function () {
      if (this.lasers.length >= this.MAX_LASERS) return;
      var startX = this.ship.x + this.ship.width / 2 + this.MUZZLE_XOFF;
      var startY = this.ship.y + this.MUZZLE_YOFF;
      var sprite = new Image({ url: LASER_URL, x: startX, y: startY, height: this.LASER_H, layer: this.LASER_LAYER });
      this.lasers.push({ sprite: sprite });
    },
    handleFireInput: function () {
      var fireHeld = keysDown.includes("SPACE") || keysDown.includes("f");
      if (this.gameActive && fireHeld && !this.prevFire) this.fireLaser();
      this.prevFire = fireHeld;
    },
    updateLasers: function () {
      var i;
      for (i = this.lasers.length - 1; i >= 0; i--) {
        var entry = this.lasers[i]; if (!entry || !entry.sprite) { this.lasers.splice(i,1); continue; }
        var s = entry.sprite;
        s.x += this.LASER_SPEED * K;
        if (typeof s.width !== "number" || (s.x - s.width / 2 > maxX)) {
          ssSafeDelete(s);
          this.lasers.splice(i,1);
        }
      }
    },

    // ---------------------------- enemies -----------------------------------
    isEnemyAllowedInStage: function (def, stage) {
      if (!def) return false;
      if (!def.stages || def.stages.length === 0) return true;
      var i; for (i = 0; i < def.stages.length; i++) if (def.stages[i] === stage) return true;
      return false;
    },
    getEnemyDefsForCurrentStage: function () {
      var allowed = [], i;
      for (i = 0; i < ENEMY_DEFS.length; i++) if (this.isEnemyAllowedInStage(ENEMY_DEFS[i], this.stage)) allowed.push(ENEMY_DEFS[i]);
      return (allowed.length > 0) ? allowed : ENEMY_DEFS;
    },
    pick: function (arr) {
      return arr[(Math.random() * arr.length) | 0];
    },
    spawnEnemy: function (enemyDef) {
      if (!enemyDef) enemyDef = this.pick(this.getEnemyDefsForCurrentStage());
      var spawnY = random(minY + 20, maxY - 60);
      var sprite = new Image({ url: enemyDef.url, x: maxX + 40, y: spawnY, height: nn(enemyDef.h, 56) });

      var mods = this.getStageMods();
      var moveSpeedEff    = nn(enemyDef.speed, 1) * nn(mods.enemySpeed, 1);
      var bulletSpeedEff  = nn(enemyDef.bulletSpeed, -3) * nn(mods.bulletSpeed, 1) * nn(this.ENEMY_BULLET_SPEED_MUL, 1);
      var fireIntervalEff = nn(enemyDef.fireInterval, 10) / (nn(mods.bulletRate, 1) * nn(this.ENEMY_FIRE_RATE_MUL, 1));

      this.enemies.push({
        sprite: sprite,
        def: enemyDef,
        hp: nn(enemyDef.strength, 1),
        t: 0,
        baseY: spawnY,
        fireTimer: fireIntervalEff,
        fireInterval: fireIntervalEff,
        moveSpeed: moveSpeedEff,
        bulletSpeed: bulletSpeedEff
      });
    },
    updateEnemySpawning: function () {
      if (!this.gameActive) return;
      var mods = this.getStageMods();
      var effectiveInterval = this.ENEMY_SPAWN_EVERY / Math.max(0.0001, nn(mods.spawnRate, 1));
      this.spawnCooldown -= DT;
      if (this.spawnCooldown <= 0) {
        var mul = Math.max(1, nn(mods.num, 1));
        var count = Math.floor(mul);
        var frac = mul - count;
        if (Math.random() < frac) count += 1;
        var i; for (i = 0; i < count; i++) this.spawnEnemy();
        this.spawnCooldown = effectiveInterval;
      }
    },
    fireEnemyBullet: function (enemy) {
      var bulletRect = new Rectangle({
        x: enemy.sprite.x - enemy.sprite.width / 2 - 6,
        y: enemy.sprite.y,
        width: this.ENEMY_BULLET_W,
        height: this.ENEMY_BULLET_H,
        color: "red"
      });
      var vx = nn(enemy.bulletSpeed, nn(enemy.def.bulletSpeed, -10));
      this.enemyBullets.push({ sprite: bulletRect, vx: vx });
    },
    killEnemy: function (idx) {
      var e = this.enemies[idx];
      this.addScore(nn(e.def.points, 100));
      if (e.def.explosionUrl) {
        var boom = new Image({ url: e.def.explosionUrl, x: e.sprite.x, y: e.sprite.y, height: nn(e.def.h,56)*1.2 });
        setTimeout(function(){ ssSafeDelete(boom); }, 300);
      }
      ssSafeDelete(e.sprite);
      this.spawnCooldown = (this.spawnCooldown > 0) ? (this.spawnCooldown / 2.5) : 0;
      this.enemies.splice(idx, 1);
    },
    updateEnemies: function () {
      if (!this.gameActive) return;
      var i, j;

      for (i = this.enemies.length - 1; i >= 0; i--) {
        var e = this.enemies[i];
        if (!e || !e.sprite) { this.enemies.splice(i,1); continue; }

        e.t = nn(e.t, 0) + DT;

        var fallbackSpeed = (e.def && typeof e.def.speed === "number") ? e.def.speed : 0;
        var speedEff = nn(e.moveSpeed, fallbackSpeed) * K;
        e.sprite.x -= speedEff;

        var pattern = e.def ? e.def.pattern : null;
        if (pattern === "sine") {
          var amp  = nn(e.def.amp, 40), freq = nn(e.def.freq, 1);
          e.sprite.y = e.baseY + Math.sin(e.t * 2 * Math.PI * freq) * amp;
        } else if (pattern === "zigzag") {
          var T = nn(e.def.period, 0.8), A = nn(e.def.amp, 80);
          var phase = (T !== 0) ? ((e.t % T) / T) : 0;
          var tri = phase < 0.5 ? (phase * 2) : (2 - phase * 2);
          e.sprite.y = e.baseY + (tri * 2 - 1) * A;
        } else if (pattern === "driftDown") {
          e.sprite.y += nn(e.def.vy, 0.5) * K;
        } else if (pattern === "driftUp") {
          e.sprite.y -= nn(e.def.vy, 0.5) * K;
        }

        var bottom = minY + 20, top = maxY - 50;
        e.sprite.y = Math.max(bottom, Math.min(top, e.sprite.y));

        e.fireTimer = nn(e.fireTimer, e.fireInterval) - DT;
        if (e.fireTimer <= 0) { this.fireEnemyBullet(e); e.fireTimer = e.fireInterval; }

        if (typeof e.sprite.width !== "number" || (e.sprite.x + e.sprite.width / 2 < minX)) {
          if (e.sprite) ssSafeDelete(e.sprite);
          if (e.def && typeof e.def.points === "number") { this.subtractScore(e.def.points); }
          this.enemies.splice(i,1);
        }
      }

      // collisions: lasers vs enemies
      for (i = this.enemies.length - 1; i >= 0; i--) {
        var t = this.enemies[i];
        if (!t || !t.sprite) { this.enemies.splice(i,1); continue; }
        for (j = this.lasers.length - 1; j >= 0; j--) {
          var L = this.lasers[j]; if (!L || !L.sprite) { this.lasers.splice(j,1); continue; }
          if (aabbOverlap(t.sprite, L.sprite)) {
            ssSafeDelete(L.sprite); this.lasers.splice(j,1);
            t.hp = nn(t.hp, 1) - 1;
            if (t.hp <= 0) { this.killEnemy(i); break; }
          }
        }
      }
    },

    updateEnemyBullets: function () {
      if (!this.gameActive) return;
      var i;
      for (i = this.enemyBullets.length - 1; i >= 0; i--) {
        var b = this.enemyBullets[i];
        if (!b || !b.sprite) { this.enemyBullets.splice(i,1); continue; }
        var s = b.sprite;
        s.x += b.vx * K;

        if (aabbOverlap(s, this.ship)) {
          ssSafeDelete(s);
          this.enemyBullets.splice(i,1);
          this.killPlayer();
          if (!this.gameActive || this.enemyBullets.length === 0) return;
          continue;
        }
        if (typeof s.width !== "number" || (s.x + s.width / 2 < minX)) {
          ssSafeDelete(s);
          this.enemyBullets.splice(i,1);
        }
      }
    },

    // ---------------------------- tick --------------------------------------
    tick: function (dt) {
      if (!this.ready) return;
      if (keysDown.includes('K')) Game.switchTo('world', { soft:true });

      // parallax
      var i;
      for (i = 0; i < this.layers.length; i++) this.layers[i].step();

      // title prompt blink (0.6s toggle)
      if (this.waitingForStart && this.titlePrompt) {
        this.blinkTimer += dt;
        if (this.blinkTimer >= 0.6) {
          this.blinkTimer = 0;
          this.titlePrompt.text = (this.titlePrompt.text ? "" : "Press ENTER to start");
        }
      }

      // maybe start
      this.maybeStartOnEnter();

      // ship & movement
      this.setShipState();
      this.returnToHome();

      // distance ticker (every 5s)
      if (this.gameActive) {
        this.distTimer += dt;
        if (this.distTimer >= 5) {
          this.distTimer -= 5;
          this.distance += 1;
          this.updateHUD();
        }
      }

      // gameplay updates
      this.handleFireInput();
      this.updateEnemySpawning();
      this.updateLasers();
      this.updateEnemies();
      this.updateEnemyBullets();

      // banner timer (simulate "after(seconds)")
      if (this._bannerActive && this._bannerShowingFor != null) {
        this._bannerShowingFor -= dt;
        if (this._bannerShowingFor <= 0) {
          if (this.banner) this.banner.text = "";
          this._bannerShowingFor = null;
          this._runBannerQueue();
        }
      }

      // keep HUD/lives aligned to edges if resized
      this.positionLivesIcons();
    }
  };

  // expose some functions used internally but not outside
  return api;
})();
// == /SideShooter ==========================================================================

// Example wiring (somewhere in your setup):
// Game.register('sideShooter', SideShooterMode);
// Game.switchTo('sideShooter'); // to enter the mini-game

// === ChatMode ================================================================

// ===== Dialogue Engine ======================================================
var DIALOG_FLAGS = {};  // global flags you can gate content on

function attachDialogue(walker, def) {
  if (!walker) return;
  var d = def || {};
  walker.dialogue = {
    topics:  d.topics  || [],     // array of { id, text, when(ctx), responses:[...] }
    onEnter: d.onEnter || null,   // optional(ctx)
    onExit:  d.onExit  || null,   // optional(ctx)
    flags:   {},                  // per-NPC flags
    name:    walker.__name || "(npc)"
  };
}

function dialogCtx(npc) {
  return {
    game: Game,
    world: WorldMode,
    npc: npc,
    player: (typeof finGuy !== "undefined" ? finGuy : null),
    global: DIALOG_FLAGS,                  // shared flags
    npcFlags: (npc && npc.dialogue) ? npc.dialogue.flags : {},
    isInParty: function (w) { return isWalkerInParty(w || npc); },
    setFlag: function (k, v) { DIALOG_FLAGS[k] = v; },
    setNPCFlag: function (k, v) { if (npc && npc.dialogue) npc.dialogue.flags[k] = v; }
  };
}

function _topicVisible(topic, ctx) { return !topic.when || !!topic.when(ctx); }
function _respAllowed(resp, ctx)   { return !resp.when  || !!resp.when(ctx); }

function _pickResponse(resps, ctx) {
  if (!resps || !resps.length) return null;
  var i; for (i = 0; i < resps.length; i++) if (_respAllowed(resps[i], ctx)) return resps[i];
  return null;
}

function setSnapshotCharMode(name, mode) {
  var snap = Game.getSnapshot && Game.getSnapshot('world');
  if (snap && snap.chars && snap.chars[name]) {
    snap.chars[name].mode = mode;
  }
}

// helpers your callbacks can use
function npcJoinParty(w) {
  if (!w) return;
  var leader = getLeaderWalker() || finGuy;
  var opts = (w._home && w._home.followOpts) ? w._home.followOpts : { stopRange:[60, 90], jitterRadius:12, repathEvery:12, speedScale:0.7, hysteresis:2 };
  w.followSprite(leader, opts);
  updatePartyStageIndex(CURRENT_STAGE);
  if (w.sprite) w.sprite.canChat = false; // party members no longer show as chat targets
  // make the saved world snapshot agree, so returning from chat won't revert it
  setSnapshotCharMode(w.__name, "follow");
  console.log("follow?", w.__name, w.state.mode, "targetIsWalker=", !!(w.state.follow.target && w.state.follow.target.state));
}

function npcLeaveParty(w) {
  if (!w) return;
  var bounds  = (w._home && w._home.bounds)   ? w._home.bounds   : (w.state && w.state.npc ? w.state.npc.bounds : null);
  var npcOpts = (w._home && w._home.npcOpts)  ? w._home.npcOpts  : null;
  var si      = (w._home && w._home.stageIndex != null) ? w._home.stageIndex : CURRENT_STAGE;

  w.wanderWithin(bounds, npcOpts || {});
  if (w.state && w.state.npc) w.state.npc.stageIndex = si;
  if (w.sprite) w.sprite.canChat = true;
  setSnapshotCharMode(w.__name, "npc");
  syncNPCVisibilityToStage();
}

function getDisplayName(w){
  if (!w) return "(unknown)";
  return (w.label || w.displayName || w.name || w.__name || "(unknown)");
}

// === ChatMode (dialogue) ====================================================
// Inventory render constants
var INV_ICON   = 52;                // icon size (width/height)
var INV_LINE_W = 2;                 // white line thickness (2–3 looks good)
var INV_BG_COL = rgb(120,120,120);  // grey background for grid area

var ChatMode = {
  id: "chat",
  __inited: false,
  ready: false,

  partner: null,
  partnerName: "(unknown)",

  // UI sprites we own/manage
  _ownedSprites: [],
  background: null,
  inner: null,
  nameText: null,
  promptText: null,
  portrait: null,
  logText: null,
  optionTexts: [],

  // dialogue state
  _ctx: null,
  _visibleTopics: [],
  _selected: 0,
  _logLines: [],
  
    // right-column inventory UI
  invTitle: null,
  invSprites: [],          // icons + count badges
  _lastInvSig: null,       // to detect changes

  // key edge-detection
  _prevUp: false, _prevDown: false, _prevEnter: false,
  _prevNums: {},

  _dims: function () {
    var screenWidth  = 2 * maxX;
    var screenHeight = 2 * maxY;

    var backgroundWidth  = screenWidth  - (screenWidth  / 5);
    var backgroundHeight = screenHeight - (screenHeight / 3);
    var innerWidth  = backgroundWidth  - 20;
    var innerHeight = backgroundHeight - 20;

    // columns: ~60% left (chat), 40% right (inventory)
    var gutter = 20;
    var leftWidth  = Math.floor(innerWidth * 0.58);
    var rightWidth = innerWidth - leftWidth - gutter;
    if (rightWidth < 160) { rightWidth = 160; leftWidth = innerWidth - rightWidth - gutter; }

    return {
      backgroundWidth:  backgroundWidth,
      backgroundHeight: backgroundHeight,
      innerWidth:       innerWidth,
      innerHeight:      innerHeight,
      leftWidth:        leftWidth,
      rightWidth:       rightWidth,
      gutter:           gutter
    };
  },

  _buildUI: function () {
    setBackdropColor("black");
    var d = this._dims();

    var background = new Rectangle();
    background.x = 0; background.y = 0;
    background.width = d.backgroundWidth; background.height = d.backgroundHeight;
    background.color = "rgb(209, 198, 136)";

    var inner = new Rectangle();
    inner.x = 0; inner.y = 0;
    inner.width = d.innerWidth; inner.height = d.innerHeight;

    var nameText = new Text({
      text: "Talking to …", size: 28, x: 0, y: maxY - 60, layer: 1000,
      color: "red", fontFamily: "poppins", textAlign: "center"
    });

    var promptText = new Text({
      text: "Press K to close", size: 20, x: 0, y: minY + 40, layer: 1000,
      color: "pink", fontFamily: "poppins", textAlign: "center"
    });

    var portrait = new Image({ x: 0, y: 0, height: 72, layer: 1001 });

    // NEW: chat log (multi-line) on the left column
    var logText = new Text({
      text: "",
      size: 18,
      x: 0, y: 0, layer: 1001,
      color: rgb(250, 245, 220), fontFamily: "poppins", textAlign: "left"
    });

    var invTitle = new Text({
      text: "School bag contents", size: 22, x: 0, y: 0, layer: 1001,
      color: "yellow", fontFamily: "poppins", textAlign: "center"
    });

    this.background = background;
    this.inner = inner;
    this.nameText = nameText;
    this.promptText = promptText;
    this.portrait = portrait;
    this.logText = logText;         // <-- remember it
    this.invTitle = invTitle;

    this._ownedSprites.push(background, inner, nameText, promptText, portrait, logText, invTitle);
    this._relayout();
  },



  _relayout: function () {
    if (!this.background || !this.inner || !this.nameText || !this.promptText) return;
    var d = this._dims();

    this.background.width  = d.backgroundWidth;
    this.background.height = d.backgroundHeight;
    this.inner.width  = d.innerWidth;
    this.inner.height = d.innerHeight;

    this.nameText.y   = maxY - 60;
    this.promptText.y = minY + 40;

    var L = this._leftColumnRect();

    var pw = this.portrait ? (this.portrait.width  || 0) : 0;
    var ph = this.portrait ? (this.portrait.height || 0) : 0;

    // left-align inside the column; keep ~60px top margin;
    // (remember sprites are positioned by center)
    this.portrait.x = L.left + 12 + pw / 2;
    this.portrait.y = L.top  - 10 - ph / 2;

    // Chat log under the portrait, left-aligned
    if (this.logText) {
      this.logText.x = L.left + 12;
      this.logText.y = L.top  - 120;
      this.logText.textAlign = "left";
    }

    // Right column anchors (from inner, not maxY)
    var rightLeft  = L.right + d.gutter;
    var rightRight = this.inner.width / 2;

    if (this.invTitle) {
      this.invTitle.x = rightLeft + 8;
      this.invTitle.y = L.top - 60;
      this.invTitle.textAlign = "left";
    }

    // Rebuild inventory grid with new geometry
    this._refreshInventory();
    // Reposition options (they live in left column)
    this._layoutOptions();
    this._repositionLog();
  },

  
  _leftColumnRect: function () {
    var d = this._dims();
    var left   = -this.inner.width / 2;
    var right  = left + d.leftWidth;
    var top    =  this.inner.height / 2;
    var bottom = -this.inner.height / 2;
    return { left:left, right:right, top:top, bottom:bottom, width:(right-left), height:(top-bottom) };
  },

  _layoutOptions: function () {
    var L = this._leftColumnRect();
    var startX = L.left + 12;
    var startY = L.bottom + 90;     // a bit above the bottom of the left column
    var step   = 26;

    for (var i = 0; i < this.optionTexts.length; i++) {
      var t = this.optionTexts[i];
      t.x = startX;
      t.y = startY + i * step;
      t.textAlign = "left";
    }
  },

  _clearOptionTexts: function () {
    var olds = this.optionTexts.slice(0);
    for (var i = 0; i < olds.length; i++) safeDelete(olds[i]);
    // drop them from ownedSprites too
    var set = Object.create(null);
    for (var j = 0; j < olds.length; j++) set[olds[j].__id || olds[j]] = true;
    this._ownedSprites = this._ownedSprites.filter(function(s){ return olds.indexOf(s) === -1; });
    this.optionTexts = [];
  },

  _pushLog: function (speaker, line) {
    if (!this.logText) return;

    // --- wrap the new text into logical lines (same as before) ---
    var L = this._leftColumnRect();
    var usable = Math.max(80, L.width - 24);           // rough text width
    var maxChars = Math.max(20, Math.floor(usable / 10));
    var text = (speaker ? (speaker + ": " + line) : String(line));
    var words = String(text).split(" ");
    var cur = "";
    this._logLines = this._logLines || [];

    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if ((cur + (cur ? " " : "") + w).length > maxChars) {
        this._logLines.push(cur);
        cur = w;
      } else {
        cur = (cur ? (cur + " " + w) : w);
      }
    }
    if (cur) this._logLines.push(cur);

    // --- compute how many lines can fit, given our bottom-anchored region ---
    var R = this._getLogRegion();
    var step = this._lineStep();
    var maxDisplayedLines = Math.max(1, Math.floor(R.height / step));

    // we render with "\n\n", which adds a blank line between entries:
    // displayedLines = 2*N - 1  =>  N <= floor((maxDisplayedLines + 1) / 2)
    var allowN = Math.max(1, Math.floor((maxDisplayedLines + 1) / 2));
    while (this._logLines.length > allowN) this._logLines.shift();

    // --- build the single Text with an empty line between entries ---
    var out = this._logLines.join("\n\n");
    this.logText.text = out;

    // --- bottom-align the block so it never creeps upward ---
    this._repositionLog();
  },

  
  // tuneable gap between lines (in px)
  logLineGap: 6,

  _getLogRegion: function () {
    var L = this._leftColumnRect();
    var topY = L.top - 120;                 // under the portrait
    var optionsTopY = this._computeOptionsTopY();
    var bottomY = optionsTopY + 8;          // small gap above options
    return {
      leftX: L.left + 12,
      topY: topY,
      bottomY: bottomY,
      height: (topY - bottomY)
    };
  },
  _lineStep: function () {
    var sz = (this.logText && this.logText.size) ? this.logText.size : 18;
    return sz + this.logLineGap; // simple estimate
  },
  _repositionLog: function () {
    if (!this.logText) return;
    var R = this._getLogRegion();
    var step = this._lineStep();
    var out = this.logText.text || "";
    var totalLines = out ? out.split("\n").length : 1;
    var h = Math.max(step, totalLines * step);

    // bottom-align: center of block sits half a block above bottom
    this.logText.x = R.leftX;
    this.logText.y = R.bottomY + h / 2;
    this.logText.textAlign = "left";
  },
  _setOptionsFromTopics: function (topics) {
    this._clearOptionTexts();
    var i;
    for (i = 0; i < topics.length; i++) {
      var label = "> " + topics[i].text;
      var t = new Text({
        text: label,
        size: 22,
        x: 0, y: 0, layer: 1001,
        color: "white", fontFamily: "poppins", textAlign: "left"
      });
      this.optionTexts.push(t);
      this._ownedSprites.push(t);
    }
    this._layoutOptions();
    this._highlightSelection();
    this._repositionLog();  
  },

  _highlightSelection: function () {
    var i;
    for (i = 0; i < this.optionTexts.length; i++) {
      var t = this.optionTexts[i];
      t.color = (i === this._selected) ? "green" : "gray";
      t.size = (i === this._selected) ? 25 : 22;
    }
  },

  _refreshVisibleTopics: function () {
    this._ctx = dialogCtx(this.partner);
    var src = (this.partner && this.partner.dialogue && this.partner.dialogue.topics) ? this.partner.dialogue.topics : [];
    var vis = [];
    var i;
    for (i = 0; i < src.length; i++) if (_topicVisible(src[i], this._ctx)) vis.push(src[i]);
    this._visibleTopics = vis;
    if (this._selected >= vis.length) this._selected = vis.length - 1;
    if (this._selected < 0) this._selected = 0;
    this._setOptionsFromTopics(vis);
  },

  _applyResponse: function (topic, resp) {
    var who = this.partnerName;
    if (topic && topic.text) this._pushLog("You", topic.text);
    if (resp && resp.text)   this._pushLog(who, resp.text);

    // run callback if present
    try {
      if (resp && typeof resp.do === "function") resp.do(this._ctx);
    } catch (e) {
      this._pushLog("(system)", "Callback error: " + e);
    }

    // go to next node if specified, else simply refresh (conditions may change)
    if (resp && resp.next && typeof resp.next === "function") {
      // if you want to push a new temporary topic set, you can do it here
      // (keeping it simple: just refresh based on updated flags)
    }

    // close if requested
    if (resp && resp.close === true) {
      Game.switchTo('world', { soft:true });
      return;
    }

    // refresh list (conditions may hide/show items after callback)
    this._refreshVisibleTopics();
  },

  // called by WorldMode when swapping in: partner can be in opts
  setPartner: function (walkerOrNull) {
    this.partner = walkerOrNull || null;
    this.partnerName = getDisplayName(this.partner);

    if (this.nameText) this.nameText.text = "Talking to " + this.partnerName;

    if (this.portrait) {
      var url = null;
      if (this.partner && this.partner.urls && this.partner.urls.front && this.partner.urls.front[0]) {
        url = this.partner.urls.front[0];
      }
      if (url) {
        this.portrait.url = url;
        // size from walker sprite ×5 (fallbacks if missing)
        var sw = (this.partner && this.partner.sprite && this.partner.sprite.width)  ? this.partner.sprite.width  : 40;
        var sh = (this.partner && this.partner.sprite && this.partner.sprite.height) ? this.partner.sprite.height : 60;

        this.portrait.width  = sw * 5;
        this.portrait.height = sh * 5;
        showSprite(this.portrait);
      } else {
        hideSprite(this.portrait);
      }
    }

    this._lastInvSig = null;   // force rebuild
    this._refreshInventory();
  },

  _beginDialogue: function () {
    // default dialogue if none attached
    if (!this.partner.dialogue) {
      attachDialogue(this.partner, {
        topics: [
          { id: "fallback", text: "Hi.", responses: [{ text: "Hey.", do: function(){} }] },
          { id: "bye", text: "Goodbye.", responses: [{ text: "See you.", do: function(){}, close:true }] }
        ]
      });
    }
    // enter hook
    var ctx = dialogCtx(this.partner);
    if (this.partner.dialogue.onEnter) {
      try { this.partner.dialogue.onEnter(ctx); } catch(e) {}
    }
    this._logLines = [];
    if (this.logText) this.logText.text = "";
    this._repositionLog();
    this._refreshVisibleTopics();
  },
  
  _computeOptionsTopY: function () {
    // Y of the *top edge* of the options block (highest option + half its height)
    var L = this._leftColumnRect();
    if (!this.optionTexts || this.optionTexts.length === 0) {
      // fallback if there are no options yet
      return L.bottom + 90; // same baseline you used for startY
    }
    var topCenterY = -Infinity, topSize = 22;
    for (var i = 0; i < this.optionTexts.length; i++) {
      var t = this.optionTexts[i];
      if (t.y > topCenterY) { topCenterY = t.y; topSize = t.size || 22; }
    }
    return topCenterY + (topSize / 2);
  },

  init: function () {
    this._buildUI();
    this.hide();
    this.__inited = true;
    this.ready = true;

    var self = this;
    this._onResize = function () { self._relayout(); };
    window.addEventListener('resize', this._onResize);
  },

  enter: function (prevId, opts) {
    var partner = (opts && (opts.partner || opts.with || opts.npc || opts.target || opts.chatter)) || null;
    if (!partner && this._savedPartnerName && typeof CHARACTERS === "object") {
      partner = CHARACTERS[this._savedPartnerName] || null;
    }
    this.setPartner(partner);
    this._relayout();
    this._beginDialogue();
  },

  show: function () {
    for (var i=0;i<this._ownedSprites.length;i++) showSprite(this._ownedSprites[i]);
    for (var j=0;j<this.invSprites.length;j++) showSprite(this.invSprites[j]);
  },

  hide: function () {
    for (var i=0;i<this._ownedSprites.length;i++) hideSprite(this._ownedSprites[i]);
    for (var j=0;j<this.invSprites.length;j++) hideSprite(this.invSprites[j]);
  },

  unload: function () {
    this.hide();
    for (var i=0;i<this._ownedSprites.length;i++) safeDelete(this._ownedSprites[i]);
    this._ownedSprites.length = 0;
    this._clearInvSprites();
    this.background = this.inner = this.nameText = this.promptText = this.portrait = this.invTitle = null;
    if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
    this.ready = false; this.__inited = false;
  },

  save: function () {
    return { partnerName: (this.partner && this.partner.__name) ? this.partner.__name : null };
  },

  load: function (snap) {
    this._savedPartnerName = snap && snap.partnerName || null;
  },

  _handleNav: function () {
    var up    = keysDown.includes('UP');
    var down  = keysDown.includes('DOWN');
    var enter = keysDown.includes('ENTER') || keysDown.includes('RETURN');

    if (up && !this._prevUp) {
      this._selected -= 1;
      if (this._selected < 0) this._selected = Math.max(0, this._visibleTopics.length - 1);
      this._highlightSelection();
    }
    if (down && !this._prevDown) {
      this._selected += 1;
      if (this._selected >= this._visibleTopics.length) this._selected = 0;
      this._highlightSelection();
    }

    // number keys 1..9 quick select
    var i;
    for (i = 1; i <= 9; i++) {
      var key = String(i);
      var held = keysDown.includes(key);
      if (held && !this._prevNums[key]) {
        var idx = i - 1;
        if (idx < this._visibleTopics.length) {
          this._selected = idx;
          this._highlightSelection();
          // treat as immediate select
          enter = true;
        }
      }
      this._prevNums[key] = held;
    }

    if (enter && !this._prevEnter && this._visibleTopics.length > 0) {
      var topic = this._visibleTopics[this._selected];
      var resp = _pickResponse(topic.responses || [], this._ctx);
      if (!resp) resp = { text: "(…)", do: function(){} };
      this._applyResponse(topic, resp);
    }

    this._prevUp = up; this._prevDown = down; this._prevEnter = enter;
  },
  
  _clearInvSprites: function () {
    for (var i = 0; i < this.invSprites.length; i++) safeDelete(this.invSprites[i]);
    this.invSprites.length = 0;
  },

  _getItemDef: function (key) {
    if (typeof getItemDef === "function") return getItemDef(key);
    if (typeof ITEM_DEFS === "object" && ITEM_DEFS[key]) return ITEM_DEFS[key];
    return null;
  },

  _readInventoryList: function (w) {
    // Returns [{key, count}] or empty array
    var out = [];
    if (!w) return out;

    // Preferred: w.inv.items is a {key: {count: n}} or {key: n}
    if (w.inv && w.inv.items) {
      for (var k in w.inv.items) {
        var entry = w.inv.items[k];
        var count = (entry && typeof entry.count === "number") ? entry.count :
                    (typeof entry === "number" ? entry : 0);
        if (count > 0) out.push({ key: k, count: count });
      }
      return out;
    }
    // Alternate: w.inventory.items
    if (w.inventory && w.inventory.items) {
      for (var k2 in w.inventory.items) {
        var e2 = w.inventory.items[k2];
        var c2 = (e2 && typeof e2.count === "number") ? e2.count :
                 (typeof e2 === "number" ? e2 : 0);
        if (c2 > 0) out.push({ key: k2, count: c2 });
      }
      return out;
    }
    // Plain map
    if (w.inv) {
      for (var k3 in w.inv) {
        if (k3 === "items") continue;
        var v = w.inv[k3];
        if (typeof v === "number" && v > 0) out.push({ key: k3, count: v });
      }
      return out;
    }
    return out;
  },

  _inventorySignature: function (w) {
    var list = this._readInventoryList(w);
    list.sort(function(a,b){ return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
    var s = "";
    for (var i = 0; i < list.length; i++) { s += list[i].key + ":" + list[i].count + ";"; }
    return s;
  },

  _refreshInventory: function () {
    if (!this.inner || !this.invTitle) return;

    // geometry of columns
    var d = this._dims();
    var L = this._leftColumnRect();                        // left column (chat)
    var rightLeft  = L.right + d.gutter;                   // start of right column
    var rightRight =  this.inner.width / 2;

    var pad = 10;                                          // inset the grid a bit
    var gridLeft = rightLeft + pad;
    var gridRight = rightRight - pad;

    // anchor just under the "Inventory" title
    var invTitleY = this.invTitle ? this.invTitle.y : (L.top - 60);
    var gridTopY  = invTitleY - 30;                        // top edge (world Y)

    // read current items and detect change
    var items = this._readInventoryList(this.partner);
    var sig = this._inventorySignature(this.partner);
    if (sig === this._lastInvSig && this.invSprites.length > 0) return;
    this._lastInvSig = sig;

    // nuke previous grid & icons
    this._clearInvSprites();

    // if no items, still draw a 1x1 grid so the panel is visible
    var count = Math.max(1, (items && items.length) ? items.length : 0);

    // compute columns that fit the width:
    // totalWidth(N) = N*ICON + (N+1)*LINE
    var ICON    = INV_ICON;
    var LINE_W  = INV_LINE_W;
    var availW  = Math.max(ICON + 2*LINE_W, gridRight - gridLeft);
    var cols    = Math.floor((availW - LINE_W) / (ICON + LINE_W));
    if (cols < 1) cols = 1;

    var rows = Math.ceil(count / cols);
    var gridW = cols * ICON + (cols + 1) * LINE_W;
    var gridH = rows * ICON + (rows + 1) * LINE_W;

    // if the computed width is narrower than the column, left align under title
    var gx0 = gridLeft;                // left x
    var gyTop = gridTopY;              // top y

    // background panel (grey)
    var bg = new Rectangle({
      x: gx0 + gridW/2,
      y: gyTop - gridH/2,
      width: gridW,
      height: gridH,
      color: INV_BG_COL,
      layer: 1000
    });
   this.invSprites.push(bg);

    // grid lines (white): outer border + internal dividers
    // verticals
    for (var c = 0; c <= cols; c++) {
      var vx = gx0 + (LINE_W/2) + c * (ICON + LINE_W);
      var vLine = new Rectangle({
        x: vx,
        y: gyTop - gridH/2,
        width: LINE_W,
        height: gridH,
        color: "white",
        layer: 1002
      });
      vLine.sendToFront();
      this.invSprites.push(vLine);
    }
    // horizontals
    for (var r = 0; r <= rows; r++) {
      var hy = gyTop - (LINE_W/2) - r * (ICON + LINE_W);
      var hLine = new Rectangle({
        x: gx0 + gridW/2,
        y: hy,
        width: gridW,
        height: LINE_W,
        color: "white",
        layer: 1002
      });
      this.invSprites.push(hLine);
    }

    // now lay out icons centered in each cell
    // cell center for (col, row):
    // cx = gx0 + LINE_W + col*(ICON+LINE_W) + ICON/2
    // cy = gyTop - LINE_W - row*(ICON+LINE_W) - ICON/2
    for (var i = 0; i < items.length; i++) {
      var row = Math.floor(i / cols);
      var col = i % cols;

      var cx = gx0 + LINE_W + col * (ICON + LINE_W) + ICON/2;
      var cy = gyTop - LINE_W - row * (ICON + LINE_W) - ICON/2;

      var def = this._getItemDef(items[i].key);
      var icon;
      if (def && def.url) {
        icon = new Image({
          url: def.url,
          x: cx, y: cy,
          width:  ICON - 5,
          height: ICON - 5,
          layer: 1001
        });
        icon.sendToFront();
      } else {
        // fallback if missing art
        icon = new Rectangle({
          x: cx, y: cy,
          width: ICON - 4,
          height: ICON - 4,
          color: rgb(230,230,230),
          layer: 1001
        });
      }
      this.invSprites.push(icon);

      if (items[i].count > 1) {
        var badge = new Text({
          text: items[i].count,
          size: 16,
          x: cx + ICON/2 - 4,
          y: cy - ICON/2 + 14,
          layer: 1003,
          color: "black",
          fontFamily: "poppins",
          textAlign: "right"
        });
        badge.sendToFront();
        this.invSprites.push(badge);
      }
    }

    // show everything we just made
    for (var j = 0; j < this.invSprites.length; j++) showSprite(this.invSprites[j]);
  },
  

  tick: function () {
    if (keysDown.includes('K') || keysDown.includes('k')) {
      Game.switchTo('world', { soft:true });
      return;
    }
    this._handleNav();       // <-- call it so options respond
    this._refreshInventory();
  }
};

// Register once:
// Game.register('chat', ChatMode);
// Register once during setup (alongside your other modes):
// Game.register('chat', ChatMode);

// Example: when you want to enter chat mode:
// Game.switchTo('chat', { soft:true });

var ITEM_DEFS = Object.create(null);

// def = { key, name, url, width, height, stackable, onAdd?, onRemove? }
function defineItem(def) {
  if (!def || !def.key) { console.warn("defineItem needs a key"); return; }
  var norm = {
    key: def.key,
    name: def.name || def.key,
    url: def.url || "",
    width: (def.width != null) ? def.width : 32,
    height: (def.height != null) ? def.height : 32,
    stackable: (def.stackable != null) ? !!def.stackable : true,
    onAdd: typeof def.onAdd === "function" ? def.onAdd : null,
    onRemove: typeof def.onRemove === "function" ? def.onRemove : null
  };
  ITEM_DEFS[norm.key] = norm;
  return norm;
}
function getItemDef(key) { return ITEM_DEFS[key] || null; }

// ===== Inventory: Per-Character Inventory ==================================
function makeInventory(owner) {
  var inv = {
    owner: owner,
    items: Object.create(null),  // key -> { def, count, data? }

    add: function (key, count, ctx) {
      if (!key) return 0;
      var def = getItemDef(key);
      if (!def) { console.warn("Unknown item key:", key); return 0; }

      var n = (count != null) ? count : 1;
      if (n <= 0) return 0;

      var entry = this.items[key];
      if (!entry) {
        entry = { def: def, count: 0 };
        this.items[key] = entry;
      }
      if (!def.stackable && entry.count > 0) {
        console.warn("Item not stackable; already have one:", key);
        return 0;
      }

      entry.count += n;

      // callback (once per add call)
      if (def.onAdd) {
        try { def.onAdd(this.owner, entry, n, ctx); } catch (e) { console.warn(e); }
      }
      return n;
    },

    remove: function (key, count, ctx) {
      if (!key) return 0;
      var entry = this.items[key]; if (!entry) return 0;

      var n = (count != null) ? count : 1;
      if (n <= 0) return 0;

      var removed = Math.min(n, entry.count);
      entry.count -= removed;

      // callback (once per remove call)
      if (entry.def && entry.def.onRemove) {
        try { entry.def.onRemove(this.owner, entry, removed, ctx); } catch (e) { console.warn(e); }
      }

      if (entry.count <= 0) delete this.items[key];
      return removed;
    },

    has: function (key, count) {
      var need = (count != null) ? count : 1;
      var entry = this.items[key];
      return !!(entry && entry.count >= need);
    },

    count: function (key) {
      var entry = this.items[key]; return entry ? entry.count : 0;
    },

    list: function () {
      var arr = [], k;
      for (k in this.items) {
        var e = this.items[k];
        arr.push({
          key: e.def.key,
          name: e.def.name,
          url: e.def.url,
          width: e.def.width,
          height: e.def.height,
          count: e.count
        });
      }
      return arr;
    },

    clear: function (ctx) {
      var k;
      for (k in this.items) {
        var e = this.items[k];
        if (e && e.def && e.count > 0 && e.def.onRemove) {
          try { e.def.onRemove(this.owner, e, e.count, ctx); } catch (err) {}
        }
      }
      this.items = Object.create(null);
    },

    // --- Snapshot helpers (compact) ---
    toJSON: function () {
      var data = Object.create(null), k;
      for (k in this.items) data[k] = this.items[k].count;
      return data; // { key: count, ... }
    },
    fromJSON: function (data, ctx) {
      this.clear(ctx);
      if (!data) return;
      var k;
      for (k in data) {
        var c = data[k] | 0;
        if (c > 0) this.add(k, c, ctx);
      }
    }
  };
  return inv;
}

function ensureInventory(w) { if (w && !w.inventory) w.inventory = makeInventory(w); return w ? w.inventory : null; }

// Resolve item defs from your registry(ies)
function _getItemDef(key) {
  if (typeof getItemDef === "function") return getItemDef(key);
  if (typeof ITEM_DEFS === "object" && ITEM_DEFS[key]) return ITEM_DEFS[key];
  if (typeof ITEMS_BY_KEY === "object" && ITEMS_BY_KEY[key]) return ITEMS_BY_KEY[key];
  if (typeof ITEM_REGISTRY === "object" && ITEM_REGISTRY[key]) return ITEM_REGISTRY[key];
  return null;
}

// Add item(s) to a character, using ensureInventory you already have.
function addItem(w, key, count, ctx) {
  var inv = ensureInventory(w);
  if (!inv) return;

  var n = (typeof count === "number" && count > 0) ? count : 1;
  var def = _getItemDef(key);

  // Prefer inventory API if your makeInventory exposes one
  if (typeof inv.addItem === "function") {
    inv.addItem(key, n, ctx);
  } else if (typeof inv.add === "function") {
    inv.add(key, n, ctx);
  } else {
    // Fallback to a simple { items: { key: {count} } } shape
    if (!inv.items) inv.items = {};
    var entry = inv.items[key];
    if (!entry) entry = inv.items[key] = { count: 0 };

    if (def && def.stackable === false) {
      if (entry.count <= 0) entry.count = 1;
    } else {
      entry.count += n;
    }
  }

  // Fire onAdd once per operation (stackables receive the count)
  if (def && typeof def.onAdd === "function") {
    try { def.onAdd(w, (inv.items && inv.items[key]) || null, n, ctx || {}); } catch(e){}
  }
}

// Remove item(s); mirrors addItem’s shape
function removeItem(w, key, count, ctx) {
  var inv = ensureInventory(w);
  if (!inv) return;

  var n = (typeof count === "number" && count > 0) ? count : 1;
  var def = _getItemDef(key);

  if (typeof inv.removeItem === "function") {
    inv.removeItem(key, n, ctx);
  } else if (typeof inv.remove === "function") {
    inv.remove(key, n, ctx);
  } else if (inv.items && inv.items[key]) {
    var entry = inv.items[key];
    if (def && def.stackable === false) {
      if (entry.count > 0) entry.count = 0;
    } else {
      entry.count -= n;
      if (entry.count < 0) entry.count = 0;
    }
  }

  if (def && typeof def.onRemove === "function") {
    try { def.onRemove(w, (inv.items && inv.items[key]) || null, n, ctx || {}); } catch(e){}
  }
}

// Seed defaults from a def-provided startingInv (object map or [{key,count}] array)
function seedStartingInventory(w, startingInv) {
  if (!startingInv) return;
  ensureInventory(w);

  if (Array.isArray(startingInv)) {
    for (var i = 0; i < startingInv.length; i++) {
      var it = startingInv[i];
      if (it && it.key) addItem(w, it.key, it.count || 1, { reason: "startup" });
    }
  } else if (typeof startingInv === "object") {
    for (var k in startingInv) {
      if (startingInv.hasOwnProperty(k)) {
        addItem(w, k, startingInv[k], { reason: "startup" });
      }
    }
  }
}


// easy transfers / queries
function transferItem(fromW, toW, key, count, ctx) {
  if (!fromW || !toW || !key) return 0;
  ensureInventory(fromW); ensureInventory(toW);
  var n = (count != null) ? count : 1;
  var can = Math.min(n, fromW.inventory.count(key));
  if (can <= 0) return 0;
  fromW.inventory.remove(key, can, ctx);
  toW.inventory.add(key, can, ctx);
  return can;
}
function whoHasItem(key, minCount) {
  var need = (minCount != null) ? minCount : 1;
  var arr = [], k;
  for (k in CHARACTERS) {
    var w = CHARACTERS[k];
    if (w && w.inventory && w.inventory.count(key) >= need) arr.push(w);
  }
  return arr;
}

// ===== Install real items from /Assets ======================================
function itemUrl(key) {
  // Produces: https://github.com/.../blob/main/Assets/<key>.png?raw=true
  const ret = REPO_BASE + "/Assets/" + key + ".png?raw=true";
  console.log(ret);
  return ret;
  
}

function installGameItems() {

  function titleCase(s) {
    return s.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function addStackable(key, display, w, h) {
    defineItem({
      key: key,
      name: display || titleCase(key),
      url: itemUrl(key),
      width: (w != null) ? w : 32,
      height: (h != null) ? h : 32,
      stackable: true
    });
  }
  function addUnique(key, display, onAdd, onRemove, w, h) {
    defineItem({
      key: key,
      name: display || titleCase(key),
      url: itemUrl(key),
      width: (w != null) ? w : 32,
      height: (h != null) ? h : 32,
      stackable: false,
      onAdd: (typeof onAdd === "function") ? onAdd : null,
      onRemove: (typeof onRemove === "function") ? onRemove : null
    });
  }

  // Food & drink (stackable)
  var foods = [
    "burger","cake","coffee","cookie","crossiant","donut",
    "drumstick","fries","hotdog","icecream","noodles","pizza","taco"
  ];
  for (var i = 0; i < foods.length; i++) addStackable(foods[i]);

  // Currency (stackable)
  addStackable("coin", "Coin");

  // Key (unique)
  addUnique("key", "Key");

  // Shoe (unique) — give +1 speed while carried
  addUnique(
    "shoe", "Shoe",
    function (w, entry, count, ctx) {
      if (!w._invMods) w._invMods = {};
      if (!w._invMods.shoeSpeed) {
        w._invMods.shoeSpeed = true;
        w.state.speed = (w.state.speed || DEFAULT_SPEED) + 1;
      }
    },
    function (w, entry, count, ctx) {
      if (w._invMods && w._invMods.shoeSpeed) {
        w._invMods.shoeSpeed = false;
        w.state.speed = (w.state.speed || DEFAULT_SPEED) - 1;
        if (w.state.speed < 1) w.state.speed = 1;
      }
    }
  );

  // Misc uniques
  addUnique("game", "Game");
  addUnique("tape", "Tape");
  
}

ready(function () {
  // Register modes
  Game.register('world', WorldMode);
  Game.register('menu',  MenuMode);
  Game.register('sideShooter', sideShooter);
  Game.register('chat', ChatMode);
  
  installGameItems();
  normalizeLinksBidirectional();

  // Start in world
  Game.switchTo('world');
  StageHUD.init();

  // Central game loop (variable dt)
  let last = performance.now();
  forever(function () {
    const now = performance.now();

    // seconds since last frame, clamped
    let dt = (now - last) / 1000;
    if (dt > MAX_DT) dt = MAX_DT;
    DT = dt;

    // smoothed 60fps scale (K ~ 1 at 60fps, ~2 at 30fps, etc.)
    const kInst = dt * 60;
    _k += (kInst - _k) * K_SMOOTH;
    K = _k;

    last = now;

    // pass dt (seconds) to whatever mode is active
    Game.tick(dt);
  });
});
