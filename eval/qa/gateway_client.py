"""Anthropic client routed through Rio's Cloudflare AI Gateway.

Requests go to the gateway's `custom-node-anthropic` provider, which holds the
Anthropic credential (the same provider Rio's `node` profile uses). Requests
authenticate to the gateway with AI_GATEWAY_TOKEN from Rio's saved secrets; the
token is never printed or written anywhere else.
"""
import json
import os
from pathlib import Path

import anthropic

ACCOUNT = '210f84d0a5c443e3b1fbeeaf7d59b2e3'
PROVIDER = f'https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/rio/custom-node-anthropic'
SECRETS = Path.home() / f'.config/rio/secrets-{ACCOUNT}-rio.json'


def gateway_token():
    token = os.environ.get('AI_GATEWAY_TOKEN') or json.loads(SECRETS.read_text()).get('AI_GATEWAY_TOKEN')
    if not token:
        raise SystemExit('AI_GATEWAY_TOKEN is unavailable')
    return token


def _provider_path(request):
    # The custom provider's base URL already ends in /v1, so the gateway serves
    # PROVIDER/messages; the SDK always appends /v1/messages to its base URL.
    prefix = f'/v1/{ACCOUNT}/rio/custom-node-anthropic/v1/'
    if request.url.path.startswith(prefix):
        request.url = request.url.copy_with(path=request.url.path.replace('/custom-node-anthropic/v1/', '/custom-node-anthropic/', 1))


def client():
    return anthropic.Anthropic(
        base_url=PROVIDER,
        # The gateway injects the stored provider key; the SDK still requires a value.
        api_key='gateway-managed',
        default_headers={'cf-aig-authorization': f'Bearer {gateway_token()}', 'cf-aig-skip-cache': 'true',
                         'cf-aig-collect-log': 'false'},
        http_client=anthropic.DefaultHttpxClient(event_hooks={'request': [_provider_path]}),
        max_retries=4,
    )
