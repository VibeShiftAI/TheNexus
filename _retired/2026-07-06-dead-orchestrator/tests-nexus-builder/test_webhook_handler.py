import pytest
import json
import hmac
import hashlib
from src.webhook_handler import WebhookHandler
from flask import Flask, request

class TestWebhookHandler:
    @pytest.fixture
    def app(self):
        app = Flask(__name__)
        return app
    
    @pytest.fixture
    def handler(self):
        config = {
            'github': {
                'webhook_secret': 'test-secret'
            },
            'gitlab': {
                'webhook_token': 'test-token'
            },
            'bot_username': 'test-bot'
        }
        return WebhookHandler(config)
    
    def test_github_signature_verification_valid(self, app, handler):
        with app.test_request_context(
            '/webhook',
            method='POST',
            data=b'{"test": "data"}',
            headers={
                'X-GitHub-Event': 'pull_request',
                'X-Hub-Signature-256': 'sha256=' + hmac.new(
                    b'test-secret',
                    b'{"test": "data"}',
                    hashlib.sha256
                ).hexdigest()
            }
        ):
            assert handler.verify_signature(request) == True
    
    def test_github_signature_verification_invalid(self, app, handler):
        with app.test_request_context(
            '/webhook',
            method='POST',
            data=b'{"test": "data"}',
            headers={
                'X-GitHub-Event': 'pull_request',
                'X-Hub-Signature-256': 'sha256=invalid'
            }
        ):
            assert handler.verify_signature(request) == False
    
    def test_parse_github_pr_merged_event(self, handler):
        payload = {
            'action': 'closed',
            'pull_request': {
                'merged': True,
                'number': 123,
                'title': 'Add new feature',
                'body': 'This PR adds a new feature',
                'user': {'login': 'developer'},
                'merged_by': {'login': 'maintainer'},
                'merge_commit_sha': 'abc123',
                'labels': [{'name': 'feature'}, {'name': 'enhancement'}]
            },
            'repository': {
                'name': 'test-repo',
                'full_name': 'org/test-repo',
                'clone_url': 'https://github.com/org/test-repo.git',
                'url': 'https://api.github.com/repos/org/test-repo'
            }
        }
        
        result = handler.parse_event(payload)
        
        assert result is not None
        assert result['provider'] == 'github'
        assert result['pull_request']['number'] == 123
        assert result['pull_request']['title'] == 'Add new feature'
        assert 'feature' in result['pull_request']['labels']
    
    def test_parse_github_pr_not_merged(self, handler):
        payload = {
            'action': 'closed',
            'pull_request': {
                'merged': False,
                'number': 123
            }
        }
        
        result = handler.parse_event(payload)
        assert result is None
    
    def test_is_bot_event(self, handler):
        event_data = {
            'pull_request': {
                'user': 'test-bot'
            }
        }
        
        assert handler.is_bot_event(event_data) == True
        
        event_data['pull_request']['user'] = 'human-developer'
        assert handler.is_bot_event(event_data) == False