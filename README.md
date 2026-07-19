# openfox-google-antigravity

Use your **Google AI Pro subscription** via Antigravity (Google's Cloud Code Assist IDE) as an LLM provider in OpenFox.

The plugin adds Google account authentication via OAuth, model discovery, and the transport required to run Gemini and Claude models from OpenFox.

This project is inspired by [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth).

---

<details open>
<summary><b>⚠️ Terms of Service Warning — Read Before Installing</b></summary>

> [!CAUTION]
> Using this plugin (and any proxy for Antigravity) violates Google's Terms of Service. A number of users have reported their Google accounts being **banned** or **shadow-banned** (restricted access without explicit notification).
>
> **By using this plugin, you acknowledge:**
> - This is an unofficial tool not endorsed by Google
> - Your account may be suspended or permanently banned
> - You assume all risks associated with using this plugin
>

</details>

---

## Install

Install the package directly into the OpenFox plugin directory, install its runtime dependencies, then restart OpenFox.

### macOS

```bash
PLUGIN_DIR="$HOME/Library/Application Support/openfox/plugins/openfox-google-antigravity" && mkdir -p "$PLUGIN_DIR" && npx --yes pacote extract openfox-google-antigravity "$PLUGIN_DIR" && npm install --omit=dev --prefix "$PLUGIN_DIR"
```

### Linux

```bash
PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/openfox/plugins/openfox-google-antigravity" && mkdir -p "$PLUGIN_DIR" && npx --yes pacote extract openfox-google-antigravity "$PLUGIN_DIR" && npm install --omit=dev --prefix "$PLUGIN_DIR"
```

### Windows PowerShell

```powershell
$dir = Join-Path $env:APPDATA 'openfox\plugins\openfox-google-antigravity'; New-Item -ItemType Directory -Force $dir | Out-Null; npx --yes pacote extract openfox-google-antigravity $dir; npm install --omit=dev --prefix $dir
```

## Development mode

When OpenFox runs with `OPENFOX_DEV=true`, replace `openfox` with `openfox-dev` in the paths above.

For local plugin development, a symlink is enough:

```bash
mkdir -p "$HOME/Library/Application Support/openfox-dev/plugins" && ln -sfn /path/to/openfox-google-antigravity "$HOME/Library/Application Support/openfox-dev/plugins/openfox-google-antigravity"
```

Build the plugin before starting OpenFox:

```bash
npm install && npm run build
```

## Use

Restart OpenFox, open the onboarding page, select **Google Antigravity**, and connect your Google account.

The plugin resolves the endpoint, authentication adapter, transport adapter, and available models.

## License

MIT
