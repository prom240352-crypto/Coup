# Changelog — 2.2.0 (Animation Integration & Celebration Upgrade)

## Added
- **Card Animation Integration**: `cardDrawAnim()` now triggers when new cards appear in hand (from deck to hand with 3D flip)
- **Card Discard Animation**: `cardDiscardAnim()` now triggers during card reveal (lose influence, with particle trail)
- **Winner Crown Animation**: Crown descends onto winner's seat with GSAP bounce + continuous floating effect
- **Golden Rain**: 5-second continuous golden particle rain during victory celebration
- **Victory Stamp**: "CHAMPION" stamp with GSAP scale animation appears center screen
- **BLOCKED Stamp**: Cyan "BLOCKED" stamp appears when action is blocked (replaces "DENIED")
- **CHALLENGED Stamp**: Red "CHALLENGED" stamp with screen shake when challenge/lose influence occurs
- **Enhanced Victory Sound**: Multi-layer victory march with ascending notes, triumphant chord, bass foundation
- **Particle Pooling**: Reuses DOM elements for particles (reduces GC pressure, pool capped at 100)
- **Mobile Throttle**: Reduced particle count on mobile devices (max 8 per burst vs 20)
- **Continuous Winner Sparkles**: Sparkle effects around winner banner during celebration

## Changed
- `renderHand()` now tracks previous hand state and animates new cards from deck position
- `showCardReveal()` now triggers card discard animation to corner of table
- `particles()` method uses object pooling for performance
- Winner celebration now has 7 layers of effects (was 3): beam, crown, stamp, rain, confetti, fireworks, sparkles
- Win sound is now a full victory march with chord progression (was simple fanfare)
- Block animation shows "BLOCKED" stamp instead of "DENIED"

## Performance
- Particle pool reduces DOM creation/deletion overhead significantly
- Mobile devices get reduced particle count automatically (detected via user agent)
- Particle pool capped at 100 elements max to prevent memory issues
- `isMobile` flag used throughout for adaptive quality

## QA
- All v2.1.0 regression tests still pass
- Client JS syntax validated
- Server module loads correctly
- Card animations tested with exchange flow

---

# Changelog — 2.1.0 (Cinematic Edition)

## Added
- **Fog/Mist Effects**: Ambient fog at table edges (top, bottom, left, right) with drifting animation
- **Dagger Shadow**: Cinematic dagger slash effect for assassinate action
- **Screen Crack**: Crack effect overlay for coup action with shockwave
- **Crown Seal**: Royal crown seal animation for tax action with golden particles
- **Card Draw Animation**: GSAP-powered card draw with 3D flip (deck to hand)
- **Card Discard Animation**: Card discard with particle trail effect
- **Enhanced Text Stamps**: "OVERTHROWN" for coup, "TREASURY" for tax, "ELIMINATED" for assassinate
- **Blood Particles**: Multi-layered blood particles for assassinate (crimson + dark red)

## Improved
- **Action Cinematics**: More layered and dramatic action sequences
- **Sound Layering**: Enhanced multi-stage sound effects
- **Visual Polish**: Smoother GSAP animations throughout
- **Table Atmosphere**: Fog effects add depth and mystery to the table

## Technical
- Added CSS animations: fogDrift, daggerSlash, crackAppear, crownSealPop
- Added AnimEngine methods: daggerShadow(), screenCrack(), crownSeal(), cardDrawAnim(), cardDiscardAnim()
- Enhanced playActionAnim() with new cinematic sequences
- All animations fall back gracefully if GSAP is unavailable

## QA
- All v2.0.0 regression tests still pass
- Tested fog rendering on multiple viewports
- Verified GSAP fallback to CSS animations
- Confirmed cinematic effects trigger correctly for each action

---

# Changelog — 2.0.0 (Premium Edition)

## Added
- GSAP 3.12.5 for smooth animations
- Felt table texture (SVG noise pattern)
- Wooden border with multi-stop gradient
- Ambient candle lighting (4 corners with flicker)
- Ambient particles (dust/embers floating up)
- Dynamic lighting per action
- 3D card tilt on hover
- Tooltips on all action buttons
- 5-step interactive tutorial
- Emoji reactions (5 emojis, float + broadcast)
- Rematch button after game ends
- Enhanced game log with icons
- Haptic feedback on mobile

## Improved
- Card reveal with GSAP 3D flip
- Coin fly with GSAP arc trajectories
- Action animations use GSAP when available
- Touch stability (100dvh, safe-area-inset)

---

# Changelog — 1.1.0

## Fixed
- Foreign Aid Duke block now resolves correctly on the server.
- Steal/counter resolution is guarded against duplicate async turn advancement.
- Exchange manual selection and timeout now return non-kept cards to the deck instead of losing them.
- Exchange timeout uses the same transaction logic as manual selection.
- Reconnection during Exchange selection safely restarts the selection timeout.

## Improved
- Added action-resolution token guards.
- Added live deck count to client state/UI.
- Added layered Web Audio effects.
- Added cinematic block/loss/winner feedback.
- Added premium table/card lighting and foil effects.
- Improved touch/mobile viewport behavior.

## QA
- Added regression tests for Foreign Aid, Steal and Exchange.
