# Plugin Marketplace

## Overview

The Plugin Marketplace lets administrators discover and install plugins directly from a configured registry server without uploading ZIP files manually.

**Security model**: The platform server fetches and validates the plugin. The browser never supplies a download URL — the server resolves it from the registry (SSRF A10).

---

## Configuration

Set the following environment variables (in `.env` or `docker-compose.yml`):

| Variable | Required | Description |
|---|---|---|
| `PLUGIN_ENABLE_MARKETPLACE` | yes | Must be `true` to activate marketplace features |
| `PLUGIN_MARKETPLACE_URL` | yes | Base HTTPS URL of the marketplace server |

```env
PLUGIN_ENABLE_MARKETPLACE=true
PLUGIN_MARKETPLACE_URL=https://plugins.example.com
```

`PLUGIN_MARKETPLACE_URL` is validated server-side:
- Must use `https://`
- Must not resolve to a private or loopback address (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, link-local, ULA)

---

## Marketplace Server Protocol

The platform calls `GET {PLUGIN_MARKETPLACE_URL}/api/plugins` and expects the following JSON shape:

```json
{
  "plugins": [
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "version": "1.0.0",
      "description": "What it does",
      "author": "Vendor Name",
      "downloadUrl": "https://plugins.example.com/releases/my-plugin-1.0.0.zip",
      "iconUrl": "https://plugins.example.com/icons/my-plugin.png",
      "minPlatformVersion": "2.8.0",
      "permissions": ["hooks:postCreateCI"],
      "category": "Monitoring"
    }
  ]
}
```

All string fields are validated through Zod. Unknown fields are stripped before the response is forwarded to the browser. `downloadUrl` is **never** sent to the browser.

---

## Server-Side Cache

Marketplace listings are cached in memory for **5 minutes** to reduce upstream round-trips. The cache is instance-local and cleared on container restart. A manual refresh button in the UI forces a new fetch by invalidating the cache.

---

## Install Flow

When an administrator clicks **Install** in the UI:

1. `POST /api/plugins/marketplace/install` with `{ pluginId: "<id>" }` in the body.
2. Server looks up the plugin in the (possibly cached) marketplace listing.
3. `downloadUrl` from the listing is SSRF-checked again before use.
4. Server downloads the ZIP (timeout 60 s, max `PLUGIN_MAX_SIZE_MB` bytes).
5. Magic bytes validated (ZIP: `50 4B 03 04`).
6. SHA-256 checksum computed.
7. `manifest.json` extracted and validated via `PluginManifestSchema`.
8. Duplicate check against `plugin_registry.plugin_id`.
9. DB record created (`status = UPLOADED`).
10. Inline validation → `VALIDATED`.
11. Inline install: migrations, file extraction to `installed/<db-uuid>/`, bundle artifacts parsed → `INSTALLED`.
12. Audit log entry: `PLUGIN_MARKETPLACE_INSTALL_STARTED`, `PLUGIN_VALIDATED`, `PLUGIN_INSTALLED`.

The result is a plugin in `INSTALLED` state, ready to be **activated** from the Plugin Manager UI (activation may require a 4-eyes approval token in production when `PLUGIN_REQUIRE_APPROVAL_PROD=true`).

---

## UI Features

- **Search**: filters by name, description, or author.
- **Category filter**: dropdown populated from the `category` field in the listing.
- **Version badge**: displays `Requires v{minPlatformVersion}+` when declared.
- **Install button**: live spinner during download; shows "Installed" badge for already-registered plugins.

---

## Security Controls

| Control | Implementation |
|---|---|
| SSRF prevention (A10) | `assertSafeUrl()` blocks private IPs, loopback, non-HTTPS on both `PLUGIN_MARKETPLACE_URL` and `downloadUrl` |
| Schema validation (A03) | Upstream JSON parsed through `MarketplaceResponseSchema` (Zod); extra fields stripped |
| Magic bytes check | `PluginValidator.validateUploadedFile()` verifies ZIP header before processing |
| Rate limiting | All plugin routes share `pluginRateLimiter` (express-rate-limit) |
| Audit logging | Every install step is recorded in `plugin_audit_logs` (A.8.15) |
| No caller-supplied URLs | `downloadUrl` is resolved server-side only — the browser sends only `pluginId` |
