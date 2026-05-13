# PumpBall — Haxball Clone with pump.fun Theme

## Overview
A real-time multiplayer Haxball clone themed after pump.fun (Solana memecoin launchpad). 
Based on the open-haxball codebase (ref-openhaxball/), converted from P2P to client-server architecture.

## Architecture

### Monorepo Structure
```
pumpball/
├── client/          # Vite + TypeScript + React frontend
│   ├── src/
│   │   ├── game/    # Physics, game logic (from ref-openhaxball)
│   │   ├── ui/      # React components for lobby, game UI
│   │   ├── network/ # Socket.io client
│   │   └── styles/  # CSS with pump.fun theme
│   └── index.html
├── server/          # Node.js + Socket.io authoritative server
│   ├── src/
│   │   ├── index.ts
│   │   ├── room.ts      # Room management (create, join, leave)
│   │   ├── gameLoop.ts  # Server-side game loop + physics
│   │   └── types.ts     # Shared types
│   └── package.json
├── shared/          # Shared types & constants
│   └── types.ts
└── package.json     # Root workspace
```

### Server (Node.js + Socket.io)
- **Authoritative server**: Server runs the physics simulation (using matter-js)
- **Room system**: Players create/join rooms with short room codes (e.g., "PUMP42")
- **Game loop**: Server-side physics at 60fps, state broadcast at 20fps
- **Events**:
  - `createRoom` → creates room, returns roomCode
  - `joinRoom(roomCode)` → joins existing room
  - `leaveRoom` → leaves room
  - `playerInput(keyboard)` → sends player inputs to server
  - `gameState` → server broadcasts authoritative state to all clients
  - `startGame` / `stopGame` → host controls
  - `changeTeam(team)` → player switches team
  - `chatMessage(text)` → room chat
  - `goal(team)` → server announces goal
  - `gameOver(score)` → game end

### Client (Vite + TypeScript)
- **Rendering only**: Client receives state from server and renders
- **Input capture**: Keyboard inputs sent to server
- **Client-side prediction**: Optional interpolation for smooth rendering
- **Lobby UI**: Room list, create/join, player list, team selection, chat

## Theme — pump.fun Colors
```css
/* Core palette */
--bg-primary: #0e0e16;        /* Deep dark background */
--bg-secondary: #1a1a2e;      /* Card/panel background */
--bg-tertiary: #16213e;       /* Slightly lighter panels */
--accent-green: #00e676;      /* Primary pump.fun green */
--accent-green-dim: #00c853;  /* Dimmer green */
--accent-lime: #76ff03;       /* Bright lime for highlights */
--text-primary: #ffffff;
--text-secondary: #a0a0b0;
--text-muted: #666680;
--team-red: #ff3860;          /* Red team */
--team-blue: #00d1ff;         /* Blue team (cyan for dark theme) */
--border: #2a2a4a;
--danger: #ff1744;
--field-bg: #0a1628;          /* Dark field background */
--field-lines: #00e67644;     /* Green field markings (translucent) */
--ball-color: #00e676;        /* Green ball */
--goal-color: #ff174488;      /* Goal line color */
```

### UI Design
- Dark, sleek, crypto-degen aesthetic
- Neon green accents everywhere
- Monospace/tech fonts (e.g., "Space Mono", "JetBrains Mono", or system monospace)
- Glowing effects on buttons and score
- Room codes displayed prominently like token addresses
- Player names with team-colored indicators
- Score display with neon glow effect
- Chat with dark theme

### Field Design
- Dark field background (#0a1628)
- Green translucent field lines (pump.fun green)
- Green ball
- Red team: #ff3860, Blue team: #00d1ff (cyan)
- Goal areas with subtle glow

## Game Features (MVP)
1. **Room system**: Create room → get code → share with friends → they join
2. **Team selection**: Red / Blue / Spectator
3. **Real-time multiplayer**: Up to 6 players (3v3)
4. **Score tracking**: First to 5 goals wins
5. **Chat**: In-room text chat
6. **Sound effects**: Goal, kick, game start/end
7. **Responsive**: Works on desktop (keyboard controls)

## Controls
- Arrow keys / WASD: Move
- Space / X: Kick ball
- Enter: Chat

## Technical Requirements
- Server: Node.js with socket.io, matter-js for physics
- Client: Vite + TypeScript, matter-js for rendering only, socket.io-client
- Both client and server should be runnable with simple npm commands
- Server on port 3001, client dev on port 5173 (Vite default)

## Reference Code
- Physics, game map, types: `ref-openhaxball/src/` 
- Use the physics.ts, gameMapClassic.ts, config.ts, types.ts as starting point
- Convert the P2P network.ts to socket.io client/server pattern
- Keep matter-js for physics engine

## Logo / Branding
- Name: "PumpBall" or "PUMPBALL"
- Tagline: "Kick it. Bet it. Degen it." (for future)
