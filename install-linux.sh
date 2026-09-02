#!/bin/bash
# Haven Desktop — Linux Desktop Integration
# Run this after downloading the AppImage to set up:
#   - Application menu entry
#   - Desktop icon
#   - File association
#
# Usage:  chmod +x install-linux.sh && ./install-linux.sh
#
# Current AppImages do not need libfuse.so.2. If an older build errors with
# "requires FUSE", run:  ./Haven*.AppImage --appimage-extract-and-run

set -e

APPIMAGE=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find the AppImage
for f in "$SCRIPT_DIR"/Haven*.AppImage "$HOME"/Downloads/Haven*.AppImage; do
  if [ -f "$f" ]; then
    APPIMAGE="$f"
    break
  fi
done

if [ -z "$APPIMAGE" ]; then
  echo "Could not find Haven AppImage."
  echo "Place it in the same directory as this script, or in ~/Downloads."
  read -rp "Enter the full path to the AppImage: " APPIMAGE
  if [ ! -f "$APPIMAGE" ]; then
    echo "File not found: $APPIMAGE"
    exit 1
  fi
fi

INSTALL_DIR="$HOME/.local/share/haven-desktop"
ICON_DIR="$HOME/.local/share/icons/hicolor"
DESKTOP_FILE="$HOME/.local/share/applications/haven-desktop.desktop"

echo "Installing Haven Desktop..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Copy AppImage
cp "$APPIMAGE" "$INSTALL_DIR/Haven.AppImage"
chmod +x "$INSTALL_DIR/Haven.AppImage"

# Extract icon from AppImage (or use bundled icon)
ICON_SRC=""
if [ -f "$SCRIPT_DIR/assets/icon.png" ]; then
  ICON_SRC="$SCRIPT_DIR/assets/icon.png"
else
  # Try to extract from AppImage
  cd /tmp
  "$INSTALL_DIR/Haven.AppImage" --appimage-extract haven.png 2>/dev/null || true
  "$INSTALL_DIR/Haven.AppImage" --appimage-extract *.png 2>/dev/null || true
  if [ -f /tmp/squashfs-root/haven.png ]; then
    ICON_SRC="/tmp/squashfs-root/haven.png"
  elif [ -f /tmp/squashfs-root/*.png ]; then
    ICON_SRC="$(ls /tmp/squashfs-root/*.png | head -1)"
  fi
  cd "$SCRIPT_DIR"
fi

# Install icon at multiple sizes
if [ -n "$ICON_SRC" ] && [ -f "$ICON_SRC" ]; then
  for size in 16 24 32 48 64 128 256 512; do
    mkdir -p "$ICON_DIR/${size}x${size}/apps"
    if command -v convert &>/dev/null; then
      convert "$ICON_SRC" -resize "${size}x${size}" "$ICON_DIR/${size}x${size}/apps/haven-desktop.png"
    else
      cp "$ICON_SRC" "$ICON_DIR/${size}x${size}/apps/haven-desktop.png"
    fi
  done
  echo "  Icons installed."
else
  echo "  Warning: Could not find icon. Menu entry will use a generic icon."
fi

# Create .desktop file
mkdir -p "$(dirname "$DESKTOP_FILE")"
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=Haven
Comment=Private self-hosted chat
Exec=$INSTALL_DIR/Haven.AppImage %U
Icon=haven-desktop
Type=Application
Categories=Network;Chat;InstantMessaging;
Terminal=false
StartupWMClass=Haven
EOF

chmod +x "$DESKTOP_FILE"

# Update desktop database
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null || true
fi

echo ""
echo "Done! Haven Desktop is now installed."
echo "  App location: $INSTALL_DIR/Haven.AppImage"
echo "  Menu entry:   $DESKTOP_FILE"
echo ""
echo "You should see 'Haven' in your application menu."
echo "To uninstall, run:  rm -rf $INSTALL_DIR $DESKTOP_FILE $ICON_DIR/*/apps/haven-desktop.png"
