const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const soundApi=require('../public/sound');
const socketClient=require('socket.io-client').io;
const {server,io,rooms,createRoom,leaveFinishedRoom,startGame,finishExchange,autoDiscardExchange,resolveForeignAid,resolveSteal}=require('../server');

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
assert(html.includes('.winner-actions{display:flex;flex-direction:column') && html.includes('.winner-actions .btn{width:100%;min-height:46px'),'result actions must stack and remain tappable on narrow screens');
for (const asset of ['sound.js','app.js','rules-reference.jpg','cards/ambassador.jpg','cards/assassin.jpg','cards/captain.jpg','cards/contessa.jpg','cards/duke.jpg']) {
  assert(fs.existsSync(path.join(publicDir,asset)),`missing public asset: ${asset}`);
}
const client=fs.readFileSync(path.join(publicDir,'app.js'),'utf8');
assert(!/localhost|127\.0\.0\.1/i.test(client),'browser client must not hard-code a development host');
assert(client.includes("if (button.id === 'rematch')") && client.includes("socket?.emit('rematch')"),'Rematch must keep using its existing same-room event');
assert(client.includes("button.id === 'create-new-room'") && client.includes("await emitWithAck('leaveRoom'"),'Create New Room must leave the old room before creating a room');
assert(client.includes('clearSavedRoom();') && client.includes('await createRoom(name)'),'Create New Room must clear old reconnect state and reuse the room creation flow');
assert(client.includes('if (createNewRoomInProgress) return;'),'Create New Room click handler must ignore duplicate taps');
assert(client.includes('socket.connect()') && client.includes("emitWithAck('reconnect', oldRoom)"),'Create New Room must recover safely if the socket disconnected');
assert(client.includes("byId('create-new-room').disabled = true;") && client.includes("byId('create-new-room').disabled = false;"),'Create New Room must disable during transition and re-enable for later games');
const createNewRoomHandler=client.indexOf('async function createNewRoomFromResult()');
assert(createNewRoomHandler>=0 && client.indexOf('if (createNewRoomInProgress) return;',createNewRoomHandler)<client.indexOf('await ',createNewRoomHandler),'duplicate-tap guard must run synchronously before any async room operation');
assert(client.includes("button.id === 'test-sound'") && client.includes('soundEngine?.testSound()'),'Test Sound must call the audio controller directly from its click handler');
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
  const screens=['lobby','waiting','game'].map(id=>elements.get(id));
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
    click(id){const button=elements.get(id);return documentHandlers.click({target:{closest:()=>button}});}
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
    let oldStorageClearedBeforeLeave=false;
    host.onAnyOutgoing(event=>{
      if (event==='leaveRoom') {
        leaveEmits+=1;
        oldStorageClearedBeforeLeave=appHarness.storage.get('coup-last-room')===undefined;
      }
      if (event==='createRoom') createEmits+=1;
    });
    const freshLobbyUpdate=waitForGameState(host,gameState=>gameState.state==='lobby' && gameState.code!==oldCode);
    const firstTap=appHarness.click('create-new-room');
    assert.strictEqual(appHarness.elements.get('lobby').classList.contains('active'),true,'result action should immediately return the player to the lobby screen');
    assert.strictEqual(appHarness.elements.get('winner-modal').classList.contains('active'),false,'result modal should close before room creation');
    const secondTap=appHarness.click('create-new-room');
    await secondTap;
    assert.strictEqual(leaveEmits,1,'double tap must send only one leave request');
    assert.strictEqual(createEmits,0,'new room creation must wait until the old room is left');
    assert.strictEqual(appHarness.elements.get('create-new-room').disabled,true,'the button should remain disabled while the request is in flight');
    await firstTap;
    const freshState=await freshLobbyUpdate;
    assert.strictEqual(freshState.state,'lobby','Create New Room should reach the normal room lobby');
    assert(oldStorageClearedBeforeLeave,'old reconnect state must be cleared before leaving the previous room');
    assert.strictEqual(leaveEmits,1,'one tap should leave exactly once');
    assert.strictEqual(createEmits,1,'one tap should create exactly one room');
    assert.strictEqual(appHarness.elements.get('waiting').classList.contains('active'),true,'the new room should render the normal waiting lobby');
    assert.strictEqual(appHarness.elements.get('create-new-room').disabled,false,'the result action should be reusable in a later match');
    const fresh=JSON.parse(appHarness.storage.get('coup-last-room'));
    assert(fresh.code && fresh.code!==oldCode,'Create New Room must generate a genuinely new room ID');

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
    const offlineNewLobby=waitForGameState(offlineHost,gameState=>gameState.state==='lobby' && gameState.code!==offlineCreated.code);
    await offlineHarness.click('create-new-room');
    const offlineFreshState=await offlineNewLobby;
    const offlineFreshRoom=rooms.get(offlineFreshState.code);
    assert(offlineFreshRoom && offlineFreshRoom.players.length===1,'a disconnected player should reconnect, leave the old room, and create a fresh lobby');
    assert(offlineFreshState.code!==offlineCreated.code);
    assert.deepStrictEqual(offlineRoom.players.map(player=>player.id),[offlineGuest.id],'disconnected create-new-room must leave the other player in their existing session');
    clearTimeout(offlineFreshRoom.timer);
    offlineFreshRoom.timer=null;
    offlineFreshRoom.state='finished';
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
