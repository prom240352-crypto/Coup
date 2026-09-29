const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const CHARACTERS = {
  duke: { name: 'Duke', color: '#e91e63', action: 'tax', block: 'foreign_aid' },
  assassin: { name: 'Assassin', color: '#424242', action: 'assassinate', block: null },
  ambassador: { name: 'Ambassador', color: '#8bc34a', action: 'exchange', block: 'steal' },
  captain: { name: 'Captain', color: '#00bcd4', action: 'steal', block: 'steal' },
  contessa: { name: 'Contessa', color: '#f44336', action: null, block: 'assassinate' }
};

function createDeck(playerCount) {
  const perChar = 3;
  const deck = [];
  for (let i = 0; i < perChar; i++) {
    for (const char of Object.keys(CHARACTERS)) {
      deck.push(char);
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateUniqueCode() {
  let code = generateCode();
  while (rooms.has(code)) code = generateCode();
  return code;
}

function createRoom(hostId, hostName) {
  const code = generateUniqueCode();
  const room = {
    code,
    players: [{ id: hostId, name: hostName, coins: 2, cards: [], alive: true, disconnected: false, disconnectTimer: null }],
    state: 'lobby',
    phase: 'waiting',
    deck: [],
    discard: [],
    currentPlayer: 0,
    selectedAction: null,
    selectedTarget: null,
    pendingChallenges: new Set(),
    pendingCounters: new Set(),
    challengeResults: [],
    counterResults: [],
    responsePhase: null,
    timer: null,
    timerEnd: null,
    winner: null,
    log: [],
    cardReveal: null,
    cardRevealSequence: 0,
    // Exchange UI state
    exchangePhase: null,       // null | 'selecting'
    exchangeDrawn: [],         // cards drawn for exchange
    exchangeHand: [],          // full hand shown to player during exchange
    // Counter challenge state
    counterChallengePhase: false,
    counterChallengeTimer: null,
    counterChallengeTimerEnd: null,
    pendingCounter: null,      // the counter being challenged
    // Last lost card info for animation
    lastLostCard: null,
    lastLostPlayerIndex: null,
    // Reconnection
    disconnectTimers: new Map(), // playerId -> timeout
    actionToken: 0,
    resolvedActionToken: null
  };
  rooms.set(code, room);
  return room;
}

function leaveFinishedRoom(room, playerId) {
  if (!room || room.state !== 'finished') return { error: 'You can only leave a finished room this way.' };
  const playerIndex = room.players.findIndex(player => player.id === playerId);
  if (playerIndex < 0) return { error: 'Player is not in this room.' };

  const [player] = room.players.splice(playerIndex, 1);
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  const disconnectTimer = room.disconnectTimers.get(player.name);
  if (disconnectTimer === player.disconnectTimer) room.disconnectTimers.delete(player.name);

  if (room.players.length === 0) {
    if (room.timer) clearTimeout(room.timer);
    if (room.counterChallengeTimer) clearTimeout(room.counterChallengeTimer);
    rooms.delete(room.code);
  }
  return { success: true, code: room.code, remainingPlayers: room.players.length };
}

function cancelWaitingRoom(room, playerId) {
  if (!room || room.state !== 'lobby') return { error: 'You can only cancel a room while waiting for players.' };
  const playerIndex = room.players.findIndex(player => player.id === playerId);
  if (playerIndex < 0) return { error: 'Player is not in this room.' };

  const [player] = room.players.splice(playerIndex, 1);
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  const disconnectTimer = room.disconnectTimers.get(player.name);
  if (disconnectTimer === player.disconnectTimer) room.disconnectTimers.delete(player.name);

  if (room.players.length === 0) {
    if (room.timer) clearTimeout(room.timer);
    if (room.counterChallengeTimer) clearTimeout(room.counterChallengeTimer);
    rooms.delete(room.code);
  }
  return { success: true, code: room.code, remainingPlayers: room.players.length };
}

function startGame(room) {
  const playerCount = room.players.length;
  room.deck = createDeck(playerCount);
  
  for (const player of room.players) {
    player.cards = [room.deck.pop(), room.deck.pop()];
    player.coins = 2;
    player.alive = true;
    player.disconnected = false;
  }
  
  room.state = 'playing';
  room.phase = 'selecting';
  room.currentPlayer = 0;
  room.exchangePhase = null;
  room.counterChallengePhase = false;
  room.responsePhase = null;
  room.actionToken = 0;
  room.resolvedActionToken = null;
  room.log.push({ type: 'system', message: 'Game started!' });
  
  startSelectionTimer(room);
}

function startSelectionTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  
  const player = room.players[room.currentPlayer];
  if (!player || !player.alive) {
    nextTurn(room);
    return;
  }
  
  // Auto-coup if 10+ coins
  if (player.coins >= 10) {
    room.phase = 'selecting';
    room.log.push({ type: 'system', message: `${player.name} has 10+ coins - must Coup!` });
    broadcastRoom(room);
    return;
  }
  
  room.timerEnd = Date.now() + 10000;
  room.timerDuration = 10000;
  broadcastRoom(room);
  
  room.timer = setTimeout(() => {
    if (room.phase === 'selecting' && !room.selectedAction) {
      executeAction(room, 'income', null);
    }
  }, 10000);
}

function findRoom(playerId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === playerId)) return room;
  }
  return null;
}

function findRoomByCode(code) {
  return rooms.get(code?.toUpperCase()) || null;
}

function getPlayerView(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return null;
  
  const view = {
    code: room.code,
    deckCount: room.deck.length,
    state: room.state,
    phase: room.phase,
    currentPlayer: room.currentPlayer,
    selectedAction: room.selectedAction,
    selectedTarget: room.selectedTarget,
    timerEnd: room.phase === 'challenging' ? null : room.timerEnd,
    timerDuration: room.timerDuration || 10000,
    myIndex: room.players.findIndex(p => p.id === playerId),
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      coins: p.coins,
      cardCount: p.cards.length,
      alive: p.alive,
      isMe: p.id === playerId,
      disconnected: p.disconnected || false,
      cards: p.id === playerId ? p.cards : null
    })),
    myCards: player.cards,
    winner: room.winner,
    log: room.log.slice(-30),
    // Exchange UI
    exchangePhase: room.exchangePhase,
    exchangeHand: room.exchangePhase === 'selecting' && player.id === room.players[room.currentPlayer]?.id
      ? room.exchangeHand : null,
    // Counter challenge
    counterChallengePhase: room.counterChallengePhase,
    counterChallengeTimerEnd: room.counterChallengeTimerEnd,
    counterChallengeDuration: room.counterChallengeDuration || 6000,
    pendingCounter: room.pendingCounter,
    responsePhase: room.responsePhase ? {
      kind: room.responsePhase.kind,
      responders: room.responsePhase.displayResponders.map(playerIndex => {
        const player = room.players[playerIndex];
        const response = room.responsePhase.responses.find(entry => entry.playerIndex === playerIndex);
        return player ? { name: player.name, status: response?.type || 'waiting' } : null;
      }).filter(Boolean),
      allowed: room.responsePhase.eligibleResponders.includes(room.players.findIndex(entry => entry.id === playerId))
        ? room.responsePhase.allowedByPlayer[room.players.findIndex(entry => entry.id === playerId)]?.types || []
        : [],
      blockCharacters: room.responsePhase.eligibleResponders.includes(room.players.findIndex(entry => entry.id === playerId))
        ? room.responsePhase.allowedByPlayer[room.players.findIndex(entry => entry.id === playerId)]?.blockCharacters || []
        : []
    } : null,
    // Card reveal
    lastLostCard: room.lastLostCard,
    lastLostPlayerIndex: room.lastLostPlayerIndex,
    cardReveal: room.cardReveal ? {
      id: room.cardReveal.id,
      playerIndex: room.cardReveal.playerIndex,
      playerName: room.cardReveal.playerName,
      card: room.cardReveal.card,
      reason: room.cardReveal.reason
    } : null
  };
  return view;
}

function broadcastRoom(room) {
  for (const player of room.players) {
    if (player.disconnected) continue;
    const view = getPlayerView(room, player.id);
    io.to(player.id).emit('gameState', view);
  }
}

function checkWinner(room) {
  const alive = room.players.filter(p => p.alive && p.cards.length > 0);
  if (alive.length === 1) {
    room.state = 'finished';
    room.phase = 'finished';
    room.winner = alive[0].id;
    room.log.push({ type: 'system', message: `${alive[0].name} wins!` });
    if (room.timer) clearTimeout(room.timer);
    return true;
  }
  return false;
}

function nextTurn(room) {
  if (room.timer) clearTimeout(room.timer);
  room.actionToken += 1;
  room.selectedAction = null;
  room.selectedTarget = null;
  room.pendingChallenges.clear();
  room.pendingCounters.clear();
  room.challengeResults = [];
  room.counterResults = [];
  room.responsePhase = null;
  room.exchangePhase = null;
  room.exchangeDrawn = [];
  room.exchangeHand = [];
  room.counterChallengePhase = false;
  room.pendingCounter = null;
  room.lastLostCard = null;
  room.lastLostPlayerIndex = null;
  if (room.counterChallengeTimer) clearTimeout(room.counterChallengeTimer);
  
  do {
    room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
  } while (!room.players[room.currentPlayer].alive || room.players[room.currentPlayer].cards.length === 0);
  
  room.phase = 'selecting';
  startSelectionTimer(room);
}

function executeAction(room, action, target) {
  if (room.phase !== 'selecting') return;
  if (room.timer) clearTimeout(room.timer);
  const actionToken = ++room.actionToken;
  room.resolvedActionToken = null;
  const player = room.players[room.currentPlayer];
  
  switch (action) {
    case 'income':
      player.coins += 1;
      room.selectedAction = action;
      room.phase = 'resolving';
      room.log.push({ type: 'action', message: `${player.name} takes Income (+1 coin)` });
      broadcastRoom(room);
      setTimeout(() => {
        if (!checkWinner(room)) nextTurn(room);
        else broadcastRoom(room);
      }, 800);
      break;
      
    case 'foreign_aid':
      room.selectedAction = action;
      room.log.push({ type: 'action', message: `${player.name} takes Foreign Aid (+2 coins)` });
      beginActionResponses(room);
      break;
      
    case 'coup':
      if (player.coins < 7 || target === null) return;
      player.coins -= 7;
      room.selectedAction = action;
      room.selectedTarget = target;
      room.phase = 'resolving';
      room.log.push({ type: 'action', message: `${player.name} coups ${room.players[target].name}!` });
      broadcastRoom(room);
      setTimeout(() => {
        loseInfluence(room, target);
        if (!checkWinner(room)) nextTurn(room);
        else broadcastRoom(room);
      }, 1200);
      break;
      
    case 'tax':
      room.selectedAction = action;
      room.log.push({ type: 'action', message: `${player.name} claims Duke and takes Tax (+3 coins)` });
      beginActionResponses(room);
      break;
      
    case 'assassinate':
      if (player.coins < 3 || target === null) return;
      player.coins -= 3;
      room.selectedAction = action;
      room.selectedTarget = target;
      room.log.push({ type: 'action', message: `${player.name} claims Assassin and targets ${room.players[target].name}` });
      beginActionResponses(room);
      break;
      
    case 'exchange':
      room.selectedAction = action;
      room.log.push({ type: 'action', message: `${player.name} claims Ambassador and exchanges cards` });
      beginActionResponses(room);
      break;
      
    case 'steal':
      if (target === null) return;
      room.selectedAction = action;
      room.selectedTarget = target;
      room.log.push({ type: 'action', message: `${player.name} claims Captain and steals from ${room.players[target].name}` });
      beginActionResponses(room);
      break;
  }
}

function getActionResolver(action) {
  return {
    foreign_aid: resolveForeignAid,
    tax: resolveTax,
    assassinate: resolveAssassinate,
    exchange: resolveExchange,
    steal: resolveSteal
  }[action] || null;
}

function beginActionResponses(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.timerEnd = null;
  room.counterChallengeTimerEnd = null;
  room.phase = 'challenging';
  room.counterResults = [];
  room.challengeResults = [];
  room.counterChallengePhase = false;
  room.pendingCounter = null;

  const actorIndex = room.currentPlayer;
  const action = room.selectedAction;
  const alivePlayers = room.players
    .map((player, index) => player.alive && player.cards.length > 0 ? index : -1)
    .filter(index => index >= 0 && index !== actorIndex);
  const targetIndex = room.selectedTarget;
  const blockCharacters = {
    foreign_aid: ['duke'],
    assassinate: ['contessa'],
    steal: ['captain', 'ambassador']
  }[action] || [];
  const allowedByPlayer = {};
  const eligibleResponders = [];

  for (const playerIndex of alivePlayers) {
    const allowed = [];
    const canBlock = blockCharacters.length && (action === 'foreign_aid' || playerIndex === targetIndex);
    if (action !== 'foreign_aid') allowed.push('CHALLENGE');
    if (canBlock) allowed.push('BLOCK');
    if (!allowed.length) continue;
    allowed.push('PASS');
    eligibleResponders.push(playerIndex);
    allowedByPlayer[playerIndex] = {
      types: allowed,
      blockCharacters: canBlock ? blockCharacters : []
    };
  }

  room.responsePhase = {
    kind: 'action',
    eligibleResponders,
    displayResponders: eligibleResponders.slice(),
    allowedByPlayer,
    responses: []
  };
  broadcastRoom(room);

  if (eligibleResponders.length === 0) resolveCurrentAction(room);
}

function resolveCurrentAction(room) {
  const resolve = getActionResolver(room.selectedAction);
  if (!resolve) return;
  room.responsePhase = null;
  room.counterChallengePhase = false;
  room.pendingCounter = null;
  resolve(room);
}

function beginCounterResponse(room, blockerIndex, char) {
  const phase = room.responsePhase;
  const actorIndex = room.currentPlayer;
  room.counterResults = [{ playerIndex: blockerIndex, char }];
  room.pendingCounter = { playerIndex: blockerIndex, char };
  room.counterChallengePhase = true;
  room.responsePhase = {
    kind: 'counter',
    eligibleResponders: [actorIndex],
    displayResponders: [...new Set([...(phase?.displayResponders || []), actorIndex])],
    allowedByPlayer: { [actorIndex]: { types: ['CHALLENGE', 'PASS'], blockCharacters: [] } },
    responses: [...(phase?.responses || []), { playerIndex: blockerIndex, type: 'BLOCK' }]
  };
  room.log.push({ type: 'counter', message: `${room.players[blockerIndex].name} blocks with ${CHARACTERS[char].name}!` });
  broadcastRoom(room);
}

function submitActionResponse(room, playerIndex, type, char) {
  const phase = room.responsePhase;
  if (!room || room.phase !== 'challenging' || !phase) return { error: 'No response phase is active.' };
  if (!phase.eligibleResponders.includes(playerIndex)) return { error: 'You are not eligible to respond.' };
  if (phase.responses.some(response => response.playerIndex === playerIndex)) return { error: 'You have already responded.' };
  const allowed = phase.allowedByPlayer[playerIndex]?.types || [];
  if (!allowed.includes(type)) return { error: 'That response is not allowed.' };

  if (type === 'BLOCK') {
    const allowedChars = phase.allowedByPlayer[playerIndex]?.blockCharacters || [];
    if (!allowedChars.includes(char)) return { error: 'That block is not allowed.' };
    beginCounterResponse(room, playerIndex, char);
    return { success: true };
  }

  phase.responses.push({ playerIndex, type });
  if (type === 'CHALLENGE') {
    room.challengeResults.push({ playerIndex, counterChallenge: phase.kind === 'counter' });
    room.log.push({ type: 'challenge', message: `${room.players[playerIndex].name} challenges${phase.kind === 'counter' ? ' the counter' : ''}!` });
    resolveCurrentAction(room);
    return { success: true };
  }

  if (phase.kind === 'counter') resolveCurrentAction(room);
  else if (phase.responses.filter(response => response.type === 'PASS').length === phase.eligibleResponders.length) resolveCurrentAction(room);
  else broadcastRoom(room);
  return { success: true };
}

function resolveWithAnimation(room, resolveFn) {
  const token = room.actionToken;
  if (room.resolvedActionToken === token) return;
  room.phase = 'resolving';
  broadcastRoom(room);
  setTimeout(() => {
    if (room.actionToken !== token || room.resolvedActionToken === token) return;
    room.resolvedActionToken = token;
    resolveFn(room);
  }, 1200);
}

function resolveForeignAid(room) {
  resolveWithAnimation(room, (room) => {
    const player = room.players[room.currentPlayer];
    const counter = room.counterResults.find(r => r.char === 'duke');

    if (counter) {
      const blocker = room.players[counter.playerIndex];
      const counterChallenge = room.challengeResults.find(r => r.counterChallenge);
      room.log.push({ type: 'counter', message: `${blocker.name} blocks Foreign Aid with Duke!` });

      if (counterChallenge) {
        const hasDuke = blocker.cards.includes('duke');
        if (hasDuke) {
          room.log.push({ type: 'challenge', message: `${blocker.name} has Duke - block challenge fails!` });
          loseInfluence(room, counterChallenge.playerIndex);
          if (!checkWinner(room)) nextTurn(room);
          else broadcastRoom(room);
          return;
        }

        room.log.push({ type: 'challenge', message: `${blocker.name} doesn't have Duke - block challenge succeeds!` });
        loseInfluence(room, counter.playerIndex);
        if (checkWinner(room)) { broadcastRoom(room); return; }
        player.coins += 2;
      } else {
        // A valid Duke block stops Foreign Aid completely.
        if (!checkWinner(room)) nextTurn(room);
        else broadcastRoom(room);
        return;
      }
    } else {
      player.coins += 2;
    }

    if (!checkWinner(room)) nextTurn(room);
    else broadcastRoom(room);
  });
}

function resolveTax(room) {
  resolveWithAnimation(room, (room) => {
    const player = room.players[room.currentPlayer];
    const challenge = room.challengeResults.find(r => true);
    if (challenge) {
      const challenger = room.players[challenge.playerIndex];
      const hasDuke = player.cards.includes('duke');
      room.log.push({ type: 'challenge', message: `${challenger.name} challenges!` });
      if (hasDuke) {
        room.log.push({ type: 'challenge', message: `${player.name} has Duke - challenge fails!` });
        loseInfluence(room, challenge.playerIndex);
      } else {
        room.log.push({ type: 'challenge', message: `${player.name} doesn't have Duke - challenge succeeds!` });
        loseInfluence(room, room.currentPlayer);
        if (!checkWinner(room)) { nextTurn(room); return; }
      }
    } else {
      player.coins += 3;
    }
    if (!checkWinner(room)) nextTurn(room);
    else broadcastRoom(room);
  });
}

function resolveAssassinate(room) {
  resolveWithAnimation(room, (room) => {
    const player = room.players[room.currentPlayer];
    const target = room.players[room.selectedTarget];
    const contessaCounter = room.counterResults.find(r => r.char === 'contessa');
    if (contessaCounter) {
      room.log.push({ type: 'counter', message: `${target.name} counters with Contessa!` });
      // Check if action player already challenged the counter
      const counterChallenge = room.challengeResults.find(r => r.counterChallenge);
      if (counterChallenge) {
        const targetHasContessa = target.cards.includes('contessa');
        if (targetHasContessa) {
          room.log.push({ type: 'challenge', message: `${target.name} has Contessa - challenge fails!` });
          loseInfluence(room, counterChallenge.playerIndex);
        } else {
          room.log.push({ type: 'challenge', message: `${target.name} doesn't have Contessa - challenge succeeds!` });
          loseInfluence(room, room.selectedTarget);
        }
        if (!checkWinner(room)) nextTurn(room);
        else broadcastRoom(room);
        return;
      }
      // No counter challenge yet - counter succeeds, action is blocked
      if (!checkWinner(room)) nextTurn(room);
      else broadcastRoom(room);
      return;
    }
    const challenge = room.challengeResults.find(r => !r.counterChallenge);
    if (challenge) {
      const hasAssassin = player.cards.includes('assassin');
      room.log.push({ type: 'challenge', message: `${room.players[challenge.playerIndex].name} challenges!` });
      if (hasAssassin) {
        room.log.push({ type: 'challenge', message: `${player.name} has Assassin - challenge fails!` });
        loseInfluence(room, challenge.playerIndex);
      } else {
        room.log.push({ type: 'challenge', message: `${player.name} doesn't have Assassin - challenge succeeds!` });
        loseInfluence(room, room.currentPlayer);
        if (!checkWinner(room)) { nextTurn(room); return; }
      }
    } else if (!contessaCounter) {
      loseInfluence(room, room.selectedTarget);
    }
    if (!checkWinner(room)) nextTurn(room);
    else broadcastRoom(room);
  });
}

function resolveExchange(room) {
  resolveWithAnimation(room, (room) => {
    const player = room.players[room.currentPlayer];
    const challenge = room.challengeResults.find(r => !r.counterChallenge);
    if (challenge) {
      const hasAmbassador = player.cards.includes('ambassador');
      room.log.push({ type: 'challenge', message: `${room.players[challenge.playerIndex].name} challenges!` });
      if (hasAmbassador) {
        room.log.push({ type: 'challenge', message: `${player.name} has Ambassador - challenge fails!` });
        loseInfluence(room, challenge.playerIndex);
      } else {
        room.log.push({ type: 'challenge', message: `${player.name} doesn't have Ambassador - challenge succeeds!` });
        loseInfluence(room, room.currentPlayer);
        if (!checkWinner(room)) { nextTurn(room); return; }
      }
    } else if (room.deck.length >= 2) {
      beginExchangeSelection(room);
      return;
    }

    if (!checkWinner(room)) nextTurn(room);
    else broadcastRoom(room);
  });
}

function beginExchangeSelection(room) {
  const player = room.players[room.currentPlayer];
  const drawn = [room.deck.pop(), room.deck.pop()];
  room.exchangeDrawn = drawn;
  room.exchangeHand = [...player.cards, ...drawn];
  room.exchangePhase = 'selecting';
  room.phase = 'exchange_select';
  room.timerEnd = Date.now() + 15000;
  room.timerDuration = 15000;
  room.log.push({ type: 'system', message: `${player.name} draws 2 cards - choosing which to keep...` });
  broadcastRoom(room);

  if (room.timer) clearTimeout(room.timer);
  const token = room.actionToken;
  room.timer = setTimeout(() => {
    if (room.actionToken === token && room.exchangePhase === 'selecting') {
      autoDiscardExchange(room);
    }
  }, 15000);
}

function finishExchange(room, keepIndices, automatic = false) {
  const player = room.players[room.currentPlayer];
  const hand = Array.isArray(room.exchangeHand) ? room.exchangeHand.slice() : [];
  if (!player || room.exchangePhase !== 'selecting' || hand.length === 0) return false;

  const keepCount = player.cards.length;
  if (keepCount < 1 || hand.length < keepCount) return false;
  const indices = automatic && keepIndices == null
    ? Array.from({ length: keepCount }, (_, i) => i)
    : keepIndices;
  if (!Array.isArray(indices) || indices.length !== keepCount
    || indices.some(index => !Number.isInteger(index) || index < 0 || index >= hand.length)
    || new Set(indices).size !== indices.length) return false;

  const keepSet = new Set(indices);
  const kept = [];
  const returned = [];
  for (let i = 0; i < hand.length; i++) {
    if (keepSet.has(i) && kept.length < keepCount) kept.push(hand[i]);
    else returned.push(hand[i]);
  }

  // Exchange cards are returned to the deck, never silently discarded.
  room.deck.push(...returned);
  for (let i = room.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
  }
  player.cards = kept;

  room.exchangePhase = null;
  room.exchangeDrawn = [];
  room.exchangeHand = [];
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.timerEnd = null;
  room.log.push({ type: 'system', message: `${player.name} finished exchanging cards${automatic ? ' (auto)' : ''}` });
  return true;
}

function autoDiscardExchange(room) {
  if (!finishExchange(room, null, true)) return;
  if (!checkWinner(room)) nextTurn(room);
  else broadcastRoom(room);
}

function resolveSteal(room) {
  resolveWithAnimation(room, (room) => {
    const player = room.players[room.currentPlayer];
    const target = room.players[room.selectedTarget];
    const counter = room.counterResults.find(r => r.char === 'captain' || r.char === 'ambassador');
    if (counter) {
      room.log.push({ type: 'counter', message: `${target.name} counters with ${CHARACTERS[counter.char].name}!` });
      const challenge = room.challengeResults.find(r => r.counterChallenge);
      if (challenge) {
        const targetHasCard = target.cards.includes(counter.char);
        if (targetHasCard) {
          room.log.push({ type: 'challenge', message: `${target.name} has ${CHARACTERS[counter.char].name} - challenge fails!` });
          loseInfluence(room, challenge.playerIndex);
        } else {
          room.log.push({ type: 'challenge', message: `${target.name} doesn't have ${CHARACTERS[counter.char].name} - challenge succeeds!` });
          loseInfluence(room, room.selectedTarget);
        }
        if (!checkWinner(room)) nextTurn(room);
        else broadcastRoom(room);
        return;
      }
      // No counter challenge - counter succeeds
      if (!checkWinner(room)) nextTurn(room);
      else broadcastRoom(room);
      return;
    }
    const challenge = room.challengeResults.find(r => !r.counterChallenge);
    if (challenge) {
      const hasCaptain = player.cards.includes('captain');
      room.log.push({ type: 'challenge', message: `${room.players[challenge.playerIndex].name} challenges!` });
      if (hasCaptain) {
        room.log.push({ type: 'challenge', message: `${player.name} has Captain - challenge fails!` });
        loseInfluence(room, challenge.playerIndex);
      } else {
        room.log.push({ type: 'challenge', message: `${player.name} doesn't have Captain - challenge succeeds!` });
        loseInfluence(room, room.currentPlayer);
        if (!checkWinner(room)) { nextTurn(room); return; }
      }
    } else if (!counter) {
      const stolen = Math.min(2, target.coins);
      target.coins -= stolen;
      player.coins += stolen;
    }
    if (!checkWinner(room)) nextTurn(room);
    else broadcastRoom(room);
  });
}

function resolveChallenge(room) {
  const action = room.selectedAction;
  const player = room.players[room.currentPlayer];
  const challenge = room.challengeResults.find(r => !r.counterChallenge);
  
  if (!challenge) return;
  
  const challenger = room.players[challenge.playerIndex];
  
  // Determine which card to check based on action
  let requiredCard = null;
  switch (action) {
    case 'tax': requiredCard = 'duke'; break;
    case 'assassinate': requiredCard = 'assassin'; break;
    case 'exchange': requiredCard = 'ambassador'; break;
    case 'steal': requiredCard = 'captain'; break;
    default: return;
  }
  
  room.phase = 'resolving';
  room.log.push({ type: 'challenge', message: `${challenger.name} challenges ${player.name}'s ${action}!` });
  broadcastRoom(room);
  
  setTimeout(() => {
    const hasCard = player.cards.includes(requiredCard);
    
    if (hasCard) {
      // Action player wins - challenger loses influence
      room.log.push({ type: 'challenge', message: `${player.name} has ${CHARACTERS[requiredCard].name} - challenge fails!` });
      loseInfluence(room, challenge.playerIndex);
      
      // Action player must put the card back and draw a new one (optional rule)
      // For simplicity, we just resolve the action normally
      resolveActionSuccess(room, action);
    } else {
      // Challenger wins - action player loses influence
      room.log.push({ type: 'challenge', message: `${player.name} doesn't have ${CHARACTERS[requiredCard].name} - challenge succeeds!` });
      loseInfluence(room, room.currentPlayer);
      
      // Action is cancelled, no effect
      if (!checkWinner(room)) nextTurn(room);
      else broadcastRoom(room);
    }
  }, 1500);
}

function resolveActionSuccess(room, action) {
  // Apply the action effect
  const player = room.players[room.currentPlayer];
  
  switch (action) {
    case 'tax':
      player.coins += 3;
      break;
    case 'assassinate':
      loseInfluence(room, room.selectedTarget);
      break;
    case 'exchange':
      if (room.deck.length >= 2) {
        beginExchangeSelection(room);
        return;
      }
      break;
    case 'steal':
      const target = room.players[room.selectedTarget];
      const stolen = Math.min(2, target.coins);
      target.coins -= stolen;
      player.coins += stolen;
      break;
  }
  
  if (!checkWinner(room)) nextTurn(room);
  else broadcastRoom(room);
}

function loseInfluence(room, playerIndex) {
  const player = room.players[playerIndex];
  if (player.cards.length > 0) {
    const lost = player.cards.pop();
    room.discard.push(lost);
    // Store for card reveal animation
    room.lastLostCard = lost;
    room.lastLostPlayerIndex = playerIndex;
    const reveal = {
      id: `${room.code}:${++room.cardRevealSequence}`,
      playerIndex,
      playerName: player.name,
      card: lost,
      reason: room.selectedAction || null
    };
    room.cardReveal = reveal;
    io.to(room.code).emit('card_revealed', reveal);
    room.log.push({ type: 'system', message: `${player.name} loses ${CHARACTERS[lost].name}` });
    if (player.cards.length === 0) {
      player.alive = false;
    }
  }
}

// ============ SOCKET HANDLERS ============
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  
  socket.on('createRoom', ({ name }, callback) => {
    const room = createRoom(socket.id, name);
    socket.join(room.code);
    callback({ code: room.code });
    broadcastRoom(room);
  });
  
  socket.on('joinRoom', ({ code, name }, callback) => {
    const room = findRoomByCode(code);
    if (!room) return callback({ error: 'Room not found' });
    if (room.state !== 'lobby') return callback({ error: 'Game already in progress' });
    if (room.players.length >= 6) return callback({ error: 'Room is full' });
    
    room.players.push({ id: socket.id, name, coins: 2, cards: [], alive: true, disconnected: false, disconnectTimer: null });
    socket.join(room.code);
    callback({ success: true });
    broadcastRoom(room);
  });

  // Reconnection handler
  socket.on('reconnect', ({ code, name }, callback) => {
    const room = findRoomByCode(code);
    if (!room) return callback({ error: 'Room not found' });
    
    const player = room.players.find(p => p.name === name && p.disconnected);
    if (!player) return callback({ error: 'Player not found or not disconnected' });
    
    // Cancel disconnect timer
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    
    // Update socket ID
    const oldId = player.id;
    player.id = socket.id;
    player.disconnected = false;

    if (room.exchangePhase === 'selecting' && room.currentPlayer === room.players.indexOf(player)) {
      room.timerEnd = Date.now() + 15000;
      room.timerDuration = 15000;
      const token = room.actionToken;
      room.timer = setTimeout(() => {
        if (room.actionToken === token && room.exchangePhase === 'selecting') autoDiscardExchange(room);
      }, 15000);
    }
    
    socket.join(room.code);
    room.log.push({ type: 'system', message: `${player.name} reconnected!` });
    
    callback({ success: true });
    broadcastRoom(room);
  });
  
  socket.on('startGame', () => {
    const room = findRoom(socket.id);
    if (!room || room.players[0].id !== socket.id) return;
    if (room.players.length < 2) return;
    
    startGame(room);
    broadcastRoom(room);
  });
  
  socket.on('selectAction', ({ action, target }) => {
    const room = findRoom(socket.id);
    if (!room || room.phase !== 'selecting') return;
    
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayer) return;
    
    room.selectedAction = action;
    room.selectedTarget = target;
    
    executeAction(room, action, target);
  });

  // Exchange card selection
  socket.on('exchangeSelect', (payload = {}, callback) => {
    const room = findRoom(socket.id);
    if (!room || room.exchangePhase !== 'selecting' || room.phase !== 'exchange_select') {
      return callback?.({ error: 'No active Exchange selection.' });
    }

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayer) return callback?.({ error: 'Only the active player may select Exchange cards.' });

    if (!finishExchange(room, payload?.keepIndices, false)) {
      return callback?.({ error: 'Invalid Exchange selection.' });
    }

    callback?.({ success: true });
    if (!checkWinner(room)) nextTurn(room);
    else broadcastRoom(room);
  });

  socket.on('actionResponse', (payload = {}, callback) => {
    const room = findRoom(socket.id);
    if (!room) return callback?.({ error: 'You are not in a room.' });
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    const { type, char } = payload && typeof payload === 'object' ? payload : {};
    const response = submitActionResponse(room, playerIndex, type, char);
    callback?.(response);
  });

  // Emoji reactions
  socket.on('emojiReaction', ({ emoji }) => {
    const room = findRoom(socket.id);
    if (!room) return;
    socket.to(room.code).emit('emojiReaction', { emoji, playerId: socket.id });
  });

  socket.on('leaveRoom', (payload = {}, callback) => {
    const room = payload.code ? findRoomByCode(payload.code) : findRoom(socket.id);
    if (!room) return callback?.({ success: true });
    if (room.state !== 'finished') return callback?.({ error: 'You can only leave a finished room this way.' });

    const player = room.players.find(entry => entry.id === socket.id)
      || room.players.find(entry => entry.disconnected && payload.name && entry.name === payload.name);
    if (!player) return callback?.({ success: true });
    const result = leaveFinishedRoom(room, player.id);
    if (result.error) return callback?.(result);
    if (player.id === socket.id) socket.leave(room.code);
    broadcastRoom(room);
    callback?.(result);
  });

  socket.on('cancelWaitingRoom', (payload = {}, callback) => {
    const room = payload.code ? findRoomByCode(payload.code) : findRoom(socket.id);
    if (!room) return callback?.({ success: true });
    const result = cancelWaitingRoom(room, socket.id);
    if (result.error) return callback?.(result);
    socket.leave(room.code);
    if (result.remainingPlayers > 0) broadcastRoom(room);
    callback?.(result);
  });

  // Rematch request
  socket.on('rematch', () => {
    const room = findRoom(socket.id);
    if (!room || room.state !== 'finished') return;
    
    // Reset room for new game
    room.state = 'lobby';
    room.phase = 'waiting';
    room.winner = null;
    room.deck = [];
    room.discard = [];
    room.currentPlayer = 0;
    room.selectedAction = null;
    room.selectedTarget = null;
    room.log = [];
    room.exchangePhase = null;
    room.exchangeDrawn = [];
    room.exchangeHand = [];
    room.counterChallengePhase = false;
    room.pendingCounter = null;
    room.lastLostCard = null;
    room.lastLostPlayerIndex = null;
    room.cardReveal = null;
    room.actionToken = 0;
    room.resolvedActionToken = null;
    
    // Reset players
    for (const player of room.players) {
      player.coins = 2;
      player.cards = [];
      player.alive = true;
      player.disconnected = false;
    }
    
    room.log.push({ type: 'system', message: 'Rematch! Back to lobby.' });
    io.to(room.code).emit('rematchReady');
    broadcastRoom(room);
  });
  
  socket.on('disconnect', () => {
    const room = findRoom(socket.id);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.disconnected = true;
        room.log.push({ type: 'system', message: `${player.name} disconnected - 60s to reconnect` });
        
        // If it's their turn during exchange_select, pause timer
        if (room.exchangePhase === 'selecting' && room.players.indexOf(player) === room.currentPlayer) {
          if (room.timer) clearTimeout(room.timer);
        }
        
        // Set a 60-second reconnect timer
        const disconnectTimer = setTimeout(() => {
          // Player didn't reconnect - treat as forfeit
          if (room.state === 'playing') {
            player.alive = false;
            player.cards = [];
            room.log.push({ type: 'system', message: `${player.name} forfeited (timeout)` });
            if (!checkWinner(room)) {
              if (room.players[room.currentPlayer]?.id === player.id) {
                nextTurn(room);
              }
              broadcastRoom(room);
            } else {
              broadcastRoom(room);
            }
          }
          room.disconnectTimers.delete(player.name);
        }, 60000);
        
        room.disconnectTimers.set(player.name, disconnectTimer);
        player.disconnectTimer = disconnectTimer;
        
        broadcastRoom(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Coup server running on port ${PORT}`);
  });
}

module.exports = {
  app, server, io, rooms, CHARACTERS, createDeck, createRoom, leaveFinishedRoom, cancelWaitingRoom, startGame, executeAction,
  resolveForeignAid, resolveSteal, resolveExchange, finishExchange, autoDiscardExchange,
  loseInfluence, getPlayerView, nextTurn, checkWinner, findRoomByCode
};
