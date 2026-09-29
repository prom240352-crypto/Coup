(() => {
  'use strict';

  const characterNames = {
    duke: 'Duke',
    assassin: 'Assassin',
    ambassador: 'Ambassador',
    captain: 'Captain',
    contessa: 'Contessa'
  };
  const characterColors = {
    duke: 'var(--duke)',
    assassin: 'var(--assassin)',
    ambassador: 'var(--ambassador)',
    captain: 'var(--captain)',
    contessa: 'var(--contessa)'
  };
  const actions = [
    { action: 'income', label: 'Income', detail: '+1 coin', icon: 'I' },
    { action: 'foreign_aid', label: 'Foreign Aid', detail: '+2 coins', icon: 'F' },
    { action: 'coup', label: 'Coup', detail: '7 coins', icon: 'C' },
    { action: 'tax', label: 'Tax', detail: 'Duke · +3', icon: 'D', color: 'duke' },
    { action: 'assassinate', label: 'Assassinate', detail: 'Assassin · 3 coins', icon: 'A', color: 'assassin' },
    { action: 'exchange', label: 'Exchange', detail: 'Ambassador', icon: 'M', color: 'ambassador' },
    { action: 'steal', label: 'Steal', detail: 'Captain', icon: 'S', color: 'captain' }
  ];
  const socket = typeof window.io === 'function' ? window.io() : null;
  const soundEngine = window.CoupSound || null;
  const storageKey = 'coup-last-room';
  let state = null;
  let pendingTargetAction = null;
  let pendingLeaveRoom = null;
  let createNewRoomInProgress = false;
  let selectedExchange = new Set();
  let exchangeSignature = '';
  let displayedCardRevealId = null;
  let cardRevealTimer = null;
  let toastTimeout;
  let tutorialIndex = 0;
  let previousAudioSnapshot = null;
  let previousAudioLog = [];
  let audioLogSequence = 0;
  let impactTimer = null;
  let leaveRequestInProgress = false;
  let cancelWaitingInProgress = false;

  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function setScreen(id) {
    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.toggle('active', screen.id === id);
    });
  }

  function setStatus(message, id = 'lobby-status') {
    const element = byId(id);
    if (element) element.textContent = message;
  }

  function showToast(message, isError = false) {
    const stack = byId('toast-stack');
    const toast = document.createElement('div');
    toast.className = `game-toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    stack.append(toast);
    window.setTimeout(() => toast.remove(), 3500);
  }

  function saveRoom(code, name) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ code, name }));
    } catch (error) {
      console.warn('Could not save reconnect details:', error);
    }
  }

  function readSavedRoom() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || 'null');
    } catch {
      return null;
    }
  }

  function clearSavedRoom() {
    try {
      localStorage.removeItem(storageKey);
    } catch (error) {
      console.warn('Could not clear reconnect details:', error);
    }
  }

  const tutorialSteps = [
    ['The Court', 'Each player begins with two hidden influence cards and two coins. Keep your cards secret and watch what others claim.'],
    ['Your Turn', 'Choose Income for one coin, Foreign Aid for two, or claim a role action. A Coup costs seven coins and cannot be blocked.'],
    ['Challenge Claims', 'Tax, Assassinate, Exchange, and Steal make role claims. Other players may challenge; a false claim loses influence.'],
    ['Block Actions', 'Duke blocks Foreign Aid, Contessa blocks Assassinate, and Captain or Ambassador blocks Steal. Blocks can also be challenged.'],
    ['Win the Court', 'Lose an influence card when challenged successfully or targeted by a Coup or Assassinate. The last player with influence wins.']
  ];

  function renderTutorial() {
    const [title, text] = tutorialSteps[tutorialIndex];
    byId('tutorial-content').innerHTML = `<h3>${escapeHtml(title)}</h3><p class="modal-copy">${escapeHtml(text)}</p>`;
    byId('tutorial-step-count').textContent = `${tutorialIndex + 1} / ${tutorialSteps.length}`;
    byId('tutorial-prev').disabled = tutorialIndex === 0;
    byId('tutorial-next').textContent = tutorialIndex === tutorialSteps.length - 1 ? 'Done' : 'Next';
  }

  function updateSoundControls() {
    const toggle = byId('sound-toggle');
    const soundState = soundEngine?.getState();
    const enabled = soundState?.enabled ?? false;
    toggle.textContent = enabled ? '♫' : '×';
    toggle.setAttribute('aria-label', enabled ? 'Turn sound off' : 'Turn sound on');
    toggle.title = enabled ? 'Turn sound off' : 'Turn sound on';
    toggle.disabled = !soundState?.supported;
    if (!soundState?.supported) toggle.title = 'Web Audio is not supported in this browser';
    byId('volume-slider').value = String(Math.round((soundState?.volume ?? 0.65) * 100));
    byId('volume-slider').disabled = !soundState?.supported;
    const settingsToggle = byId('sound-toggle-settings');
    settingsToggle.textContent = `Sound: ${enabled ? 'On' : 'Off'}`;
    settingsToggle.setAttribute('aria-pressed', String(enabled));
    settingsToggle.disabled = !soundState?.supported;
    byId('volume-slider-settings').value = String(Math.round((soundState?.volume ?? 0.65) * 100));
    byId('volume-slider-settings').disabled = !soundState?.supported;
    updateAudioDiagnostics();
  }

  function updateAudioDiagnostics(testResult) {
    if (!soundEngine) {
      byId('audio-debug-api').textContent = 'unavailable';
      byId('audio-debug-context').textContent = 'not created';
      byId('audio-debug-output').textContent = 'unavailable';
      byId('audio-debug-enabled').textContent = 'unavailable';
      byId('audio-debug-volume').textContent = 'unavailable';
      byId('audio-debug-last-sound').textContent = 'None';
      byId('audio-debug-error').textContent = 'Sound controller did not load';
      return;
    }
    const soundState = soundEngine.getState();
    byId('audio-debug-api').textContent = soundState.supported ? `${soundState.api} available` : 'unavailable';
    byId('audio-debug-context').textContent = soundState.contextState;
    byId('audio-debug-output').textContent = soundState.outputAvailable ? 'destination available' : 'destination unavailable';
    byId('audio-debug-enabled').textContent = soundState.enabled ? 'ON' : 'OFF';
    byId('audio-debug-volume').textContent = `${Math.round(soundState.volume * 100)}%`;
    byId('audio-debug-last-sound').textContent = soundState.lastSound.at
      ? `${soundState.lastSound.at} (${soundState.lastSound.type})`
      : 'None';
    byId('audio-debug-error').textContent = soundState.lastError || 'None';
    if (typeof testResult === 'boolean') {
      byId('audio-test-status').textContent = testResult
        ? 'Test tone scheduled. If silent, check device output/volume and read Audio Debug.'
        : soundState.lastError || 'Test tone could not be scheduled.';
    }
  }

  function playSound(name = 'ui', eventId) {
    if (soundEngine) void soundEngine.play(name, eventId);
  }

  function audioEntryKey(entry) {
    return `${entry.type || ''}:${entry.message || ''}`;
  }

  function getNewAudioEntries(previous, current) {
    const maxOverlap = Math.min(previous.length, current.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matches = true;
      for (let index = 0; index < overlap; index += 1) {
        if (audioEntryKey(previous[previous.length - overlap + index]) !== audioEntryKey(current[index])) {
          matches = false;
          break;
        }
      }
      if (matches) return current.slice(overlap);
    }
    return previous.length ? current : [];
  }

  function processAudioState(nextState) {
    const nextLog = nextState.log || [];
    const previous = previousAudioSnapshot;
    if (!previous) {
      previousAudioSnapshot = nextState;
      previousAudioLog = nextLog.slice();
      return;
    }

    const addedEntries = getNewAudioEntries(previousAudioLog, nextLog);
    const eventPrefix = `${nextState.code || 'room'}:${++audioLogSequence}`;
    let sawCounter = false;
    let challengedClaimSuccessfully = false;
    let challengedCounterSuccessfully = false;
    let impactKind = null;

    for (const entry of addedEntries) {
      const eventId = `${eventPrefix}:${entry.type}:${entry.message}`;
      if (entry.type === 'action') {
        playSound('cardCast', eventId);
        if (/\bcoups\b/i.test(entry.message)) impactKind = 'coup';
      }
      if (entry.type === 'counter') {
        sawCounter = true;
        impactKind = 'block';
        playSound('counter', eventId);
      }
      if (entry.type === 'challenge') {
        impactKind = 'challenge';
        if (/block challenge succeeds/i.test(entry.message)) {
          challengedCounterSuccessfully = true;
          challengedClaimSuccessfully = true;
          playSound('success', eventId);
        } else if (/challenge succeeds/i.test(entry.message)) {
          challengedClaimSuccessfully = true;
          playSound('success', eventId);
        } else if (/challenge fails/i.test(entry.message)) {
          playSound('failure', eventId);
        } else {
          playSound('challenge', eventId);
        }
      }
    }

    if (previous.state !== 'playing' && nextState.state === 'playing') {
      playSound('gameStart', `${eventPrefix}:start`);
    }
    if (previous.state !== 'finished' && nextState.state === 'finished') {
      playSound('gameEnd', `${eventPrefix}:end`);
    }

    for (const oldPlayer of previous.players || []) {
      const newPlayer = (nextState.players || []).find(player => player.id === oldPlayer.id);
      if (newPlayer && oldPlayer.cardCount > newPlayer.cardCount) {
        playSound(newPlayer.cardCount === 0 ? 'elimination' : 'loss', `${eventPrefix}:influence:${newPlayer.id}:${newPlayer.cardCount}`);
      }
    }

    const turnChanged = previous.state === 'playing' && nextState.state === 'playing'
      && previous.currentPlayer !== nextState.currentPlayer;
    if (turnChanged) {
      playSound('turn', `${eventPrefix}:turn:${nextState.currentPlayer}`);
      const actionFailed = challengedClaimSuccessfully && !challengedCounterSuccessfully;
      const actionBlocked = sawCounter && !challengedCounterSuccessfully && !challengedClaimSuccessfully;
      if (previous.selectedAction && !actionFailed && !actionBlocked) {
        playSound('success', `${eventPrefix}:action-success:${previous.selectedAction}`);
      }
    }

    if (impactKind) triggerImpact(impactKind);
    previousAudioSnapshot = nextState;
    previousAudioLog = nextLog.slice();
  }

  function emitWithAck(event, payload) {
    return new Promise(resolve => {
      if (!socket?.connected) {
        resolve({ error: 'Not connected to the game server.' });
        return;
      }
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) resolve({ error: 'The server did not respond. Please try again.' });
      }, 8000);
      socket.emit(event, payload, response => {
        settled = true;
        window.clearTimeout(timeout);
        resolve(response || {});
      });
    });
  }

  async function createRoom(nameOverride) {
    if (cancelWaitingInProgress) {
      setStatus('Leaving the previous room. Please wait.');
      return { error: 'Leaving the previous room.' };
    }
    if (createNewRoomInProgress) {
      setStatus('Leaving the previous room. Please wait.');
      return { error: 'Leaving the previous room.' };
    }
    const name = (nameOverride || byId('player-name').value).trim();
    if (!name) {
      setStatus('Enter your name first.', 'create-room-status');
      return { error: 'Enter your name first.' };
    }
    setStatus('Creating room...', 'create-room-status');
    byId('confirm-create-room').disabled = true;
    const response = await emitWithAck('createRoom', { name });
    byId('confirm-create-room').disabled = false;
    if (response.error) {
      setStatus(response.error, 'create-room-status');
      return response;
    }
    byId('player-name').value = name;
    saveRoom(response.code, name);
    setStatus(`Room ${response.code} created.`, 'waiting-status');
    byId('room-code-input').value = response.code;
    return response;
  }

  function unlockCreateNewRoomButton(message) {
    createNewRoomInProgress = false;
    pendingLeaveRoom = null;
    byId('create-new-room').disabled = false;
    if (message) setStatus(message);
  }

  async function finishPendingRoomLeave() {
    if (!pendingLeaveRoom || !socket?.connected || leaveRequestInProgress) return;
    leaveRequestInProgress = true;
    const response = await emitWithAck('leaveRoom', pendingLeaveRoom);
    leaveRequestInProgress = false;
    if (response.error && !socket.connected) {
      setStatus('Connection lost. Reconnecting to leave the finished room...');
      socket.connect();
      return;
    }
    pendingLeaveRoom = null;
    createNewRoomInProgress = false;
    byId('create-new-room').disabled = false;
    setStatus(response.error || 'You left the finished room. Create or join a room.');
  }

  async function createNewRoomFromResult() {
    if (createNewRoomInProgress) return;
    createNewRoomInProgress = true;
    byId('create-new-room').disabled = true;

    const saved = readSavedRoom();
    const currentPlayer = state?.players?.[state.myIndex];
    const name = currentPlayer?.name || saved?.name || byId('player-name').value.trim() || 'Player';
    const oldCode = state?.code || saved?.code || null;
    clearSavedRoom();
    byId('player-name').value = name;
    byId('create-room-name').value = name;
    byId('winner-modal').classList.remove('active');
    pendingLeaveRoom = oldCode ? { code: oldCode, name } : null;
    pendingTargetAction = null;
    state = null;
    previousAudioSnapshot = null;
    previousAudioLog = [];
    setScreen('lobby');
    setStatus('You are back in the lobby. Create or join a room.');

    if (!pendingLeaveRoom) {
      createNewRoomInProgress = false;
      byId('create-new-room').disabled = false;
      return;
    }
    if (!socket) return unlockCreateNewRoomButton('The game server is unavailable. You are back at the lobby.');
    if (!socket.connected) {
      setStatus('Reconnecting only to leave the finished room...');
      socket.connect();
      return;
    }
    await finishPendingRoomLeave();
  }

  function openCreateRoomScreen() {
    byId('create-room-name').value = byId('player-name').value;
    byId('create-room-status').textContent = '';
    setScreen('create-room-screen');
  }

  async function cancelWaitingRoom() {
    if (state?.state !== 'lobby' || !state.code || cancelWaitingInProgress) return;
    if (!socket?.connected) {
      setStatus('Connection lost. Reconnect before leaving the room.', 'waiting-status');
      return;
    }

    cancelWaitingInProgress = true;
    const code = state.code;
    byId('cancel-waiting').disabled = true;
    clearSavedRoom();
    pendingTargetAction = null;
    selectedExchange.clear();
    exchangeSignature = '';
    state = null;
    byId('player-name').value = '';
    byId('create-room-name').value = '';
    byId('room-code-input').value = '';
    byId('create-room-status').textContent = '';
    setScreen('lobby');
    setStatus('You left the room. Create or join a room.');

    const response = await emitWithAck('cancelWaitingRoom', { code });
    cancelWaitingInProgress = false;
    byId('cancel-waiting').disabled = false;
    if (response.error) setStatus(response.error);
  }

  async function joinRoom() {
    const name = byId('player-name').value.trim();
    const code = byId('room-code-input').value.trim().toUpperCase();
    if (!name) return setStatus('Enter your name first.');
    if (!code) return setStatus('Enter a room code.');
    setStatus('Joining room...');
    const response = await emitWithAck('joinRoom', { code, name });
    if (response.error) return setStatus(response.error);
    saveRoom(code, name);
    setStatus(`Joined room ${code}.`, 'waiting-status');
  }

  function renderWaiting() {
    setScreen('waiting');
    byId('copy-room-code').textContent = state.code || '-----';
    const players = state.players || [];
    const host = state.myIndex === 0;
    byId('waiting-players').innerHTML = Array.from({ length: 6 }, (_, index) => {
      const player = players[index];
      if (!player) return `<div class="player-slot empty"><span class="player-avatar">+</span><span>Waiting for player</span></div>`;
      return `<div class="player-slot filled"><span class="player-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(player.name)}</span>${player.isMe ? '<span class="connection-indicator">YOU</span>' : ''}</div>`;
    }).join('');
    const start = byId('start-game');
    start.disabled = !host || players.length < 2;
    start.textContent = host ? (players.length < 2 ? 'Waiting for Players' : 'Start Game') : 'Waiting for Host';
    setStatus(`${players.length} / 6 players`, 'waiting-status');
  }

  function cardMarkup(character, index, selected = false, exchange = false) {
    const name = characterNames[character] || character;
    const imagePath = `/cards/${encodeURIComponent(character)}.jpg`;
    if (exchange) {
      return `<button class="exchange-card${selected ? ' selected' : ''}" type="button" data-exchange-index="${index}" aria-pressed="${selected}" aria-label="${escapeHtml(name)}${selected ? ', selected' : ''}"><img src="${imagePath}" alt=""><span>${escapeHtml(name)}</span></button>`;
    }
    return `<div class="hand-card"><div class="hand-card-inner"><img src="${imagePath}" alt="${escapeHtml(name)}"><span class="card-label">${escapeHtml(name)}</span></div><span class="card-glow" style="background:${characterColors[character] || 'var(--gold)'}"></span></div>`;
  }

  function renderSeats() {
    const players = state.players || [];
    const myIndex = state.myIndex;
    const currentIndex = state.currentPlayer;
    const targeting = Boolean(pendingTargetAction && state.phase === 'selecting' && currentIndex === myIndex);
    const selectedTarget = Number.isInteger(state.selectedTarget) ? state.selectedTarget : null;
    const targetFocus = targeting || selectedTarget !== null;
    byId('game').classList.toggle('target-focus', targetFocus);
    const targetHint = byId('target-hint');
    if (targetHint) targetHint.textContent = targeting ? 'Choose a living player at the table.' : '';

    byId('player-seats').innerHTML = players.map((player, index) => {
      const offset = (index - myIndex + players.length) % players.length;
      const angle = (90 + offset * 360 / players.length) * Math.PI / 180;
      const left = 50 + Math.cos(angle) * 37;
      const top = 50 + Math.sin(angle) * 32;
      const classes = ['opponent-seat'];
      if (!player.alive) classes.push('dead');
      if (index === currentIndex) classes.push('active');
      if (targeting && index !== myIndex && player.alive) classes.push('seat-target', 'target-candidate');
      if (selectedTarget === index) classes.push('target-selected');
      const inner = `<span class="seat-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><span class="seat-name">${escapeHtml(player.name)}${player.isMe ? ' (You)' : ''}</span><span class="seat-info"><span class="seat-coins">${player.coins} C</span><span class="seat-cards">${player.cardCount} influence</span></span>${player.disconnected ? '<span class="connection-indicator">Reconnecting</span>' : ''}`;
      return `<div class="${classes.join(' ')}" style="left:${left}%;top:${top}%">${targeting && index !== myIndex && player.alive ? `<button class="seat-target" type="button" data-target-index="${index}" aria-label="Target ${escapeHtml(player.name)}">${inner}</button>` : inner}</div>`;
    }).join('');
  }

  function renderActions() {
    const panel = byId('action-panel');
    const content = byId('action-content');
    const me = state.players[state.myIndex];
    const myTurn = state.currentPlayer === state.myIndex && state.phase === 'selecting';
    if (!myTurn || !me?.alive) {
      panel.classList.remove('active');
      return;
    }
    panel.classList.add('active');
    const available = me.coins >= 10 ? actions.filter(item => item.action === 'coup') : actions;
    const buttons = available.map(item => {
      const disabled = (item.action === 'coup' && me.coins < 7) || (item.action === 'assassinate' && me.coins < 3);
      const selected = pendingTargetAction === item.action;
      const color = item.color ? ` style="background:${characterColors[item.color]}"` : '';
      return `<button class="action-btn${disabled ? ' disabled' : ''}${selected ? ' selected' : ''}" type="button" data-select-action="${item.action}" aria-pressed="${selected}"${disabled ? ' disabled' : ''}><span class="char-icon"${color}>${item.icon}</span><span class="action-name">${item.label}</span><span class="action-cost">${item.detail}</span></button>`;
    }).join('');
    content.innerHTML = `<h3>Your Turn</h3><div class="action-grid">${buttons}</div><p class="target-hint" id="target-hint" aria-live="polite">${pendingTargetAction ? `${escapeHtml(actionLabel(pendingTargetAction))} · Choose a living player.` : 'Select an action.'}</p>`;
  }

  function actionLabel(action) {
    return actions.find(item => item.action === action)?.label || action || 'Action';
  }

  function lastActionHasCounter() {
    const log = state.log || [];
    let actionIndex = -1;
    log.forEach((entry, index) => { if (entry.type === 'action') actionIndex = index; });
    return log.some((entry, index) => index > actionIndex && entry.type === 'counter');
  }

  function renderChallenge() {
    const panel = byId('challenge-panel');
    const shouldShow = state.phase === 'challenging';
    panel.classList.toggle('active', shouldShow);
    if (!shouldShow) {
      panel.innerHTML = '';
      return;
    }

    const current = state.players[state.currentPlayer];
    const responsePhase = state.responsePhase || { allowed: [], blockCharacters: [], responders: [] };
    const canRespond = responsePhase.allowed.length > 0;
    const options = [];

    if (responsePhase.allowed.includes('CHALLENGE')) {
      const label = responsePhase.kind === 'counter' ? 'Challenge the block' : `Challenge ${current?.name || 'the claim'}`;
      options.push(`<button class="challenge-option response-choice response-challenge" type="button" data-response="CHALLENGE" aria-pressed="false"><span class="challenge-option-title">Challenge</span><span class="challenge-option-desc">${escapeHtml(label)}.</span></button>`);
    }
    for (const character of responsePhase.blockCharacters || []) {
      options.push(`<button class="challenge-option response-choice response-block" type="button" data-response="BLOCK" data-block-character="${escapeHtml(character)}" aria-pressed="false"><span class="challenge-option-title">Block with ${escapeHtml(characterNames[character] || character)}</span><span class="challenge-option-desc">Claim ${escapeHtml(characterNames[character] || character)}.</span></button>`);
    }
    if (responsePhase.allowed.includes('PASS')) {
      options.push('<button class="challenge-option response-choice response-pass" type="button" data-response="PASS" aria-pressed="false"><span class="challenge-option-title">Pass</span></button>');
    }

    const responders = (responsePhase.responders || []).map(responder => {
      const status = responder.status === 'waiting' ? 'Waiting...' : `✓ ${responder.status}`;
      const statusClass = `response-${String(responder.status).toLowerCase().replace(/[^a-z]/g, '')}`;
      return `<div class="response-status ${statusClass}"><span>${escapeHtml(responder.name)}</span><span>${escapeHtml(status)}</span></div>`;
    }).join('');
    panel.innerHTML = `<div class="response-flow" aria-live="polite"><strong>${escapeHtml(actionLabel(state.selectedAction).toUpperCase())}</strong><span aria-hidden="true">↓</span><span>${canRespond ? 'YOUR RESPONSE' : 'WAITING FOR RESPONSE'}</span></div><h3>${escapeHtml(current?.name || 'Player')} made a claim</h3><div class="challenge-options">${options.join('')}</div><div class="response-statuses" aria-live="polite">${responders}</div>${options.length ? '' : '<p class="modal-copy">Waiting for responses...</p>'}`;
  }

  function renderExchange() {
    const modal = byId('exchange-modal');
    const isExchange = state.phase === 'exchange_select' && state.exchangePhase === 'selecting';
    const hand = state.exchangeHand;
    modal.classList.toggle('active', Boolean(isExchange && Array.isArray(hand)));
    if (!isExchange || !Array.isArray(hand)) {
      exchangeSignature = '';
      selectedExchange = new Set();
      return;
    }
    const keepCount = Math.min(state.players[state.myIndex]?.cardCount || 0, hand.length);
    const signature = hand.join(',');
    if (signature !== exchangeSignature) {
      exchangeSignature = signature;
      selectedExchange = new Set();
    }
    byId('exchange-cards').innerHTML = hand.map((character, index) => cardMarkup(character, index, selectedExchange.has(index), true)).join('');
    byId('exchange-count').textContent = `${selectedExchange.size} / ${keepCount} selected`;
    byId('confirm-exchange').disabled = selectedExchange.size !== keepCount;
  }

  function showCardReveal(reveal) {
    const banner = byId('card-reveal');
    if (!banner) return;
    if (!reveal) {
      if (cardRevealTimer) window.clearTimeout(cardRevealTimer);
      cardRevealTimer = null;
      displayedCardRevealId = null;
      banner.hidden = true;
      return;
    }
    if (reveal.id === displayedCardRevealId) return;
    displayedCardRevealId = reveal.id;
    triggerImpact(reveal.reason === 'coup' ? 'coup' : 'loss');
    const character = characterNames[reveal.card] || reveal.card;
    banner.innerHTML = `<span class="card-reveal-copy"><span>${escapeHtml(reveal.playerName)} lost Influence</span><strong>${escapeHtml(character)}</strong><small>INFLUENCE -1</small></span><img class="revealed-card-image" src="/cards/${encodeURIComponent(reveal.card)}.jpg" alt="${escapeHtml(character)} revealed">`;
    banner.hidden = false;
    if (cardRevealTimer) window.clearTimeout(cardRevealTimer);
    cardRevealTimer = window.setTimeout(() => {
      banner.hidden = true;
      cardRevealTimer = null;
    }, 2800);
  }

  function triggerImpact(kind) {
    const game = byId('game');
    if (impactTimer) window.clearTimeout(impactTimer);
    game.classList.remove('impact-feedback');
    game.dataset.impact = kind;
    void game.offsetWidth;
    game.classList.add('impact-feedback');
    impactTimer = window.setTimeout(() => {
      game.classList.remove('impact-feedback');
      delete game.dataset.impact;
      impactTimer = null;
    }, 260);
  }

  function renderLog() {
    byId('game-log').innerHTML = (state.log || []).slice(-18).map(entry => `<div class="log-entry ${escapeHtml(entry.type)}">${escapeHtml(entry.message)}</div>`).join('');
    const log = byId('game-log');
    log.scrollTop = log.scrollHeight;
  }

  function updateTimer() {
    if (!state || !state.timerEnd) {
      byId('timer-text').textContent = '';
      byId('timer-progress').style.strokeDashoffset = '0';
      return;
    }
    const remaining = Math.max(0, state.timerEnd - Date.now());
    const duration = Math.max(1, state.timerDuration || 10000);
    const fraction = Math.min(1, remaining / duration);
    byId('timer-text').textContent = String(Math.ceil(remaining / 1000));
    byId('timer-progress').style.strokeDashoffset = String(339.292 * (1 - fraction));
  }

  function renderGame() {
    setScreen('game');
    showCardReveal(state.cardReveal);
    const me = state.players[state.myIndex];
    const current = state.players[state.currentPlayer];
    byId('game-code').textContent = `ROOM ${state.code}`;
    byId('my-coins').textContent = String(me?.coins ?? 0);
    byId('deck-count').textContent = String(state.deckCount ?? 0);
    byId('turn-indicator').textContent = state.state === 'finished' ? 'Game Over' : `${current?.name || 'Player'}'s turn`;
    byId('connection-state').textContent = socket?.connected ? 'Connected' : 'Reconnecting...';
    byId('game-message').textContent = state.state === 'finished' ? 'Game over.' : state.phase === 'selecting' ? (state.currentPlayer === state.myIndex ? 'Choose an action.' : 'Waiting for the active player.') : state.phase === 'challenging' ? `${actionLabel(state.selectedAction)} · Waiting for response.` : state.phase === 'exchange_select' ? 'Exchange · Choose cards to keep.' : `${actionLabel(state.selectedAction)} · Resolving...`;
    if (state.phase !== 'selecting') pendingTargetAction = null;
    renderSeats();
    renderActions();
    renderChallenge();
    renderExchange();
    renderLog();
    byId('player-hand').innerHTML = (me?.cards || []).map(cardMarkup).join('');
    updateTimer();

    if (state.state === 'finished') {
      const winner = state.players.find(player => player.id === state.winner);
      byId('winner-message').textContent = `${winner?.name || 'A player'} controls the court.`;
      byId('winner-modal').classList.add('active');
    } else {
      byId('winner-modal').classList.remove('active');
    }
  }

  function render() {
    if (!state) {
      setScreen('lobby');
      return;
    }
    if (state.state === 'lobby') renderWaiting();
    else renderGame();
  }

  function showFloatingEmoji(emoji, playerId) {
    const item = document.createElement('span');
    item.className = 'emoji-float';
    item.textContent = emoji;
    item.style.left = `${20 + Math.random() * 60}%`;
    item.style.bottom = '20px';
    item.dataset.playerId = playerId || '';
    document.body.append(item);
    window.setTimeout(() => item.remove(), 1900);
  }

  function chooseAction(action) {
    const targeted = ['coup', 'assassinate', 'steal'].includes(action);
    if (targeted) {
      pendingTargetAction = action;
      renderGame();
      return;
    }
    pendingTargetAction = null;
    socket?.emit('selectAction', { action, target: null });
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;

    if (button.id === 'create-room') return openCreateRoomScreen();
    if (button.id === 'confirm-create-room') return createRoom(byId('create-room-name').value);
    if (button.id === 'cancel-waiting') return cancelWaitingRoom();
    if (button.id === 'join-room') return joinRoom();
    if (button.id === 'start-game') return socket?.emit('startGame');
    if (button.id === 'copy-room-code') {
      try {
        await navigator.clipboard.writeText(state?.code || '');
        showToast('Room code copied.');
      } catch {
        showToast(`Room code: ${state?.code || ''}`);
      }
      return;
    }
    if (button.dataset.selectAction) return chooseAction(button.dataset.selectAction);
    if (button.dataset.targetIndex !== undefined) {
      if (pendingTargetAction) socket?.emit('selectAction', { action: pendingTargetAction, target: Number(button.dataset.targetIndex) });
      pendingTargetAction = null;
      return;
    }
    if (button.dataset.response) {
      button.classList.add('is-selected');
      button.setAttribute('aria-pressed', 'true');
      button.disabled = true;
      const response = { type: button.dataset.response };
      if (button.dataset.blockCharacter) response.char = button.dataset.blockCharacter;
      if (response.type === 'PASS') playSound('ui', `${state?.code}:response:${state?.log?.length || 0}:${state?.myIndex}:pass`);
      return socket?.emit('actionResponse', response, result => {
        if (result?.error) {
          showToast(result.error, true);
          if (state) renderChallenge();
        }
      });
    }
    if (button.dataset.exchangeIndex !== undefined) {
      const index = Number(button.dataset.exchangeIndex);
      const keepCount = Math.min(state?.players[state.myIndex]?.cardCount || 0, state?.exchangeHand?.length || 0);
      if (selectedExchange.has(index)) selectedExchange.delete(index);
      else if (selectedExchange.size < keepCount) selectedExchange.add(index);
      if (state) renderExchange();
      return;
    }
    if (button.id === 'confirm-exchange') {
      socket?.emit('exchangeSelect', { keepIndices: [...selectedExchange] }, result => {
        if (result?.error) {
          showToast(result.error, true);
          return;
        }
        byId('exchange-modal').classList.remove('active');
      });
      return;
    }
    if (button.id === 'open-rules') {
      byId('rules-modal').classList.add('active');
      return;
    }
    if (button.id === 'open-audio-settings' || button.id === 'open-audio-settings-game') {
      updateSoundControls();
      byId('audio-settings-modal').classList.add('active');
      return;
    }
    if (button.id === 'close-audio-settings') {
      byId('audio-settings-modal').classList.remove('active');
      return;
    }
    if (button.id === 'test-sound') {
      byId('audio-test-status').textContent = 'Starting 600 Hz test tone...';
      const testResult = soundEngine?.testSound();
      updateAudioDiagnostics();
      Promise.resolve(testResult).then(result => {
        updateAudioDiagnostics(Boolean(result));
        updateSoundControls();
      });
      return;
    }
    if (button.id === 'sound-toggle-settings') {
      const wasEnabled = soundEngine?.getState().enabled ?? false;
      soundEngine?.setEnabled(!wasEnabled);
      updateSoundControls();
      if (!wasEnabled) playSound('ui', `settings-toggle:${Date.now()}`);
      return;
    }
    if (button.id === 'close-rules') {
      byId('rules-modal').classList.remove('active');
      return;
    }
    if (button.id === 'rematch') {
      byId('winner-modal').classList.remove('active');
      state = null;
      socket?.emit('rematch');
      return;
    }
    if (button.id === 'create-new-room') return createNewRoomFromResult();
    if (button.id === 'open-tutorial') {
      tutorialIndex = 0;
      renderTutorial();
      byId('tutorial-modal').classList.add('active');
      return;
    }
    if (button.id === 'close-tutorial') {
      byId('tutorial-modal').classList.remove('active');
      return;
    }
    if (button.id === 'tutorial-prev') {
      tutorialIndex = Math.max(0, tutorialIndex - 1);
      renderTutorial();
      return;
    }
    if (button.id === 'tutorial-next') {
      if (tutorialIndex === tutorialSteps.length - 1) byId('tutorial-modal').classList.remove('active');
      else tutorialIndex += 1;
      renderTutorial();
      return;
    }
    if (button.id === 'sound-toggle') {
      const wasEnabled = soundEngine?.getState().enabled ?? false;
      soundEngine?.setEnabled(!wasEnabled);
      updateSoundControls();
      if (!wasEnabled) playSound('ui', `toggle:${Date.now()}`);
      return;
    }
    if (button.dataset.emoji) {
      socket?.emit('emojiReaction', { emoji: button.dataset.emoji });
      showFloatingEmoji(button.dataset.emoji);
      playSound();
    }
  });

  for (const slider of [byId('volume-slider'), byId('volume-slider-settings')]) {
    slider.addEventListener('input', event => {
      soundEngine?.setVolume(Number(event.target.value) / 100);
      updateSoundControls();
    });
  }

  byId('room-code-input').addEventListener('input', event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      byId('rules-modal').classList.remove('active');
      byId('tutorial-modal').classList.remove('active');
      byId('audio-settings-modal').classList.remove('active');
      if (state?.phase !== 'exchange_select') byId('exchange-modal').classList.remove('active');
    }
    if (event.key === 'Enter' && document.activeElement === byId('player-name')) openCreateRoomScreen();
    if (event.key === 'Enter' && document.activeElement === byId('create-room-name')) createRoom(byId('create-room-name').value);
    if (event.key === 'Enter' && document.activeElement === byId('room-code-input')) joinRoom();
  });

  if (socket) {
    socket.on('connect', async () => {
      byId('connection-state').textContent = 'Connected';
      setStatus('Connected. Create a room or join with a code.');
      if (pendingLeaveRoom) {
        await finishPendingRoomLeave();
        return;
      }
      const saved = readSavedRoom();
      if (!saved?.code || !saved?.name || state) return;
      byId('player-name').value = saved.name;
      const result = await emitWithAck('reconnect', saved);
      if (result.error) {
        clearSavedRoom();
        setStatus('Previous room is no longer available. Create or join a room.');
      }
    });
    socket.on('gameState', nextState => {
      if (createNewRoomInProgress && pendingLeaveRoom) return;
      processAudioState(nextState);
      state = nextState;
      const saved = readSavedRoom();
      if (state.code && saved?.name) saveRoom(state.code, saved.name);
      render();
    });
    socket.on('card_revealed', reveal => showCardReveal(reveal));
    socket.on('emojiReaction', data => showFloatingEmoji(data.emoji, data.playerId));
    socket.on('disconnect', () => {
      byId('connection-state').textContent = 'Reconnecting...';
      setStatus('Connection lost. Reconnecting...', state ? 'waiting-status' : 'lobby-status');
    });
    socket.on('connect_error', error => {
      setStatus(`Could not connect to the game server: ${error.message}`);
    });
  } else {
    setStatus('The Socket.IO client did not load. Reload the page to try again.');
  }

  updateSoundControls();

  window.setInterval(updateTimer, 250);
})();
