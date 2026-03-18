# 🐰😤 BunMoji

*Sidecar-driven sprite expressions and background switching for SillyTavern.* ✨

[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-blue.svg)](https://docs.sillytavern.app/)
[![TunnelVision Compatible](https://img.shields.io/badge/TunnelVision-Compatible-blueviolet.svg)](https://github.com/Coneja-Chibi/TunnelVision)
[![BunnyMo Compatible](https://img.shields.io/badge/BunnyMo-Compatible-pink.svg)](https://github.com/Coneja-Chibi/BunnyMo)

---

## 🎭 What It Does

ST's built-in expression system guesses emotions from text *after* the AI writes. BunMoji does the opposite — a sidecar LLM reads the scene *before* generation and **deliberately picks** the expression and background. 🧠

- 🚀 Sidecar fires pre-generation — zero token overhead on your main model
- 🔧 Native tool calling (Anthropic `tool_use`, OpenAI function calling, Google JSON fallback)
- ⚡ Conditional sprites with narrative conditions (`[mood:tense]`, `[weather:rain]`, freeform)
- 🖼️ Background switching from your existing ST gallery
- 📊 Activity feed showing what the sidecar picked and why
- 💾 Expression metadata survives swipes, reloads, and manual overrides

---

## 🚀 Setup

### Prerequisites

- 🖥️ SillyTavern (latest)
- 🎨 Character with sprite images in their folder
- 💰 A cheap/fast API for the sidecar (Haiku, Gemini Flash, DeepSeek, etc.)
- 🔑 `allowKeysExposure: true` in ST's `config.yaml`

### 1. Install 📥

Paste `https://github.com/Coneja-Chibi/BunMoji` into SillyTavern's "Install Extension" input and click install.

### 2. Configure Sidecar 🛰️

1. ST Connection Manager → create a profile (e.g. "BunMoji Sidecar")
2. Set API source + model (cheap and fast is ideal)
3. In BunMoji settings → select the profile from the Sidecar dropdown

### 3. Add Sprites 🎨

Upload sprite images via drag & drop, file browser, or ZIP upload. Supports PNG, JPG, GIF, WebP, APNG! 🎞️

Filenames become labels: `joy.png` → "joy", `smug.webp` → "smug"

> ⚠️ **Important:** When you upload a sprite with a non-standard label (anything not in ST's default 24 expressions), BunMoji registers it automatically. **Reload the page once** after the first upload for ST to rebuild its sprite cache. After that, it's permanent. 🔄

### 4. Enable 🔛

Toggle "Enable BunMoji." It suppresses ST's built-in classifier, registers your sprite labels, and starts firing the sidecar on every generation.

### 5. Chat 💬

Send a message. Watch the activity feed glow ✨. Expression changes. Background changes. Done! 🎉

---

## 🏷️ Label Sprites

The base set. Auto-detected from your character's sprite folder. The sidecar always has access to these and picks the best fit for the current scene. 🎯

## ⚡ Conditional Sprites

Override sprites that only activate when narrative conditions are met. **When conditionals pass, they take priority over labels.** 👑

Condition types: Emotion, Mood, Time of Day, Location, Weather, Activity, Relationship, Freeform

Conditions support negation (`!` prefix = NOT) and OR groups:

```
exasperated:
  Group 1: [emotion:angry] AND [activity:combat]
  OR
  Group 2: [emotion:scared] AND [!location:safe place]
  OR
  Group 3: [freeform:Sylvian has scared Boo]
```

Priority: conditionals that pass → best fit among them → labels if none pass. For complex stuff, just use freeform — plain English, the sidecar evaluates it. 🧠

---

## 🖼️ Background Tool

Enable to let the sidecar pick scene backgrounds from your ST gallery too. Same sidecar call, both expression + background in one shot. 🎬

- 📸 Thumbnail gallery in settings
- ⚡ Conditional backgrounds (same system as sprites)
- 🔒 Per-chat locking, persists on reload

---

## 📊 Activity Feed

Floating widget (bottom-left) shows what the sidecar is doing in real-time:
- 🎭 Expression picks with reasoning
- 🖼️ Background picks with reasoning
- ⚡ Conditional activations
- ❌ Errors
- ✨ Pulsing glow while working

---

## ✏️ Label Aliases

Click any label in the sprite grid to rename it. The alias is what the sidecar sees — the file stays untouched. 📝

`625418344757067786` → click → type "exasperated" → done! ✅

---

## 👁️ Visibility Controls

Each sprite has independent eye toggles for label and conditional sections:

| Label 👁 | Conditional 👁 | Behavior |
|----------|---------------|----------|
| ✅ ON | ✅ ON | Available everywhere; conditional takes priority when conditions met |
| ✅ ON | ❌ OFF | Always available as label |
| ❌ OFF | ✅ ON | Only available when conditions pass |
| ❌ OFF | ❌ OFF | Invisible to sidecar 👻 |

Arrow buttons (↑↓) move sprites between sections.

---

## ⌨️ Slash Commands

| Command | What It Does |
|---------|-------------|
| `/bm [expression]` | Manually set an expression (overrides sidecar, saves to metadata) 🎯 |
| `/bunmoji [expression]` | Alias for `/bm` |

Autocomplete shows available expressions with aliases. 💾

---

## 🔄 Swipes & Reloads

- **Swipes:** Each swipe stores its own expression. Swiping back restores it. 🔄
- **Reload:** Restores from metadata (slight delay to let ST settle). 🔁
- **Manual `/bm`:** Saves to metadata + chat save. Persists across everything. 💪

---

## 🩺 Diagnostics

Run Diagnostics checks: extension state, classifier suppression, sprites found, sidecar configured, API key access, conditional validation, custom expression registration. 🔧

---

## 🆚 vs ST's Built-In

| | ST Built-In | BunMoji 😤 |
|--|-------------|---------|
| When | After generation 🐌 | Before generation ⚡ |
| How | Classifier guesses | Sidecar decides deliberately 🧠 |
| Main model cost | Tokens 💸 | Zero 🆓 |
| Custom expressions | Manual setup | Auto-detected from files ✨ |
| Conditionals | ❌ | ✅ With narrative conditions |
| Backgrounds | Separate feature | Same sidecar call 🎬 |
| Reasoning | Hidden 🙈 | Activity feed shows why 👀 |
| Swipe persistence | Inconsistent 😬 | Always (metadata) 💾 |
| Aliases | ❌ | Click to rename ✏️ |

---

## 📁 File Structure

```
BunMoji/
├── 🎛️ index.js            Init, settings, UI, events, uploads
├── 🔧 tool.js             Sprite/bg helpers, cache, alias resolution
├── 🧠 sidecar-eval.js     Prompt building, tool calling, response parsing
├── 📡 llm-sidecar.js      Direct API calls (Anthropic/OpenAI/Google)
├── ⚡ conditions.js       Condition type parsing
├── 📊 activity-feed.js    Floating feed widget
├── 🩺 diagnostics.js      Health checks
├── 🎨 settings.html       UI template
├── 💅 style.css           Styles
└── 📋 manifest.json       Extension metadata
```

---

## ⚠️ Known Limitations

- 👤 Single-character chats only for now
- 🔄 First upload of non-default sprite labels needs one page reload
- ⌨️ Uses `/bm` command (doesn't override ST's `/sprite`)
- ⏱️ Sidecar adds ~1-2s latency before each generation

---

## ❓ FAQ

**🔭 Works with TunnelVision?** Yes! Independent extensions, separate sidecars recommended.

**🎨 No sprites?** BunMoji does nothing. Upload sprites first.

**💰 Token cost?** Zero on main model. Sidecar is a separate cheap call.

**🎞️ GIFs/WebP?** Yes! ST handles them natively.

**🔄 Reload needed after upload?** Once per new non-default label. Permanent after that.

**😐 Fallback expression?** Configurable (default: neutral). Safety net when sidecar fails.

---

## 🐰 Support

- [Down the Rabbit Hole](https://discord.gg/nhspYJPWqg) — bug reports, feature requests, help 🐇
- [AI Presets](https://discord.gg/aipresets) — ST community discord

---

*Like all my ST extensions, BunMoji is a proof-of-concept prototype. Every extension I release for SillyTavern is the starting point for a more complete implementation on [RoleCall](https://rolecallstudios.com/coming-soon) — my RP platform where I can build without the constraints of working around someone else's codebase. ST is where I started and I'll always give back to this community, but the full vision lives on RC. If you like what BunMoji does here, the RoleCall version goes further. [RoleCall Discord](https://discord.gg/94NWQppMWt)*
