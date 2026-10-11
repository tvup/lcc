# lcc — LibreChat Code

A terminal REPL for [LibreChat](https://www.librechat.ai/), inspired by [Claude Code](https://claude.com/product/claude-code).

```
    /\_/\   lcc v1.0.49 — LibreChat Code
   ( ● ● )  Agent: my-agent
    > ▽ <   Tools: on
   /|   |\   MCP: 1 server, 5 tools
  (_|   |_)  /help for commands
```

## Features

- Interactive chat with streaming responses
- Tool use (read/write/edit files, bash, grep, list files)
- [MCP](https://modelcontextprotocol.io/) server support for external tools
- Hold-space voice dictation (Deepgram Nova-3 or OpenAI Whisper)
- Markdown rendering in the terminal
- Tab completion and live command hints
- Multiple models/agents with `/model`
- Multiline input (end a line with `\`)
- Save and load conversations with session auto-restore
- Self-update with changelog via `/update`
- Localised UI — Danish and British English (`/config` → Language, or `LCC_LANG=en`)

## Install

Requires **Node.js 18+** and **git**.

```bash
curl -fsSL https://raw.githubusercontent.com/tvup/lcc/master/install.sh | bash
```

This clones the repo to `~/.lcc`, builds it, and symlinks `lcc` to `~/.local/bin/`.

## Configuration

Run `/config` inside the REPL for an interactive settings menu:

```
  Configuration

  1. URL              https://your-librechat-instance.com
  2. API key          sk-***key
  3. Agent ID         agent_xxx
  4. Language         English (British)
  5. Voice engine     Deepgram Nova-3 (live text)
  6. Voice language   en
  7. Deepgram key     dg-***key
  8. OpenAI key       sk-***key

  Select (1-8) or Enter to go back:
```

Items 5–8 configure [voice input](#voice-input). Keys are shown masked, and a setting that is overridden by an environment variable is marked as such.

Or set environment variables:

```bash
export LIBRECHAT_URL=https://your-librechat-instance.com
export LIBRECHAT_API_KEY=your-api-key
export LIBRECHAT_AGENT_ID=agent_xxx   # optional
export LCC_LANG=en                    # optional: en or da (default)
```

Or create `~/.config/lcc/config.json`:

```json
{
  "url": "https://your-librechat-instance.com",
  "apiKey": "your-api-key",
  "agentId": "agent_xxx",
  "language": "en"
}
```

### MCP servers

Add external tool servers in `~/.config/lcc/mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my/mcp-server"]
    }
  }
}
```

### Voice input

Hold the space bar at the prompt to dictate; the transcript is inserted into the input line for you to edit before sending. Two engines are available:

- **Deepgram Nova-3** — streams audio and shows the text live while you speak
- **OpenAI Whisper** — transcribes when you release the key

Pick the engine, language and API keys in `/config` (items 5–8), or with commands:

| Command                                | Description                              |
| -------------------------------------- | ---------------------------------------- |
| `/voice`                               | Show current voice settings              |
| `/voice deepgram` / `/voice whisper`   | Select engine (asks for a key if missing) |
| `/voice off`                           | Turn voice input off                     |
| `/voice language <code>`               | Set the dictation language, e.g. `da`, `en` |
| `/voice key deepgram\|whisper`         | Replace a saved API key                  |

`sprog` and `nøgle` work as aliases for `language` and `key`. Keys can also come from `DEEPGRAM_API_KEY` / `OPENAI_API_KEY`, which take precedence over saved keys. Settings are stored in `~/.config/lcc/voice.json`.

Requires an audio recorder: `arecord` (alsa-utils) on Linux, or `rec` from SoX (`brew install sox` on macOS).

## Commands

| Command       | Description                              |
|---------------|------------------------------------------|
| `/help`       | Show all commands                        |
| `/clear`      | Clear conversation history               |
| `/config`     | Interactive settings menu                |
| `/model`      | Show or switch model/agent               |
| `/models`     | List all available models                |
| `/save`       | Save conversation                        |
| `/load`       | Load a saved conversation                |
| `/tools`      | Toggle tool use on/off                   |
| `/mcp`        | Show MCP servers and tools               |
| `/voice`      | Configure voice dictation                |
| `/restart`    | Restart (reloads config and MCP servers) |
| `/update`     | Update and restart (git pull + build)    |
| `/exit`       | Quit                                     |

## Development

```bash
git clone https://github.com/tvup/lcc.git
cd lcc
npm install
npm run dev
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
