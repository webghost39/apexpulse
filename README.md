# 🔥 ApexPulse - Multiplayer Esports Talent Analytics

ApexPulse is a lightweight, high-performance, real-time multiplayer esports aim-training and talent-calibration game. Built with modern UI/UX principles and a server-side statistical anti-cheat audit matrix. Works on desktop and mobile (touch supported).

## 🚀 Features
- **Host-Controlled Rooms:** First player to join is the host. The host waits for everyone, then locks the room and opens the match.
- **Two-Layer Timing:** Locking opens a global **60s window**. Each player runs their own **30s** test individually — start any time within the window. Late starters are capped by the remaining window time.
- **Fair Targets:** All players in a room share the same seed, so everyone gets the identical target sequence.
- **Whichever Comes First:** The match ends when every player has finished OR the 60s window closes — whichever happens first.
- **Server-Side Anti-Cheat:** Captures sub-millisecond pointer telemetry to flag macro auto-clickers and aimbot lock-on, server-side.
- **Mobile Ready:** Responsive layout (game area + leaderboard) with full touch support.

## 🎮 How to Play
1. Open the app — enter your name.
2. Share the room URL (copy button in the header) with friends. They open the same link.
3. The host clicks **LOCK & START** once everyone has joined (this closes the room to new players).
4. Each player clicks **START** to play their own 30s run. Hit the targets; miss costs points.
5. Click **FINISH** to submit early, or let the timer run out.
6. When all players finish or the 60s window ends, the final leaderboard is shown. The host can **PLAY AGAIN**.

### Tuning durations (optional)
The window and per-player run length are configurable via environment variables:
```bash
MATCH_WINDOW=90 PLAYER_DURATION=45 npm start
```
Defaults: `MATCH_WINDOW=60`, `PLAYER_DURATION=30` (seconds).

---

## 🛠️ Local Quickstart (Development)

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Boot Core App:**
   ```bash
   npm start
   ```
   Open your browser at `http://localhost:3000`.

   To play on phones, make sure devices are on the same network and open `http://<YOUR_COMPUTER_IP>:3000`.

---

## ☁️ Tencent Cloud Production Deployment

### Prerequisites
Purchase a **Lighthouse** instance on Tencent Cloud (Ubuntu 20.04 LTS / 22.04 LTS or CentOS Stream recommended).

### Step 1: Open Port in Firewall
1. Go to your Tencent Cloud Server Management Dashboard.
2. Navigate to the **Firewall** tab.
3. Click **Add Rule**:
   - **Protocol:** `TCP`
   - **Port:** `3000`
   - **Source:** `0.0.0.0/0` (allows global traffic)

### Step 2: Environment Provisioning
Connect via SSH/WebShell to your cloud instance terminal, then run:
```bash
# Update apt package caches (Ubuntu)
sudo apt update

# Install Node.js and npm
sudo apt install -y nodejs npm

# Globally install the PM2 process manager to keep the server running in the background
sudo npm install pm2 -g
```

### Step 3: Clone the Repository
```bash
# Move to the web deployment folder
mkdir -p /www && cd /www

# Clone this repo from your GitHub
git clone <YOUR_GITHUB_REPOSITORY_HTTPS_URL>
cd apexpulse

# Install server dependencies
npm install
```

### Step 4: Boot the Production Service
```bash
# Run the pre-configured script alias from package.json
npm run prod
```
*Done! Open `http://<YOUR_SERVER_PUBLIC_IP>:3000` to battle with friends.*

---

## 🔄 One-Click Hot-Updates
After you modify local files and push them to GitHub, updating your production node takes only **two commands**:
```bash
cd /www/apexpulse
git pull origin main
pm2 restart apexpulse
```
