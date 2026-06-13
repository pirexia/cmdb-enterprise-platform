import { PluginValidator } from '../engine.js';

describe('PluginValidator', () => {
  describe('validateMigrationSql', () => {
    it('accepts valid CREATE TABLE with plg_ prefix', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'CREATE TABLE IF NOT EXISTS plg_my_plugin_items (id SERIAL PRIMARY KEY, name TEXT);',
          'my-plugin',
        ),
      ).not.toThrow();
    });

    it('accepts CREATE INDEX on plg_ table', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'CREATE INDEX idx_plg_my_plugin_items_name ON plg_my_plugin_items (name);',
          'my-plugin',
        ),
      ).not.toThrow();
    });

    it('rejects DROP TABLE on core table (configuration_items)', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'DROP TABLE configuration_items;',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_FORBIDDEN');
    });

    it('rejects TRUNCATE on a core table', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'TRUNCATE TABLE configuration_items;',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_FORBIDDEN');
    });

    it('rejects ALTER TABLE on a core table', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'ALTER TABLE users ADD COLUMN hacked TEXT;',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_FORBIDDEN');
    });

    it('rejects DELETE FROM a core table', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'DELETE FROM users WHERE 1=1;',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_FORBIDDEN');
    });

    it('rejects DROP INDEX on a core object', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'DROP INDEX users_email_idx;',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_FORBIDDEN');
    });

    it('rejects GRANT/REVOKE outright', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'GRANT ALL ON configuration_items TO cmdb_plugin;',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_FORBIDDEN');
    });

    it('allows ALTER/TRUNCATE on the plugin own tables', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'ALTER TABLE plg_my_plugin_items ADD COLUMN extra TEXT; TRUNCATE TABLE plg_my_plugin_items;',
          'my-plugin',
        ),
      ).not.toThrow();
    });

    it('does not flag dangerous verbs inside comments or string literals', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          "CREATE TABLE plg_my_plugin_log (msg TEXT DEFAULT 'do not DROP TABLE users'); -- DROP TABLE users",
          'my-plugin',
        ),
      ).not.toThrow();
    });

    it('rejects CREATE TABLE without plg_<id>_ prefix', () => {
      expect(() =>
        PluginValidator.validateMigrationSql(
          'CREATE TABLE evil_table (id SERIAL PRIMARY KEY);',
          'my-plugin',
        ),
      ).toThrow('PLUGIN_DDL_PREFIX');
    });

    it('accepts multiple valid statements separated by semicolons', () => {
      const sql = [
        'CREATE TABLE IF NOT EXISTS plg_my_plugin_events (id SERIAL PRIMARY KEY, payload JSONB);',
        'CREATE INDEX idx_plg_my_plugin_events_id ON plg_my_plugin_events (id);',
        '-- A comment line',
        'INSERT INTO plg_my_plugin_events (payload) VALUES (\'{}\'::jsonb);',
      ].join('\n');

      expect(() =>
        PluginValidator.validateMigrationSql(sql, 'my-plugin'),
      ).not.toThrow();
    });
  });

  describe('validateManifest', () => {
    const validManifest = {
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      author: 'Test Author',
      license: 'MIT',
    };

    it('accepts valid manifest with all required fields', () => {
      expect(() => PluginValidator.validateManifest(validManifest)).not.toThrow();
    });

    it('rejects manifest without id', () => {
      const { id: _id, ...noId } = validManifest;
      expect(() => PluginValidator.validateManifest(noId)).toThrow();
    });

    it('rejects manifest with non-kebab-case id', () => {
      expect(() =>
        PluginValidator.validateManifest({ ...validManifest, id: 'My_Plugin!' }),
      ).toThrow();
    });

    it('rejects manifest with invalid permission', () => {
      expect(() =>
        PluginValidator.validateManifest({
          ...validManifest,
          permissions: ['db:read', 'not:valid-permission'],
        }),
      ).toThrow();
    });

    it('accepts manifest with empty permissions array', () => {
      expect(() =>
        PluginValidator.validateManifest({ ...validManifest, permissions: [] }),
      ).not.toThrow();
    });
  });
});
