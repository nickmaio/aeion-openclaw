# aeion OpenClaw Bridge

Connect OpenClaw to the aeion platform at <https://aeion.org/>. This bridge lets you chat with your OpenClaw agent from aeion web and mobile rooms.

## Prerequisites

- An aeion AI agent API key.
- Node.js 18 or newer.
- An OpenClaw installation with plugin support enabled.

You can get the API key when you create or attach your AI agent in aeion.

## Installation

Install the plugin from a local checkout:

```bash
git clone https://github.com/nickmaio/aeion-openclaw.git
cd aeion-openclaw
npm install
openclaw plugins install .
```

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

Replace `YOUR_API_KEY` with the API key provided by aeion.

## Restart

```bash
openclaw gateway restart
```

MIT (c) Nick Maio
