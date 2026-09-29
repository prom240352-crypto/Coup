const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const soundApi=require('../public/sound');
const socketClient=require('socket.io-client').io;
const {server,io,rooms,createRoom,leaveFinishedRoom,cancelWaitingRoom,startGame,executeAction,finishExchange,autoDiscardExchange,resolveForeignAid,resolveSteal,loseInfluence,getPlayerView,checkWinner}=require('../server');

const publicDir=path.join(__dirname,'..','public');
const html=fs.readFileSync(path.join(publicDir,'index.html'),'utf8');
assert(html.includes('</style>') && html.includes('<body>') && html.includes('</body>') && html.includes('</html>'),'frontend HTML must be a complete document');
assert(html.includes('class="screen active" id="lobby"'),'frontend must render the lobby before JavaScript connects');
assert(html.includes('src="/socket.io/socket.io.js"'),'frontend must load the same-origin Socket.IO client');
assert(html.includes('<script src="/sound.js" defer></script>'),'frontend must load the sound controller');
assert(html.includes('src="/app.js"'),'frontend must load its game client');
assert(html.includes('id="sound-toggle"') && html.includes('id="volume-slider"'),'frontend must expose sound controls');
assert(html.includes('id="test-sound"') && html.includes('id="audio-debug-error"'),'audio settings must expose Test Sound and visible errors');
assert(html.indexOf('src="/sound.js"')<html.indexOf('src="/app.js"'),'sound controller must load before the game app');
assert(html.includes('id="rematch"') && html.includes('id="create-new-room"'),'result modal must offer rematch and create-new-room actions');
assert(html.includes('id="card-reveal"'),'frontend must provide a public card-reveal status element');
assert(html.includes('.action-btn.selected') && html.includes('.target-focus .opponent-seat:not(.target-selected)'),'action and target states must have clear selected and reduced-emphasis styling');
assert(html.includes('.response-flow') && html.includes('.response-challenge') && html.includes('.response-block') && html.includes('.response-pass'),'response choices and phase status must have distinct visual treatments');
assert(html.includes('@keyframes cardRevealFlip') && html.includes('@keyframes impactFlash') && html.includes('@keyframes screenEnter'),'brief reveal, impact, and screen transitions must be defined');
assert(html.includes('@media(prefers-reduced-motion:reduce)') && html.includes('.challenge-panel{width:min(400px,92vw);max-height:calc(100dvh - 28px);padding:16px}'),'motion and response controls must respect accessibility and small screens');
assert(html.includes('.winner-actions{display:flex;flex-direction:column') && html.includes('.winner-actions .btn{width:100%;min-height:46px'),'result actions must stack and remain tappable on narrow screens');
for (const asset of ['sound.js','app.js','rules-reference.jpg','cards/ambassador.jpg','cards/assassin.jpg','cards/captain.jpg','cards/contessa.jpg','cards/duke.jpg']) {
  assert(fs.existsSync(path.join(publicDir,asset)),`missing public asset: ${asset}`);
}
const client=fs.readFileSync(path.join(publicDir,'app.js'),'utf8');
assert(client.includes("socket.on('card_revealed'") && client.includes("showCardReveal(state.cardReveal)"),'the client must display the generic public card reveal event and reconnect state');
assert(!/localhost|127\.0\.0\.1/i.test(client),'browser client must not hard-code a development host');
assert(client.includes("if (button.id === 'rematch')") && client.includes("socket?.emit('rematch')"),'Rematch must keep using its existing same-room event');
assert(client.includes("button.id === 'create-new-room'") && client.includes("emitWithAck('leaveRoom', pendingLeaveRoom)"),'Create New Room must leave the finished room');
assert(client.includes("button.id === 'confirm-create-room'") && client.includes("button.id === 'cancel-waiting'"),'room setup must confirm creation and waiting screen must own cancellation');
const setupMarkup=html.slice(html.indexOf('<section class="screen" id="create-room-screen"'),html.indexOf('<section class="screen" id="waiting"'));
const waitingMarkup=html.slice(html.indexOf('<section class="screen" id="waiting"'),html.indexOf('<section class="screen" id="game"'));
assert(!setupMarkup.includes('Cancel') && !setupMarkup.includes('cancel-create-room'),'room setup must not contain a Cancel control');
assert(waitingMarkup.indexOf('id="waiting-players"')<waitingMarkup.indexOf('id="cancel-waiting"'),'waiting Cancel must sit below the player list');
assert(waitingMarkup.indexOf('id="cancel-waiting"')<waitingMarkup.indexOf('id="start-game"'),'waiting Cancel must remain separate from the room code and player list');
assert.strictEqual((html.match(/id="cancel-waiting"/g)||[]).length,1,'Cancel must appear only on the waiting screen');
assert(html.includes('.waiting-cancel{min-height:52px}') && html.includes('#waiting{justify-content:flex-start;gap:10px;overflow-y:auto'),'waiting controls must remain reachable on small viewports');
assert(client.includes('clearSavedRoom();') && client.includes("setScreen('lobby')"),'Create New Room must clear reconnect state and return to the lobby');
assert(!client.includes('finishPendingNewRoom') && !client.includes("emitWithAck('reconnect', oldRoom)"),'leaving a finished room must not reconnect it or create a new room automatically');
assert(client.includes('if (createNewRoomInProgress) return;'),'Create New Room click handler must ignore duplicate taps');
assert(client.includes('socket.connect()') && client.includes("emitWithAck('reconnect', saved)"),'ordinary reconnect must remain available for an explicitly saved room');
assert(client.includes("byId('create-new-room').disabled = true;") && client.includes("byId('create-new-room').disabled = false;"),'Create New Room must disable during transition and re-enable for later games');
const createNewRoomHandler=client.indexOf('async function createNewRoomFromResult()');
assert(createNewRoomHandler>=0 && client.indexOf('if (createNewRoomInProgress) return;',createNewRoomHandler)<client.indexOf('await ',createNewRoomHandler),'duplicate-tap guard must run synchronously before any async room operation');
assert(client.includes("button.id === 'test-sound'") && client.includes('soundEngine?.testSound()'),'Test Sound must call the audio controller directly from its click handler');
assert(client.includes("socket.on('card_revealed'") && client.includes('INFLUENCE -1') && client.includes('challenge-proof') && client.includes('CHALLENGE FAILED'),'public card reveal should distinguish proof cards from influence loss');
assert(client.includes('responsePhase.allowed.includes') && client.includes("response.type === 'PASS'"),'response UI and pass feedback must use the viewer-specific server allowance');
for (const cue of ['cardCast','challenge','counter','success','failure','loss','elimination','turn','gameStart','gameEnd']) {
  assert(soundApi.patterns[cue],`missing synthesized sound cue: ${cue}`);
  assert(client.includes(`'${cue}'`),`game client does not map an event to sound cue: ${cue}`);
}

function createFakeAudioRoot(initialValues={},options={}) {
  const values=new Map(Object.entries(initialValues));
  const listeners={};
  const contexts=[];
  class FakeAudioContext {
    constructor(){if(options.constructorError)throw new Error('mock constructor failure');this.state=options.initialState||'suspended';this.currentTime=0;this.destination={nodeType:'destination'};this.oscillators=[];this.gains=[];this.connections=[];contexts.push(this);}
    resume(){if(options.resumeReject)return Promise.reject(new Error('mock resume rejection'));this.state='running';return Promise.resolve();}
    createGain(){
      const gain={value:0,setTargetAtTime(value){this.value=value;},setValueAtTime(value){this.value=value;},exponentialRampToValueAtTime(value){this.value=value;}};
      const node={gain,nodeType:'gain',connect(target){this.context.connections.push([this.nodeType,target]);this.connectedTo=target;}};node.context=this;this.gains.push(node);return node;
    }
    createOscillator(){
      const oscillator={frequency:{value:null,setValueAtTime(value){this.value=value;}},nodeType:'oscillator',connect(target){this.context.connections.push([this.nodeType,target]);this.connectedTo=target;},start(when){this.started=true;this.startTime=when;},stop(when){this.stopped=true;this.stopTime=when;},type:'sine'};oscillator.context=this;
      this.oscillators.push(oscillator);return oscillator;
    }
  }
  return {
    root:{AudioContext:options.unavailable?undefined:FakeAudioContext,localStorage:{getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,value)},addEventListener:(name,handler,options)=>{listeners[name]={handler,options};}},
    contexts,values,listeners
  };
}

const wait=ms=>new Promise(r=>setTimeout(r,ms));

function emitWithAck(client,event,payload) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`${event} acknowledgement timed out`)),4000);
    client.emit(event,payload,response=>{clearTimeout(timeout);resolve(response||{});});
  });
}

function waitForGameState(client,predicate) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{client.off('gameState',listener);reject(new Error('gameState timed out'));},4000);
    const listener=gameState=>{
      if (!predicate(gameState)) return;
      clearTimeout(timeout);
      client.off('gameState',listener);
      resolve(gameState);
    };
    client.on('gameState',listener);
  });
}

async function waitUntil(predicate,message) {
  const deadline=Date.now()+4000;
  while(!predicate()) {
    if(Date.now()>=deadline)throw new Error(message);
    await wait(10);
  }
}

function waitForCardReveal(client,kind) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{client.off('card_revealed',listener);reject(new Error(`card_revealed ${kind} timed out`));},4000);
    const listener=reveal=>{
      if(reveal.kind!==kind)return;
      clearTimeout(timeout);
      client.off('card_revealed',listener);
      resolve(reveal);
    };
    client.on('card_revealed',listener);
  });
}

function inventoryCards(room) {
  return [...room.players.flatMap(player=>player.cards),...room.deck,...room.discard].sort();
}

async function connectTestClient(url) {
  const client=socketClient(url,{reconnection:false,timeout:3000});
  await new Promise((resolve,reject)=>{
    client.once('connect',resolve);
    client.once('connect_error',reject);
  });
  return client;
}

function createAppHarness(socket,initialStorage={}) {
  const elements=new Map();
  const documentHandlers={};
  const storage=new Map(Object.entries(initialStorage));
  const createElement=id=>{
    const classes=new Set();
    return {
      id,value:'',textContent:'',innerHTML:'',disabled:false,title:'',dataset:{},style:{},scrollTop:0,scrollHeight:0,
      classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name,force){const shouldAdd=force===undefined?!classes.has(name):Boolean(force);if(shouldAdd)classes.add(name);else classes.delete(name);return shouldAdd;}},
      attributes:{},setAttribute(name,value){this.attributes[name]=String(value);},hasAttribute(name){return Object.prototype.hasOwnProperty.call(this.attributes,name);},
      addEventListener(name,handler){this.handlers ||= {};this.handlers[name]=handler;}
    };
  };
  for (const [,id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id,createElement(id));
  const screens=['lobby','create-room-screen','waiting','game'].map(id=>elements.get(id));
  const localStorage={getItem:key=>storage.has(key)?storage.get(key):null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  const document={
    activeElement:null,
    body:{append(){}},
    getElementById:id=>elements.get(id)||null,
    querySelectorAll:selector=>selector==='.screen'?screens:[],
    addEventListener:(name,handler)=>{documentHandlers[name]=handler;}
  };
  const sound={getState:()=>({enabled:true,volume:0.65,supported:true,api:'AudioContext',contextState:'running',outputAvailable:true,lastSound:{type:'none',at:null},lastError:null}),play:()=>Promise.resolve(true),setEnabled(){},setVolume(){}};
  const window={io:()=>socket,CoupSound:sound,localStorage,setTimeout,clearTimeout,setInterval:()=>0};
  const context=vm.createContext({window,document,localStorage,console:{warn(){},error:console.error},navigator:{clipboard:{writeText:()=>Promise.resolve()}},setTimeout,clearTimeout,Promise,Date,Math,Map,Set,encodeURIComponent});
  vm.runInContext(fs.readFileSync(path.join(publicDir,'app.js'),'utf8'),context,{filename:'public/app.js'});
  return {
    elements,storage,documentHandlers,
    click(id){const button=elements.get(id);return documentHandlers.click({target:{closest:()=>button}});},
    clickData(dataset){const button={id:'',dataset};return documentHandlers.click({target:{closest:()=>button}});}
  };
}

(async()=>{
  // Web Audio regression: gesture unlock, singleton context, dedupe and persistence.
  const audioMock=createFakeAudioRoot();
  const sound=soundApi.create(audioMock.root);
  assert.strictEqual(sound.getState().enabled,true);
  assert.strictEqual(sound.getState().volume,0.65);
  assert.strictEqual(await sound.play('cardCast','before-unlock'),false,'sound must not play before an audio gesture unlocks the context');
  assert.strictEqual(audioMock.contexts.length,0,'sound events must not create a context outside a user gesture');
  assert.strictEqual(audioMock.listeners.pointerdown.options.passive,true,'pointer unlock must not block touch interactions');
  assert.strictEqual(audioMock.listeners.touchstart.options.passive,true,'iOS touch unlock must be passive');
  await audioMock.listeners.pointerdown.handler();
  assert.strictEqual(audioMock.contexts.length,1,'the first gesture should create one shared AudioContext');
  assert.strictEqual(audioMock.contexts[0].state,'running','the first gesture should resume AudioContext');
  assert(audioMock.contexts[0].gains[0].gain.value>0.1,'default master gain should be audible without being unbounded');
  assert.strictEqual(sound.getState().outputAvailable,true);
  assert.strictEqual(await sound.play('cardCast','cast-1'),true);
  const oscillatorCount=audioMock.contexts[0].oscillators.length;
  assert.strictEqual(await sound.play('cardCast','cast-1'),false,'the same event must not play twice');
  assert.strictEqual(audioMock.contexts[0].oscillators.length,oscillatorCount);
  assert.strictEqual(await sound.testSound(),true,'Test Sound should schedule immediately through its direct controller path');
  const testOscillator=audioMock.contexts[0].oscillators.at(-1);
  assert.strictEqual(testOscillator.frequency.value,600,'Test Sound uses an audible 600 Hz tone');
  assert(testOscillator.stopTime-testOscillator.startTime>=0.2 && testOscillator.stopTime-testOscillator.startTime<=0.22,'Test Sound duration should be about 200ms');
  const testEnvelope=testOscillator.connectedTo;
  const masterGain=audioMock.contexts[0].gains[0];
  assert.strictEqual(testEnvelope.nodeType,'gain');
  assert.strictEqual(testEnvelope.connectedTo,masterGain,'per-sound gain must connect to master gain');
  assert.strictEqual(masterGain.connectedTo,audioMock.contexts[0].destination,'master gain must connect to destination');
  sound.setVolume(0.8);
  const voicesBeforeZero=audioMock.contexts[0].oscillators.length;
  sound.setVolume(0);
  assert.strictEqual(await sound.testSound(),false,'zero volume must not produce a silent-looking successful test');
  assert.match(sound.getState().lastError,/Volume is 0/);
  assert.strictEqual(masterGain.gain.value,0,'zero volume should silence the master output');
  assert.strictEqual(audioMock.contexts[0].oscillators.length,voicesBeforeZero,'zero volume must not schedule voices');
  sound.setVolume(0.8);
  sound.setEnabled(false);
  assert.strictEqual(audioMock.values.get('coup-sound-enabled'),'false');
  assert.strictEqual(audioMock.values.get('coup-sound-volume'),'0.8');
  assert.strictEqual(await sound.play('success','muted-event'),false,'muted sound must not schedule voices');
  const resumeOnTouch=audioMock.listeners.touchstart.handler;
  const reloadedSound=soundApi.create(audioMock.root);
  assert.strictEqual(reloadedSound.getState().enabled,false,'mute must persist after reload');
  assert.strictEqual(reloadedSound.getState().volume,0.8,'master volume must persist after reload');
  sound.setEnabled(true);
  assert.strictEqual(audioMock.values.get('coup-sound-enabled'),'true');
  audioMock.contexts[0].state='suspended';
  await resumeOnTouch();
  assert.strictEqual(audioMock.contexts[0].state,'running','touch gesture should resume a suspended context');
  assert.strictEqual(audioMock.contexts.length,1,'resume must reuse the existing context');

  const malformedAudio=createFakeAudioRoot({'coup-sound-enabled':'enabled-ish','coup-sound-volume':'loud'});
  const fallbackSound=soundApi.create(malformedAudio.root);
  assert.strictEqual(fallbackSound.getState().enabled,true,'malformed sound setting should safely default to enabled');
  assert.strictEqual(fallbackSound.getState().volume,0.65,'malformed volume should safely use the default level');
  assert.strictEqual(malformedAudio.values.get('coup-sound-enabled'),'true');
  assert.strictEqual(malformedAudio.values.get('coup-sound-volume'),'0.65');

  const unsupportedAudio=createFakeAudioRoot({}, {unavailable:true});
  const unsupportedSound=soundApi.create(unsupportedAudio.root);
  assert.strictEqual(unsupportedSound.getState().supported,false);
  assert.strictEqual(await unsupportedSound.testSound(),false,'Test Sound should report unavailable Web Audio');
  assert.match(unsupportedSound.getState().lastError,/unavailable/);

  const brokenConstructorAudio=createFakeAudioRoot({}, {constructorError:true});
  const brokenConstructorSound=soundApi.create(brokenConstructorAudio.root);
  assert.strictEqual(await brokenConstructorSound.testSound(),false,'constructor exceptions should be reported');
  assert.match(brokenConstructorSound.getState().lastError,/constructor failure/);

  const resumeFailureAudio=createFakeAudioRoot({}, {resumeReject:true});
  const resumeFailureSound=soundApi.create(resumeFailureAudio.root);
  assert.strictEqual(await resumeFailureSound.testSound(),false,'Test Sound must fail visibly when resume rejects');
  assert.match(resumeFailureSound.getState().lastError,/resume\(\) failed.*mock resume rejection/i);
  assert.strictEqual(resumeFailureAudio.contexts[0].oscillators[0].stopped,true,'failed test tone should be stopped');

  const runningAudio=createFakeAudioRoot({}, {initialState:'running'});
  const runningSound=soundApi.create(runningAudio.root);
  assert.strictEqual(await runningSound.testSound(),true,'Test Sound should work with an already-running context');
  assert.strictEqual(runningAudio.contexts[0].oscillators[0].frequency.value,600);

  const directSuspendedAudio=createFakeAudioRoot();
  const directSuspendedSound=soundApi.create(directSuspendedAudio.root);
  assert.strictEqual(await directSuspendedSound.testSound(),true,'Test Sound must unlock and play from a suspended context');
  assert.strictEqual(directSuspendedAudio.contexts[0].state,'running');
  assert.strictEqual(directSuspendedAudio.contexts[0].oscillators[0].frequency.value,600);

  const webkitAudio=createFakeAudioRoot();
  webkitAudio.root.webkitAudioContext=webkitAudio.root.AudioContext;
  webkitAudio.root.AudioContext={notAConstructor:true};
  const webkitSound=soundApi.create(webkitAudio.root);
  assert.strictEqual(webkitSound.getState().api,'webkitAudioContext','Safari-prefixed AudioContext must be detected');
  assert.strictEqual(await webkitSound.testSound(),true,'WebKit-prefixed AudioContext must play the Test Sound');

  // Exchange regression: returned cards must go back to deck, never disappear.
  const r=createRoom('a','A');
  r.players.push({id:'b',name:'B',coins:2,cards:[],alive:true,disconnected:false,disconnectTimer:null});
  startGame(r);
  const p=r.players[0];
  const originalDeck=r.deck.length;
  r.currentPlayer=0; r.actionToken=7; r.exchangePhase='selecting'; r.phase='exchange_select';
  r.exchangeHand=[p.cards[0],p.cards[1],'duke','captain'];
  const beforeTotal=r.deck.length+r.exchangeHand.length;
  assert.strictEqual(finishExchange(r,[0,1],false),true);
  assert.strictEqual(p.cards.length,2);
  assert.strictEqual(r.exchangeHand.length,0);
  assert.strictEqual(r.exchangeDrawn.length,0);
  assert.strictEqual(r.deck.length, beforeTotal-2, 'exactly two kept cards leave the exchange pool');
  assert.strictEqual(r.deck.length, originalDeck+2, 'two non-kept cards returned to deck');

  // Exchange timeout regression: auto-resolve must also return the extra cards.
  const rt=createRoom('t','Timeout');
  rt.players.push({id:'u',name:'U',coins:2,cards:[],alive:true,disconnected:false,disconnectTimer:null});
  startGame(rt);
  const timeoutPlayer=rt.players[0];
  const timeoutDeckBefore=rt.deck.length;
  rt.currentPlayer=0; rt.actionToken=30; rt.exchangePhase='selecting'; rt.phase='exchange_select';
  rt.exchangeHand=[timeoutPlayer.cards[0],timeoutPlayer.cards[1],'assassin','contessa'];
  autoDiscardExchange(rt);
  assert.strictEqual(timeoutPlayer.cards.length,2,'timeout should preserve a valid 2-card hand');
  assert.strictEqual(rt.deck.length,timeoutDeckBefore+2,'timeout must return two unkept cards to the deck');
  assert.strictEqual(rt.discard.length,0,'exchange timeout must not discard cards');
  clearTimeout(rt.timer);

  // Foreign Aid regression: Duke block must stop the +2.
  const f=createRoom('a','A');
  f.players.push({id:'b',name:'B',coins:2,cards:['duke','contessa'],alive:true,disconnected:false,disconnectTimer:null});
  f.players.push({id:'c',name:'C',coins:2,cards:['captain','assassin'],alive:true,disconnected:false,disconnectTimer:null});
  f.state='playing'; f.phase='challenging'; f.currentPlayer=0; f.selectedAction='foreign_aid'; f.selectedTarget=null; f.actionToken=10; f.counterResults=[{playerIndex:1,char:'duke'}];
  const beforeCoins=f.players[0].coins;
  resolveForeignAid(f);
  await wait(1350);
  assert.strictEqual(f.players[0].coins,beforeCoins,'blocked Foreign Aid must not award coins');
  clearTimeout(f.timer);

  // Steal regression: a counter must advance the turn only once.
  const st=createRoom('a','A');
  st.players.push({id:'b',name:'B',coins:5,cards:['captain','duke'],alive:true,disconnected:false,disconnectTimer:null});
  st.players.push({id:'c',name:'C',coins:2,cards:['assassin','contessa'],alive:true,disconnected:false,disconnectTimer:null});
  st.state='playing'; st.phase='challenging'; st.currentPlayer=0; st.selectedAction='steal'; st.selectedTarget=1; st.actionToken=20; st.counterResults=[{playerIndex:1,char:'captain'}]; st.challengeResults=[];
  resolveSteal(st);
  await wait(1350);
  assert.strictEqual(st.currentPlayer,1,'steal counter path should advance exactly one turn');
  assert.strictEqual(st.actionToken,21,'turn token should increment once');
  clearTimeout(st.timer);

  // End-of-game flow integration: rematch keeps its room; leaving removes one player; fresh setup uses a new room.
  const protectedRoom=createRoom('protected','Protected');
  protectedRoom.state='playing';
  assert.match(leaveFinishedRoom(protectedRoom,'protected').error,/finished room/);
  assert.strictEqual(rooms.get(protectedRoom.code),protectedRoom,'a rejected active-game leave must not delete its room');
  assert.match(cancelWaitingRoom(protectedRoom,'protected').error,/while waiting/,'waiting cancellation must be rejected once gameplay has started');
  assert.strictEqual(rooms.get(protectedRoom.code),protectedRoom,'waiting cancellation must not delete an active game');
  const emptyRoom=createRoom('alone','Alone');
  emptyRoom.state='finished';
  assert.strictEqual(leaveFinishedRoom(emptyRoom,'alone').success,true);
  assert.strictEqual(rooms.has(emptyRoom.code),false,'the last player leaving should remove only their now-empty finished room');
  const sameNameRoom=createRoom('same-name','Duplicate Name');
  const sameNameOther={id:'other-player',name:'Duplicate Name',coins:2,cards:[],alive:true,disconnected:true,disconnectTimer:null};
  const leavingTimer=setTimeout(()=>{},60000);
  const otherTimer=setTimeout(()=>{},60000);
  sameNameRoom.players[0].disconnectTimer=leavingTimer;
  sameNameOther.disconnectTimer=otherTimer;
  sameNameRoom.players.push(sameNameOther);
  sameNameRoom.disconnectTimers.set(sameNameOther.name,otherTimer);
  sameNameRoom.state='finished';
  assert.strictEqual(leaveFinishedRoom(sameNameRoom,'same-name').success,true);
  assert.strictEqual(sameNameRoom.disconnectTimers.get(sameNameOther.name),otherTimer,'leaving one player must not clear a same-named opponent timer');
  clearTimeout(otherTimer);
  sameNameRoom.disconnectTimers.clear();
  rooms.delete(sameNameRoom.code);

  const testRoomCodes=[];
  const testClients=[];
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const address=server.address();
    const url=`http://127.0.0.1:${address.port}`;
    const host=await connectTestClient(url);
    testClients.push(host);
    const guest=await connectTestClient(url);
    testClients.push(guest);

    const created=await emitWithAck(host,'createRoom',{name:'Host'});
    assert(created.code,'host should create an original room');
    const oldCode=created.code;
    testRoomCodes.push(oldCode);
    const originalLobbyUpdate=waitForGameState(host,gameState=>gameState.code===oldCode && gameState.state==='lobby' && gameState.players.length===2);
    const joined=await emitWithAck(guest,'joinRoom',{code:oldCode,name:'Guest'});
    assert.strictEqual(joined.success,true,'guest should join the original room');
    await originalLobbyUpdate;
    const oldRoom=rooms.get(oldCode);
    assert(oldRoom,'original room should be registered');

    oldRoom.state='finished';
    oldRoom.phase='finished';
    oldRoom.winner=host.id;
    const rematchState=waitForGameState(host,gameState=>gameState.code===oldCode && gameState.state==='lobby');
    host.emit('rematch');
    await rematchState;
    assert.strictEqual(rooms.get(oldCode),oldRoom,'Rematch must retain the same room object and room ID');
    assert.deepStrictEqual(oldRoom.players.map(player=>player.id),[host.id,guest.id],'Rematch must preserve the current room players');

    oldRoom.state='finished';
    oldRoom.phase='finished';
    const appHarness=createAppHarness(host,{'coup-last-room':JSON.stringify({code:oldCode,name:'Host'})});
    const finishedState={
      code:oldCode,state:'finished',phase:'finished',currentPlayer:0,selectedAction:null,selectedTarget:null,
      timerEnd:null,timerDuration:10000,myIndex:0,deckCount:15,winner:host.id,log:[],myCards:[],
      exchangePhase:null,exchangeHand:null,counterChallengePhase:false,counterChallengeTimerEnd:null,
      counterChallengeDuration:6000,pendingCounter:null,lastLostCard:null,lastLostPlayerIndex:null,
      players:oldRoom.players.map((player,index)=>({id:player.id,name:player.name,coins:player.coins,cardCount:player.cards.length,alive:player.alive,isMe:index===0,disconnected:false,cards:index===0?player.cards:null}))
    };
    const resultScreen=waitForGameState(host,gameState=>gameState.code===oldCode && gameState.state==='finished');
    io.to(host.id).emit('gameState',finishedState);
    await resultScreen;

    let leaveEmits=0;
    let createEmits=0;
    let cancelEmits=0;
    let oldStorageClearedBeforeLeave=false;
    let reconnectStorageClearedBeforeCancel=false;
    host.onAnyOutgoing(event=>{
      if (event==='leaveRoom') {
        leaveEmits+=1;
        oldStorageClearedBeforeLeave=appHarness.storage.get('coup-last-room')===undefined;
      }
      if (event==='createRoom') createEmits+=1;
      if (event==='cancelWaitingRoom') {
        cancelEmits+=1;
        reconnectStorageClearedBeforeCancel=appHarness.storage.get('coup-last-room')===undefined;
      }
    });
    const firstTap=appHarness.click('create-new-room');
    assert.strictEqual(appHarness.elements.get('lobby').classList.contains('active'),true,'result action should immediately return the player to the lobby screen');
    assert.strictEqual(appHarness.elements.get('winner-modal').classList.contains('active'),false,'result modal should close before room creation');
    const secondTap=appHarness.click('create-new-room');
    await secondTap;
    assert.strictEqual(leaveEmits,1,'double tap must send only one leave request');
    await firstTap;
    assert(oldStorageClearedBeforeLeave,'old reconnect state must be cleared before leaving the previous room');
    assert.strictEqual(leaveEmits,1,'one tap should leave exactly once');
    assert.strictEqual(createEmits,0,'Create New Room must not create a room automatically');
    assert.strictEqual(appHarness.elements.get('lobby').classList.contains('active'),true,'Create New Room should return to the lobby');
    assert.strictEqual(appHarness.elements.get('waiting').classList.contains('active'),false,'returning to lobby must not join a room');
    assert.strictEqual(appHarness.elements.get('create-new-room').disabled,false,'the result action should be reusable in a later match');

    appHarness.click('create-room');
    assert.strictEqual(appHarness.elements.get('create-room-screen').classList.contains('active'),true,'Create Room should open setup without creating a room');
    appHarness.elements.get('create-room-name').value='Discarded Name';
    assert.strictEqual(appHarness.elements.has('cancel-create-room'),false,'room setup must not expose a Cancel control');
    const cancelledRoomUpdate=waitForGameState(host,gameState=>gameState.state==='lobby' && gameState.code!==oldCode);
    await appHarness.click('confirm-create-room');
    const cancelledState=await cancelledRoomUpdate;
    assert.strictEqual(createEmits,1,'explicit confirmation should create exactly one room');
    assert.strictEqual(appHarness.elements.get('waiting').classList.contains('active'),true,'confirmed room should render the waiting lobby');
    assert.strictEqual(cancelledState.players[0].name,'Discarded Name','room creation must use the setup name');
    const cancelledCode=cancelledState.code;
    testRoomCodes.push(cancelledCode);
    const emptyCancelledRoom=rooms.get(cancelledCode);
    assert(emptyCancelledRoom,'newly created waiting room should exist before cancellation');
    await appHarness.click('cancel-waiting');
    assert.strictEqual(cancelEmits,1,'waiting Cancel must send one server cancellation');
    assert(reconnectStorageClearedBeforeCancel,'waiting Cancel must clear saved reconnect state before leaving');
    assert.strictEqual(rooms.has(cancelledCode),false,'cancelling the only player must delete the now-empty room');
    assert.strictEqual(appHarness.storage.has('coup-last-room'),false,'waiting Cancel must clear saved room state');
    assert.strictEqual(appHarness.elements.get('lobby').classList.contains('active'),true,'waiting Cancel must return to the lobby');
    assert.strictEqual(appHarness.elements.get('waiting').classList.contains('active'),false,'the cancelled room must no longer be shown');
    assert.strictEqual(appHarness.elements.get('player-name').value,'','waiting Cancel must clear the previous player name');
    assert.strictEqual(createEmits,1,'cancelling a waiting room must not create another room');

    const cancelGuest=await connectTestClient(url);
    testClients.push(cancelGuest);
    appHarness.click('create-room');
    appHarness.elements.get('create-room-name').value='Waiting Host';
    const sharedCancelRoomUpdate=waitForGameState(host,gameState=>gameState.state==='lobby' && gameState.code!==oldCode && gameState.code!==cancelledCode);
    await appHarness.click('confirm-create-room');
    const sharedCancelState=await sharedCancelRoomUpdate;
    const sharedCancelCode=sharedCancelState.code;
    testRoomCodes.push(sharedCancelCode);
    const sharedCancelRoom=rooms.get(sharedCancelCode);
    const guestJoinedCancelRoom=waitForGameState(host,gameState=>gameState.code===sharedCancelCode && gameState.players.length===2);
    assert.strictEqual((await emitWithAck(cancelGuest,'joinRoom',{code:sharedCancelCode,name:'Cancel Guest'})).success,true);
    await guestJoinedCancelRoom;
    const remainingGuestState=waitForGameState(cancelGuest,gameState=>gameState.code===sharedCancelCode && gameState.players.length===1 && gameState.myIndex===0);
    await appHarness.click('cancel-waiting');
    const guestAfterHostCancel=await remainingGuestState;
    assert.strictEqual(cancelEmits,2,'each waiting cancellation must send exactly one server request');
    assert.strictEqual(sharedCancelRoom.players.length,1,'cancelling the host must remove only that player');
    assert.strictEqual(sharedCancelRoom.players[0].id,cancelGuest.id,'the other player must remain in the room');
    assert.strictEqual(guestAfterHostCancel.players[0].isMe,true,'remaining player must receive the updated host/player index');
    assert.strictEqual(Array.from(rooms.values()).some(room=>room.players.some(player=>player.id===host.id)),false,'cancelled host must not remain as a ghost player');
    host.emit('startGame');
    host.emit('selectAction',{action:'income'});
    await wait(20);
    assert.strictEqual(sharedCancelRoom.state,'lobby','stale actions from the cancelled client must not affect the old room');
    assert.strictEqual(sharedCancelRoom.players.length,1,'stale actions must not restore the cancelled player');
    assert.strictEqual((await emitWithAck(cancelGuest,'cancelWaitingRoom',{code:sharedCancelCode})).success,true,'the remaining player should also be able to cancel the now-empty waiting room');
    assert.strictEqual(rooms.has(sharedCancelCode),false,'the last waiting player cancelling must delete the room');

    appHarness.elements.get('player-name').value='Lobby Renamed';
    appHarness.click('create-room');
    assert.strictEqual(appHarness.elements.get('create-room-name').value,'Lobby Renamed','room setup should use the latest lobby name');
    const freshLobbyUpdate=waitForGameState(host,gameState=>gameState.state==='lobby' && gameState.code!==oldCode && gameState.code!==cancelledCode && gameState.code!==sharedCancelCode);
    await appHarness.click('confirm-create-room');
    const freshState=await freshLobbyUpdate;
    assert.strictEqual(createEmits,3,'a new room should only be created after explicit confirmation');
    const fresh=JSON.parse(appHarness.storage.get('coup-last-room'));
    assert(fresh.code && fresh.code!==oldCode && fresh.code!==cancelledCode && fresh.code!==sharedCancelCode,'recreating after cancellation must use a new room ID');
    assert.strictEqual(rooms.get(fresh.code).players[0].name,'Lobby Renamed','Create Room must use the newly entered name');

    assert.strictEqual(rooms.get(oldCode),oldRoom,'leaving must not delete a room still used by another player');
    assert.deepStrictEqual(oldRoom.players.map(player=>player.id),[guest.id],'leaving must remove only the requesting player');
    assert.strictEqual(oldRoom.state,'finished','leaving must not reset the other player\'s finished session');

    oldRoom.state='finished';
    const guestRematch=waitForGameState(guest,gameState=>gameState.code===oldCode && gameState.state==='lobby');
    guest.emit('rematch');
    await guestRematch;
    assert.strictEqual(rooms.get(oldCode),oldRoom,'the remaining player should retain control of the old room');
    assert.strictEqual(oldRoom.players.length,1);

    testRoomCodes.push(fresh.code);
    const freshRoom=rooms.get(fresh.code);
    assert(freshRoom && freshRoom.state==='lobby' && freshRoom.phase==='waiting','new room should reach the normal lobby state');
    assert.deepStrictEqual(freshRoom.players.map(player=>player.id),[host.id]);

    const nextPlayer=await connectTestClient(url);
    testClients.push(nextPlayer);
    const newGameLobby=waitForGameState(host,gameState=>gameState.code===fresh.code && gameState.players.length===2);
    const freshJoin=await emitWithAck(nextPlayer,'joinRoom',{code:fresh.code,name:'Next Player'});
    assert.strictEqual(freshJoin.success,true,'a second player should join the new room normally');
    await newGameLobby;
    const startedGame=waitForGameState(host,gameState=>gameState.code===fresh.code && gameState.state==='playing');
    host.emit('startGame');
    const startedState=await startedGame;
    assert.strictEqual(startedState.players.length,2,'new room should start a normal two-player game');
    assert(startedState.players.every(player=>player.cardCount===2),'normal game setup should deal two influence cards');
    clearTimeout(freshRoom.timer);
    freshRoom.timer=null;
    freshRoom.state='finished';

    const visualPlayers=[
      {id:host.id,name:'Host',coins:3,cardCount:2,alive:true,isMe:true,disconnected:false,cards:['duke','captain']},
      {id:nextPlayer.id,name:'Next Player',coins:2,cardCount:2,alive:true,isMe:false,disconnected:false,cards:null}
    ];
    const visualState={
      code:fresh.code,state:'playing',phase:'selecting',currentPlayer:0,selectedAction:null,selectedTarget:null,
      timerEnd:null,timerDuration:10000,myIndex:0,deckCount:11,winner:null,log:[],myCards:['duke','captain'],
      exchangePhase:null,exchangeHand:null,counterChallengePhase:false,counterChallengeTimerEnd:null,
      counterChallengeDuration:6000,pendingCounter:null,lastLostCard:null,lastLostPlayerIndex:null,cardReveal:null,responsePhase:null,
      players:visualPlayers
    };
    const deliverVisualState=async(view,predicate)=>{
      const received=waitForGameState(host,predicate);
      io.to(host.id).emit('gameState',view);
      await received;
    };
    await deliverVisualState(visualState,gameState=>gameState.code===fresh.code && gameState.phase==='selecting' && gameState.selectedAction===null);
    appHarness.clickData({selectAction:'assassinate'});
    assert(appHarness.elements.get('action-content').innerHTML.includes('class="action-btn selected"'),'chosen target action should remain visibly selected');
    assert(appHarness.elements.get('action-content').innerHTML.includes('Assassinate · Choose a living player.'),'selected action should provide an immediate target prompt');
    assert(appHarness.elements.get('game').classList.contains('target-focus'),'target selection should activate focus styling');
    assert(appHarness.elements.get('player-seats').innerHTML.includes('target-candidate'),'living opponent targets should be marked without exposing cards');

    const visualResponseState={...visualState,phase:'challenging',currentPlayer:0,myIndex:1,selectedAction:'assassinate',selectedTarget:1,
      players:[{...visualPlayers[1],isMe:false},{...visualPlayers[0],isMe:true}],
      responsePhase:{kind:'action',allowed:['CHALLENGE','PASS'],blockCharacters:[],responders:[{name:'Host',status:'waiting'}]}};
    await deliverVisualState(visualResponseState,gameState=>gameState.code===fresh.code && gameState.phase==='challenging' && gameState.selectedAction==='assassinate');
    assert(appHarness.elements.get('player-seats').innerHTML.includes('target-selected'),'server-selected target should remain highlighted during resolution');
    const responseMarkup=appHarness.elements.get('challenge-panel').innerHTML;
    assert(responseMarkup.includes('ASSASSINATE') && responseMarkup.includes('YOUR RESPONSE'),'response panel should show the action-to-response flow for eligible players');
    assert(responseMarkup.includes('data-response="CHALLENGE"') && responseMarkup.includes('data-response="PASS"'),'eligible response actions should remain available');
    assert(!responseMarkup.includes('data-response="BLOCK"'),'the presentation must not invent a response absent from server allowance');

    const waitingResponseState={...visualResponseState,myIndex:0,responsePhase:{kind:'action',allowed:[],blockCharacters:[],responders:[{name:'Host',status:'PASS'}]}};
    await deliverVisualState(waitingResponseState,gameState=>gameState.code===fresh.code && gameState.phase==='challenging' && gameState.myIndex===0);
    const waitingMarkup=appHarness.elements.get('challenge-panel').innerHTML;
    assert(waitingMarkup.includes('WAITING FOR RESPONSE') && waitingMarkup.includes('response-pass'),'response status should show waiting and a completed PASS clearly');
    assert(!waitingMarkup.includes('data-response='),'players without an allowed response must not see action buttons');

    const revealState={...waitingResponseState,phase:'resolving',responsePhase:null,
      players:[{...waitingResponseState.players[0],cardCount:1},{...waitingResponseState.players[1],cardCount:2}],
      cardReveal:{id:`${fresh.code}:reveal:1`,playerIndex:0,playerName:'Next Player',card:'duke',reason:'assassinate'}};
    await deliverVisualState(revealState,gameState=>gameState.code===fresh.code && gameState.phase==='resolving' && gameState.cardReveal?.id===revealState.cardReveal.id);
    const revealMarkup=appHarness.elements.get('card-reveal').innerHTML;
    assert(revealMarkup.includes('Next Player lost Influence') && revealMarkup.includes('Duke') && revealMarkup.includes('INFLUENCE -1'),'card reveal should name the player, revealed card, and influence loss');
    assert.strictEqual((revealMarkup.match(/<img\b/g)||[]).length,1,'public reveal must display exactly one revealed card');
    assert.strictEqual(appHarness.elements.get('game').dataset.impact,'loss','influence reveal should trigger one short impact effect');
    await wait(300);
    assert.strictEqual(appHarness.elements.get('game').classList.contains('impact-feedback'),false,'impact styling should clean itself up after the short effect');
    assert.strictEqual(appHarness.elements.get('game').dataset.impact,undefined,'impact metadata should not persist after cleanup');

    const proofRevealState={...revealState,cardReveal:{...revealState.cardReveal,id:`${fresh.code}:proof:1`,kind:'challenge-proof'}};
    await deliverVisualState(proofRevealState,gameState=>gameState.cardReveal?.id===proofRevealState.cardReveal.id);
    const proofRevealMarkup=appHarness.elements.get('card-reveal').innerHTML;
    assert(proofRevealMarkup.includes('Next Player proved the Duke claim') && proofRevealMarkup.includes('ASSASSINATE · CHALLENGE FAILED'),'challenge proof UI should show the proven role and challenge context');
    assert(!proofRevealMarkup.includes('INFLUENCE -1'),'proving a claim must not be presented as losing influence');
    assert.strictEqual((proofRevealMarkup.match(/<img\b/g)||[]).length,1,'proof reveal should show only the public claimed card');

    let responseHost=await connectTestClient(url);
    testClients.push(responseHost);
    const responderB=await connectTestClient(url);
    testClients.push(responderB);
    const responderC=await connectTestClient(url);
    testClients.push(responderC);
    const responseCreated=await emitWithAck(responseHost,'createRoom',{name:'Action Host'});
    testRoomCodes.push(responseCreated.code);
    await emitWithAck(responderB,'joinRoom',{code:responseCreated.code,name:'B'});
    await emitWithAck(responderC,'joinRoom',{code:responseCreated.code,name:'C'});
    const responseRoom=rooms.get(responseCreated.code);
    const resetResponseRoom=()=>{
      if(responseRoom.timer)clearTimeout(responseRoom.timer);
      if(responseRoom.counterChallengeTimer)clearTimeout(responseRoom.counterChallengeTimer);
      responseRoom.timer=null;
      responseRoom.counterChallengeTimer=null;
      responseRoom.timerEnd=null;
      responseRoom.counterChallengeTimerEnd=null;
      responseRoom.state='playing';
      responseRoom.phase='selecting';
      responseRoom.currentPlayer=0;
      responseRoom.selectedAction=null;
      responseRoom.selectedTarget=null;
      responseRoom.responsePhase=null;
      responseRoom.counterChallengePhase=false;
      responseRoom.pendingCounter=null;
      responseRoom.counterResults=[];
      responseRoom.challengeResults=[];
      responseRoom.deck=[];
      responseRoom.discard=[];
      responseRoom.cardReveal=null;
      responseRoom.lastLostCard=null;
      responseRoom.lastLostPlayerIndex=null;
      responseRoom.resolvedActionToken=null;
      responseRoom.players[0].coins=2;
      responseRoom.players[0].cards=['duke','assassin'];
      responseRoom.players[1].coins=2;
      responseRoom.players[1].cards=['captain','duke'];
      responseRoom.players[2].coins=2;
      responseRoom.players[2].cards=['ambassador','contessa'];
      responseRoom.players.forEach(player=>{player.alive=true;});
    };
    const startResponseAction=async(action,target=null,configure=()=>{})=>{
      resetResponseRoom();
      configure(responseRoom);
      if(action==='assassinate')responseRoom.players[0].coins=3;
      if(action==='coup')responseRoom.players[0].coins=10;
      const expectedPhase=['income','coup'].includes(action)?'resolving':'challenging';
      const started=waitForGameState(responderB,gameState=>gameState.selectedAction===action && gameState.phase===expectedPhase);
      executeAction(responseRoom,action,target);
      return started;
    };

    const runTaxChallenge=async({actorCards,challengerCards,deck,thirdAlive=true})=>{
      const responseState=await startResponseAction('tax',null,room=>{
        room.players[0].cards=actorCards.slice();
        room.players[1].cards=challengerCards.slice();
        room.players[2].cards=thirdAlive?['ambassador','contessa']:[];
        room.players[2].alive=thirdAlive;
        room.deck=deck.slice();
        room.discard=[];
      });
      assert.deepStrictEqual(responseState.responsePhase.allowed,['CHALLENGE','PASS']);
      const cardsBefore=inventoryCards(responseRoom);
      const proofEvents=[responseHost,responderB,responderC].map(client=>waitForCardReveal(client,'challenge-proof'));
      const finalState=waitForGameState(responseHost,view=>view.state==='finished'||(view.state==='playing'&&view.phase==='selecting'&&view.currentPlayer===1));
      const originalRandom=Math.random;
      let resultingState;
      try {
        Math.random=()=>0;
        assert.strictEqual((await emitWithAck(responderB,'actionResponse',{type:'CHALLENGE'})).success,true);
        resultingState=await finalState;
      } finally {
        Math.random=originalRandom;
      }
      const [actorProof,challengerProof,observerProof]=await Promise.all(proofEvents);
      assert.deepStrictEqual(actorProof,challengerProof);
      assert.deepStrictEqual(actorProof,observerProof);
      assert.deepStrictEqual(Object.keys(actorProof).sort(),['card','id','kind','playerIndex','playerName','reason']);
      assert.strictEqual(actorProof.kind,'challenge-proof');
      assert.strictEqual(actorProof.playerIndex,0);
      assert.strictEqual(actorProof.card,'duke');
      assert.strictEqual(actorProof.reason,'tax');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(actorProof,'replacement'),false,'public proof must not include the replacement');
      assert.deepStrictEqual(inventoryCards(responseRoom),cardsBefore,'challenge proof/replacement/loss must conserve every card across hands, deck, and discard');
      return {cardsBefore,actorProof,resultingState};
    };

    const runOtherRoleProof=async({action,claimedCard,proofPlayerIndex,counterClaim=false})=>{
      const roleDeck=['assassin','duke','captain'];
      const actorCards={assassinate:['captain','assassin'],exchange:['captain','ambassador'],steal:['duke','captain']}[action]||['duke','assassin'];
      const responseState=await startResponseAction(action,action==='assassinate'||action==='steal'?2:null,room=>{
        room.players[0].cards=actorCards.slice();
        room.players[1].cards=['captain','duke'];
        room.players[2].cards=['ambassador','contessa'];
        room.players[proofPlayerIndex].cards[1]=claimedCard;
        room.players.forEach(player=>{player.coins=5;player.alive=true;});
        room.players[1].coins=5;
        room.players[2].coins=5;
        room.deck=roleDeck.slice();
        room.discard=[];
      });
      assert(responseState.responsePhase,'the claimed action should open the existing response phase');
      const cardsBefore=inventoryCards(responseRoom);
      const proofCardsBefore=responseRoom.players[proofPlayerIndex].cards.slice();
      const proofEvents=[responseHost,responderB,responderC].map(client=>waitForCardReveal(client,'challenge-proof'));
      const finalState=waitForGameState(responseHost,view=>view.state==='finished'||(view.state==='playing'&&view.phase==='selecting'&&view.currentPlayer===1));
      const originalRandom=Math.random;
      let resultingState;
      try {
        Math.random=()=>0;
        if(counterClaim) {
          const blocker=[responseHost,responderB,responderC][proofPlayerIndex];
          const counterPhase=waitForGameState(responseHost,view=>view.responsePhase?.kind==='counter');
          assert.strictEqual((await emitWithAck(blocker,'actionResponse',{type:'BLOCK',char:claimedCard})).success,true);
          await counterPhase;
          assert.strictEqual((await emitWithAck(responseHost,'actionResponse',{type:'CHALLENGE'})).success,true);
        } else {
          assert.strictEqual((await emitWithAck(responderB,'actionResponse',{type:'CHALLENGE'})).success,true);
        }
        resultingState=await finalState;
      } finally {
        Math.random=originalRandom;
      }
      const [proofForOwner,proofForChallenger,proofForObserver]=await Promise.all(proofEvents);
      assert.deepStrictEqual(proofForOwner,proofForChallenger);
      assert.deepStrictEqual(proofForOwner,proofForObserver);
      assert.strictEqual(proofForOwner.kind,'challenge-proof');
      assert.strictEqual(proofForOwner.playerIndex,proofPlayerIndex);
      assert.strictEqual(proofForOwner.card,claimedCard);
      const proofPlayer=responseRoom.players[proofPlayerIndex];
      assert.strictEqual(proofPlayer.cards.length,2,'proof must preserve the challenged player\'s influence count');
      assert.strictEqual(proofPlayer.cards[0],proofCardsBefore[0],'replacement must occupy the proven card\'s original hand slot');
      assert.strictEqual(responseRoom.players[counterClaim?0:1].cards.length,1,'the challenger must lose exactly one influence');
      assert.deepStrictEqual(inventoryCards(responseRoom),cardsBefore,'each proof resolver must conserve cards');
      assert.strictEqual(getPlayerView(responseRoom,proofPlayer.id).myCards.length,2);
      const observer=[responseHost,responderB,responderC].find((client,index)=>index!==proofPlayerIndex);
      assert.strictEqual(getPlayerView(responseRoom,observer.id).players[proofPlayerIndex].cards,null,'opponents must not receive the proven player\'s replacement hand');
      assert.strictEqual(resultingState.state,'playing');
      return proofForOwner;
    };

    const twoInfluenceProof=await runTaxChallenge({actorCards:['captain','duke'],challengerCards:['ambassador','contessa'],deck:['ambassador','assassin','contessa']});
    assert.strictEqual(responseRoom.players[0].cards.length,2,'a proven 2-influence player must keep both influences');
    assert.deepStrictEqual(responseRoom.players[0].cards,['captain','ambassador'],'the exact Duke slot should be replaced by a card drawn from the shuffled server deck');
    assert.strictEqual(responseRoom.players[1].cards.length,1,'the challenger must lose one influence');
    assert(responseRoom.deck.includes('duke'),'the revealed Duke must return to the deck when a different card is drawn');
    assert.strictEqual(twoInfluenceProof.actorProof.card,'duke','public proof must reveal the exact claimed role');
    const ownerAfterProof=getPlayerView(responseRoom,responseHost.id);
    const opponentAfterProof=getPlayerView(responseRoom,responderC.id);
    assert.deepStrictEqual(ownerAfterProof.myCards,['captain','ambassador'],'the owner should receive their private replacement in game state');
    assert.deepStrictEqual(ownerAfterProof.players[0].cards,['captain','ambassador']);
    assert.strictEqual(opponentAfterProof.players[0].cards,null,'opponents must not receive the replacement hand');

    const originalHostSocketId=responseHost.id;
    responseHost.disconnect();
    await waitUntil(()=>responseRoom.players[0].disconnected,'proven player should be marked disconnected before reconnect');
    const reconnectedHost=await connectTestClient(url);
    testClients.push(reconnectedHost);
    const privateReconnectState=waitForGameState(reconnectedHost,view=>view.code===responseCreated.code&&view.myIndex===0&&view.players[0].cards?.includes('ambassador'));
    assert.strictEqual((await emitWithAck(reconnectedHost,'reconnect',{code:responseCreated.code,name:'Action Host'})).success,true);
    const restoredPrivateState=await privateReconnectState;
    assert.notStrictEqual(reconnectedHost.id,originalHostSocketId);
    assert.deepStrictEqual(restoredPrivateState.myCards,['captain','ambassador'],'reconnect must restore the private replacement card');
    assert.strictEqual(getPlayerView(responseRoom,responderC.id).players[0].cards,null,'reconnect must not expose the replacement to opponents');
    responseHost=reconnectedHost;

    await runTaxChallenge({actorCards:['duke'],challengerCards:['captain','contessa'],deck:['assassin','ambassador']});
    assert.strictEqual(responseRoom.players[0].cards.length,1,'a proven 1-influence player must remain at exactly one influence');
    assert.strictEqual(responseRoom.players[1].cards.length,1,'challenger still loses one influence against a 1-influence claim');
    assert.strictEqual(responseRoom.players[0].cards[0],'assassin','the one-card hand should be replaced from the server deck');

    await runTaxChallenge({actorCards:['captain','duke'],challengerCards:['assassin','contessa'],deck:['duke','assassin']});
    assert.deepStrictEqual(responseRoom.players[0].cards,['captain','duke'],'same-role replacement is allowed when another Duke is legitimately drawn from the deck');
    assert.strictEqual(responseRoom.players[1].cards.length,1);

    const lastInfluenceProof=await runTaxChallenge({actorCards:['duke'],challengerCards:['captain'],deck:['assassin'],thirdAlive:false});
    assert.strictEqual(lastInfluenceProof.resultingState.state,'finished','existing game-over behavior should finish when the challenger loses their last influence');
    assert.strictEqual(responseRoom.winner,responseHost.id);
    assert.strictEqual(responseRoom.players[0].cards.length,1,'proof replacement must keep the winning player alive with one influence');
    assert.strictEqual(responseRoom.players[0].alive,true);
    assert.strictEqual(responseRoom.players[1].cards.length,0);
    assert.strictEqual(responseRoom.players[1].alive,false);

    await runOtherRoleProof({action:'assassinate',claimedCard:'assassin',proofPlayerIndex:0});
    await runOtherRoleProof({action:'exchange',claimedCard:'ambassador',proofPlayerIndex:0});
    await runOtherRoleProof({action:'steal',claimedCard:'captain',proofPlayerIndex:0});
    await runOtherRoleProof({action:'foreign_aid',claimedCard:'duke',proofPlayerIndex:1,counterClaim:true});
    await runOtherRoleProof({action:'assassinate',claimedCard:'contessa',proofPlayerIndex:2,counterClaim:true});
    await runOtherRoleProof({action:'steal',claimedCard:'captain',proofPlayerIndex:2,counterClaim:true});

    let falseChallengeProofCount=0;
    const falseChallengeProofListener=reveal=>{if(reveal.kind==='challenge-proof')falseChallengeProofCount+=1;};
    responseHost.on('card_revealed',falseChallengeProofListener);
    const falseClaimState=await startResponseAction('tax',null,room=>{
      room.players[0].cards=['captain','assassin'];
      room.players[1].cards=['ambassador','contessa'];
      room.players[2].cards=['duke','captain'];
      room.deck=['duke','assassin'];
      room.discard=[];
    });
    assert.deepStrictEqual(falseClaimState.responsePhase.allowed,['CHALLENGE','PASS']);
    const falseClaimCardsBefore=inventoryCards(responseRoom);
    const falseClaimReveal=waitForCardReveal(responseHost,'influence-loss');
    const falseClaimNextTurn=waitForGameState(responseHost,view=>view.state==='playing'&&view.phase==='selecting'&&view.currentPlayer===1);
    assert.strictEqual((await emitWithAck(responderB,'actionResponse',{type:'CHALLENGE'})).success,true);
    await falseClaimNextTurn;
    const falseClaimLoss=await falseClaimReveal;
    responseHost.off('card_revealed',falseChallengeProofListener);
    assert.strictEqual(falseClaimLoss.kind,'influence-loss','an unproven claim should keep the existing influence-loss reveal behavior');
    assert.strictEqual(falseChallengeProofCount,0,'an unproven claim must not emit a proof reveal');
    assert.deepStrictEqual(responseRoom.players[0].cards,['captain'],'the player without Duke still loses their influence');
    assert.deepStrictEqual(responseRoom.players[1].cards,['ambassador','contessa'],'the unsuccessful challenger keeps both influences');
    assert.strictEqual(responseRoom.players[0].coins,2,'a successfully challenged false Tax claim must not award coins');
    assert.deepStrictEqual(inventoryCards(responseRoom),falseClaimCardsBefore,'false-claim resolution should still conserve all cards');

    let responseState=await startResponseAction('tax');
    assert.deepStrictEqual(responseState.responsePhase.allowed,['CHALLENGE','PASS'],'Tax responders may challenge or pass');
    assert.deepStrictEqual(responseState.responsePhase.blockCharacters,[],'Tax has no block response');
    assert.strictEqual(responseState.timerEnd,null,'response phase must not expose a countdown timer');
    assert.strictEqual(responseRoom.timer,null,'response phase must not schedule a timeout');
    assert.strictEqual(responseState.players[0].cards,null,'a responder view must not receive another player\'s cards');
    assert(!JSON.stringify(responseState.responsePhase).match(/duke|assassin|ambassador|captain|contessa/),'shared response state must not reveal role identities');
    const afterBPass=waitForGameState(responseHost,gameState=>gameState.responsePhase?.responders.some(player=>player.name==='B'&&player.status==='PASS'));
    assert.strictEqual((await emitWithAck(responderB,'actionResponse',{type:'PASS'})).success,true);
    responseState=await afterBPass;
    assert.strictEqual(responseState.phase,'challenging','one PASS must not resolve while another eligible player is waiting');
    assert(responseState.responsePhase.responders.some(player=>player.name==='B'&&player.status==='PASS'));
    assert(responseState.responsePhase.responders.some(player=>player.name==='C'&&player.status==='waiting'));
    assert.match((await emitWithAck(responderB,'actionResponse',{type:'PASS'})).error,/already responded/,'duplicate responses must be rejected');
    assert.match((await emitWithAck(responseHost,'actionResponse',{type:'PASS'})).error,/not eligible/,'the action player must not respond to their own claim');
    assert.match((await emitWithAck(responderC,'actionResponse',{type:'BLOCK',char:'duke'})).error,/not allowed/,'an unavailable response type must be rejected');
    assert.match((await emitWithAck(responderC,'actionResponse',{type:'INVALID'})).error,/not allowed/,'invalid response values must be rejected');
    assert.match((await emitWithAck(responderC,'actionResponse',null)).error,/not allowed/,'a malformed null response payload must be rejected without bypassing validation');
    const taxResolving=waitForGameState(responseHost,gameState=>gameState.selectedAction==='tax'&&gameState.phase==='resolving');
    assert.strictEqual((await emitWithAck(responderC,'actionResponse',{type:'PASS'})).success,true);
    await taxResolving;
    await wait(1350);
    assert.strictEqual(responseRoom.players[0].coins,5,'all PASS responses should resolve Tax exactly once');
    assert.match((await emitWithAck(responderC,'actionResponse',{type:'PASS'})).error,/No response phase/,'late responses must be rejected after resolution');

    await startResponseAction('tax');
    await emitWithAck(responderB,'actionResponse',{type:'PASS'});
    const taxChallengeResolving=waitForGameState(responseHost,gameState=>gameState.selectedAction==='tax'&&gameState.phase==='resolving');
    assert.strictEqual((await emitWithAck(responderC,'actionResponse',{type:'CHALLENGE'})).success,true);
    await taxChallengeResolving;
    assert.strictEqual(responseRoom.phase,'resolving','a challenge must interrupt without waiting for remaining responders');
    await wait(1350);
    assert.strictEqual(responseRoom.players[2].cards.length,1,'a failed challenge must lose influence through the existing rules resolver');

    responseState=await startResponseAction('foreign_aid');
    assert.deepStrictEqual(responseState.responsePhase.allowed,['BLOCK','PASS'],'Foreign Aid permits block or pass');
    assert.deepStrictEqual(responseState.responsePhase.blockCharacters,['duke']);
    await emitWithAck(responderB,'actionResponse',{type:'PASS'});
    assert.strictEqual(responseRoom.phase,'challenging','Foreign Aid must wait after only one PASS');
    assert.match((await emitWithAck(responderC,'actionResponse',{type:'BLOCK',char:'contessa'})).error,/not allowed/,'invalid block claims must be rejected');
    const counterPhase=waitForGameState(responseHost,gameState=>gameState.responsePhase?.kind==='counter');
    assert.strictEqual((await emitWithAck(responderC,'actionResponse',{type:'BLOCK',char:'duke'})).success,true);
    responseState=await counterPhase;
    assert.deepStrictEqual(responseState.responsePhase.allowed,['CHALLENGE','PASS'],'the action player may challenge or pass on a block');
    assert.strictEqual(responseState.timerEnd,null,'counter response phase must not have a countdown');
    assert.strictEqual(responseRoom.timer,null,'counter response phase must not schedule a timeout');
    const aidResolving=waitForGameState(responseHost,gameState=>gameState.selectedAction==='foreign_aid'&&gameState.phase==='resolving');
    await emitWithAck(responseHost,'actionResponse',{type:'PASS'});
    await aidResolving;
    await wait(1350);
    assert.strictEqual(responseRoom.players[0].coins,2,'an unchallenged Duke block must stop Foreign Aid');

    const targetViewPromise=waitForGameState(responderC,gameState=>gameState.selectedAction==='assassinate'&&gameState.phase==='challenging');
    responseState=await startResponseAction('assassinate',2);
    assert.deepStrictEqual(responseState.responsePhase.allowed,['CHALLENGE','PASS'],'non-target Assassin responders can challenge or pass');
    assert.deepStrictEqual(responseState.responsePhase.blockCharacters,[],'non-target players cannot block Assassinate');
    const targetView=await targetViewPromise;
    assert(targetView.responsePhase.allowed.includes('BLOCK'),'the target may block Assassinate');
    assert.deepStrictEqual(targetView.responsePhase.blockCharacters,['contessa']);
    const counterChallengeView=waitForGameState(responseHost,gameState=>gameState.responsePhase?.kind==='counter');
    await emitWithAck(responderC,'actionResponse',{type:'BLOCK',char:'contessa'});
    responseState=await counterChallengeView;
    assert(responseState.responsePhase.allowed.includes('CHALLENGE'),'the actor may challenge a Contessa block');
    const assassinateResolving=waitForGameState(responseHost,gameState=>gameState.selectedAction==='assassinate'&&gameState.phase==='resolving');
    await emitWithAck(responseHost,'actionResponse',{type:'CHALLENGE'});
    await assassinateResolving;
    await wait(1350);

    const stealTargetView=waitForGameState(responderC,gameState=>gameState.selectedAction==='steal'&&gameState.phase==='challenging');
    responseState=await startResponseAction('steal',2);
    assert.deepStrictEqual(responseState.responsePhase.allowed,['CHALLENGE','PASS'],'a non-target Steal responder may challenge or pass');
    const stealTargetState=await stealTargetView;
    assert.deepStrictEqual(stealTargetState.responsePhase.allowed,['CHALLENGE','BLOCK','PASS'],'the Steal target may challenge, block, or pass');
    assert.deepStrictEqual(stealTargetState.responsePhase.blockCharacters,['captain','ambassador'],'the Steal target may choose either existing block role');
    await emitWithAck(responderB,'actionResponse',{type:'PASS'});
    await emitWithAck(responderC,'actionResponse',{type:'PASS'});
    await wait(1350);
    assert.strictEqual(responseRoom.players[0].coins,4,'all PASS responses should resolve Steal');
    assert.strictEqual(responseRoom.players[2].coins,0);

    await startResponseAction('exchange');
    assert.deepStrictEqual(responseState.responsePhase.allowed,['CHALLENGE','PASS'],'Exchange responders may challenge or pass');
    await emitWithAck(responderB,'actionResponse',{type:'PASS'});
    await emitWithAck(responderC,'actionResponse',{type:'PASS'});
    await wait(1350);
    assert.strictEqual(responseRoom.phase,'selecting','unopposed Exchange should return to its existing selecting phase');
    assert.strictEqual((await emitWithAck(responderB,'actionResponse',{type:'PASS'})).error,'No response phase is active.');
    if(responseRoom.timer)clearTimeout(responseRoom.timer);
    responseRoom.timer=null;

    responseState=await startResponseAction('coup',2);
    assert.strictEqual(responseState.responsePhase,null,'Coup has no response phase');
    await wait(1300);
    responseState=await startResponseAction('income');
    assert.strictEqual(responseState.responsePhase,null,'Income has no response phase');
    await wait(850);

    resetResponseRoom();
    responseRoom.selectedAction='assassinate';
    responseRoom.players[1].cards=['captain','duke'];
    const revealClients=[responseHost,responderB,responderC];
    const revealCounts=[0,0,0];
    const revealListeners=revealClients.map((client,index)=>{
      const listener=()=>{revealCounts[index]+=1;};
      client.on('card_revealed',listener);
      return listener;
    });
    const revealPromises=revealClients.map(client=>new Promise(resolve=>client.once('card_revealed',resolve)));
    const removedCard=responseRoom.players[1].cards.at(-1);
    loseInfluence(responseRoom,1);
    const revealPayloads=await Promise.all(revealPromises);
    await wait(30);
    revealClients.forEach((client,index)=>client.off('card_revealed',revealListeners[index]));
    assert.deepStrictEqual(revealCounts,[1,1,1],'each connected player must receive exactly one card reveal event');
    assert(revealPayloads.every(reveal=>reveal.card===removedCard),'the reveal must match the exact card removed from the hand');
    assert(revealPayloads.every(reveal=>reveal.playerIndex===1&&reveal.playerName==='B'),'the reveal must identify the player who lost influence');
    assert.deepStrictEqual(Object.keys(revealPayloads[0]).sort(),['card','id','kind','playerIndex','playerName','reason'],'public reveal payload must contain only intended public fields');
    assert.strictEqual(revealPayloads[0].kind,'influence-loss');
    assert.strictEqual(responseRoom.players[1].cards.length,1,'the other influence must remain in the player hand');
    assert(!JSON.stringify(revealPayloads[0]).includes('captain'),'the remaining hidden card must not be included in reveal data');
    const publicRevealView=getPlayerView(responseRoom,responseHost.id);
    assert.deepStrictEqual(publicRevealView.cardReveal,revealPayloads[0],'public reveal state must match the one emitted event');
    assert.strictEqual(publicRevealView.players[1].cards,null,'opponents must not receive the remaining hidden card');
    assert.strictEqual(publicRevealView.exchangeHand,null,'public reveal state must not include private Exchange cards');

    const beginExchangeWithHand=async(initialCards,loseOne=false)=>{
      resetResponseRoom();
      responseRoom.players[0].cards=initialCards.slice();
      if(loseOne)loseInfluence(responseRoom,0);
      const survivingInfluence=responseRoom.players[0].cards.length;
      responseRoom.deck=['duke','assassin','contessa','ambassador'];
      const responseStarted=waitForGameState(responseHost,gameState=>gameState.selectedAction==='exchange'&&gameState.phase==='challenging');
      executeAction(responseRoom,'exchange');
      await responseStarted;
      const ownSelection=waitForGameState(responseHost,gameState=>gameState.phase==='exchange_select'&&gameState.exchangePhase==='selecting');
      const opponentSelection=waitForGameState(responderB,gameState=>gameState.phase==='exchange_select'&&gameState.exchangePhase==='selecting');
      assert.strictEqual((await emitWithAck(responderB,'actionResponse',{type:'PASS'})).success,true);
      assert.strictEqual((await emitWithAck(responderC,'actionResponse',{type:'PASS'})).success,true);
      const [ownView,opponentView]=await Promise.all([ownSelection,opponentSelection]);
      assert.strictEqual(ownView.exchangeHand.length,survivingInfluence+2,'the active player receives their private Exchange pool');
      assert.strictEqual(opponentView.exchangeHand,null,'opponents must not receive Exchange card identities');
      assert.strictEqual(opponentView.players[0].cards,null,'opponents must not receive the active player\'s hidden cards');
      return {survivingInfluence,pool:responseRoom.exchangeHand.slice()};
    };

    const twoInfluenceExchange=await beginExchangeWithHand(['duke','assassin']);
    const twoInfluenceDeckBefore=responseRoom.deck.length;
    assert.match((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0,0]})).error,/Invalid Exchange selection/,'duplicate selected cards must be rejected');
    assert.match((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0]})).error,/Invalid Exchange selection/,'invalid selection count must be rejected');
    assert.match((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0,999]})).error,/Invalid Exchange selection/,'a card outside the Exchange pool must be rejected');
    assert.strictEqual(responseRoom.exchangePhase,'selecting','invalid submissions must leave the Exchange phase active');
    assert.strictEqual((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0,1]})).success,true);
    assert.strictEqual(responseRoom.players[0].cards.length,2,'two surviving Influence must yield exactly two final cards');
    assert.deepStrictEqual(responseRoom.players[0].cards,[twoInfluenceExchange.pool[0],twoInfluenceExchange.pool[1]],'selected pool entries must be retained exactly once');
    assert.strictEqual(responseRoom.deck.length,twoInfluenceDeckBefore+2,'each unselected Exchange card must return to the deck once');
    assert.match((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0,1]})).error,/No active Exchange selection/,'late Exchange submissions must be rejected');
    assert.strictEqual(responseRoom.players[0].cards.length,twoInfluenceExchange.survivingInfluence,'Exchange must not increase surviving Influence');

    const oneAfterLoss=await beginExchangeWithHand(['captain','duke'],true);
    assert.strictEqual(oneAfterLoss.survivingInfluence,1,'the loss must be reflected before Exchange begins');
    assert.strictEqual((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0]})).success,true);
    assert.strictEqual(responseRoom.players[0].cards.length,1,'two Influence reduced to one must remain one after Exchange');

    const oneInfluenceExchange=await beginExchangeWithHand(['ambassador']);
    assert.strictEqual(oneInfluenceExchange.survivingInfluence,1);
    assert.strictEqual((await emitWithAck(responseHost,'exchangeSelect',{keepIndices:[0]})).success,true);
    assert.strictEqual(responseRoom.players[0].cards.length,1,'one Influence Exchange must keep exactly one card');

    const reconnectExchange=await beginExchangeWithHand(['contessa']);
    const disconnectedState=waitForGameState(responderB,gameState=>gameState.players[0].disconnected);
    responseHost.disconnect();
    await disconnectedState;
    const exchangeReconnectClient=await connectTestClient(url);
    testClients.push(exchangeReconnectClient);
    const reconnectedState=waitForGameState(exchangeReconnectClient,gameState=>gameState.phase==='exchange_select'&&gameState.exchangePhase==='selecting');
    const opponentReconnectedState=waitForGameState(responderB,gameState=>gameState.phase==='exchange_select'&&gameState.exchangePhase==='selecting');
    assert.strictEqual((await emitWithAck(exchangeReconnectClient,'reconnect',{code:responseCreated.code,name:'Action Host'})).success,true);
    const [privateReconnectView,publicReconnectView]=await Promise.all([reconnectedState,opponentReconnectedState]);
    assert.deepStrictEqual(privateReconnectView.exchangeHand,reconnectExchange.pool,'the active player must recover their private Exchange pool after reconnecting');
    assert.strictEqual(publicReconnectView.exchangeHand,null,'reconnecting must not expose the Exchange pool to opponents');
    const opponentDisconnectState=waitForGameState(exchangeReconnectClient,gameState=>gameState.players[1].disconnected);
    responderB.disconnect();
    await opponentDisconnectState;
    const opponentReconnectClient=await connectTestClient(url);
    testClients.push(opponentReconnectClient);
    const opponentPrivateState=waitForGameState(opponentReconnectClient,gameState=>gameState.phase==='exchange_select'&&gameState.exchangePhase==='selecting');
    const opponentPublicState=waitForGameState(exchangeReconnectClient,gameState=>gameState.phase==='exchange_select'&&gameState.players[1].disconnected===false);
    assert.strictEqual((await emitWithAck(opponentReconnectClient,'reconnect',{code:responseCreated.code,name:'B'})).success,true);
    const [opponentViewAfterReconnect,activeViewAfterOpponentReconnect]=await Promise.all([opponentPrivateState,opponentPublicState]);
    assert.strictEqual(opponentViewAfterReconnect.exchangeHand,null,'an opponent reconnecting during Exchange must not receive the private pool');
    assert.strictEqual(opponentViewAfterReconnect.players[0].cards,null,'an opponent reconnecting during Exchange must not receive the active player\'s cards');
    assert.deepStrictEqual(activeViewAfterOpponentReconnect.exchangeHand,reconnectExchange.pool,'opponent reconnect must preserve the active player\'s private Exchange pool');
    assert.strictEqual((await emitWithAck(exchangeReconnectClient,'exchangeSelect',{keepIndices:[0]})).success,true);
    assert.strictEqual(responseRoom.players[0].cards.length,1,'reconnecting during Exchange must preserve surviving Influence');

    const eliminationRoom=createRoom('qa-host','Winner');
    eliminationRoom.players[0].cards=['duke'];
    eliminationRoom.players.push({id:'qa-target',name:'Eliminated',coins:2,cards:['captain'],alive:true,disconnected:false,disconnectTimer:null});
    eliminationRoom.state='playing';
    eliminationRoom.selectedAction='assassinate';
    loseInfluence(eliminationRoom,1);
    assert.strictEqual(eliminationRoom.players[1].alive,false,'losing the last Influence must eliminate the player');
    assert.strictEqual(checkWinner(eliminationRoom),true,'eliminating all but one player must end the game');
    assert.strictEqual(eliminationRoom.state,'finished','elimination must publish the finished game state');
    assert.strictEqual(eliminationRoom.winner,'qa-host','the sole surviving player must be the winner');

    const offlineHost=await connectTestClient(url);
    testClients.push(offlineHost);
    const offlineGuest=await connectTestClient(url);
    testClients.push(offlineGuest);
    const offlineCreated=await emitWithAck(offlineHost,'createRoom',{name:'Offline Host'});
    testRoomCodes.push(offlineCreated.code);
    await emitWithAck(offlineGuest,'joinRoom',{code:offlineCreated.code,name:'Offline Guest'});
    const offlineRoom=rooms.get(offlineCreated.code);
    offlineRoom.state='finished';
    offlineRoom.phase='finished';
    const offlineHarness=createAppHarness(offlineHost,{'coup-last-room':JSON.stringify({code:offlineCreated.code,name:'Offline Host'})});
    const offlineFinishedState={
      code:offlineCreated.code,state:'finished',phase:'finished',currentPlayer:0,selectedAction:null,selectedTarget:null,
      timerEnd:null,timerDuration:10000,myIndex:0,deckCount:0,winner:offlineHost.id,log:[],myCards:[],
      exchangePhase:null,exchangeHand:null,counterChallengePhase:false,counterChallengeTimerEnd:null,
      counterChallengeDuration:6000,pendingCounter:null,lastLostCard:null,lastLostPlayerIndex:null,
      players:offlineRoom.players.map((player,index)=>({id:player.id,name:player.name,coins:player.coins,cardCount:player.cards.length,alive:player.alive,isMe:index===0,disconnected:false,cards:index===0?player.cards:null}))
    };
    const offlineResultScreen=waitForGameState(offlineHost,gameState=>gameState.code===offlineCreated.code && gameState.state==='finished');
    io.to(offlineHost.id).emit('gameState',offlineFinishedState);
    await offlineResultScreen;
    offlineHost.disconnect();
    await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('server did not mark disconnected finished-room player')),4000);
      const check=()=>{
        const player=offlineRoom.players.find(entry=>entry.name==='Offline Host');
        if (player?.disconnected) {
          clearTimeout(deadline);
          resolve();
        } else setTimeout(check,10);
      };
      check();
    });
    let offlineCreateEmits=0;
    offlineHost.onAnyOutgoing(event=>{if(event==='createRoom')offlineCreateEmits+=1;});
    const offlineReconnect=new Promise(resolve=>offlineHost.once('connect',resolve));
    await offlineHarness.click('create-new-room');
    await offlineReconnect;
    await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('disconnected finished-room player was not removed')),4000);
      const check=()=>{
        if (!offlineRoom.players.some(player=>player.name==='Offline Host')) {
          clearTimeout(deadline);
          resolve();
        } else setTimeout(check,10);
      };
      check();
    });
    assert.strictEqual(offlineHarness.elements.get('lobby').classList.contains('active'),true,'offline Create New Room should remain in the lobby');
    assert.strictEqual(offlineCreateEmits,0,'offline leave must not auto-create a room after reconnecting');
    assert.deepStrictEqual(offlineRoom.players.map(player=>player.id),[offlineGuest.id],'disconnected create-new-room must leave the other player in their existing session');
  } finally {
    for (const client of testClients) client.disconnect();
    if (server.listening) await new Promise(resolve=>io.close(resolve));
    for (const room of rooms.values()) {
      if (room.timer) clearTimeout(room.timer);
      if (room.counterChallengeTimer) clearTimeout(room.counterChallengeTimer);
      for (const player of room.players) if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
      for (const timer of room.disconnectTimers.values()) clearTimeout(timer);
      room.disconnectTimers.clear();
    }
    for (const code of testRoomCodes) rooms.delete(code);
    rooms.delete(protectedRoom.code);
  }

  console.log('PASS: Frontend document, same-origin client, and public assets');
  console.log('PASS: Web Audio gesture unlock, context reuse, mute persistence, and event deduplication');
  console.log('PASS: Foreign Aid block, Steal double-turn guard, Exchange card preservation');
  console.log('PASS: Rematch reuses the room; leaving preserves other players; fresh room reaches normal game setup');
})().catch(err=>{ console.error(err); process.exit(1); });
