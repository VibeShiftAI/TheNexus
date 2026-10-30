/**
 * The 2026-10-30 retirement of per-token API model rows: stale rows go
 * inactive (never deleted), rows something still names are kept, and fresh
 * databases seed only the rows Praxis can serve. Runs on a temp database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function freshDbFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-rows-'));
    return { dir, file: path.join(dir, 'nexus.db') };
}

function loadDb(file) {
    process.env.NEXUS_DB_PATH = file;
    jest.resetModules();
    return require('../../db');
}

describe('model rows on a database', () => {
    let tmp;
    beforeEach(() => { tmp = freshDbFile(); });
    afterEach(() => {
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    });

    test('a fresh database seeds the local model, the free lane and current roles only', async () => {
        const db = loadDb(tmp.file);
        const models = await db.getModels(false);
        expect(models.map(m => m.id).sort()).toEqual([
            'local-gemma-4-31b', 'openrouter-auto-free', 'openrouter-laguna-s',
            'openrouter-nemotron-ultra', 'openrouter-north-mini-code',
        ]);
        const aliases = await db.getModelAliases(false);
        expect(aliases.map(a => a.alias)).toEqual(['local_default']);
        const roles = await db.getModelRoles(false);
        const byRole = Object.fromEntries(roles.map(r => [r.role, r.assignment]));
        // The value-guarded 2026-07-18 migration leaves the current seeds alone.
        expect(byRole['agent.interactive']).toBe('cli:claude-code/claude-sonnet-5-5@low');
        expect(byRole['research.deep']).toBe('cli:claude-code/claude-opus-5-5@high');
        expect(Object.values(byRole).some(a => /gemini_default|gemini_fast|model:/.test(a))).toBe(false);
    });

    test('stale API rows go inactive once; named rows and their aliases are kept', async () => {
        loadDb(tmp.file); // creates the schema and records the migration on an empty table
        const raw = new Database(tmp.file);
        const insert = raw.prepare(
            "INSERT INTO models (id, name, provider, api_model_id, is_active) VALUES (?, ?, ?, ?, 1)"
        );
        insert.run('google-gemini-pro', 'Gemini 3.1 Pro', 'google', 'gemini-3.1-pro-preview');
        insert.run('google-gemini-flash', 'Gemini 3.8 Flash', 'google', 'gemini-3.8-flash');
        insert.run('openai-gpt', 'GPT-5.6', 'openai', 'gpt-5.6-sol');
        insert.run('anthropic-claude-opus', 'Claude Opus 5', 'anthropic', 'claude-opus-5');
        insert.run('anthropic-claude-sonnet', 'Claude Sonnet 5', 'anthropic', 'claude-sonnet-5');
        insert.run('openrouter-glm', 'GLM 5.2', 'openrouter', 'z-ai/glm-5.2:free');
        raw.prepare("INSERT INTO model_aliases (alias, target) VALUES ('gemini_default', 'model:google-gemini-pro')").run();
        raw.prepare("INSERT INTO model_aliases (alias, target) VALUES ('gemini_fast', 'model:google-gemini-flash')").run();
        // A role still on Sonnet 5 by row, and one on the fast Gemini alias.
        raw.prepare("UPDATE model_roles SET assignment = 'model:anthropic-claude-sonnet' WHERE role = 'feedback.reply'").run();
        raw.prepare("UPDATE model_roles SET assignment = 'alias:gemini_fast' WHERE role = 'context.plan'").run();
        raw.prepare("DELETE FROM model_control_settings WHERE key = 'stale_api_model_rows_v1'").run();
        raw.close();

        loadDb(tmp.file); // the migration runs again on load
        const check = new Database(tmp.file, { readonly: true });
        const active = Object.fromEntries(check.prepare('SELECT id, is_active FROM models').all().map(r => [r.id, r.is_active]));
        expect(active).toMatchObject({
            'google-gemini-pro': 0,
            'openai-gpt': 0,
            'anthropic-claude-opus': 0,
            'openrouter-glm': 0,
            // Still named by a role, directly or through an alias.
            'anthropic-claude-sonnet': 1,
            'google-gemini-flash': 1,
            // Current rows are untouched.
            'local-gemma-4-31b': 1,
            'openrouter-nemotron-ultra': 1,
        });
        const aliasActive = Object.fromEntries(check.prepare('SELECT alias, is_active FROM model_aliases').all().map(r => [r.alias, r.is_active]));
        expect(aliasActive).toMatchObject({ gemini_default: 0, gemini_fast: 1, local_default: 1 });
        const record = JSON.parse(check.prepare("SELECT value FROM model_control_settings WHERE key = 'stale_api_model_rows_v1'").get().value);
        expect(record.deactivated.sort()).toEqual(['anthropic-claude-opus', 'google-gemini-pro', 'openai-gpt', 'openrouter-glm']);
        expect(record.kept.sort()).toEqual(['anthropic-claude-sonnet', 'google-gemini-flash']);
        expect(record.retiredAliases).toEqual(['gemini_default']);
        check.close();

        // Keyed: a later boot does not undo an operator re-activating a row.
        const raw2 = new Database(tmp.file);
        raw2.prepare("UPDATE models SET is_active = 1 WHERE id = 'openai-gpt'").run();
        raw2.close();
        loadDb(tmp.file);
        const again = new Database(tmp.file, { readonly: true });
        expect(again.prepare("SELECT is_active FROM models WHERE id = 'openai-gpt'").get().is_active).toBe(1);
        again.close();
    });
});
