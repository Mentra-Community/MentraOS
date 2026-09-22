"""Configuration contract shared by Android and iOS PR packaging."""
from copy import deepcopy
import datetime as dt
import os
import re
from urllib.parse import urlsplit

CONTRACT = 'mentraPrBuild'


def read_build(config):
    build = config.get('extra', {}).get(CONTRACT, {})
    if build.get('schemaVersion') != 1 or not re.fullmatch(r'[a-f0-9]{64}', build.get('mobileFingerprint', '')):
        raise ValueError('App does not support PR repackaging')
    if not re.fullmatch(r'[a-f0-9]{40}', build.get('mobileSourceCommit', '')):
        raise ValueError('Missing original mobile source revision')
    return build


def build_info(env=os.environ):
    return {'commit': env['PR_HEAD_SHA'], 'branch': env['GITHUB_HEAD_REF'],
            'user': env['GITHUB_ACTOR'], 'time': dt.datetime.now(dt.timezone.utc).isoformat()}


def packaged_config(config, *, fingerprint, ota_url, head_sha, build_number, platform, build_info=None):
    url = urlsplit(ota_url)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.fragment or re.search(r'\s', ota_url)):
        raise ValueError('Invalid OTA manifest URL')
    if not re.fullmatch(r'[a-f0-9]{40}', head_sha):
        raise ValueError('Expected full PR head SHA')
    if not isinstance(build_number, int) or not 1 <= build_number <= 2_100_000_000:
        raise ValueError('Invalid mobile build number')
    result = deepcopy(config)
    build = read_build(result)
    if build['mobileFingerprint'] != fingerprint:
        raise ValueError('Mobile fingerprint mismatch')
    build.update(otaManifestUrl=ota_url, prHeadSha=head_sha, buildNumber=build_number)
    if build_info is not None:
        build['buildInfo'] = build_info
    if platform == 'android':
        result.setdefault('android', {})['versionCode'] = build_number
    elif platform == 'ios':
        result.setdefault('ios', {})['buildNumber'] = str(build_number)
    else:
        raise ValueError('Expected android or ios')
    return result
