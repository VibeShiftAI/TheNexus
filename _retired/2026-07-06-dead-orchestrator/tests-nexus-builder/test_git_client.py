import pytest
import os
import git
from unittest.mock import Mock, patch
from src.git_client import GitClient

class TestGitClient:
    @pytest.fixture
    def client(self, tmp_path):
        config = {
            'git': {
                'temp_dir': str(tmp_path / 'repos'),
                'bot_email': 'bot@test.com',
                'bot_name': 'Test Bot'
            },
            'github': {
                'api_token': 'test-token'
            }
        }
        return GitClient(config)
    
    @pytest.fixture
    def test_repo(self, tmp_path):
        # Create a test git repository
        repo_path = tmp_path / 'test-repo'
        repo_path.mkdir()
        repo = git.Repo.init(repo_path)
        
        # Add a file and commit
        readme = repo_path / 'README.md'
        readme.write_text('# Test Repo')
        repo.index.add(['README.md'])
        repo.index.commit('Initial commit')
        
        return str(repo_path)
    
    def test_add_auth_to_url(self, client):
        # GitHub URL
        url = 'https://github.com/org/repo.git'
        auth_url = client._add_auth_to_url(url)
        assert auth_url == 'https://test-token@github.com/org/repo.git'
        
        # GitLab URL
        client.gitlab_token = 'gitlab-token'
        url = 'https://gitlab.com/org/repo.git'
        auth_url = client._add_auth_to_url(url)
        assert auth_url == 'https://oauth2:gitlab-token@gitlab.com/org/repo.git'
    
    @patch('git.Repo.clone_from')
    def test_clone_repository(self, mock_clone, client):
        mock_repo = Mock()
        mock_clone.return_value = mock_repo
        
        repo_path = client.clone_repository(
            'https://github.com/org/repo.git',
            'repo'
        )
        
        assert 'repo' in repo_path
        mock_clone.assert_called_once()
        
    def test_create_branch(self, client, test_repo):
        repo = git.Repo(test_repo)
        
        # Create a mock remote
        with patch.object(repo, 'remote') as mock_remote:
            mock_remote.return_value.refs = [Mock(name='origin/main')]
            mock_remote.return_value.fetch = Mock()
            
            client.create_branch(test_repo, 'feature-branch')
            
            assert 'feature-branch' in [b.name for b in repo.branches]
            assert repo.active_branch.name == 'feature-branch'
    
    @patch('requests.post')
    def test_create_github_pr(self, mock_post, client):
        mock_response = Mock()
        mock_response.status_code = 201
        mock_response.json.return_value = {
            'html_url': 'https://github.com/org/repo/pull/1'
        }
        mock_post.return_value = mock_response
        
        repository = {
            'provider': 'github',
            'api_url': 'https://api.github.com/repos/org/repo'
        }
        
        pr_url = client.create_pull_request(
            repository,
            'feature-branch',
            'Test PR',
            'Test description'
        )
        
        assert pr_url == 'https://github.com/org/repo/pull/1'
        mock_post.assert_called_once()
    
    def test_cleanup(self, client, test_repo):
        assert os.path.exists(test_repo)
        
        client.cleanup(test_repo)
        
        assert not os.path.exists(test_repo)