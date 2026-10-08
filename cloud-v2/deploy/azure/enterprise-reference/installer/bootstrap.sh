#!/usr/bin/env bash
# Download the Mentra Private Cloud installer for Azure.
#
#   curl -fsSLo mentra-install.sh https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/private-cloud/CHANNEL/install.sh \
#     && bash mentra-install.sh
#
# Runs in Azure Cloud Shell (Bash) from any browser, or any Bash terminal with
# Azure CLI and Python 3. It downloads the latest published release, verifies
# its SHA-256 checksum, unpacks it into ~/mentra-install, then starts guided
# setup. Run it again to continue an interrupted setup or to upgrade.
#
#   MENTRA_VERSION=3.3.0-dev.711   use that exact release instead of the latest
#   MENTRA_INSTALL_DIR=PATH        use another folder (default ~/mentra-install)
#   MENTRA_START=0                 only download; print the setup command
#
# CI publishes this file with the channel filled in. Everything runs from
# main() on the last line, so a truncated download executes nothing.
set -euo pipefail

main() {
  command -v python3 >/dev/null 2>&1 || {
    printf 'Python 3 is required. Azure Cloud Shell (Bash) includes it.\n' >&2
    exit 1
  }
  # Guided setup asks questions, so it starts only when a person is at the terminal.
  local start="${MENTRA_START:-auto}"
  if [[ "$start" == auto ]]; then
    if [[ -t 0 && -t 1 ]]; then start=1; else start=0; fi
  fi
  NEXT_FILE="$(mktemp)"
  trap 'rm -f "${NEXT_FILE:-}"' EXIT
  MENTRA_CHANNEL="${MENTRA_CHANNEL:-__MENTRA_CHANNEL__}" \
    MENTRA_DOWNLOAD_ORIGIN="${MENTRA_DOWNLOAD_ORIGIN:-https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS}" \
    MENTRA_START="$start" MENTRA_NEXT="$NEXT_FILE" \
    python3 - "$@" <<'PY'
import hashlib, json, os, re, shutil, stat, sys, tarfile, tempfile, urllib.error, urllib.request
from pathlib import Path

VERSION = re.compile(r'\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?')
UNEXPECTED = 'Unexpected release information. Use the install command from the Mentra IT guide.'


def fail(message):
    print('Error: ' + message, file=sys.stderr)
    sys.exit(1)


def fetch(url, destination=None):
    try:
        # Cloudflare rejects Python's default user agent.
        request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'mentra-private-cloud-bootstrap/1'})
        with urllib.request.urlopen(request, timeout=120) as response:
            if destination is None:
                return response.read()
            with open(destination, 'wb') as stream:
                shutil.copyfileobj(response, stream)
    except urllib.error.HTTPError as error:
        fail(f'Cannot download {url} (HTTP {error.code}).')
    except OSError as error:
        fail(f'Cannot download {url} ({getattr(error, "reason", error)}). Check this terminal can reach the internet.')


def fetch_json(url):
    try:
        value = json.loads(fetch(url))
    except ValueError:
        fail(UNEXPECTED)
    return value if isinstance(value, dict) else fail(UNEXPECTED)


def resolve(origin, channel):
    pinned = os.environ.get('MENTRA_VERSION', '')
    if pinned:
        if not VERSION.fullmatch(pinned):
            fail('MENTRA_VERSION must look like 3.3.0 or 3.3.0-dev.711')
        index = fetch_json(f'{origin}/releases/mentra-private-cloud-{pinned}/_assets.json')
        archive = next((a for a in index.get('assets', []) if a.get('name') == 'mentra-private-cloud.tar.gz'), None)
        if not archive:
            fail(f'Release {pinned} has no installer package')
        return pinned, archive.get('browser_download_url', ''), archive.get('digest', '').removeprefix('sha256:')
    if not re.fullmatch(r'dev|beta|stable', channel):
        fail('Unknown release channel. Use the install command from the Mentra IT guide.')
    latest = fetch_json(f'{origin}/private-cloud/{channel}/latest.json')
    if latest.get('schemaVersion') != 1 or latest.get('channel') != channel:
        fail(UNEXPECTED)
    return latest.get('version', ''), latest.get('archiveUrl', ''), latest.get('sha256', '')


def unpack(archive, destination):
    # Accept only the package folder's regular files and directories.
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if (Path(member.name).is_absolute() or '..' in parts or not parts or parts[0] != 'mentra-private-cloud'
                    or not (member.isfile() or member.isdir())):
                fail('The downloaded package contains unexpected files and was not unpacked')
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, open(target, 'wb') as stream:
                shutil.copyfileobj(source, stream)
            target.chmod(0o755 if member.mode & 0o100 else 0o644)
    if not (destination / 'mentra-private-cloud/setup.sh').is_file():
        fail('The downloaded package is missing setup.sh')


def download(package, version, url, checksum):
    package.parent.mkdir(mode=0o700, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=package.parent, prefix=f'.{version}.'))
    try:
        print(f'Downloading Mentra Private Cloud {version}...')
        archive = staging / 'mentra-private-cloud.tar.gz'
        fetch(url, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            fail('Checksum mismatch: the download was corrupted or changed. Nothing was installed.')
        (staging / 'mentra-private-cloud.tar.gz.sha256').write_text(f'{checksum}  mentra-private-cloud.tar.gz\n')
        unpack(archive, staging)
        if package.exists():
            shutil.rmtree(package)
        staging.rename(package)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print(f'Checksum verified: {checksum}')


def main():
    origin = os.environ['MENTRA_DOWNLOAD_ORIGIN'].rstrip('/')
    version, url, checksum = resolve(origin, os.environ['MENTRA_CHANNEL'])
    if not VERSION.fullmatch(version) or not re.fullmatch(r'[0-9a-f]{64}', checksum):
        fail(UNEXPECTED)
    if not url.startswith(f'{origin}/releases/mentra-private-cloud-{version}/'):
        fail('Release information points outside Mentra downloads')

    home = Path(os.environ.get('MENTRA_INSTALL_DIR') or Path.home() / 'mentra-install').expanduser()
    try:
        home.mkdir(parents=True, exist_ok=True)
        home.chmod(0o700)
        home = home.resolve()
        info = home.stat()
    except OSError as error:
        fail(f'Cannot use {home} ({error.strerror}).')
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        fail(f'{home} cannot be made private. In Cloud Shell, use the default ~/mentra-install (not clouddrive).')

    package = home / 'packages' / version
    if (package / 'mentra-private-cloud/setup.sh').is_file():
        print(f'Mentra Private Cloud {version} is already downloaded.')
    else:
        download(package, version, url, checksum)

    link = home / 'mentra-private-cloud'
    # Packages before 3.3.0-dev.712 default the state folder to mentra-setup.
    state_dir = next((home / name for name in ('mentra-state', 'mentra-setup') if (home / name / 'state.json').exists()),
                     home / 'mentra-state')
    active, runner, message = deployment_plan(home, package, state_dir)
    if link.exists() and not link.is_symlink():
        print(f'\n{link} already exists and was left unchanged. The new package is in {package}.')
        return
    target = f'packages/{active.name}/mentra-private-cloud' if active else None
    if target and (not link.is_symlink() or os.readlink(link) != target):
        temporary = home / '.mentra-private-cloud.link'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target)
        temporary.replace(link)
    if message:
        print('\n' + message)
    if not runner:
        return
    if active and runner[0] == str(home / 'packages' / active.name / 'mentra-private-cloud/setup.sh'):
        runner[0] = str(link / 'setup.sh')
    command = runner + ['--directory', str(state_dir)]
    if os.environ.get('MENTRA_START') == '1':
        # The shell starts guided setup once this download step has exited.
        Path(os.environ['MENTRA_NEXT']).write_text('\n'.join([str(home)] + command) + '\n')
    else:
        relative = ' '.join(c.replace(str(home) + '/', './') for c in command)
        print(f'\nNext, run:\n\n  cd {home}\n  {relative}')


def release_hash(package):
    path = package / 'mentra-private-cloud/release.json'
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def order(version):
    # Same ordering as the installer's release_version(): a release follows its prereleases.
    base, _, suffix = version.partition('-')
    parts = tuple((0, int(x)) if x.isdigit() else (1, x) for x in suffix.split('.')) if suffix else ()
    return tuple(int(x) for x in base.split('.')) + ((0, parts) if suffix else (1, ()))


def deployment_plan(home, package, state_dir):
    """Mirror the installer's rule that saved state belongs to one release.

    Returns the package the link must point at (None leaves it alone), the
    setup command to run next (None for nothing) and a message for the operator.
    """
    def setup(p):
        return [str(home / 'packages' / p.name / 'mentra-private-cloud/setup.sh')]
    if not (state_dir / 'state.json').exists():
        return package, setup(package), f'Mentra Private Cloud {package.name} is ready in {home}.'
    try:
        state = json.loads((state_dir / 'state.json').read_text())
        pending = json.loads((state_dir / 'upgrade.pending.json').read_text()) \
            if (state_dir / 'upgrade.pending.json').exists() else {}
    except (OSError, ValueError):
        return None, None, f'Cannot read {state_dir}; the active package was left unchanged.'
    # The only package that can operate this state, including a pending upgrade's target.
    required = pending.get('targetReleaseHash') or state.get('releaseHash')
    current = next((p for p in sorted((home / 'packages').iterdir()) if release_hash(p) == required), None)
    if current is None:
        return None, None, (f'The package for the deployment in {state_dir} is not in {home / "packages"}, '
                            'so the active package was left unchanged.')
    if current == package or order(package.name) <= order(current.name):
        return current, setup(current), None
    if state.get('phase') == 'infrastructure_verified' and not pending:
        # Guided setup in the new package previews the upgrade and asks before changing anything.
        return current, setup(package), (f'Upgrade available: {current.name} -> {package.name}. '
                                                       'Your deployment keeps running until you confirm.')
    return current, setup(current), (f'Setup with {current.name} is not finished yet; it continues now. '
                                     f'Run this command again afterwards to upgrade to {package.name}.')

main()
PY
  if [[ -s "$NEXT_FILE" ]]; then
    local lines=() line
    while IFS= read -r line; do lines+=("$line"); done < "$NEXT_FILE"
    rm -f "$NEXT_FILE"
    cd "${lines[0]}"
    exec "${lines[@]:1}"
  fi
}

main "$@"
