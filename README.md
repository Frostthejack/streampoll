# 🎯 Stream Poll — Live Chat Poll Overlay

A highly customizable, borderless, always-on-top overlay application that reads your **Restream.io** live chat in real time and automatically updates a visual poll based on viewer keyword votes. Built with Tauri + Rust for lightning-fast performance and minimal resource usage.

---

## 📋 Table of Contents

1. [What It Does](#what-it-does)
2. [Installation](#installation)
3. [Restream Developer App Setup (Required)](#restream-developer-app-setup-required)
4. [Connecting the App to Restream](#connecting-the-app-to-restream)
5. [Setting Up Your Poll](#setting-up-your-poll)
6. [Managing the Poll (Overlay & Controls)](#managing-the-poll-overlay--controls)
7. [Appearance & Themes](#appearance--themes)
8. [Window Settings & Click-Through](#window-settings--click-through)
9. [Troubleshooting](#troubleshooting)

---

## What It Does

- Reads **live chat** from your Restream-connected platforms (YouTube, Twitch, Facebook, TikTok, etc.) in real time.
- Viewers vote by **typing a keyword** in chat (e.g., `a`, `yes`, `1`).
- The **poll bars update live** on a sleek screen overlay.
- The window is **borderless, transparent, and always on top** — perfect for capturing in OBS, Streamlabs, or just keeping an eye on it while you game.
- Supports **multiple layouts** (Standard, Compact, Grid, Minimalist), custom themes, and custom background images.
- **Click-through mode** lets your mouse pass directly through the window so it never interrupts your gameplay.

---

## Installation

You can download the latest installers and executables for v0.5.1 directly from the repository:
- [Stream Poll Executable (app.exe)](src-tauri/target/release/app.exe)
- [Stream Poll Setup Installer (NSIS)](src-tauri/target/release/bundle/nsis/stream-poll_0.5.1_x64-setup.exe)
- [Stream Poll MSI Installer](src-tauri/target/release/bundle/msi/stream-poll_0.5.1_x64_en-US.msi)

1. Run the **`stream-poll_0.5.1_x64-setup.exe`** installer.
2. Follow the installer prompts to complete the installation.
3. Launch **Stream Poll** from your Start menu or Desktop shortcut.

> **Note:** Windows may show a SmartScreen warning since the app is not currently code-signed. Click **"More info" → "Run anyway"** to proceed safely.

---

## Restream Developer App Setup (Required)

Before Stream Poll can read your live chat, you must create a Developer App on your Restream account to generate the necessary API credentials. You only need to do this **once**.

### Step 1: Create a Developer Account
1. Go to the Restream Developer portal at **[developers.restream.io](https://developers.restream.io/)**.
2. Sign in with your **existing Restream account** (the same one you stream with).
3. Once logged in, click on **"Applications"** in the top navigation bar.

![Restream Developer Applications Tab Placeholder](docs/restream_applications.png)

### Step 2: Create a New Application
1. Click the **"New Application"** (or "Create App") button.
2. Fill in the form:
   - **Application Name:** `Stream Poll` (or any name you prefer).
   - **Description:** `Live chat poll overlay` (optional).
   - **Website:** You can leave this blank or use your streaming profile URL.
3. Click **Create** or **Save**.

### Step 3: Configure OAuth Settings & Redirect URIs
After creating the app, you will be taken to its settings dashboard. Find the **OAuth / Redirect URIs** section.

1. **Redirect URI:** Add the following URI *exactly* as shown (no trailing slashes, no spaces):
   ```text
   http://localhost:17394/callback
   ```
2. **Scopes / Permissions:** You must grant the app permission to read your chat. Enable the following scopes:
   - ✅ **`chat:read`** — *Required.* Allows the app to read incoming live chat messages.
   - ✅ **`profile`** — *Optional but recommended.* Allows the app to read your account profile details.
3. **Save** your changes.

![Restream OAuth Configuration Placeholder](docs/restream_oauth.png)

### Step 4: Copy Your Credentials
On the same settings page, locate your API credentials:
- **Client ID:** A long string of characters.
- **Client Secret:** A private string that acts as your password.

**Copy both of these values.** You will need them to connect Stream Poll.

> ⚠️ **SECURITY WARNING:** Keep your **Client Secret** private! Never show it on stream or share it with anyone.

---

## Connecting the App to Restream

Now that you have your credentials, it's time to connect the Stream Poll application!

1. Open **Stream Poll**. You will see the main **Settings** window.
2. Navigate to the **Auth** tab in the sidebar.
3. Paste your **Client ID** into the designated field.
4. Paste your **Client Secret** into the designated field.
5. Click the **🔐 Connect to Restream** button.
   
![Stream Poll Auth Tab Placeholder](docs/app_auth_tab.png)

6. Your default web browser will automatically open and take you to a Restream authorization page.
7. Click **Authorize** or **Allow** to grant your newly created app access to your chat.
8. Your browser will display a success message. You can now close the browser tab.
9. Back in Stream Poll, the status should turn **green** to indicate you are successfully connected!

> 🔄 **Note:** Restream access tokens occasionally expire for security. If the app disconnects or stops counting votes, simply go back to the Auth tab, click **Disconnect**, and then **Connect to Restream** again to refresh the connection.

---

## Setting Up Your Poll

1. Open the **Poll** tab in the Settings window.
2. Enter your **Poll Question** (e.g., *"Which game should I play next?"*).
3. Set up your **Options**. For each option:
   - **Label:** What viewers will see on screen (e.g., *"Minecraft"*).
   - **Keywords:** What viewers must type in chat to vote for this option. You can use multiple keywords separated by commas (e.g., `minecraft, mc, 1`).
   - **Color:** Pick a unique color for the poll bar using the color swatch.
4. Click **+ Add Option** to add as many choices as you need.
5. Configure your voting rules:
   - **Case Insensitive:** `A` and `a` both count as the same vote (Recommended: ON).
   - **One Vote Per User:** Prevents viewers from spamming votes. Each chatter's vote will only be counted once (Recommended: ON).
6. Click **💾 Save Settings** at the bottom!

![Stream Poll Setup Tab Placeholder](docs/app_poll_setup.png)

### Keyword Tips
- **Keep them short:** Make it easy for viewers (e.g., `1`, `2`, `3` or `y`, `n`).
- **Flexible Matching:** Keywords are matched against the entire message text. If a viewer types `yes please`, and your keyword is `yes`, the vote is successfully counted!

---

## Managing the Poll (Overlay & Controls)

When you launch Stream Poll, the **Settings window** opens. To view the actual poll, click **▶ Show Overlay** in the bottom left of the Settings window. This opens the transparent, borderless overlay window that you can capture in your streaming software!

### Overlay Interactive Controls
You can control the poll *directly* from the transparent overlay!
- **Status Bar:** Click the status text (`Idle`, `Live`, or `Paused`) at the top of the overlay to toggle the poll's state. 
  - Clicking `Idle` will **Start** the poll.
  - Clicking `Live` will **Pause** the poll.
  - Clicking `Paused` will **Resume** the poll.
- **Stop Button:** A red `⏹ Stop` button will appear below the poll when it is running. Clicking this completely stops the poll and resets the vote count.
- **Next Button:** If you have multiple polls queued up, a `⏭ Next` button will appear. Clicking it will immediately load the next poll in your queue.

![Overlay Controls Placeholder](docs/app_overlay_controls.png)

> **Important:** The app only listens to the chat when the status is **Live**. 

---

## Appearance & Themes

Stream Poll is incredibly customizable. Open the **Style Tweaks** tab in Settings to personalize your overlay!

### Layout Modes
- **Standard (Stacked):** Question on top, bars stacked vertically.
- **Compact (Inline):** Slimmer bars, great for saving screen space.
- **Grid (2 Columns):** Displays options side-by-side.
- **Minimalist:** Completely removes the container background for a clean, floating look.

### Custom Images
You can customize almost every element of the poll using your own graphics:
- **Panel Background Image:** Replaces the solid container color.
- **Bar Background Image (Track):** Replaces the empty bar track.
- **Bar Fill Image:** Replaces the colored bar fill that grows as votes come in.
- **Banner Background Image:** Places an image directly behind the Poll Question text at the top of the overlay.

Simply upload your images, and they will dynamically stretch to fit the elements perfectly!

![Style Customization Placeholder](docs/app_style_tweaks.png)

---

## Window Settings & Click-Through

Navigate to the **Settings (Gear Icon) / Application** section for advanced window behavior.

### Click-Through Mode
When Click-Through is enabled, the poll overlay becomes a "ghost." Your mouse clicks will pass **directly through** the overlay into the game or application behind it. This is perfect for single-monitor streamers!

**How to toggle it quickly:**
1. In Settings, configure a **Click-Through Keybind** (e.g., `Ctrl+Shift+T`).
2. When you are gaming, press the shortcut to instantly toggle the ghost mode on or off.
3. An indicator on the overlay will show `Click-Through ON` when enabled.

---

## Troubleshooting

### Chat messages aren't being counted!
1. Ensure the Restream Status in the Auth tab is **Connected (Green)**.
2. Make sure you clicked the overlay to start the poll and it says **● Live**.
3. Go to the **Live Chat** tab in Settings. If you don't see any messages arriving here when people type in your chat, your Restream token may have expired. Disconnect and Reconnect in the Auth tab.
4. Ensure your Keywords match the test messages exactly.

### I lost the overlay window / it disappeared!
- Ensure you clicked **Show Overlay** in the Settings window.
- If Click-Through mode is ON, you cannot click or drag the window. Use your keyboard shortcut to turn Click-Through OFF so you can drag it again.
- Press `Win+D` to show your desktop, sometimes the window is hiding behind a fullscreen game.

### OAuth login opens a browser error page!
- Double-check that your **Redirect URI** on the Restream Developer Dashboard is exactly `http://localhost:17394/callback` (no slash at the end).
- Ensure you pasted the **Client ID** into the Client ID box, and not the Client Secret by mistake.

---
*Built with [Tauri](https://tauri.app) + Rust + Vanilla JS*
