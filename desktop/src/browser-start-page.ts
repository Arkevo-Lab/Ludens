/**
 * Self-contained, zero-network-dependency 3D WebGL / Canvas interactive start page
 * served for `ludens-browser://start`.
 */
export function buildBrowserStartPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ludens WebGL Arena</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070b14;
      --panel: rgba(10, 16, 30, 0.72);
      --border: rgba(94, 234, 212, 0.24);
      --accent: #38f8d4;
      --accent-2: #818cf8;
      --warn: #fb7185;
      --gold: #fbbf24;
      --text: #e6f0ff;
      --muted: #8ea2c8;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: radial-gradient(circle at 50% 25%, #111c36 0%, var(--bg) 72%);
      color: var(--text);
      font-family: var(--sans);
      user-select: none;
      -webkit-user-select: none;
    }
    #arena {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      cursor: crosshair;
      outline: none;
    }
    .hud {
      position: fixed;
      inset: 0;
      pointer-events: none;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      z-index: 2;
    }
    .row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-family: var(--mono);
      letter-spacing: 0.04em;
      background: rgba(56, 248, 212, 0.14);
      border: 1px solid rgba(56, 248, 212, 0.35);
      color: var(--accent);
    }
    .pill.locked {
      background: rgba(129, 140, 248, 0.22);
      border-color: rgba(129, 140, 248, 0.55);
      color: #c7d2fe;
    }
    .stats {
      margin-top: 8px;
      display: grid;
      grid-template-columns: repeat(4, minmax(56px, auto));
      gap: 10px;
      font-family: var(--mono);
    }
    .stat-label {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
    }
    .stat-val {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
    }
    .stat-val.gold { color: var(--gold); }
    .stat-val.accent { color: var(--accent); }
    .telemetry {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 5px;
    }
    .keys-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .keycap {
      min-width: 28px;
      height: 26px;
      padding: 0 7px;
      border-radius: 6px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: rgba(15, 23, 42, 0.78);
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 60ms ease, background 60ms ease, border-color 60ms ease, color 60ms ease;
    }
    .keycap.active {
      background: rgba(56, 248, 212, 0.24);
      border-color: var(--accent);
      color: #ffffff;
      transform: translateY(-1px);
      box-shadow: 0 0 12px rgba(56, 248, 212, 0.45);
    }
    .controls-hint {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      color: var(--muted);
    }
    .reset-btn {
      pointer-events: auto;
      appearance: none;
      border: 1px solid rgba(56, 248, 212, 0.4);
      background: rgba(56, 248, 212, 0.14);
      color: var(--accent);
      border-radius: 7px;
      padding: 5px 10px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .reset-btn:hover {
      background: rgba(56, 248, 212, 0.26);
    }
    .flash {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      opacity: 0;
      transition: opacity 160ms ease;
    }
  </style>
</head>
<body>
  <canvas id="arena" tabindex="0" aria-label="Ludens WebGL Arena 3D Canvas"></canvas>
  <div id="flash" class="flash"></div>
  <div class="hud">
    <div class="row">
      <div class="card">
        <div class="title">
          <span>Ludens WebGL Arena</span>
          <span id="renderer-badge" class="pill">WEBGL 3D</span>
        </div>
        <div class="stats">
          <div><div class="stat-label">FPS</div><div id="hud-fps" class="stat-val accent">60</div></div>
          <div><div class="stat-label">Score</div><div id="hud-score" class="stat-val gold">0</div></div>
          <div><div class="stat-label">Combo</div><div id="hud-combo" class="stat-val">x1</div></div>
          <div><div class="stat-label">Targets</div><div id="hud-targets" class="stat-val">0</div></div>
        </div>
      </div>
      <div class="card telemetry">
        <span id="lock-badge" class="pill">CLICK TO LOCK CAMERA</span>
        <div id="hud-camera">YAW 0° · PITCH -18°</div>
        <div id="hud-pos">POS (0.0, 0.0)</div>
      </div>
    </div>
    <div class="row" style="align-items: flex-end;">
      <div class="card">
        <div class="stat-label" style="margin-bottom: 6px;">Held Inputs</div>
        <div class="keys-wrap" id="keys-hud">
          <span class="keycap" data-key="w">W</span>
          <span class="keycap" data-key="a">A</span>
          <span class="keycap" data-key="s">S</span>
          <span class="keycap" data-key="d">D</span>
          <span class="keycap" data-key="arrowup">↑</span>
          <span class="keycap" data-key="arrowdown">↓</span>
          <span class="keycap" data-key="arrowleft">←</span>
          <span class="keycap" data-key="arrowright">→</span>
          <span class="keycap" data-key=" ">SPACE</span>
          <span class="keycap" data-mouse="0">LMB</span>
          <span class="keycap" data-mouse="2">RMB</span>
        </div>
      </div>
      <div class="card controls-hint">
        <span>WASD / Arrows: Move · Space: Boost · Drag / Lock Mouse: Orbit</span>
        <button id="reset-btn" class="reset-btn" type="button">Reset (R)</button>
      </div>
    </div>
  </div>
  <script>
  (() => {
    const canvas = document.getElementById('arena');
    const flashEl = document.getElementById('flash');
    const fpsEl = document.getElementById('hud-fps');
    const scoreEl = document.getElementById('hud-score');
    const comboEl = document.getElementById('hud-combo');
    const targetsEl = document.getElementById('hud-targets');
    const cameraEl = document.getElementById('hud-camera');
    const posEl = document.getElementById('hud-pos');
    const lockBadge = document.getElementById('lock-badge');
    const rendererBadge = document.getElementById('renderer-badge');
    const resetBtn = document.getElementById('reset-btn');
    const keyCaps = Array.from(document.querySelectorAll('.keycap'));

    const ARENA_LIMIT = 14;
    const heldKeys = new Set();
    const heldMouse = new Set();

    const state = {
      px: 0,
      pz: 0,
      vx: 0,
      vz: 0,
      roll: 0,
      yaw: 0,
      pitch: -0.32,
      score: 0,
      combo: 1,
      collected: 0,
      dragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      time: 0,
      targets: [],
      hazards: [],
    };

    function seededRandom(seed) {
      let s = seed >>> 0;
      return () => {
        s = (1664525 * s + 1013904223) >>> 0;
        return s / 4294967296;
      };
    }
    let rand = seededRandom(20261125);

    function spawnTarget(index) {
      const angle = rand() * Math.PI * 2;
      const radius = 3.5 + rand() * (ARENA_LIMIT - 5);
      return {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        phase: rand() * Math.PI * 2 + index,
      };
    }

    function resetGame() {
      rand = seededRandom(Date.now() & 0xffffffff);
      state.px = 0;
      state.pz = 0;
      state.vx = 0;
      state.vz = 0;
      state.roll = 0;
      state.yaw = 0;
      state.pitch = -0.32;
      state.score = 0;
      state.combo = 1;
      state.collected = 0;
      state.targets = Array.from({ length: 6 }, (_, i) => spawnTarget(i));
      state.hazards = Array.from({ length: 5 }, (_, i) => {
        const angle = (i / 5) * Math.PI * 2;
        return {
          x: Math.cos(angle) * 9,
          z: Math.sin(angle) * 9,
          vx: (rand() - 0.5) * 4.2,
          vz: (rand() - 0.5) * 4.2,
          spin: rand() * Math.PI * 2,
          hitCooldown: 0,
        };
      });
      syncHud();
    }

    function triggerFlash(color) {
      flashEl.style.background = color;
      flashEl.style.opacity = '0.28';
      clearTimeout(triggerFlash._t);
      triggerFlash._t = setTimeout(() => { flashEl.style.opacity = '0'; }, 140);
    }

    function syncKeysHud() {
      for (const cap of keyCaps) {
        const k = cap.getAttribute('data-key');
        const m = cap.getAttribute('data-mouse');
        const active = k !== null ? heldKeys.has(k) : m !== null ? heldMouse.has(Number(m)) : false;
        cap.classList.toggle('active', active);
      }
    }

    function syncHud() {
      scoreEl.textContent = String(state.score);
      comboEl.textContent = 'x' + state.combo;
      targetsEl.textContent = String(state.collected);
      const yawDeg = Math.round(((state.yaw * 180) / Math.PI) % 360);
      const pitchDeg = Math.round((state.pitch * 180) / Math.PI);
      cameraEl.textContent = 'YAW ' + yawDeg + '° · PITCH ' + pitchDeg + '°';
      posEl.textContent = 'POS (' + state.px.toFixed(1) + ', ' + state.pz.toFixed(1) + ')';
    }

    function normalizeKey(e) {
      if (e.code === 'Space') return ' ';
      return (e.key || '').toLowerCase();
    }

    window.addEventListener('keydown', (e) => {
      const k = normalizeKey(e);
      if (k === 'r') {
        resetGame();
        return;
      }
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
      }
      heldKeys.add(k);
      syncKeysHud();
    });

    window.addEventListener('keyup', (e) => {
      heldKeys.delete(normalizeKey(e));
      syncKeysHud();
    });

    window.addEventListener('blur', () => {
      heldKeys.clear();
      heldMouse.clear();
      state.dragging = false;
      syncKeysHud();
    });

    canvas.addEventListener('mousedown', (e) => {
      canvas.focus();
      heldMouse.add(e.button);
      state.dragging = true;
      state.lastMouseX = e.clientX;
      state.lastMouseY = e.clientY;
      syncKeysHud();
    });

    window.addEventListener('mouseup', (e) => {
      heldMouse.delete(e.button);
      state.dragging = false;
      syncKeysHud();
    });

    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas && typeof canvas.requestPointerLock === 'function') {
        try { canvas.requestPointerLock(); } catch {}
      }
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      lockBadge.textContent = locked ? 'POINTER LOCKED · ESC TO EXIT' : 'CLICK TO LOCK CAMERA';
      lockBadge.classList.toggle('locked', locked);
    });

    window.addEventListener('mousemove', (e) => {
      const locked = document.pointerLockElement === canvas;
      const syntheticRelative = !e.isTrusted && (e.movementX !== 0 || e.movementY !== 0);
      if (locked || syntheticRelative) {
        state.yaw -= (e.movementX || 0) * 0.005;
        state.pitch = Math.max(-1.15, Math.min(-0.08, state.pitch - (e.movementY || 0) * 0.004));
        return;
      }
      if (state.dragging || (e.buttons & 1) !== 0) {
        const dx = e.movementX || (e.clientX - state.lastMouseX);
        const dy = e.movementY || (e.clientY - state.lastMouseY);
        state.lastMouseX = e.clientX;
        state.lastMouseY = e.clientY;
        state.yaw -= dx * 0.006;
        state.pitch = Math.max(-1.15, Math.min(-0.08, state.pitch - dy * 0.0045));
      }
    });

    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetGame();
    });

    // Minimal mat4 math (column-major)
    function mat4Perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ]);
    }
    function mat4LookAt(eye, target, up) {
      let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
      let len = Math.hypot(zx, zy, zz) || 1;
      zx /= len; zy /= len; zz /= len;
      let xx = up[1] * zz - up[2] * zy;
      let xy = up[2] * zx - up[0] * zz;
      let xz = up[0] * zy - up[1] * zx;
      len = Math.hypot(xx, xy, xz) || 1;
      xx /= len; xy /= len; xz /= len;
      const yx = zy * xz - zz * xy;
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;
      return new Float32Array([
        xx, yx, zx, 0,
        xy, yy, zy, 0,
        xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
        1,
      ]);
    }
    function mat4Mul(a, b) {
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          out[c * 4 + r] =
            a[0 * 4 + r] * b[c * 4 + 0] +
            a[1 * 4 + r] * b[c * 4 + 1] +
            a[2 * 4 + r] * b[c * 4 + 2] +
            a[3 * 4 + r] * b[c * 4 + 3];
        }
      }
      return out;
    }
    function mat4Model(tx, ty, tz, ry, rz, sx, sy, sz) {
      const cy = Math.cos(ry), syr = Math.sin(ry);
      const cz = Math.cos(rz), szr = Math.sin(rz);
      return new Float32Array([
        cy * cz * sx, szr * sx, -syr * cz * sx, 0,
        -cy * szr * sy, cz * sy, syr * szr * sy, 0,
        syr * sz, 0, cy * sz, 0,
        tx, ty, tz, 1,
      ]);
    }

    // Build cube geometry (positions + normals)
    function makeCubeData() {
      const faces = [
        { n: [0, 0, 1], v: [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] },
        { n: [0, 0, -1], v: [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]] },
        { n: [0, 1, 0], v: [[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]] },
        { n: [0, -1, 0], v: [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]] },
        { n: [1, 0, 0], v: [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]] },
        { n: [-1, 0, 0], v: [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]] },
      ];
      const pos = [];
      const norm = [];
      for (const f of faces) {
        const idx = [0, 1, 2, 0, 2, 3];
        for (const i of idx) {
          pos.push(f.v[i][0] * 0.5, f.v[i][1] * 0.5, f.v[i][2] * 0.5);
          norm.push(f.n[0], f.n[1], f.n[2]);
        }
      }
      return { pos: new Float32Array(pos), norm: new Float32Array(norm), count: 36 };
    }

    function makeGridData(size, step) {
      const lines = [];
      for (let i = -size; i <= size; i += step) {
        lines.push(i, 0, -size, i, 0, size);
        lines.push(-size, 0, i, size, 0, i);
      }
      return { pos: new Float32Array(lines), count: lines.length / 3 };
    }

    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    let webglState = null;

    if (gl) {
      const vsSrc = \`
        attribute vec3 aPos;
        attribute vec3 aNorm;
        uniform mat4 uMvp;
        uniform mat4 uModel;
        varying vec3 vNorm;
        varying vec3 vWorld;
        void main() {
          vec4 w = uModel * vec4(aPos, 1.0);
          vWorld = w.xyz;
          vNorm = normalize(mat3(uModel) * aNorm);
          gl_Position = uMvp * vec4(aPos, 1.0);
        }
      \`;
      const fsSrc = \`
        precision mediump float;
        uniform vec3 uColor;
        uniform float uUnlit;
        varying vec3 vNorm;
        varying vec3 vWorld;
        void main() {
          float dist = length(vWorld.xz);
          float fog = clamp(1.0 - dist / 34.0, 0.14, 1.0);
          if (uUnlit > 0.5) {
            gl_FragColor = vec4(uColor * fog, 1.0);
            return;
          }
          vec3 light = normalize(vec3(0.45, 0.85, 0.55));
          float diff = max(dot(normalize(vNorm), light), 0.25);
          vec3 lit = uColor * (0.35 + diff * 0.85);
          gl_FragColor = vec4(mix(vec3(0.03, 0.05, 0.11), lit, fog), 1.0);
        }
      \`;
      function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      }
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      gl.enable(gl.DEPTH_TEST);

      const cube = makeCubeData();
      const grid = makeGridData(16, 2);

      const cubePosBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cubePosBuf);
      gl.bufferData(gl.ARRAY_BUFFER, cube.pos, gl.STATIC_DRAW);

      const cubeNormBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cubeNormBuf);
      gl.bufferData(gl.ARRAY_BUFFER, cube.norm, gl.STATIC_DRAW);

      const gridPosBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, gridPosBuf);
      gl.bufferData(gl.ARRAY_BUFFER, grid.pos, gl.STATIC_DRAW);

      webglState = {
        prog,
        aPos: gl.getAttribLocation(prog, 'aPos'),
        aNorm: gl.getAttribLocation(prog, 'aNorm'),
        uMvp: gl.getUniformLocation(prog, 'uMvp'),
        uModel: gl.getUniformLocation(prog, 'uModel'),
        uColor: gl.getUniformLocation(prog, 'uColor'),
        uUnlit: gl.getUniformLocation(prog, 'uUnlit'),
        cubePosBuf,
        cubeNormBuf,
        cubeCount: cube.count,
        gridPosBuf,
        gridCount: grid.count,
      };
    } else {
      rendererBadge.textContent = 'CANVAS 3D';
    }

    const ctx2d = gl ? null : canvas.getContext('2d');

    function resizeCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
    resetGame();

    function stepSimulation(dt) {
      state.time += dt;
      let moveForward = 0;
      let moveRight = 0;
      if (heldKeys.has('w') || heldKeys.has('arrowup')) moveForward += 1;
      if (heldKeys.has('s') || heldKeys.has('arrowdown')) moveForward -= 1;
      if (heldKeys.has('d') || heldKeys.has('arrowright')) moveRight += 1;
      if (heldKeys.has('a') || heldKeys.has('arrowleft')) moveRight -= 1;

      const boost = heldKeys.has(' ') ? 1.85 : 1.0;
      const speed = 10.5 * boost;
      const fx = -Math.sin(state.yaw);
      const fz = -Math.cos(state.yaw);
      const rx = Math.cos(state.yaw);
      const rz = -Math.sin(state.yaw);

      let ax = fx * moveForward + rx * moveRight;
      let az = fz * moveForward + rz * moveRight;
      const mag = Math.hypot(ax, az);
      if (mag > 0) {
        ax = (ax / mag) * speed;
        az = (az / mag) * speed;
      }

      const damping = Math.exp(-8 * dt);
      state.vx = state.vx * damping + ax * (1 - damping);
      state.vz = state.vz * damping + az * (1 - damping);
      state.px = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, state.px + state.vx * dt));
      state.pz = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, state.pz + state.vz * dt));
      state.roll += ((-moveRight * 0.42) - state.roll) * Math.min(1, dt * 10);

      for (let i = 0; i < state.targets.length; i++) {
        const t = state.targets[i];
        if (Math.hypot(t.x - state.px, t.z - state.pz) < 1.35) {
          state.collected += 1;
          state.score += 100 * state.combo;
          state.combo = Math.min(12, state.combo + 1);
          state.targets[i] = spawnTarget(i + state.collected);
          triggerFlash('radial-gradient(circle, rgba(56,248,212,0.55), transparent 70%)');
        }
      }

      for (const h of state.hazards) {
        h.x += h.vx * dt;
        h.z += h.vz * dt;
        h.spin += dt * 1.4;
        if (Math.abs(h.x) > ARENA_LIMIT) { h.x = Math.sign(h.x) * ARENA_LIMIT; h.vx *= -1; }
        if (Math.abs(h.z) > ARENA_LIMIT) { h.z = Math.sign(h.z) * ARENA_LIMIT; h.vz *= -1; }
        if (h.hitCooldown > 0) h.hitCooldown -= dt;
        if (h.hitCooldown <= 0 && Math.hypot(h.x - state.px, h.z - state.pz) < 1.35) {
          h.hitCooldown = 1.0;
          state.combo = 1;
          state.score = Math.max(0, state.score - 50);
          triggerFlash('radial-gradient(circle, rgba(251,113,133,0.65), transparent 70%)');
        }
      }
    }

    function renderWebGL(vp) {
      const s = webglState;
      gl.clearColor(0.03, 0.05, 0.10, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // Draw grid
      const identity = mat4Model(0, 0, 0, 0, 0, 1, 1, 1);
      gl.uniformMatrix4fv(s.uModel, false, identity);
      gl.uniformMatrix4fv(s.uMvp, false, vp);
      gl.uniform3f(s.uColor, 0.14, 0.42, 0.56);
      gl.uniform1f(s.uUnlit, 1.0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.gridPosBuf);
      gl.enableVertexAttribArray(s.aPos);
      gl.vertexAttribPointer(s.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.disableVertexAttribArray(s.aNorm);
      gl.drawArrays(gl.LINES, 0, s.gridCount);

      // Bind cube buffers
      gl.bindBuffer(gl.ARRAY_BUFFER, s.cubePosBuf);
      gl.enableVertexAttribArray(s.aPos);
      gl.vertexAttribPointer(s.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.cubeNormBuf);
      gl.enableVertexAttribArray(s.aNorm);
      gl.vertexAttribPointer(s.aNorm, 3, gl.FLOAT, false, 0, 0);
      gl.uniform1f(s.uUnlit, 0.0);

      function drawCube(tx, ty, tz, ry, rz, sx, sy, sz, r, g, b) {
        const model = mat4Model(tx, ty, tz, ry, rz, sx, sy, sz);
        gl.uniformMatrix4fv(s.uModel, false, model);
        gl.uniformMatrix4fv(s.uMvp, false, mat4Mul(vp, model));
        gl.uniform3f(s.uColor, r, g, b);
        gl.drawArrays(gl.TRIANGLES, 0, s.cubeCount);
      }

      // Player hover-craft
      const hoverY = 0.72 + Math.sin(state.time * 4.5) * 0.12;
      drawCube(state.px, hoverY, state.pz, state.yaw, state.roll, 1.15, 0.42, 1.55, 0.22, 0.96, 0.84);
      drawCube(state.px, hoverY + 0.28, state.pz, state.yaw, state.roll, 0.52, 0.28, 0.72, 0.58, 0.65, 0.98);

      // Target crystals
      for (const t of state.targets) {
        const bob = 0.85 + Math.sin(state.time * 3.2 + t.phase) * 0.26;
        drawCube(t.x, bob, t.z, state.time * 2.1 + t.phase, 0.65, 0.68, 0.68, 0.68, 0.98, 0.78, 0.18);
      }

      // Hazard cubes
      for (const h of state.hazards) {
        drawCube(h.x, 0.85, h.z, h.spin, 0.2, 1.1, 1.1, 1.1, 0.96, 0.28, 0.48);
      }
    }

    function renderFallback2D(vp) {
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.fillStyle = '#070b14';
      ctx2d.fillRect(0, 0, w, h);

      function project(x, y, z) {
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
        const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        if (cw <= 0.1) return null;
        return { x: (cx / cw * 0.5 + 0.5) * w, y: (0.5 - cy / cw * 0.5) * h, depth: cw };
      }

      ctx2d.strokeStyle = 'rgba(56, 248, 212, 0.22)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let i = -16; i <= 16; i += 2) {
        const a = project(i, 0, -16), b = project(i, 0, 16);
        if (a && b) { ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y); }
        const c = project(-16, 0, i), d = project(16, 0, i);
        if (c && d) { ctx2d.moveTo(c.x, c.y); ctx2d.lineTo(d.x, d.y); }
      }
      ctx2d.stroke();

      const entities = [
        { x: state.px, y: 0.75, z: state.pz, size: 18, color: '#38f8d4' },
        ...state.targets.map((t) => ({ x: t.x, y: 0.9, z: t.z, size: 13, color: '#fbbf24' })),
        ...state.hazards.map((hz) => ({ x: hz.x, y: 0.9, z: hz.z, size: 16, color: '#fb7185' })),
      ];
      for (const e of entities) {
        const p = project(e.x, e.y, e.z);
        if (!p) continue;
        const r = Math.max(4, (e.size * 10) / p.depth);
        ctx2d.fillStyle = e.color;
        ctx2d.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
    }

    let lastTime = performance.now();
    let frameCount = 0;
    let fpsAccumulator = 0;
    let hudTimer = 0;

    function tick(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      frameCount += 1;
      fpsAccumulator += dt;
      hudTimer += dt;

      stepSimulation(dt);

      const camDist = 9.5;
      const eyeX = state.px + Math.sin(state.yaw) * Math.cos(state.pitch) * camDist;
      const eyeY = 2.4 - Math.sin(state.pitch) * camDist;
      const eyeZ = state.pz + Math.cos(state.yaw) * Math.cos(state.pitch) * camDist;
      const aspect = Math.max(0.2, canvas.width / Math.max(1, canvas.height));
      const proj = mat4Perspective(Math.PI / 3, aspect, 0.1, 100);
      const view = mat4LookAt([eyeX, eyeY, eyeZ], [state.px, 0.8, state.pz], [0, 1, 0]);
      const vp = mat4Mul(proj, view);

      if (gl && webglState) renderWebGL(vp);
      else if (ctx2d) renderFallback2D(vp);

      if (fpsAccumulator >= 0.35) {
        fpsEl.textContent = String(Math.round(frameCount / fpsAccumulator));
        frameCount = 0;
        fpsAccumulator = 0;
      }
      if (hudTimer >= 0.08) {
        hudTimer = 0;
        syncHud();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();
  </script>
</body>
</html>`
}
