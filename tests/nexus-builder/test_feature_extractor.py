import pytest
from unittest.mock import Mock, patch
import requests
from src.feature_extractor import FeatureExtractor

class TestFeatureExtractor:
    @pytest.fixture
    def extractor(self):
        config = {
            'github': {
                'api_token': 'test-token'
            },
            'gitlab': {
                'api_token': 'test-token'
            }
        }
        return FeatureExtractor(config)
    
    @patch('requests.get')
    def test_extract_github_context(self, mock_get, extractor):
        # Mock API responses
        pr_response = Mock()
        pr_response.json.return_value = {
            'additions': 100,
            'deletions': 20
        }
        
        files_response = Mock()
        files_response.json.return_value = [
            {'filename': 'src/feature.py', 'status': 'added'},
            {'filename': 'tests/test_feature.py', 'status': 'added'},
            {'filename': 'README.md', 'status': 'modified'}
        ]
        
        commits_response = Mock()
        commits_response.json.return_value = [
            {'commit': {'message': 'Add new feature'}},
            {'commit': {'message': 'Add tests'}}
        ]
        
        mock_get.side_effect = [pr_response, files_response, commits_response]
        
        repository = {
            'provider': 'github',
            'name': 'test-repo',
            'api_url': 'https://api.github.com/repos/org/test-repo'
        }
        
        pull_request = {
            'number': 123,
            'title': 'Add new feature',
            'body': 'Feature description',
            'user': 'developer',
            'labels': ['feature']
        }
        
        context = extractor.extract_context(repository, pull_request)
        
        assert context['pr_number'] == 123
        assert context['files_changed'] == 3
        assert context['additions'] == 100
        assert len(context['code_changes']['new_files']) == 2
        assert 'src/feature.py' in context['code_changes']['new_files']
        assert 'tests/test_feature.py' in context['code_changes']['test_files']
    
    def test_analyze_file_changes(self, extractor):
        files = [
            {'filename': 'src/api.py', 'status': 'added'},
            {'filename': 'src/utils.py', 'status': 'modified'},
            {'filename': 'old_file.py', 'status': 'deleted'},
            {'filename': 'tests/test_api.py', 'status': 'added'},
            {'filename': 'config.yaml', 'status': 'modified'},
            {'filename': 'README.md', 'status': 'modified'}
        ]
        
        analysis = extractor._analyze_file_changes(files)
        
        assert len(analysis['new_files']) == 2
        assert len(analysis['modified_files']) == 3
        assert len(analysis['deleted_files']) == 1
        assert len(analysis['test_files']) == 1
        assert len(analysis['doc_files']) == 1
        assert len(analysis['config_files']) == 1
        assert len(analysis['source_files']) == 2