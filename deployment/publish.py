"""Publish this checkout to existing AWS resources; never create resources or migrate data."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
BUCKET = 'ai-personal-memory-web-webbucket-gscxygrgjqvl'
DISTRIBUTION = 'E3RHZGLPP9XWSI'
WEBSITE = 'https://d2hi82pya3luc1.cloudfront.net'


def run(args, cwd=ROOT, capture=False, input_text=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True, input=input_text,
                          stdout=subprocess.PIPE if capture else None).stdout


def api_url():
    value = os.environ.get('VITE_API_URL', '')
    for filename in ('.env', '.env.local', '.env.production', '.env.production.local'):
        path = ROOT / 'web' / filename
        if path.exists():
            for line in path.read_text().splitlines():
                if line.startswith('VITE_API_URL=') and 'VITE_API_URL' not in os.environ:
                    value = line.split('=', 1)[1].strip().strip('\"\'')
    if not re.fullmatch(r'https://[a-z0-9]+\.execute-api\.ap-southeast-2\.amazonaws\.com/?', value):
        raise RuntimeError('Set the production VITE_API_URL in web/.env.local before publishing.')
    return value.rstrip('/')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='m15-deploy')
    parser.add_argument('--function-name', help='Optional override of the API Lambda discovered from API Gateway')
    args = parser.parse_args()
    region = 'ap-southeast-2'

    def aws(*command, capture=True):
        return run(['aws', *command, '--profile', args.profile, '--region', region, '--no-cli-pager'], capture=capture)

    def data(*command):
        return json.loads(aws(*command, '--output', 'json'))

    endpoint = api_url()
    # Perform access checks before building, pushing, or changing production.
    identity = data('sts', 'get-caller-identity')
    aws('s3api', 'head-bucket', '--bucket', BUCKET)
    distribution = data('cloudfront', 'get-distribution', '--id', DISTRIBUTION)['Distribution']
    origins = distribution['DistributionConfig']['Origins']['Items']
    if distribution['DomainName'] != WEBSITE.split('//')[1] or not any(origin['DomainName'].startswith(BUCKET + '.') for origin in origins):
        raise RuntimeError('The website distribution does not match the expected bucket.')
    function_name = args.function_name
    if not function_name:
        api_id = endpoint.split('//')[1].split('.')[0]
        integrations = data('apigatewayv2', 'get-integrations', '--api-id', api_id)['Items']
        functions = {match.group(1) for item in integrations if (match := re.search(r'function:([^/:]+)', item.get('IntegrationUri', '')))}
        if len(functions) != 1:
            raise RuntimeError('Cannot uniquely identify the existing API Lambda. Supply --function-name.')
        function_name = functions.pop()
    current = data('lambda', 'get-function', '--function-name', function_name)
    config = current['Configuration']
    old_image = current['Code'].get('ResolvedImageUri')
    if config.get('PackageType') != 'Image' or not old_image or '@sha256:' not in old_image:
        raise RuntimeError('The selected Lambda must use a digest-pinned existing ECR image.')
    repository = old_image.split('@')[0]
    registry, repository_name = repository.split('/', 1)
    if not registry.startswith(identity['Account'] + '.dkr.ecr.' + region + '.'):
        raise RuntimeError('Lambda ECR repository does not belong to the active deployment account/region.')
    architectures = config.get('Architectures', ['x86_64'])
    if architectures != ['x86_64']:
        raise RuntimeError('This Dockerfile deployment expects an x86_64 Lambda.')
    run(['docker', 'info', '--format', '{{.OSType}}'])
    run([str(ROOT / '.venv/bin/python'), '-m', 'pytest', '-q'])
    run(['npm', 'test'], cwd=ROOT / 'web')
    run(['npm', 'run', 'build'], cwd=ROOT / 'web')
    tag = 'web-parity-' + uuid4().hex[:12]
    image = repository + ':' + tag
    run(['docker', 'build', '--platform', 'linux/amd64', '--provenance=false', '-f', 'deployment/Dockerfile', '-t', image, '.'])
    password = aws('ecr', 'get-login-password')
    run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry], input_text=password)
    del password
    run(['docker', 'push', image])
    digest = data('ecr', 'describe-images', '--repository-name', repository_name, '--image-ids', 'imageTag=' + tag)['imageDetails'][0]['imageDigest']
    new_image = repository + '@' + digest
    aws('lambda', 'update-function-code', '--function-name', function_name, '--image-uri', new_image,
        '--revision-id', config['RevisionId'])
    try:
        aws('lambda', 'wait', 'function-updated-v2', '--function-name', function_name)
        with urlopen(endpoint + '/health', timeout=35) as response:
            if response.status != 200:
                raise RuntimeError('API health check failed')
        with tempfile.TemporaryDirectory(prefix='apm-publish-') as backup:
            index = str(Path(backup) / 'index.html')
            aws('s3', 'cp', 's3://' + BUCKET + '/index.html', index)
            try:
                aws('s3', 'sync', str(ROOT / 'web/dist') + '/', 's3://' + BUCKET + '/', '--exclude', 'index.html',
                    '--cache-control', 'public,max-age=31536000,immutable')
                aws('s3', 'cp', str(ROOT / 'web/dist/index.html'), 's3://' + BUCKET + '/index.html',
                    '--cache-control', 'no-cache,no-store,must-revalidate', '--content-type', 'text/html; charset=utf-8')
                invalidation = data('cloudfront', 'create-invalidation', '--distribution-id', DISTRIBUTION, '--paths', '/', '/index.html')['Invalidation']['Id']
                aws('cloudfront', 'wait', 'invalidation-completed', '--distribution-id', DISTRIBUTION, '--id', invalidation)
                with urlopen(WEBSITE + '/?release=' + tag, timeout=30) as response:
                    if response.read().decode() != (ROOT / 'web/dist/index.html').read_text():
                        raise RuntimeError('Published index does not match the build')
            except Exception:
                aws('s3', 'cp', index, 's3://' + BUCKET + '/index.html', '--cache-control', 'no-cache,no-store,must-revalidate', '--content-type', 'text/html; charset=utf-8')
                aws('cloudfront', 'create-invalidation', '--distribution-id', DISTRIBUTION, '--paths', '/', '/index.html')
                raise
    except Exception:
        print('Publishing failed; restoring the previous Lambda image.', file=sys.stderr)
        rollback_config = data('lambda', 'get-function-configuration', '--function-name', function_name)
        if rollback_config.get('LastUpdateStatus') == 'InProgress':
            aws('lambda', 'wait', 'function-updated-v2', '--function-name', function_name)
            rollback_config = data('lambda', 'get-function-configuration', '--function-name', function_name)
        aws('lambda', 'update-function-code', '--function-name', function_name, '--image-uri', old_image,
            '--revision-id', rollback_config['RevisionId'])
        aws('lambda', 'wait', 'function-updated-v2', '--function-name', function_name)
        raise
    print('Published frontend and API:', WEBSITE)
    print('Manual acceptance still required: sign-in, chat, camera, fields, tags and email reminder.')


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, RuntimeError, OSError) as error:
        print('Deployment stopped:', error, file=sys.stderr)
        sys.exit(1)
