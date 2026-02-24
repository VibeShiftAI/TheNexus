import os
import shutil
from ruamel.yaml import YAML

PROMPT_FILE = "config/prompts.yaml"

class PromptManager:
    def __init__(self):
        self.yaml = YAML()
        self.yaml.preserve_quotes = True
    
    def load(self, role: str) -> dict:
        if not os.path.exists(PROMPT_FILE):
            return {"system": "You are a generic AI.", "template": "{content}"}
        with open(PROMPT_FILE, 'r') as f:
            data = self.yaml.load(f)
        return data.get(role, {})

    def update_system_prompt(self, role: str, new_prompt: str):
        """
        Updates the system prompt for a role and saves to disk.
        Creates a .bak backup first.
        """
        if not os.path.exists(PROMPT_FILE): return

        # 1. Backup
        shutil.copy(PROMPT_FILE, f"{PROMPT_FILE}.bak")
        
        # 2. Update
        with open(PROMPT_FILE, 'r') as f:
            data = self.yaml.load(f)
            
        if role in data:
            data[role]['system'] = new_prompt
            
        with open(PROMPT_FILE, 'w') as f:
            self.yaml.dump(data, f)
            
    def get_template(self, role: str, **kwargs) -> str:
        data = self.load(role)
        template = data.get('template', "")
        # Safe format (ignores missing keys)
        return template.format(**kwargs)
