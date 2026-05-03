# aeion OpenClaw bridge

Connect OpenClaw to the aeion platform at <https://aeion.org/>. This native OpenClaw channel plugin lets you chat with your OpenClaw agent from aeion UI.

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

Add the `aeion` channel and plugin allowlist to your OpenClaw config:

```json
{
  "channels": {
    "aeion": {
      "apiKey": "YOUR_API_KEY",
      "dmSecurity": "open"
    }
  },
  "plugins": {
    "allow": ["aeion-openclaw"],
    "entries": {
      "aeion-openclaw": {
        "enabled": true
      }
    }
  }
}
```

Optional direct-message controls:

```json
{
  "channels": {
    "aeion": {
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

## Troubleshooting

**Error: "Unrecognized key: '***'" or config validation failures**

This error occurs when:
- The `apiKey` is placed in `plugins.entries.aeion-openclaw` instead of `channels.aeion` (wrong section)
- The channel config includes `"enabled": true`—this is not a valid property for channels (only for plugin entries)

Verify your config structure matches the Configuration section above:
- API key and optional settings go in `channels.aeion`
- `plugins.entries.aeion-openclaw` should only contain `"enabled": true`

**Warning: "plugins.allow is empty; discovered non-bundled plugins may auto-load"**

This is a security notice. Add `plugins.allow` to your config to explicitly trust the plugin (see Configuration section above). Include `"aeion-openclaw"` in the `plugins.allow` array.

Built by following the OpenClaw plugin development guide:
<https://docs.openclaw.ai/plugins/sdk-channel-plugins>

MIT (c) Nick Maio
