#!/usr/bin/env bash
# Download the Mentra Private Cloud installer for Azure.
#
#   curl -fsSL https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/private-cloud/CHANNEL/install.sh | bash
#
# Runs in Azure Cloud Shell (Bash) from any browser, or any Bash terminal with
# Azure CLI and Python 3. It downloads the latest published release, verifies
# its SHA-256 checksum and unpacks it into ~/mentra-install. It does not sign in
# to Azure or change anything there.
#
#   MENTRA_VERSION=3.3.0-dev.711   use that exact release instead of the latest
#   MENTRA_INSTALL_DIR=PATH        use another folder (default ~/mentra-install)
#
# CI publishes this file with the channel filled in. Everything runs from
# main() on the last line, so a truncated download executes nothing.
set -euo pipefail

main() {
  command -v python3 >/dev/null 2>&1 || {
    printf 'Python 3 is required. Azure Cloud Shell (Bash) includes it.\n' >&2
    exit 1
  }
  MENTRA_CHANNEL="${MENTRA_CHANNEL:-__MENTRA_CHANNEL__}" \
    MENTRA_DOWNLOAD_ORIGIN="${MENTRA_DOWNLOAD_ORIGIN:-https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS}" \
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
    target = f'packages/{version}/mentra-private-cloud'
    deployed = (home / 'mentra-state/state.json').exists()
    if link.is_symlink() and os.readlink(link) != target and deployed:
        # An existing deployment stays on its installer until IT upgrades it.
        previous = os.readlink(link)
        print(f'''
A deployment already exists in {home / 'mentra-state'} and still uses {previous}.
To upgrade it to {version}, first back up as described under "Upgrades" in the IT guide, then run:

  cd {home}
  ./{target}/setup.sh upgrade --directory ./mentra-state --previous-package ./{previous} --backup-confirmed
  ln -sfn {target} mentra-private-cloud
  ./mentra-private-cloud/setup.sh resume --directory ./mentra-state
  ./mentra-private-cloud/setup.sh verify --directory ./mentra-state''')
        return
    if link.exists() and not link.is_symlink():
        print(f'\n{link} already exists and was left unchanged. The new package is in {home / target}.')
        return
    if not link.is_symlink() or os.readlink(link) != target:
        temporary = home / '.mentra-private-cloud.link'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target)
        temporary.replace(link)
    next_command = 'status' if deployed else 'init'
    print(f'''
Mentra Private Cloud {version} is ready in {home}.
Next, run:

  cd {home}
  ./mentra-private-cloud/setup.sh {next_command} --directory ./mentra-state''')


main()
PY
}

main "$@"
