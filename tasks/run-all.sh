#!/bin/bash
set -e
cd ~/pumpball

CLAUDE="/Users/onchainsaber/.local/bin/claude"
NOTIFY="openclaw system event --text"
MODE="--mode now"

notify() {
  $NOTIFY "$1" $MODE 2>/dev/null || true
}

# ============================================================
# TASK 1: Replace "P" watermark with logo.png centered
# ============================================================
notify "🔧 PumpBall Task 1/7: Replacing P watermark with logo.png..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall, a Haxball clone.

TASK: Replace the ugly 'P' text watermark in the center of the field with the actual logo image (logo.png).

File: client/src/renderer.ts

Current code draws a large 'P' character as watermark in buildFieldCache(). Replace it with:
1. Load the logo.png image (from /logo.png since it's in client/public/)
2. Draw it centered on the field with subtle opacity (around 0.06-0.08 alpha) — it should be a watermark, not dominant
3. The logo should scale proportionally with field size (like the P did with FIELD_W/550 ratio)
4. Make the logo size about 60-80px at 4v4 scale, scaling down for smaller modes
5. Use globalAlpha for the transparency
6. Handle image loading properly — create an Image element, load it, and redraw field cache when loaded

The logo should look professional — centered, subtle, properly scaled per mode.

DO NOT modify any other rendering logic. Only replace the P watermark section.

When completely finished, run: openclaw system event --text 'Done: Task 1/7 - Logo watermark replaced' --mode now
"

echo "✅ Task 1 complete"

# ============================================================
# TASK 2: Fix post-match reset (game gets stuck)
# ============================================================
notify "🔧 PumpBall Task 2/7: Fixing post-match reset..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall (Haxball clone). Server: server/src/room.ts, Client: client/src/main.ts

TASK: Fix the post-match reset so the game properly transitions back to the room lobby after a match ends.

PROBLEMS:
1. After gameOver, the client stays on the game screen and feels 'stuck'
2. The reset() in room.ts sets status='waiting' and broadcasts roomUpdated, but the client doesn't handle the transition well

FIXES NEEDED:

SERVER (room.ts):
1. In reset(), after clearing everything, emit a dedicated 'gameReset' event to the room BEFORE broadcastRoomInfo()
2. Make sure all intervals are properly cleared in reset()

CLIENT (main.ts):
1. Add a socket.on('gameReset') handler that:
   - Sets isInGame = false
   - Dispatches 'gameStopped' event  
   - Switches to room screen (showScreen('room'))
   - Clears interpolation state (prevState = null, targetState = null)
   - Shows a toast 'Match ended - returning to lobby'
2. Also handle the case in 'roomUpdated' — if we receive status='waiting' while isInGame is true, transition back
3. After gameOver event, show a countdown overlay or message before the reset happens (the 4 second delay)

Keep changes minimal and focused. Don't break existing functionality.

When completely finished, run: openclaw system event --text 'Done: Task 2/7 - Post-match reset fixed' --mode now
"

echo "✅ Task 2 complete"

# ============================================================
# TASK 3: Auto-start when room is full + countdown timer
# ============================================================
notify "🔧 PumpBall Task 3/7: Auto-start system..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall (Haxball clone). 

TASK: Implement auto-start system. Remove host control — nobody should control rooms. When a room has enough players on teams, auto-start with a countdown.

FILES: server/src/room.ts, server/src/index.ts, client/src/main.ts

SERVER CHANGES (room.ts):
1. Remove the concept of 'host' for game control. Keep hostId only for display purposes or remove entirely.
2. Add an auto-start mechanism:
   - When BOTH teams have at least 1 player each AND the room is full (all team slots filled), start a 5-second countdown
   - Emit 'countdown' event with { seconds: N } each second
   - If someone leaves a team during countdown, cancel it and emit 'countdownCancelled'
   - When countdown hits 0, call startGame()
3. Auto-assign teams: when a player joins a room (not as spectator), auto-assign them to the team with fewer players. If equal, assign to red first.
4. Remove the manual startGame socket event requirement (or keep it but also allow auto-start)
5. In changeTeam(), after team change, check if auto-start conditions are met

SERVER CHANGES (index.ts):
1. Remove or keep the 'startGame' socket handler but it should no longer require host check
2. When a player joins a persistent room, auto-assign them to a team (not spectator)

CLIENT CHANGES (main.ts):
1. Add socket.on('countdown') handler — show countdown number prominently on the room screen
2. Add socket.on('countdownCancelled') handler — hide countdown, show 'Waiting for players...'
3. Remove or hide the 'Start Game' button (it's no longer needed)
4. When joining a room, player should be auto-assigned to a team (server handles this)
5. Keep the ability to switch teams manually (changeTeam buttons stay)

IMPORTANT: 
- For 1v1: need 1 red + 1 blue = 2 total
- For 2v2: need 2 red + 2 blue = 4 total  
- For 4v4: need 4 red + 4 blue = 8 total
- The countdown should only start when ALL slots are filled
- Players can still switch teams during waiting

When completely finished, run: openclaw system event --text 'Done: Task 3/7 - Auto-start system implemented' --mode now
"

echo "✅ Task 3 complete"

# ============================================================
# TASK 4: Disconnect = forfeit (victory for remaining team)
# ============================================================
notify "🔧 PumpBall Task 4/7: Disconnect forfeit system..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall (Haxball clone).

TASK: When a player disconnects during a live match, award victory to the opposing team if the disconnecting player's team has no remaining players.

FILES: server/src/room.ts, client/src/main.ts

SERVER CHANGES (room.ts):
1. In removePlayer(), when status === 'playing':
   - Remove the player from physics
   - Check if their team still has active players (non-spectator, in the game)
   - If a team has 0 players remaining, the OTHER team wins by forfeit
   - Emit 'gameOver' with { winner: otherTeam, score: currentScore, forfeit: true }
   - Then reset after 4 seconds (same as normal game over)
2. Handle edge case: if BOTH teams end up empty (everyone disconnected), just reset with no winner
3. Add a 'playerDisconnected' event emission so the client can show who left

CLIENT CHANGES (main.ts):
1. Handle 'playerDisconnected' in game — show system message '[PlayerName] disconnected'
2. Handle forfeit in gameOver — if forfeit flag is true, show 'WIN BY FORFEIT' instead of normal win message
3. Show appropriate toast notifications

Keep it clean and simple. The key rule: if during a match a team has 0 players, the other team wins.

When completely finished, run: openclaw system event --text 'Done: Task 4/7 - Disconnect forfeit system done' --mode now
"

echo "✅ Task 4 complete"

# ============================================================
# TASK 5: Default avatar gallery (Pepe, Trollface, Wojak, etc.)
# ============================================================
notify "🔧 PumpBall Task 5/7: Default avatar gallery..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall (Haxball clone).

TASK: Add a default avatar selection gallery so players can pick a meme avatar without connecting a wallet.

FILES: client/src/main.ts, client/src/styles.css, client/public/ (for assets)

IMPLEMENTATION:

1. Create SVG/emoji-based default avatars (no external image downloads needed). Use these iconic meme characters as simple colored circle avatars with emoji or text representations:
   - 🐸 Pepe (green circle with frog emoji)
   - 😈 Trollface (purple circle with devil emoji)  
   - 😎 Chad (gold circle with sunglasses emoji)
   - 🦍 Ape (brown circle with gorilla emoji)
   - 🐋 Whale (blue circle with whale emoji)
   - 🚀 Rocket (orange circle with rocket emoji)
   - 💀 Skull (dark circle with skull emoji)
   - 🤡 Clown (pink circle with clown emoji)
   - 👽 Alien (green circle with alien emoji)
   - 🔥 Fire (red circle with fire emoji)
   - ⭐ Star (yellow circle with star emoji)
   - 🎮 Gamer (teal circle with controller emoji)

2. Generate these as canvas-drawn data URLs at startup:
   - 128x128 canvas
   - Colored circle background
   - Large emoji centered
   - Convert to dataURL

3. UI: Add an avatar picker section on the lobby screen (visible to all players, not just wallet-connected):
   - Grid of circular avatar thumbnails
   - Click to select — adds a 'selected' ring
   - Selected avatar is stored in localStorage
   - Selected avatar dataURL is sent with joinRoom as avatarData

4. Style the avatar picker:
   - Grid layout, 6 columns
   - Each avatar: 48px circle, hover glow effect
   - Selected: mint green border ring
   - Section title: 'Choose Avatar'
   - Place it below the player name input area on the lobby screen

5. The avatar picker should work for ALL players (guests and wallet-connected)
   - Wallet-connected players can still upload custom avatars (that takes priority)
   - Guest players use the picker

IMPORTANT: Do NOT try to download external images. Generate everything with canvas + emoji.

When completely finished, run: openclaw system event --text 'Done: Task 5/7 - Default avatar gallery added' --mode now
"

echo "✅ Task 5 complete"

# ============================================================
# TASK 6: Better team differentiation with skins
# ============================================================
notify "🔧 PumpBall Task 6/7: Team differentiation..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall (Haxball clone).

TASK: Make team differentiation much more visible, especially when players have avatar skins.

FILE: client/src/renderer.ts

CURRENT PROBLEM:
- When players have avatar skins, the thin 1.5px-2.5px team-colored border ring is barely visible
- It's hard to tell which team a player is on at a glance
- The border colors for blue team are grey/white which doesn't stand out

CHANGES NEEDED:

1. THICK TEAM BORDER: Increase border ring to 3.5px for all players (4px for self)
   - Red team (mint): bright #91F1B5 border with slight glow
   - Blue team (white): bright #FFFFFF border with slight glow
   
2. TEAM GLOW EFFECT: Add a subtle outer glow ring around each player
   - Red team: mint green glow (rgba(145, 241, 181, 0.3)), radius PLAYER_R + 5
   - Blue team: white glow (rgba(255, 255, 255, 0.25)), radius PLAYER_R + 5
   - This creates a visible 'aura' that's team-colored even with skins

3. TEAM INDICATOR DOT: Draw a small colored dot ABOVE the player name
   - 4px radius circle
   - Team color (mint for red, white for blue)
   - Positioned above the name text
   
4. NAME COLOR BY TEAM: Color the player name text by team
   - Red team names: #91F1B5 (mint)
   - Blue team names: #FFFFFF (white)
   - Currently all names are #ffffffcc regardless of team

5. DIRECTION INDICATOR: Keep the kick ring but make it team-colored too

DO NOT use shadowBlur (GPU killer as noted in the codebase). Use solid color rings/circles for glow effects.

Keep all changes in renderer.ts drawPlayers() method. Don't break the avatar rendering or self-indicator.

When completely finished, run: openclaw system event --text 'Done: Task 6/7 - Team differentiation improved' --mode now
"

echo "✅ Task 6 complete"

# ============================================================
# TASK 7: General UX polish
# ============================================================
notify "🔧 PumpBall Task 7/7: UX polish..."

$CLAUDE --permission-mode bypassPermissions --print "
You are working on PumpBall (Haxball clone).

TASK: General UX improvements to make the experience more intuitive.

FILES: client/src/main.ts, client/src/styles.css, server/src/room.ts

CHANGES:

1. CLEAR GAME STATUS MESSAGES:
   - When waiting for players: show 'Waiting for players... (2/4)' with current/needed count
   - When countdown is active: show big countdown number
   - When game is live: show time remaining prominently
   - When game ends: show clear 'GAME OVER' overlay with winner and score for 3 seconds

2. ROOM SCREEN IMPROVEMENTS:
   - Show the game mode more prominently (1v1 / 2v2 / 4v4) with larger text
   - Show 'Players needed: X more' below team slots
   - Add visual feedback when teams are ready (green checkmark or glow)

3. GAME OVER OVERLAY (client/main.ts):
   - After 'gameOver' event, show a centered overlay on the game canvas:
     - 'VICTORY' or 'DEFEAT' (based on player's team) or 'DRAW'
     - Final score: RED 3 - 2 BLUE
     - 'Returning to lobby in X...' countdown
   - Semi-transparent dark overlay behind it
   - Fade out before transition to room screen

4. JOINING FLOW:
   - When clicking a match card on lobby, if the game is in progress, show 'Joining as spectator...' toast
   - If the game is waiting, show 'Joining team...' toast

5. LEAVE ROOM BUTTON:
   - Make sure the back/leave button is always visible and works cleanly
   - On game screen, add a small 'Leave' button in the corner

Keep changes practical and clean. Don't over-engineer.

When completely finished, run: openclaw system event --text 'Done: Task 7/7 - UX polish complete. All PumpBall tasks finished! 🎉' --mode now
"

echo "✅ Task 7 complete"

notify "🎉 ALL 7 PumpBall tasks completed! Ready for review."
echo ""
echo "======================================"
echo "  ALL 7 TASKS COMPLETE"
echo "======================================"
