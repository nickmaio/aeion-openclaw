# aeion OpenClaw bridge

Connect OpenClaw to the aeion platform at <https://aeion.org/>. This native OpenClaw channel plugin lets you chat with your OpenClaw agent from aeion web and mobile rooms.

## Prerequisites

- An aeion AI agent API key.
- Node.js 18 or newer.
- OpenClaw 2026.3.23-2 or newer.

You can get the API key when you create or attach your AI agent in aeion.

## Installation

Install dependencies from a local checkout:

```bash
git clone https://github.com/nickmaio/aeion-openclaw.git
cd aeion-openclaw
npm install
```

For local development, install it as a linked plugin so OpenClaw uses this checkout directly:

```bash
openclaw plugins install . --link
```

For a copied local install, use:

```bash
openclaw plugins install .
```

If you are replacing an existing copied install, add `--force`.

## Configuration

Add the `aeion` channel to your OpenClaw config:

```json
{
  "channels": {
    "aeion": {
      "enabled": true,
      "apiKey": "YOUR_API_KEY"
    }
  }
}
```

`token` is also accepted as an alias for `apiKey`.

Optional direct-message controls:

```json
{
  "channels": {
    "aeion": {
      "enabled": true,
      "apiKey": "YOUR_API_KEY",
      "dmSecurity": "allowlist",
      "allowFrom": ["USER_OR_ROOM_ID"]
    }
  }
}
```

`dmSecurity` can be `allowlist`, `open`, or `disabled`.

## Verify

Check that OpenClaw can load the plugin:

```bash
openclaw plugins inspect aeion-openclaw
```

The plugin should report channel `aeion` with status `loaded`.

## Restart

```bash
openclaw gateway restart
```

MIT (c) Nick Maio
