"""The packaged build config (app.config's extra.mentraBuild) that Android and iOS packaging write after the compile."""
from copy import deepcopy
import datetime as dt
import os
import re
from urllib.parse import urlsplit

CONTRACT = 'mentraBuild'


def read_build(config):
    build = config.get('extra', {}).get(CONTRACT, {})
    if build.get('schemaVersion') != 2 or not re.fullmatch(r'[a-f0-9]{64}', build.get('mobileFingerprint', '')):
        raise ValueError('App has no packaged build config')
    if not re.fullmatch(r'[a-f0-9]{40}', build.get('mobileSourceCommit', '')):
        raise ValueError('Missing original mobile source revision')
    return build


def pr_backend(base_ref):
    """Match prBackend in pr-mobile-build.mjs: PRs into staging use staging."""
    return 'staging' if base_ref == 'staging' else 'dev'


def build_info(env=os.environ):
    return {'commit': env['PR_HEAD_SHA'], 'branch': env.get('MENTRA_PR_HEAD_REF') or env['GITHUB_HEAD_REF'],
            'user': env['GITHUB_ACTOR'], 'time': dt.datetime.now(dt.timezone.utc).isoformat()}


def packaging_inputs(env=os.environ):
    """The values packaging writes: a release's own (prepare-mobile-release-env.mjs writes MENTRA_APP_IDENTITY and
    MENTRA_BUILD_*), or a PR head's."""
    build_number = int(env['MENTRAOS_PINNED_BUILD_NUMBER'])
    if env.get('MENTRA_APP_IDENTITY'):
        return dict(ota_url=env['MENTRA_OTA_MANIFEST_URL'], build_number=build_number, identity=env['MENTRA_APP_IDENTITY'],
                    metadata={key: env[f'MENTRA_BUILD_{key.upper()}'] for key in ('commit', 'branch', 'user', 'time')})
    return dict(ota_url=env['PR_OTA_MANIFEST_URL'], build_number=build_number, identity=None, metadata=build_info(env))


def packaged_config(config, *, fingerprint, ota_url, build_number, platform, build_info, identity=None):
    url = urlsplit(ota_url)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.fragment or re.search(r'\s', ota_url)):
        raise ValueError('Invalid OTA manifest URL')
    if not re.fullmatch(r'[a-f0-9]{40}', build_info.get('commit', '')):
        raise ValueError('Expected the full commit of the build')
    if not isinstance(build_number, int) or not 1 <= build_number <= 2_100_000_000:
        raise ValueError('Invalid mobile build number')
    result = deepcopy(config)
    build = read_build(result)
    if build['mobileFingerprint'] != fingerprint:
        raise ValueError('Mobile fingerprint mismatch')
    build.update(otaManifestUrl=ota_url, buildInfo=build_info, buildNumber=build_number)
    if identity is not None:
        if not re.fullmatch(r'\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?', identity):
            raise ValueError('Invalid release identity')
        build['identity'] = identity
    if platform == 'android':
        result.setdefault('android', {})['versionCode'] = build_number
    elif platform == 'ios':
        result.setdefault('ios', {})['buildNumber'] = str(build_number)
    else:
        raise ValueError('Expected android or ios')
    return result
