# COUP v2.2.0 — Animation Integration & Celebration Upgrade — Next AI Handoff

## What's new in v2.2.0

This is an animation integration and celebration upgrade from v2.1.0. All core game logic (server.js) is unchanged. The client (index.html) received significant improvements:

### 1. Card Animation Integration (COMPLETED from v2.1.0 Priority 2)
- ✅ **Card Draw Animation**: When new cards appear in hand, they animate from deck to hand with 3D flip
  - `renderHand()` now tracks `previousHand` and detects new cards
  - Uses `AnimEngine.cardDrawAnim()` for smooth GSAP animation
  - Plays exchange sound on card draw
- ✅ **Card Discard Animation**: When losing influence, card animates to discard pile
  - `showCardReveal()` now triggers `AnimEngine.cardDiscardAnim()`
  - Particle trail follows the card to discard area

### 2. Winner Celebration Upgrade (COMPLETED from v2.1.0 Priority 3)
- ✅ **Crown Animation**: Crown descends onto winner's seat with bounce + floating
  - `AnimEngine.crownDescend(x, y)` with GSAP bounce.out easing
  - Continuous gentle floating after landing
  - Sparkle burst when crown lands
- ✅ **Golden Rain**: 5-second continuous golden particle rain
  - `AnimEngine.goldenRain(duration)` with adaptive quality
  - Particles fall with sway and rotation
- ✅ **Victory Stamp**: "CHAMPION" stamp with scale animation
  - `AnimEngine.victoryStamp(name)` with GSAP back.out easing
- ✅ **Enhanced Victory Sound**: Multi-layer victory march
  - Ascending note sequence (8 notes)
  - Triumphant chord (4 voices)
  - Deep bass foundation
  - Soft shimmer overlay
- ✅ **7-Layer Celebration**: beam, crown, stamp, rain, confetti, fireworks, sparkles

### 3. Additional Stamps
- ✅ **BLOCKED Stamp**: Cyan "BLOCKED" stamp when action is blocked
  - Replaces old "DENIED" stamp
  - Appears with shield animation
- ✅ **CHALLENGED Stamp**: Red "CHALLENGED" stamp when challenge occurs
  - Triggers with screen shake
  - Appears at center of table

### 4. Performance Improvements
- ✅ **Particle Pooling**: Reuses DOM elements instead of creating/destroying
  - `particlePool` array stores up to 100 particles
  - `particles()` method checks pool before creating new elements
  - Significantly reduces GC pressure
- ✅ **Mobile Throttle**: Adaptive quality based on device
  - `isMobile` flag detects mobile via user agent
  - Mobile: max 8 particles per burst, pool capped at 40
  - Desktop: max 20+ particles per burst, pool capped at 100

### 5. Enhanced Audio
- ✅ **Victory March**: Complete victory sound redesign
  - 8-note ascending sequence
  - 4-voice triumphant chord
  - Bass foundation (130Hz sine)
  - Soft shimmer (filtered noise)

## Files changed in v2.2.0

### server.js
- **No changes** from v2.1.0

### public/index.html
- **CSS Added**: None (all animations use existing CSS classes)
- **JS Added**: 
  - `AnimEngine.blockedStamp(x, y)` - Cyan BLOCKED stamp
  - `AnimEngine.challengedStamp(x, y)` - Red CHALLENGED stamp with shake
  - `AnimEngine.crownDescend(x, y)` - Crown animation for winner
  - `AnimEngine.goldenRain(duration)` - Golden particle rain
  - `AnimEngine.victoryStamp(name)` - CHAMPION stamp
  - `previousHand` array for tracking card changes
  - `isMobile` flag for adaptive quality
  - `particlePool` array for particle reuse
  - `MAX_PARTICLES` constant
- **JS Modified**: 
  - `renderHand()` - Now tracks previous hand and animates new cards
  - `showCardReveal()` - Now triggers card discard animation
  - `particles()` - Now uses object pooling
  - `showShield()` - Now shows BLOCKED stamp instead of DENIED
  - Winner celebration - Now has 7 layers of effects
  - `SoundEngine.play('win')` - Now plays victory march
  - `socket.on('gameState')` - Now triggers CHALLENGED stamp

### package.json
- Version bumped to 2.2.0
- Description updated to "Cinematic Edition v2.2"

## Run

```bash
npm install
npm start
```

Then open: http://localhost:3000

## Test

```bash
npm test
```

Expected: `PASS: Foreign Aid block, Steal double-turn guard, Exchange card preservation`

## Priority recommendations for next AI

### Priority 1: Real audio samples ⭐⭐⭐
**Status**: Still using Web Audio API oscillators.
**Task**: Replace synthesized sounds with real audio samples from freesound.org or use Tone.js for more sophisticated synthesis. Each action should have 3-5 layered sounds. Reference: Slay the Spire, Hearthstone, Marvel Snap.

**Needed sounds**:
- Coin: Metal coin clink (search: "coin drop", "metal clink")
- Coup: Explosion + debris (search: "explosion small", "debris impact")
- Assassinate: Blade slash + impact (search: "sword slash", "knife stab")
- Tax: Royal fanfare + coins (search: "fanfare trumpet", "coins pouring")
- Exchange: Card shuffle (search: "card shuffle", "paper shuffle")
- Block: Shield bash (search: "shield hit", "metal shield")

### Priority 2: Interactive tutorial ⭐⭐
**Status**: Still text-based 5-step tutorial.
**Task**: Make tutorial interactive - highlight UI elements as you learn, show animated examples, guide user through first turn, add practice mode for challenge/counter.

### Priority 3: Advanced table effects ⭐
**Status**: Has fog + candles.
**Task**: Add dynamic shadows (cards cast shadows based on mouse), reflective surface, optional weather effects (rain/snow), day/night cycle.

### Priority 4: Exchange animation integration ⭐
**Status**: Card draw/discard integrated, but exchange flow not fully animated.
**Task**: When exchange starts, animate 2 cards drawing from deck. When exchange ends, animate returned cards going back to deck. Show card faces during exchange selection.

### Priority 5: Accessibility ⭐
**Task**: Add reduce motion toggle, colorblind mode, screen reader support (ARIA labels), keyboard navigation.

### Priority 6: Performance ⭐
**Task**: Move particle physics to web worker, lazy load GSAP, consider canvas rendering for particles on low-end devices, pause animations when tab not visible.

## QA scenarios for next AI

### New features (v2.2.0)
- [ ] Card draw animation triggers when new cards appear in hand
- [ ] Card discard animation triggers when losing influence
- [ ] Crown descends onto winner's seat with bounce
- [ ] Golden rain falls for 5 seconds after victory
- [ ] CHAMPION stamp appears center screen
- [ ] BLOCKED stamp appears when action is blocked
- [ ] CHALLENGED stamp appears with screen shake
- [ ] Particle pooling works (check DevTools for fewer DOM nodes)
- [ ] Mobile devices have reduced particle count
- [ ] Victory sound is multi-layered march

### Existing features (regression)
- [ ] All v2.1.0 tests still pass
- [ ] Multiplayer core works (create, join, start, all actions)
- [ ] Foreign Aid block matrix
- [ ] Steal counter matrix
- [ ] Exchange card preservation
- [ ] Reconnection during normal turn and exchange
- [ ] Card reveal animation
- [ ] Fog effects at table edges
- [ ] Action cinematics (assassinate, coup, tax)
- [ ] Mobile touch controls
- [ ] Emoji reactions
- [ ] Rematch button
- [ ] Tutorial opens and navigates

## Known limitations
1. GSAP loaded from CDN - if offline, falls back to CSS animations
2. Sound still uses Web Audio API oscillators - not true cinematic quality
3. No real audio samples - all synthesized
4. Fog effects may impact performance on very old mobile devices
5. Screen crack effect is SVG-based, could be more detailed
6. No accessibility options (reduce motion, colorblind mode)
7. Tutorial is text-only, not interactive

## Tech stack
- **Server**: Node.js + Express + Socket.io
- **Client**: Vanilla JS + GSAP 3.12.5 (CDN) + Web Audio API
- **Styling**: CSS3 with custom properties, animations, gradients
- **Assets**: Card images (JPG) in public/cards/

## Handoff prompt

> Continue this COUP project from v2.2.0. **Do not rewrite working systems.** First inspect `server.js`, `public/index.html`, and `tests/regressions.js` and run `npm test`.
>
> The v2.2.0 pass added: card animation integration (cardDrawAnim and cardDiscardAnim now trigger in game flow), winner celebration upgrade (crown animation, golden rain, CHAMPION stamp, victory march sound, 7-layer effects), BLOCKED/CHALLENGED stamps, particle pooling for performance, and mobile throttle.
>
> **Priority 1**: Replace Web Audio oscillators with real audio samples from freesound.org or Tone.js. Each action should have 3-5 layered sounds. Reference Slay the Spire / Hearthstone / Marvel Snap.
>
> **Priority 2**: Make tutorial interactive - highlight UI elements as you learn, show animated examples, guide user through first turn, add practice mode.
>
> **Priority 3**: Add advanced table effects - dynamic shadows, reflective surface, optional weather effects, day/night cycle.
>
> **Priority 4**: Complete exchange animation integration - animate cards drawing from deck and returning to deck during exchange.
>
> **Priority 5**: Add accessibility options - reduce motion toggle, colorblind mode, ARIA labels, keyboard navigation.
>
> Before finishing, run `npm test`, perform syntax check of client script, and manually verify at least two connected clients. Fix any discovered regression before returning the next package.
