/* Interaction model adapted from MeteorNOX / DeepSeek-Balance-Whale-Widget (MIT).
 * Native window movement is owned by the Electron main process. */
const bridge = window.companion;
const pet = document.querySelector('#pet');
const portrait = document.querySelector('#portrait');
const body = document.querySelector('#body');
const mirror = document.querySelector('#mirror');
const bubble = document.querySelector('#bubble');
const message = document.querySelector('#message');
const game = document.querySelector('#game');
const gameScore = document.querySelector('#game-score');
const gameTime = document.querySelector('#game-time');
const gameTarget = document.querySelector('#game-target');
let locale = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
let copy = companionI18n[locale];
let activityInput = null;
let lastSpeech = null;
let alpha;
let flipped = false;
let held = null;
let interactive = false;
let hideTimer;
let line = 0;
let activityId = null;
const activityActions = document.querySelector('#activity-actions');
const activityOpen = document.querySelector('#activity-open');
function activityHit(point) {
  if (!activityId || !bubble.classList.contains('open')) return false;
  // Only the visible text/button block receives native input, not transparent gutters or bubble tail.
  const rect = activityActions.getBoundingClientRect();
  const text = message.getBoundingClientRect();
  return [rect, text].some(r => point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom);
}
bridge?.onActivity(event => {
  if (event.type === 'hide') { if (event.displayId === activityId) hideBubble(); return; }
  if (event.type !== 'show' || typeof event.displayId !== 'string') return;
  stopGame();
  clearTimeout(hideTimer);
  activityId = event.displayId;
  activityInput = event.input;
  renderLogContent(message, event.input, copy.activity);
  poses.activity(event.input);
  activityActions.hidden = false;
  bubble.classList.add('open', 'activity');
  bubble.setAttribute('aria-hidden', 'false');
  update(lastPoint);
});
document.querySelector('#activity-open').addEventListener('click', () => { if (activityId) void bridge?.openActivity(activityId); });
document.querySelector('#activity-dismiss').addEventListener('click', () => { if (activityId) void bridge?.dismissActivity(activityId); hideBubble(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && gameActive) { event.preventDefault(); stopGame(); return; }
  if (event.key === 'Escape' && activityId) { void bridge?.dismissActivity(activityId); hideBubble(); }
});
let sound = { enabled: true, volume: .5, source: null };
let clickAudio;
function configureSound(settings) {
  clickAudio?.pause();
  sound = settings;
  clickAudio = sound.source ? new Audio(sound.source.dataUrl) : null;
  if (clickAudio) clickAudio.volume = sound.volume;
}
bridge?.onSound(configureSound);
function playClickSound() {
  if (!sound.enabled || !clickAudio || sound.volume === 0) return;
  clickAudio.pause();
  clickAudio.currentTime = 0;
  void clickAudio.play().catch(() => console.warn('Pet click sound could not play'));
}
function formatSpeech(speech) {
  if (!speech) return '';
  if (speech.kind === 'line') return copy.lines[speech.index];
  return `${speech.score >= 10 ? copy.game.win : copy.game.lose}\n${copy.game.score.replace('{score}', speech.score)} · ${copy.game.best.replace('{best}', bestScore)}`;
}
function setLocale(next) {
  if (!companionI18n[next]) return;
  locale = next;
  copy = companionI18n[locale];
  document.documentElement.lang = copy.lang;
  document.title = copy.name;
  pet.setAttribute('aria-label', copy.petLabel);
  pet.title = copy.petTitle;
  activityOpen.firstChild.textContent = copy.details + ' ';
  const dismiss = document.querySelector('#activity-dismiss');
  dismiss.textContent = copy.dismiss;
  dismiss.setAttribute('aria-label', copy.dismissLabel);
  dismiss.title = copy.dismissLabel;
  game.setAttribute('aria-label', copy.game.label);
  gameTarget.setAttribute('aria-label', copy.game.target);
  gameTarget.title = copy.game.target;
  const asset = assets.get(pet.dataset.state);
  if (asset) portrait.alt = copy.name + ' · ' + (copy.assets[asset.id] ?? asset.label);
  if (activityInput) renderLogContent(message, activityInput, copy.activity);
  else if (bubble.classList.contains('open') && lastSpeech) message.textContent = formatSpeech(lastSpeech);
  updateGameHud();
}
bridge?.onLocale?.(setLocale);
let lastPoint = { x: -1, y: -1 };
const assets = new Map(ludensCatalog.assets.map(asset => [asset.id, asset]));
const effectImage = document.querySelector('#effect');
let requestedState = null, requestVersion = 0;
async function showPose({ state, effect }) {
  const overlay = assets.get(effect);
  effectImage.hidden = !overlay;
  if (overlay) effectImage.src = 'ludens/' + overlay.file;
  if (state === requestedState) return;
  const asset = assets.get(state);
  if (!asset || asset.kind !== 'state') return;
  requestedState = state;
  const version = ++requestVersion;
  try {
    const image = new Image(); image.src = 'ludens/' + asset.file;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (version !== requestVersion) return;
    // Calibrate head size, not the full silhouette; keep the button and alpha hit area aligned.
    pet.style.setProperty('--pose-scale', asset.display_scale ?? 1);
    // Commit art, layout and alpha together; slow decodes cannot overwrite a newer pose.
    portrait.src = image.src; alpha = pixels;
    portrait.alt = copy.name + ' · ' + (copy.assets[asset.id] ?? asset.label);
    pet.dataset.state = state;
    update(lastPoint);
  } catch (error) {
    if (version === requestVersion) requestedState = null;
    console.warn('Ludens pose unavailable:', state, error);
  }
}
const poses = createPetState(value => { void showPose(value); });
bridge?.onPose?.(value => {
  if (!value || (value.state !== null && assets.get(value.state)?.kind !== 'state')) return;
  if (value.effect !== null && assets.get(value.effect)?.kind !== 'effect') return;
  poses.choose(value.state, value.effect);
});
const poseTimer = setInterval(() => poses.refresh(), 1000);
window.addEventListener('pagehide', () => { clearInterval(poseTimer); stopGame(); });

function hit(point) {
  const rect = portrait.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  let x = (point.x - rect.left) / rect.width;
  const y = (point.y - rect.top) / rect.height;
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || !alpha) return false;
  // During the flip use the currently rendered direction, not its target.
  if (new DOMMatrixReadOnly(getComputedStyle(mirror).transform).a < 0) x = 1 - x;
  const px = Math.min(alpha.width - 1, Math.floor(x * alpha.width));
  return alpha.data[(Math.floor(y * alpha.height) * alpha.width + px) * 4 + 3] > 10;
}
function gameHit(point) {
  if (!gameActive || gameTarget.hidden) return false;
  const rect = gameTarget.getBoundingClientRect();
  return point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
}
function update(point) {
  lastPoint = point;
  const next = held !== null || hit(point) || activityHit(point) || gameHit(point);
  if (next !== interactive) { interactive = next; bridge?.interactive(next); }
}
function speak() {
  if (gameActive) return;
  const index = line % copy.lines.length;
  poses.interact(index % 2 ? '14-petted' : '13-poked');
  playClickSound();
  if (activityId) { activityOpen.focus(); return; }
  line++;
  clearTimeout(hideTimer);
  lastSpeech = { kind: 'line', index };
  message.textContent = formatSpeech(lastSpeech);
  bubble.classList.add('open');
  bubble.setAttribute('aria-hidden', 'false');
  hideTimer = setTimeout(hideBubble, 5000);
}
function hideBubble() { poses.activity(null); activityId = null; activityInput = null; lastSpeech = null; if (bubble.contains(document.activeElement)) pet.focus(); activityActions.hidden = true; delete message.dataset.blockId; bubble.classList.remove('open', 'activity'); bubble.setAttribute('aria-hidden', 'true'); update(lastPoint); }
let gameActive = false, gameFrame = 0, gameScoreValue = 0, bestScore = 0;
let gameStartedAt = 0, gameEndsAt = 0, targetExpiresAt = 0, nextSpawnAt = 0, lastHudAt = 0, lastSpot = -1;
const gameSpots = [[7, 20], [79, 18], [9, 59], [77, 57]];
function updateGameHud(seconds = 20) {
  gameScore.textContent = `★ ${gameScoreValue} / 10`;
  gameTime.textContent = `${seconds.toFixed(1)}s`;
}
function spawnStar(now) {
  let spot = Math.floor(Math.random() * gameSpots.length);
  if (spot === lastSpot) spot = (spot + 1) % gameSpots.length;
  lastSpot = spot;
  gameTarget.style.left = gameSpots[spot][0] + '%';
  gameTarget.style.top = gameSpots[spot][1] + '%';
  gameTarget.hidden = false;
  targetExpiresAt = now + Math.max(550, 1150 - (now - gameStartedAt) * .03);
  update(lastPoint);
}
function gameTick(now) {
  if (!gameActive) return;
  const remaining = Math.max(0, gameEndsAt - now);
  if (remaining === 0) { finishGame(); return; }
  if (now - lastHudAt >= 100) { updateGameHud(remaining / 1000); lastHudAt = now; }
  if (!gameTarget.hidden && now >= targetExpiresAt) {
    gameTarget.hidden = true;
    nextSpawnAt = now + 140;
    update(lastPoint);
  }
  if (gameTarget.hidden && now >= nextSpawnAt) spawnStar(now);
  gameFrame = requestAnimationFrame(gameTick);
}
function startGame() {
  if (activityId) { void bridge?.dismissActivity(activityId); hideBubble(); }
  stopGame();
  hideBubble();
  gameActive = true;
  gameScoreValue = 0;
  gameStartedAt = performance.now();
  gameEndsAt = gameStartedAt + 20000;
  nextSpawnAt = gameStartedAt;
  lastHudAt = 0;
  lastSpot = -1;
  poses.game(true);
  game.hidden = false;
  gameTarget.hidden = true;
  updateGameHud();
  gameFrame = requestAnimationFrame(gameTick);
  update(lastPoint);
}
function stopGame() {
  if (!gameActive) return;
  gameActive = false;
  cancelAnimationFrame(gameFrame);
  game.hidden = true;
  gameTarget.hidden = true;
  poses.game(false);
  update(lastPoint);
}
function finishGame() {
  const score = gameScoreValue;
  stopGame();
  bestScore = Math.max(bestScore, score);
  poses.interact(score >= 10 ? '10-success' : '11-failure', 1800);
  lastSpeech = { kind: 'game', score };
  message.textContent = formatSpeech(lastSpeech);
  bubble.classList.add('open');
  bubble.setAttribute('aria-hidden', 'false');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBubble, 5000);
}
gameTarget.addEventListener('click', () => {
  if (!gameActive || gameTarget.hidden) return;
  gameScoreValue++;
  playClickSound();
  poses.interact('14-petted', 260);
  gameTarget.hidden = true;
  nextSpawnAt = performance.now() + 100;
  updateGameHud(Math.max(0, gameEndsAt - performance.now()) / 1000);
  update(lastPoint);
});
bridge?.onGame?.(value => { if (value === 'start') startGame(); });
pet.addEventListener('pointerdown', event => {
  if (gameActive || event.button !== 0 || !hit({ x: event.clientX, y: event.clientY })) return;
  event.preventDefault();
  held = event.pointerId;
  pet.setPointerCapture(held);
  body.classList.add('pressed');
  poses.interact('15-dragged', Infinity);
  bridge?.beginDrag();
});
async function release(event, cancelled = false) {
  if (held === null) return;
  const pointer = held;
  held = null;
  body.classList.remove('pressed');
  const moved = await bridge?.endDrag(cancelled);
  if (pet.hasPointerCapture(pointer)) pet.releasePointerCapture(pointer);
  poses.interact(!cancelled && moved ? '16-land' : '01-idle', cancelled ? 0 : 900);
  if (!cancelled && !moved) speak();
  if (event) update({ x: event.clientX, y: event.clientY });
}
pet.addEventListener('pointerup', event => { void release(event); });
pet.addEventListener('pointermove', () => { if (held !== null) bridge?.moveDrag(); });
pet.addEventListener('pointercancel', event => { void release(event, true); });
pet.addEventListener('lostpointercapture', event => { void release(event, true); });
window.addEventListener('blur', () => { void release(null, true); });
document.addEventListener('contextmenu', event => { event.preventDefault(); bridge?.menu(); });
pet.addEventListener('dblclick', () => bridge?.open());
pet.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); speak(); }
  if (event.key === 'Escape') { if (activityId) void bridge?.dismissActivity(activityId); hideBubble(); }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); bridge?.menu(); }
});
document.addEventListener('mousemove', event => update({ x: event.clientX, y: event.clientY }));
bridge?.onCursor(update);
bridge?.onFlip(value => { flipped = value; mirror.classList.toggle('flipped', value); });
let hitFrame = 0;
let hitUntil = 0;
document.addEventListener('transitionrun', () => {
  hitUntil = performance.now() + 550;
  if (hitFrame) return;
  function tick() {
    update(lastPoint);
    hitFrame = performance.now() < hitUntil ? requestAnimationFrame(tick) : 0;
  }
  hitFrame = requestAnimationFrame(tick);
});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
bridge?.reducedMotion(reducedMotion.matches);
reducedMotion.addEventListener('change', event => bridge?.reducedMotion(event.matches));
setLocale(locale);
async function prepare() {
  await portrait.decode();
  const canvas = document.createElement('canvas');
  canvas.width = portrait.naturalWidth; canvas.height = portrait.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(portrait, 0, 0);
  alpha = ctx.getImageData(0, 0, canvas.width, canvas.height);
  await document.querySelector('#bubble img').decode();
  try { if (bridge?.getSound) configureSound(await bridge.getSound()); }
  catch { console.warn('Pet sound settings unavailable'); }
  poses.refresh();
  bridge?.ready();
}
void prepare().catch(error => console.error('Companion asset failed:', error));
