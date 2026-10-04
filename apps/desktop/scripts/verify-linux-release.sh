#!/bin/bash
set -euo pipefail

normalize_debian_version() {
  printf '%s\n' "$1" | tr '-' '~'
}

if [[ "${1:-}" == "--normalize-debian-version" ]]; then
  if [[ "$#" -ne 2 ]]; then
    echo "Usage: verify-linux-release.sh --normalize-debian-version <version>" >&2
    exit 2
  fi
  normalize_debian_version "$2"
  exit 0
fi

install_package=false
if [[ "${1:-}" == "--install" ]]; then
  install_package=true
  shift
fi

if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo "Usage: verify-linux-release.sh [--install] <release-dir> <version> [proof-dir]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Linux release verification must run on native Linux x86_64." >&2
  exit 1
fi

if $install_package && [[ "${CI:-}" != "true" ]]; then
  echo "Package install, upgrade, and removal verification is restricted to CI." >&2
  exit 1
fi

release_dir="$(cd "$1" && pwd)"
version="$2"
proof_dir="${3:-$release_dir/linux-package-proof}"
mkdir -p "$proof_dir"
proof_dir="$(cd "$proof_dir" && pwd)"

appimage="$release_dir/pi-gui-$version-x86_64.AppImage"
deb="$release_dir/pi-gui_${version}_amd64.deb"
debian_version="$(normalize_debian_version "$version")"
required_dependencies=(
  "libgtk-3-0 | libgtk-3-0t64"
  libnotify4
  libnss3
  libxss1
  libxtst6
  xdg-utils
  "libatspi2.0-0 | libatspi2.0-0t64"
  libuuid1
  libsecret-1-0
  libgbm1
)

for artifact in "$appimage" "$deb"; do
  if [[ ! -s "$artifact" ]]; then
    echo "Missing or empty Linux release artifact: $artifact" >&2
    exit 1
  fi
done

temporary_root="$(mktemp -d)"
package_installed=false
smoke_session=""

# Prints the smoke session's live processes, plus any installed-app process that left it.
smoke_processes() {
  ps -e -o pid=,sid=,stat=,args= | awk -v session="$smoke_session" '
    $3 !~ /^Z/ && ($2 == session || $4 ~ /^\/(opt\/pi-gui\/|usr\/bin\/pi-gui$)/) { print $1 }
  '
}

wait_for_smoke_exit() {
  local deadline=$((SECONDS + $1))
  local repeat_signal="${2:-}"
  local pids
  while pids="$(smoke_processes)" && [[ -n "$pids" ]]; do
    if ((SECONDS >= deadline)); then
      return 1
    fi
    if [[ -n "$repeat_signal" ]]; then
      # A dying process may still start another before SIGKILL lands.
      # shellcheck disable=SC2086 # One PID per word.
      kill -s "$repeat_signal" $pids 2>/dev/null || true
    fi
    sleep 0.2
  done
}

show_smoke_processes() {
  local pids
  pids="$(smoke_processes | paste -sd, -)"
  if [[ -n "$pids" ]]; then
    ps -o pid=,sid=,stat=,args= -p "$pids" || true
  fi
}

stop_smoke_processes() {
  if [[ -z "$smoke_session" ]]; then
    return 0
  fi
  show_smoke_processes
  # timeout already sent SIGTERM to the session; a second one would skip the app's
  # bounded quit flush, so wait for that quit before forcing anything left.
  if wait_for_smoke_exit 10 || wait_for_smoke_exit 10 KILL; then
    return 0
  fi
  echo "pi-gui smoke processes survived SIGKILL:" >&2
  show_smoke_processes >&2
  return 1
}

cleanup() {
  stop_smoke_processes || true
  if $package_installed; then
    sudo env DEBIAN_FRONTEND=noninteractive apt-get purge -y pi-gui \
      >"$proof_dir/emergency-remove.log" 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

install_test_tools() {
  sudo apt-get update 2>&1 | tee "$proof_dir/apt-update.log"
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    binutils \
    desktop-file-utils \
    file \
    xauth \
    xvfb \
    2>&1 | tee "$proof_dir/install-test-tools.log"
}

verify_appimage() {
  readelf -h "$appimage" | tee "$proof_dir/appimage-elf-header.txt"
  grep -F "Advanced Micro Devices X86-64" "$proof_dir/appimage-elf-header.txt"
  chmod +x "$appimage"

  local extract_root="$temporary_root/appimage"
  mkdir -p "$extract_root"
  (
    cd "$extract_root"
    "$appimage" --appimage-extract >/dev/null
  )

  local extracted="$extract_root/squashfs-root"
  for executable in "$extracted/AppRun" "$extracted/pi-gui"; do
    if [[ ! -x "$executable" ]]; then
      echo "AppImage is missing executable payload: $executable" >&2
      exit 1
    fi
  done
  if [[ ! -f "$extracted/resources/app.asar" ]]; then
    echo "AppImage is missing resources/app.asar" >&2
    exit 1
  fi

  readelf -h "$extracted/pi-gui" | tee "$proof_dir/appimage-app-elf-header.txt"
  grep -F "Advanced Micro Devices X86-64" "$proof_dir/appimage-app-elf-header.txt"
}

verify_deb_archive() {
  dpkg-deb --info "$deb" | tee "$proof_dir/dpkg-info.txt"
  dpkg-deb --contents "$deb" | tee "$proof_dir/dpkg-contents.txt"
  dpkg-deb --field "$deb" | tee "$proof_dir/dpkg-control-fields.txt"

  assert_control_field Package "pi-gui"
  assert_control_field Version "$debian_version"
  assert_control_field Architecture "amd64"
  assert_control_field Section "devel"
  assert_control_field Priority "optional"
  assert_control_field Maintainer "Matthew Lam <minghinmatthew.lam@gmail.com>"
  assert_control_field Homepage "https://github.com/minghinmatthewlam/pi-gui"

  local description
  description="$(dpkg-deb --field "$deb" Description | head -n 1)"
  if [[ "$description" != "Codex-style desktop app for the pi coding agent" ]]; then
    echo "Unexpected Debian Description: $description" >&2
    exit 1
  fi

  local dependencies
  dependencies="$(
    dpkg-deb --field "$deb" Depends |
      tr ',' '\n' |
      sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/[[:space:]]+\(.*\)$//'
  )"
  printf '%s\n' "$dependencies" >"$proof_dir/dpkg-dependencies.txt"
  for dependency in "${required_dependencies[@]}"; do
    if ! grep -Fx "$dependency" "$proof_dir/dpkg-dependencies.txt" >/dev/null; then
      echo "Debian package is missing dependency: $dependency" >&2
      exit 1
    fi
  done

  local contents="$proof_dir/dpkg-contents.txt"
  assert_contents "$contents" '\./opt/pi-gui/pi-gui$' "application executable"
  assert_contents "$contents" '\./opt/pi-gui/chrome-sandbox$' "Chrome sandbox"
  assert_contents "$contents" '\./opt/pi-gui/resources/app\.asar$' "app.asar"
  assert_contents "$contents" '\./opt/pi-gui/resources/apparmor-profile$' "AppArmor profile"
  assert_contents "$contents" '\./usr/share/applications/pi-gui\.desktop$' "desktop entry"
  assert_contents "$contents" '\./usr/share/icons/hicolor/[0-9]+x[0-9]+/apps/pi-gui\.png$' "desktop icon"
  assert_contents "$contents" '\./opt/pi-gui/resources/pi-gui-core$' "Rust core process"

  local control_dir="$temporary_root/control"
  mkdir -p "$control_dir"
  dpkg-deb --control "$deb" "$control_dir"
  find "$control_dir" -maxdepth 1 -type f -print -exec sh -c 'printf "%s\n" "--- $1"; cat "$1"' _ {} \; \
    >"$proof_dir/dpkg-control-archive.txt"

  local postinst="$control_dir/postinst"
  local postrm="$control_dir/postrm"
  for script in "$postinst" "$postrm"; do
    if [[ ! -x "$script" ]]; then
      echo "Debian control script is missing or not executable: $script" >&2
      exit 1
    fi
  done
  grep -F "update-alternatives --install '/usr/bin/pi-gui' 'pi-gui' '/opt/pi-gui/pi-gui' 100" "$postinst"
  grep -F "chmod 4755 '/opt/pi-gui/chrome-sandbox'" "$postinst"
  grep -F "chmod 0755 '/opt/pi-gui/chrome-sandbox'" "$postinst"
  grep -F "APPARMOR_PROFILE_TARGET='/etc/apparmor.d/pi-gui'" "$postinst"
  grep -F "update-alternatives --remove 'pi-gui' '/opt/pi-gui/pi-gui'" "$postrm"
  if grep -F "update-alternatives --remove 'pi-gui' '/usr/bin/pi-gui'" "$postrm"; then
    echo "Debian postrm uses the alternatives link instead of the registered target." >&2
    exit 1
  fi

  local extracted="$temporary_root/deb-root"
  dpkg-deb --extract "$deb" "$extracted"
  readelf -h "$extracted/opt/pi-gui/pi-gui" | tee "$proof_dir/deb-app-elf-header.txt"
  grep -F "Advanced Micro Devices X86-64" "$proof_dir/deb-app-elf-header.txt"

  readelf -h "$extracted/opt/pi-gui/resources/pi-gui-core" | tee "$proof_dir/deb-core-elf-header.txt"
  grep -F "Advanced Micro Devices X86-64" "$proof_dir/deb-core-elf-header.txt"
}

verify_install_upgrade_launch_remove() {
  if dpkg-query --show --showformat='${Status}\n' pi-gui 2>/dev/null | grep -F "install ok installed"; then
    echo "Refusing to replace an existing pi-gui installation on the CI runner." >&2
    exit 1
  fi

  local old_root="$temporary_root/old-package"
  local old_deb="$temporary_root/pi-gui_0.0.0_amd64.deb"
  dpkg-deb --raw-extract "$deb" "$old_root"
  sed -i 's/^Version: .*/Version: 0.0.0/' "$old_root/DEBIAN/control"
  dpkg-deb --build --root-owner-group "$old_root" "$old_deb" \
    | tee "$proof_dir/build-upgrade-fixture.log"

  package_installed=true
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "$old_deb" \
    2>&1 | tee "$proof_dir/install-old-version.log"
  assert_installed_version "0.0.0"

  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb" \
    2>&1 | tee "$proof_dir/upgrade-to-release.log"
  assert_installed_version "$debian_version"

  dpkg-query --listfiles pi-gui | tee "$proof_dir/installed-files.txt"
  desktop-file-validate /usr/share/applications/pi-gui.desktop \
    2>&1 | tee "$proof_dir/desktop-file-validation.txt"

  for installed_path in \
    /opt/pi-gui/pi-gui \
    /opt/pi-gui/chrome-sandbox \
    /opt/pi-gui/resources/app.asar \
    /usr/share/applications/pi-gui.desktop; do
    if [[ ! -e "$installed_path" ]]; then
      echo "Installed Debian package is missing: $installed_path" >&2
      exit 1
    fi
  done
  if ! compgen -G '/usr/share/icons/hicolor/*x*/apps/pi-gui.png' >/dev/null; then
    echo "Installed Debian package is missing its desktop icon." >&2
    exit 1
  fi
  if [[ "$(readlink -f /usr/bin/pi-gui)" != "/opt/pi-gui/pi-gui" ]]; then
    echo "/usr/bin/pi-gui does not resolve to the installed executable." >&2
    exit 1
  fi

  local sandbox_owner_mode
  sandbox_owner_mode="$(stat -c '%u:%g %a' /opt/pi-gui/chrome-sandbox)"
  printf '%s\n' "$sandbox_owner_mode" | tee "$proof_dir/chrome-sandbox-owner-mode.txt"
  case "$sandbox_owner_mode" in
    "0:0 755" | "0:0 4755") ;;
    *)
      echo "Chrome sandbox must be root-owned and mode 0755 or 4755; got $sandbox_owner_mode." >&2
      exit 1
      ;;
  esac

  # The integrated terminal runs in the Rust core: open a shell through it and read its output.
  local core_profile="$temporary_root/core-profile"
  mkdir -p "$core_profile"
  ELECTRON_RUN_AS_NODE=1 /opt/pi-gui/pi-gui -e '
    const { spawn } = require("node:child_process");
    const core = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => {
      core.kill();
      process.exit(2);
    }, 10000);
    const send = (message) => core.stdin.write(`${JSON.stringify(message)}\n`);
    let lines = "";
    let output = "";
    core.stdout.setEncoding("utf8");
    core.stdout.on("data", (chunk) => {
      lines += chunk;
      for (let end = lines.indexOf("\n"); end >= 0; end = lines.indexOf("\n")) {
        const message = JSON.parse(lines.slice(0, end));
        lines = lines.slice(end + 1);
        if (message.error) throw new Error(message.error.message);
        if (message.id === 2) {
          const terminalId = message.result.sessions[0].id;
          const data = "printf pi-gui-%s-ok core-terminal\n";
          send({ id: 3, method: "terminal.write", params: { ownerId: 1, terminalId, data } });
        } else if (message.method === "terminal.data") {
          output += message.params.data;
          process.stdout.write(message.params.data);
          if (output.includes("pi-gui-core-terminal-ok")) {
            clearTimeout(timer);
            send({ id: 4, method: "core.shutdown" });
            core.stdin.end();
          }
        }
      }
    });
    core.on("close", (code) => process.exit(code ?? 1));
    send({ id: 1, method: "core.initialize", params: { userDataDir: process.argv[2] } });
    const panel = { workspaceId: "smoke", workspacePath: "/tmp", terminalScopeId: "smoke" };
    send({
      id: 2,
      method: "terminal.ensurePanel",
      params: { ownerId: 1, ...panel, shell: "/bin/sh" },
    });
  ' /opt/pi-gui/resources/pi-gui-core "$core_profile" | tee "$proof_dir/core-terminal-runtime.txt"
  grep -F "pi-gui-core-terminal-ok" "$proof_dir/core-terminal-runtime.txt"

  local smoke_home="$temporary_root/smoke-home"
  mkdir -p "$smoke_home/.config" "$smoke_home/.cache"
  # timeout returns once xvfb-run exits, while pi-gui can still be quitting. Run the
  # smoke in its own session so everything it started can be stopped before purge.
  set +e
  # shellcheck disable=SC2016 # The session leader records its own PID.
  HOME="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_home/.config" \
    XDG_CACHE_HOME="$smoke_home/.cache" \
    setsid --wait bash -c 'printf "%s\n" "$$" >"$1" && shift && exec "$@"' bash \
    "$temporary_root/smoke-session" \
    timeout --signal=TERM --kill-after=5s 15s \
    xvfb-run -a /usr/bin/pi-gui --disable-gpu \
    >"$proof_dir/app-launch.log" 2>&1
  local launch_status=$?
  set -e
  smoke_session="$(<"$temporary_root/smoke-session")"
  stop_smoke_processes | tee "$proof_dir/app-shutdown.txt"
  if [[ "$launch_status" -ne 124 ]]; then
    cat "$proof_dir/app-launch.log" >&2
    echo "Installed pi-gui did not remain running under Xvfb (status $launch_status)." >&2
    exit 1
  fi
  if grep -E "SUID sandbox helper binary was found|No usable sandbox" "$proof_dir/app-launch.log"; then
    echo "Installed pi-gui reported a Chrome sandbox failure." >&2
    exit 1
  fi

  sudo env DEBIAN_FRONTEND=noninteractive apt-get purge -y pi-gui \
    2>&1 | tee "$proof_dir/remove.log"
  package_installed=false

  for removed_path in \
    /opt/pi-gui \
    /usr/bin/pi-gui \
    /etc/alternatives/pi-gui \
    /usr/share/applications/pi-gui.desktop \
    /etc/apparmor.d/pi-gui; do
    if [[ -e "$removed_path" || -L "$removed_path" ]]; then
      echo "Debian package removal left behind: $removed_path" >&2
      sudo find "$removed_path" -maxdepth 3 -ls >&2 || true
      exit 1
    fi
  done
  if compgen -G '/usr/share/icons/hicolor/*x*/apps/pi-gui.png' >/dev/null; then
    echo "Debian package removal left behind a pi-gui desktop icon." >&2
    exit 1
  fi
  if dpkg-query --show pi-gui >/dev/null 2>&1; then
    echo "pi-gui remains registered after package purge." >&2
    exit 1
  fi
}

assert_control_field() {
  local field="$1"
  local expected="$2"
  local actual
  actual="$(dpkg-deb --field "$deb" "$field")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Unexpected Debian $field: expected '$expected', got '$actual'." >&2
    exit 1
  fi
}

assert_contents() {
  local contents_file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -Eq "$pattern" "$contents_file"; then
    echo "Debian package is missing $label." >&2
    exit 1
  fi
}

assert_installed_version() {
  local expected="$1"
  local actual
  actual="$(dpkg-query --show --showformat='${Version}' pi-gui)"
  printf '%s\n' "$actual" | tee -a "$proof_dir/installed-versions.txt"
  if [[ "$actual" != "$expected" ]]; then
    echo "Installed pi-gui version mismatch: expected $expected, got $actual." >&2
    exit 1
  fi
}

if $install_package; then
  install_test_tools
fi

verify_appimage
verify_deb_archive

if $install_package; then
  verify_install_upgrade_launch_remove
fi

printf 'Verified Linux %s release artifacts:\n- %s\n- %s\n' \
  "$version" "$appimage" "$deb" | tee "$proof_dir/summary.txt"
