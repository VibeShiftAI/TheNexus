import pytest
import os
from src.readme_manager import ReadmeManager

class TestReadmeManager:
    @pytest.fixture
    def manager(self):
        config = {
            'readme': {
                'section_markers': {
                    'features': '## Features',
                    'new_features': '### New Features'
                },
                'update_strategy': 'append_to_section'
            }
        }
        return ReadmeManager(config)
    
    @pytest.fixture
    def sample_readme(self, tmp_path):
        readme_path = tmp_path / "README.md"
        readme_path.write_text("""# Test Project

## Description
A test project for documentation bot.

## Features
- Existing feature 1
- Existing feature 2

## Installation
Install using pip.

## Usage
Run the application.
""")
        return str(readme_path)
    
    def test_update_readme_append_to_features(self, manager, sample_readme):
        update_data = {
            'content': 'New authentication system with OAuth2 support',
            'section': 'Features',
            'summary': 'Added auth system'
        }
        
        updated_content = manager.update_readme(sample_readme, update_data)
        
        assert 'New authentication system' in updated_content
        assert '- Existing feature 1' in updated_content  # Original content preserved
        
    def test_backup_creation(self, manager, sample_readme):
        update_data = {'content': 'Test update', 'section': 'Features'}
        
        manager.update_readme(sample_readme, update_data)
        
        # Check backup exists
        backup_files = [f for f in os.listdir(os.path.dirname(sample_readme)) 
                       if f.startswith('README.md.backup.')]
        assert len(backup_files) == 1
    
    def test_parse_structure(self, manager):
        content = """# Project

## Description
Text here.

## Features
### Core Features
- Feature 1

### New Features
- Feature 2

## Installation
"""
        
        structure = manager._parse_structure(content)
        
        assert len(structure['sections']) == 5
        assert structure['features_section'] is not None
        assert structure['sections'][2]['title'] == 'Features'
        assert structure['sections'][2]['level'] == 2
    
    def test_validate_markdown(self, manager):
        # Valid markdown
        assert manager.validate_markdown("# Title\n\n