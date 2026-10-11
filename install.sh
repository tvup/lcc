#!/bin/bash

set -e

REPO_URL="https://github.com/tvup/lcc.git"
INSTALL_DIR="$HOME/.lcc"
BIN_DIR="$HOME/.local/bin"
BIN_NAME="lcc"

# --- Colour helpers (only when stderr is a terminal) ---
red="" green="" dim="" reset=""
if [ -t 2 ]; then
    red=$'\033[31m'
    green=$'\033[32m'
    dim=$'\033[2m'
    reset=$'\033[0m'
fi

die() { echo "${red}$1${reset}" >&2; exit 1; }
info() { echo "${dim}  $1${reset}"; }

# --- Refuse sudo (same rationale as Claude Code's installer) ---
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    die "Kør ikke dette script med sudo. lcc installeres i din hjemmemappe og kræver ikke root.

Kør i stedet:
    curl -fsSL https://raw.githubusercontent.com/tvup/lcc/master/install.sh | bash"
fi

# --- Check dependencies ---
for cmd in node npm git; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd er påkrævet men ikke installeret."
done

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
    die "Node.js 18+ er påkrævet (du har $(node -v))."
fi

echo ""
echo "${green}  /\\_/\\${reset}   ${green}lcc${reset}${dim} installer${reset}"
echo "${green}  ( ● ● )${reset}${dim}  LibreChat Code${reset}"
echo "${green}   > ▽ <${reset}"
echo ""

# --- Clone or pull ---
if [ -d "$INSTALL_DIR/.git" ]; then
    info "Opdaterer eksisterende installation..."
    git -C "$INSTALL_DIR" pull --ff-only origin master 2>&1 | while read -r line; do info "$line"; done
else
    if [ -d "$INSTALL_DIR" ]; then
        die "$INSTALL_DIR eksisterer allerede men er ikke et git-repo. Fjern mappen og prøv igen."
    fi
    info "Kloner lcc til $INSTALL_DIR..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | while read -r line; do info "$line"; done
fi

# --- Install and build ---
info "Installerer afhængigheder..."
(cd "$INSTALL_DIR" && npm install --production=false --silent 2>&1) | while read -r line; do info "$line"; done

info "Bygger..."
(cd "$INSTALL_DIR" && npm run build --silent 2>&1) | while read -r line; do info "$line"; done

# --- Create bin symlink ---
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/$BIN_NAME"
chmod +x "$INSTALL_DIR/dist/index.js"

# --- Ensure ~/.local/bin is in PATH ---
add_to_path() {
    local shell_rc="$1"
    local marker="# lcc"
    if [ -f "$shell_rc" ] && grep -qF "$marker" "$shell_rc"; then
        return
    fi
    echo "" >> "$shell_rc"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\" $marker" >> "$shell_rc"
    info "Tilføjet ~/.local/bin til PATH i $(basename "$shell_rc")"
}

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    case "$(basename "${SHELL:-bash}")" in
        zsh)  add_to_path "$HOME/.zshrc" ;;
        bash)
            if [ -f "$HOME/.bash_profile" ]; then
                add_to_path "$HOME/.bash_profile"
            else
                add_to_path "$HOME/.bashrc"
            fi
            ;;
        fish)
            mkdir -p "$HOME/.config/fish"
            if ! grep -qF "lcc" "$HOME/.config/fish/config.fish" 2>/dev/null; then
                echo "set -gx PATH \$HOME/.local/bin \$PATH # lcc" >> "$HOME/.config/fish/config.fish"
                info "Tilføjet ~/.local/bin til PATH i config.fish"
            fi
            ;;
        *)  add_to_path "$HOME/.profile" ;;
    esac
fi

# --- Verify ---
VERSION=$(node -p "require('$INSTALL_DIR/package.json').version")

echo ""
echo "${green}✅ lcc v${VERSION} installeret!${reset}"
echo ""
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
    echo "${dim}  Genstart din terminal eller kør:${reset}"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
fi
echo "${dim}  Kør 'lcc' for at starte.${reset}"
echo "${dim}  Kør 'lcc' og brug /update for at opdatere.${reset}"
echo ""
