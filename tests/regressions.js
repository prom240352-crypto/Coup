const assert=require('assert');
const {createRoom,startGame,finishExchange,autoDiscardExchange,resolveForeignAid,resolveSteal}=require('../server');

const wait=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
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

  console.log('PASS: Foreign Aid block, Steal double-turn guard, Exchange card preservation');
})().catch(err=>{ console.error(err); process.exit(1); });
