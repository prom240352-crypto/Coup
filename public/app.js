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
  const storageKey = 'coup-last-room';
  let state = null;
  let pendingTargetAction = null;
  let selectedExchange = new Set();
  let exchangeSignature = '';
  let toastTimeout;
  let tutorialIndex = 0;
  let soundEnabled = true;
  let soundVolume = 0.35;
  let audioContext = null;
  let lastLogLength = 0;

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

  function playSound(kind = 'tap') {
    if (!soundEnabled || soundVolume <= 0) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext ||= new AudioContextClass();
      if (audioContext.state === 'suspended') audioContext.resume();
      const notes = kind === 'action' ? [440, 554] : kind === 'challenge' ? [220, 330] : [660];
      notes.forEach((frequency, index) => {
        const start = audioContext.currentTime + index * 0.07;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, soundVolume * 0.045), start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.19);
      });
    } catch (error) {
      console.warn('Audio playback is unavailable:', error);
    }
  }

  function updateSoundControls() {
    const toggle = byId('sound-toggle');
    toggle.textContent = soundEnabled ? '♫' : '×';
    toggle.setAttribute('aria-label', soundEnabled ? 'Turn sound off' : 'Turn sound on');
    toggle.title = soundEnabled ? 'Turn sound off' : 'Turn sound on';
    byId('volume-slider').value = String(Math.round(soundVolume * 100));
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

  async function createRoom() {
    const name = byId('player-name').value.trim();
    if (!name) return setStatus('Enter your name first.');
    setStatus('Creating room...');
    const response = await emitWithAck('createRoom', { name });
    if (response.error) return setStatus(response.error);
    saveRoom(response.code, name);
    setStatus(`Room ${response.code} created.`, 'waiting-status');
    byId('room-code-input').value = response.code;
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
      if (targeting && index !== myIndex && player.alive) classes.push('seat-target');
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
      const color = item.color ? ` style="background:${characterColors[item.color]}"` : '';
      return `<button class="action-btn${disabled ? ' disabled' : ''}" type="button" data-select-action="${item.action}"${disabled ? ' disabled' : ''}><span class="char-icon"${color}>${item.icon}</span><span class="action-name">${item.label}</span><span class="action-cost">${item.detail}</span></button>`;
    }).join('');
    content.innerHTML = `<h3>Your Turn</h3><div class="action-grid">${buttons}</div><p class="target-hint" id="target-hint">${pendingTargetAction ? 'Choose a living player at the table.' : ''}</p>`;
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

    const me = state.players[state.myIndex];
    const current = state.players[state.currentPlayer];
    const selectedAction = state.selectedAction;
    const isActionPlayer = state.myIndex === state.currentPlayer;
    const isTarget = state.selectedTarget === state.myIndex;
    const challengeable = !['foreign_aid', 'income', 'coup'].includes(selectedAction);
    const allowedCounter = selectedAction === 'foreign_aid' ? ['duke'] : selectedAction === 'assassinate' && isTarget ? ['contessa'] : selectedAction === 'steal' && isTarget ? ['captain', 'ambassador'] : [];
    const hasCounter = lastActionHasCounter();
    const options = [];

    if (state.counterChallengePhase && isActionPlayer && state.pendingCounter) {
      options.push(`<button class="challenge-option" type="button" data-counter-challenge><span class="challenge-option-title">Challenge the counterclaim</span><span class="challenge-option-desc">${escapeHtml(current.name)} claimed ${characterNames[state.pendingCounter.char] || 'a role'}.</span></button>`);
    } else if (!isActionPlayer) {
      if (challengeable) options.push(`<button class="challenge-option" type="button" data-challenge><span class="challenge-option-title">Challenge ${escapeHtml(current.name)}</span><span class="challenge-option-desc">Contest the claim of ${actionLabel(selectedAction)}.</span></button>`);
      if (allowedCounter.length && !hasCounter && !state.counterChallengePhase) {
        options.push(...allowedCounter.map(character => `<button class="challenge-option" type="button" data-counter="${character}"><span class="challenge-option-title">Block with ${characterNames[character]}</span><span class="challenge-option-desc">Claim ${characterNames[character]} to block.</span></button>`));
      }
    }

    const waiting = options.length ? '' : `<p class="modal-copy">${isActionPlayer ? 'Waiting for challenges or blocks...' : 'Waiting for the other players...'}</p>`;
    panel.innerHTML = `<h3>${escapeHtml(current?.name || 'Player')} · ${escapeHtml(actionLabel(selectedAction))}</h3><div class="challenge-options">${options.join('')}</div>${waiting}`;
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
    const signature = hand.join(',');
    if (signature !== exchangeSignature) {
      exchangeSignature = signature;
      selectedExchange = new Set();
    }
    byId('exchange-cards').innerHTML = hand.map((character, index) => cardMarkup(character, index, selectedExchange.has(index), true)).join('');
    byId('exchange-count').textContent = `${selectedExchange.size} / 2 selected`;
    byId('confirm-exchange').disabled = selectedExchange.size !== 2;
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
    const me = state.players[state.myIndex];
    const current = state.players[state.currentPlayer];
    byId('game-code').textContent = `ROOM ${state.code}`;
    byId('my-coins').textContent = String(me?.coins ?? 0);
    byId('deck-count').textContent = String(state.deckCount ?? 0);
    byId('turn-indicator').textContent = state.state === 'finished' ? 'Game Over' : `${current?.name || 'Player'}'s turn`;
    byId('connection-state').textContent = socket?.connected ? 'Connected' : 'Reconnecting...';
    byId('game-message').textContent = state.phase === 'selecting' ? (state.currentPlayer === state.myIndex ? 'Choose an action.' : 'Waiting for the active player.') : state.phase === 'challenging' ? 'Challenge or block the claim.' : state.phase === 'exchange_select' ? 'Choose cards to keep.' : 'Resolving action...';
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

    if (button.id === 'create-room') return createRoom();
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
    if (button.hasAttribute('data-challenge')) return socket?.emit('challenge', { isCounterChallenge: false });
    if (button.dataset.counter) return socket?.emit('counter', { char: button.dataset.counter });
    if (button.hasAttribute('data-counter-challenge')) return socket?.emit('counterChallenge');
    if (button.dataset.exchangeIndex !== undefined) {
      const index = Number(button.dataset.exchangeIndex);
      if (selectedExchange.has(index)) selectedExchange.delete(index);
      else if (selectedExchange.size < 2) selectedExchange.add(index);
      if (state) renderExchange();
      return;
    }
    if (button.id === 'confirm-exchange') {
      socket?.emit('exchangeSelect', { keepIndices: [...selectedExchange] });
      byId('exchange-modal').classList.remove('active');
      return;
    }
    if (button.id === 'open-rules') {
      byId('rules-modal').classList.add('active');
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
      soundEnabled = !soundEnabled;
      try { localStorage.setItem('coup-sound-enabled', String(soundEnabled)); } catch {}
      updateSoundControls();
      if (soundEnabled) playSound();
      return;
    }
    if (button.dataset.emoji) {
      socket?.emit('emojiReaction', { emoji: button.dataset.emoji });
      showFloatingEmoji(button.dataset.emoji);
      playSound();
    }
  });

  byId('volume-slider').addEventListener('input', event => {
    soundVolume = Number(event.target.value) / 100;
    try { localStorage.setItem('coup-sound-volume', String(soundVolume)); } catch {}
  });

  byId('room-code-input').addEventListener('input', event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      byId('rules-modal').classList.remove('active');
      byId('tutorial-modal').classList.remove('active');
      if (state?.phase !== 'exchange_select') byId('exchange-modal').classList.remove('active');
    }
    if (event.key === 'Enter' && document.activeElement === byId('player-name')) createRoom();
    if (event.key === 'Enter' && document.activeElement === byId('room-code-input')) joinRoom();
  });

  if (socket) {
    socket.on('connect', async () => {
      byId('connection-state').textContent = 'Connected';
      setStatus('Connected. Create a room or join with a code.');
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
      const entries = nextState.log || [];
      const appended = entries.slice(Math.min(lastLogLength, entries.length));
      if (appended.some(entry => entry.type === 'action')) playSound('action');
      else if (appended.some(entry => entry.type === 'challenge' || entry.type === 'counter')) playSound('challenge');
      lastLogLength = entries.length;
      state = nextState;
      const saved = readSavedRoom();
      if (state.code && saved?.name) saveRoom(state.code, saved.name);
      render();
    });
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

  try {
    soundEnabled = localStorage.getItem('coup-sound-enabled') !== 'false';
    const storedVolume = Number(localStorage.getItem('coup-sound-volume'));
    if (Number.isFinite(storedVolume) && storedVolume >= 0 && storedVolume <= 1) soundVolume = storedVolume;
  } catch {}
  updateSoundControls();

  window.setInterval(updateTimer, 250);
})();
