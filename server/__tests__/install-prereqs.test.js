const fs = require('fs');
const path = require('path');

describe('install-mac prerequisites', () => {
  test('provisions ripgrep for praxis-mind MCP vault search', () => {
    const installer = fs.readFileSync(path.join(__dirname, '..', '..', 'install-mac.sh'), 'utf8');

    expect(installer).toContain('command -v rg');
    expect(installer).toContain('brew install ripgrep');
    expect(installer).toContain('sudo apt install -y ripgrep');
  });
});
