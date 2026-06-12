/**
 * Custom Jest resolver that strips .js extensions from relative imports
 * and tries to resolve them as .ts files first (for TypeScript projects that
 * use explicit .js extensions in import statements per ESM conventions).
 */
const fs = require('fs');
const path = require('path');

module.exports = (request, options) => {
  // For relative imports ending in .js, try resolving as .ts first
  if (request.startsWith('.') && request.endsWith('.js')) {
    const withoutExt = request.slice(0, -3);
    const tsPath = path.resolve(path.dirname(options.basedir), withoutExt + '.ts');

    if (fs.existsSync(tsPath)) {
      return tsPath;
    }

    // Also try without extension (let defaultResolver handle it)
    try {
      return options.defaultResolver(withoutExt, options);
    } catch (_) {
      // Fall through to default behavior
    }
  }

  return options.defaultResolver(request, options);
};
