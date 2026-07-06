import pytest
from unittest.mock import Mock, patch
from src.llm_orchestrator import LLMOrchestrator

class TestLLMOrchestrator:
    @pytest.fixture
    def orchestrator(self, tmp_path):
        # Create test prompts
        prompts_dir = tmp_path / "config" / "prompts"
        prompts_dir.mkdir(parents=True)
        
        decision_prompt = prompts_dir / "decision_prompt.txt"
        decision_prompt.write_text("Test decision prompt: {pr_title}")
        
        generation_prompt = prompts_dir / "content_generation_prompt.txt"
        generation_prompt.write_text("Test generation prompt: {pr_title}")
        
        config = {
            'llm': {
                'provider': 'openai',
                'model': 'gpt-4',
                'api_key': 'test-key',
                'confidence_threshold': 0.8
            }
        }
        
        with patch('src.llm_orchestrator.Path') as mock_path:
            mock_path.return_value = prompts_dir
            return LLMOrchestrator(config)
    
    @patch('openai.ChatCompletion.create')
    def test_classify_change_new_feature(self, mock_openai, orchestrator):
        mock_openai.return_value = Mock(
            choices=[Mock(
                message=Mock(
                    content='{"is_new_feature": true, "confidence": 0.9, "reason": "Adds new API endpoint", "feature_type": "api"}'
                )
            )]
        )
        
        context = {
            'pr_title': 'Add user authentication endpoint',
            'pr_description': 'This PR adds a new /auth endpoint',
            'files_changed': 5,
            'additions': 150,
            'deletions': 20,
            'pr_labels': ['feature'],
            'commit_messages': ['Add auth endpoint', 'Add tests'],
            'file_list': ['src/auth.py', 'tests/test_auth.py']
        }
        
        result = orchestrator.classify_change(context)
        
        assert result['is_new_feature'] == True
        assert result['confidence'] == 0.9
        assert result['feature_type'] == 'api'
    
    @patch('openai.ChatCompletion.create')
    def test_classify_change_bug_fix(self, mock_openai, orchestrator):
        mock_openai.return_value = Mock(
            choices=[Mock(
                message=Mock(
                    content='{"is_new_feature": false, "confidence": 0.95, "reason": "Bug fix only", "feature_type": "bug_fix"}'
                )
            )]
        )
        
        context = {
            'pr_title': 'Fix null pointer exception',
            'pr_description': 'Fixes bug in user service',
            'files_changed': 1,
            'additions': 5,
            'deletions': 3,
            'pr_labels': ['bug'],
            'commit_messages': ['Fix NPE'],
            'file_list': ['src/user_service.py']
        }
        
        result = orchestrator.classify_change(context)
        
        assert result['is_new_feature'] == False
        assert result['confidence'] == 0.95
    
    @patch('openai.ChatCompletion.create')
    def test_generate_readme_update(self, mock_openai, orchestrator):
        mock_openai.return_value = Mock(
            choices=[Mock(
                message=Mock(
                    content='Added authentication system - Supports OAuth2 and JWT tokens. Includes user registration and login endpoints. Configure via auth.config.'
                )
            )]
        )
        
        context = {
            'pr_title': 'Add authentication system',
            'pr_description': 'Complete auth implementation',
            'repository_name': 'test-repo',
            'author': 'developer',
            'pr_number': 123,
            'code_changes': {'new_files': ['auth.py']},
            'diff_summary': '+ def authenticate():'
        }
        
        result = orchestrator.generate_readme_update(context)
        
        assert 'content' in result
        assert 'authentication' in result['content']
        assert result['pr_reference'] == 'PR #123'