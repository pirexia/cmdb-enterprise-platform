# Fix Security Issues #76, #77, #78, #79, #80, #81, #83 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolver siete issues de seguridad y cumplimiento: CSP headers (#76+#83), LDAP strict mode (#78), GDPR privacy notice (#77), NIS2 IRP expandido (#79), DPIA (#80), y BCP/RTO/RPO + mejoras de backup (#81).

**Architecture:** Cambios de código en nginx, next.config.ts y backend/src/index.ts para headers de seguridad y LDAP. Nueva página frontend estática para aviso de privacidad. Documentación de cumplimiento en docs/security/isms/. Mejoras de scripts en scripts/.

**Tech Stack:** nginx 1.30, Next.js 15 App Router, Express/Helmet, TypeScript, bash scripts.

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `nginx/conf.d/frontend.conf` | Añadir CSP, mejorar HSTS, Permissions-Policy extendida |
| Modify | `frontend/next.config.ts` | Añadir CSP header, descomentar HSTS |
| Modify | `backend/src/index.ts` | Activar Helmet CSP (API), añadir LDAP_STRICT_MODE |
| Create | `frontend/app/privacy/page.tsx` | Página de aviso de privacidad GDPR Art. 13/14 |
| Modify | `frontend/app/login/page.tsx` | Añadir enlace a privacy notice |
| Modify | `frontend/locales/{en,es,de,pt,fr,it}.json` | Claves i18n para privacy |
| Modify | `docs/security/isms/04-incident-response-plan.md` | Expandir con NIS2 Art. 23 timelines y detección |
| Create | `docs/security/isms/06-dpia.md` | DPIA completa GDPR Art. 35 |
| Create | `docs/security/isms/07-bcp-rto-rpo.md` | BCP/RTO/RPO + ISO 22301 |
| Modify | `scripts/db-backup.sh` | Añadir verificación de integridad gunzip -t |
| Create | `scripts/docs-backup.sh` | Backup de DOCUMENTS_STORAGE_PATH |
| Modify | `docs/SYSADMIN_MANUAL.md` + `.en.md` | Sección LDAP_STRICT_MODE + privacy notice obligations |

---

## Task 1 — #76 + #83: Content-Security-Policy y security headers completos

**Files:**
- Modify: `nginx/conf.d/frontend.conf`
- Modify: `frontend/next.config.ts`
- Modify: `backend/src/index.ts` (línea ~96)

- [ ] **Step 1: Añadir CSP e HSTS mejorado a nginx/conf.d/frontend.conf**

  En la sección `# ── Security headers (frontend responses) ──`, reemplazar el bloque completo de `add_header` con:

  ```nginx
      # ── Security headers (frontend responses) ─────────────────────────────────
      add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
      add_header X-Frame-Options           "DENY" always;
      add_header X-Content-Type-Options    "nosniff" always;
      add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
      add_header X-XSS-Protection          "1; mode=block" always;
      add_header Permissions-Policy        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
      add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';" always;
  ```

  Notas de diseño:
  - `X-Frame-Options: DENY` (más restrictivo que el anterior SAMEORIGIN — la app no usa iframes)
  - `style-src 'unsafe-inline'` es necesario para Tailwind CSS y Next.js
  - `img-src data:` necesario para QR codes (base64 data URIs)
  - `img-src https:` necesario para posibles avatares externos o recursos de confianza
  - `frame-ancestors 'none'` más seguro que X-Frame-Options (CSP L2+)
  - `connect-src 'self'` cubre las llamadas `/api/*` desde el mismo origen nginx

- [ ] **Step 2: También eliminar las cabeceras redundantes del bloque /_next/static/**

  En el bloque `location /_next/static/`, las cabeceras `X-Content-Type-Options` y `X-Frame-Options` se repiten. El bloque ya hereda los headers del server{}, así que reemplazar ese bloque con:

  ```nginx
      # ── Next.js static assets — aggressive caching ───────────────────────────
      location /_next/static/ {
          proxy_pass http://frontend:3001;
          proxy_set_header Host             $host;
          proxy_set_header X-Forwarded-Proto $scheme;

          add_header Cache-Control "public, max-age=31536000, immutable" always;
      }
  ```

- [ ] **Step 3: Actualizar next.config.ts — añadir CSP y descomentar HSTS**

  Reemplazar el archivo completo `frontend/next.config.ts` con:

  ```typescript
  import type { NextConfig } from "next";

  const nextConfig: NextConfig = {
    output: "standalone",

    // ── Security Headers (ISO 27001 A.8.24 / A.10.1) ─────────────────────────
    // Applied to every Next.js response. nginx overrides these in production;
    // these act as fallback for direct Next.js access (dev, testing).
    async headers() {
      return [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            { key: "X-XSS-Protection", value: "1; mode=block" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            {
              key: "Permissions-Policy",
              value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
            },
            {
              key: "Strict-Transport-Security",
              value: "max-age=31536000; includeSubDomains; preload",
            },
            {
              key: "Content-Security-Policy",
              value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
            },
          ],
        },
      ];
    },
  };

  export default nextConfig;
  ```

- [ ] **Step 4: Activar Helmet CSP en backend/src/index.ts para la API**

  Reemplazar el bloque del helmet (línea ~96-99):

  ```typescript
  // Before:
  app.use((helmetFn as any)({
    hsts: false,              // nginx handles HSTS on the public interface
    contentSecurityPolicy: false, // API-only server — no HTML served
  }));

  // After:
  app.use((helmetFn as any)({
    hsts: false, // nginx handles HSTS on the public interface
    contentSecurityPolicy: {
      // Restrictive API-only policy: no content rendered, so only frame-ancestors matters.
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  ```

- [ ] **Step 5: Rebuild y verificar headers**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 15
  curl -sk -I https://localhost | grep -iE "content-security-policy|x-frame|strict-transport|referrer|permissions"
  ```

  Expected output (mínimo):
  ```
  content-security-policy: default-src 'self'; ...
  x-frame-options: DENY
  strict-transport-security: max-age=31536000; includeSubDomains; preload
  referrer-policy: strict-origin-when-cross-origin
  permissions-policy: camera=(), ...
  ```

- [ ] **Step 6: Health check**

  ```bash
  curl -sk https://localhost/api/health
  ```

  Expected: `{"status":"ok",...}`

- [ ] **Step 7: Commit**

  ```bash
  git add nginx/conf.d/frontend.conf frontend/next.config.ts backend/src/index.ts
  git commit -m "fix(security): add Content-Security-Policy + harden security headers — closes #76, closes #83

  nginx: CSP default-src 'self', frame-ancestors 'none'; HSTS includeSubDomains+preload;
  Permissions-Policy extended with usb/interest-cohort; X-Frame-Options DENY.
  next.config.ts: CSP + HSTS as fallback for direct Next.js access.
  Backend Helmet: enable restrictive CSP (default-src 'none'; frame-ancestors 'none')
  for the JSON-only API server.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2 — #78: LDAP strict mode + documentación del fallback

**Files:**
- Modify: `backend/src/index.ts` (sección login LDAP, líneas ~764-818)
- Modify: `docs/SYSADMIN_MANUAL.md` y `docs/SYSADMIN_MANUAL.en.md`

- [ ] **Step 1: Verificar el flujo MFA para LDAP ADMINs**

  Leer las líneas 777-920 de `backend/src/index.ts`. Confirmar que tras `ldapSuccess = true`, el código asigna `user = rows[0]` y luego el flujo continúa hasta la sección MFA (línea ~858: `if (user.mfa_enabled && user.mfa_secret)`). Los LDAP ADMINs pasan por el mismo check MFA que los usuarios locales — no hay bypass.

  La seguridad del fallback depende del dummy hash: si LDAP falla, el bloque `if (!ldapSuccess)` intenta login local, pero el shadow user tiene `password = bcrypt.hash('ldap-provisioned-{timestamp}')` — un hash que ningún usuario real conoce.

- [ ] **Step 2: Añadir LDAP_STRICT_MODE en backend/src/index.ts**

  En la sección de login LDAP (líneas ~764-818), reemplazar el bloque:

  ```typescript
  // Before (lines ~801-818):
  if (!ldapSuccess) {
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, email, password, role, COALESCE(active, true) AS active,
             mfa_enabled, mfa_secret, mfa_prompted_at
      FROM "users" WHERE email = ${email} LIMIT 1
    `;
    if (!rows[0] || !rows[0].password) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    user = rows[0];
    log.info(`[POST /api/auth/login] Local authentication successful for ${email}`);
  }
  ```

  ```typescript
  // After:
  if (!ldapSuccess) {
    // LDAP_STRICT_MODE=true: block local auth fallback for LDAP-provisioned accounts.
    // This prevents the (already-safe) fallback when the LDAP server is unreachable.
    // LDAP shadow users have a random bcrypt hash they don't know, so fallback is
    // already safe by design — but strict mode makes this an explicit policy.
    if (process.env.LDAP_STRICT_MODE === 'true' && process.env.USE_LDAP === 'true' && !isLocalAccount) {
      log.warn(`[POST /api/auth/login] LDAP_STRICT_MODE: blocking local fallback for ${email}`);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, email, password, role, COALESCE(active, true) AS active,
             mfa_enabled, mfa_secret, mfa_prompted_at
      FROM "users" WHERE email = ${email} LIMIT 1
    `;
    if (!rows[0] || !rows[0].password) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    // Safety note: LDAP shadow users have password = bcrypt(random-token) so
    // bcrypt.compare against a real user-supplied password will always fail.
    // LDAP_STRICT_MODE adds an explicit policy-level block before this check.
    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    user = rows[0];
    log.info(`[POST /api/auth/login] Local authentication successful for ${email}`);
  }
  ```

- [ ] **Step 3: Añadir LDAP_STRICT_MODE a .env.example**

  En `.env.example`, buscar la sección LDAP y añadir:

  ```bash
  # LDAP_STRICT_MODE=true  # Block local auth fallback when LDAP is unreachable.
  #                        # Only relevant when USE_LDAP=true.
  #                        # Default: false (safe because shadow users have random hashes).
  ```

- [ ] **Step 4: Actualizar SYSADMIN_MANUAL.md**

  En `docs/SYSADMIN_MANUAL.md`, en la sección de LDAP/SSO (buscar `## 15. Configuración de SSO` o sección LDAP), añadir al final:

  ```markdown
  ### LDAP_STRICT_MODE

  Por defecto, si el servidor LDAP no está disponible, la autenticación LDAP falla y el sistema intenta autenticación local. Los usuarios shadow LDAP tienen un hash de contraseña aleatorio que no puede usarse para login local, por lo que el fallback es seguro por diseño.

  Para entornos de alta seguridad que requieren bloqueo explícito del fallback:

  ```env
  LDAP_STRICT_MODE=true
  ```

  Con esta opción, si el servidor LDAP no responde, los usuarios LDAP reciben `Invalid credentials` en lugar de intentar autenticación local. **No afecta a las cuentas locales** (emails que terminan en `@cmdb.local` o `@cmdb.internal`).

  **Impacto:** Si el servidor LDAP cae, ningún usuario LDAP podrá autenticarse hasta que LDAP se recupere. Mantén siempre al menos una cuenta ADMIN local activa.
  ```

  Añadir el equivalente en inglés a `docs/SYSADMIN_MANUAL.en.md`:

  ```markdown
  ### LDAP_STRICT_MODE

  By default, if the LDAP server is unavailable, the system falls back to local authentication. LDAP shadow users have a random bcrypt hash (not usable for real login), so the fallback is safe by design.

  For high-security deployments requiring explicit policy enforcement:

  ```env
  LDAP_STRICT_MODE=true
  ```

  With this setting, if the LDAP server does not respond, LDAP users receive `Invalid credentials` instead of attempting local auth. **Does not affect local accounts** (emails ending in `@cmdb.local` or `@cmdb.internal`).

  **Impact:** If the LDAP server goes down, no LDAP users can authenticate until it recovers. Always maintain at least one active local ADMIN account.
  ```

- [ ] **Step 5: TypeScript check**

  ```bash
  sg docker -c "docker exec cmdb-backend ./node_modules/.bin/tsc --noEmit 2>&1" || cd /home/andres/cmdb-enterprise-platform/backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep -v "Property 'licenseUser'"
  ```

  Expected: sin errores nuevos.

- [ ] **Step 6: Rebuild y health check**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 15 && curl -sk https://localhost/api/health
  ```

  Expected: `{"status":"ok",...}`

- [ ] **Step 7: Commit**

  ```bash
  git add backend/src/index.ts .env.example docs/SYSADMIN_MANUAL.md docs/SYSADMIN_MANUAL.en.md
  git commit -m "fix(security): add LDAP_STRICT_MODE + document auth fallback safety — closes #78

  LDAP_STRICT_MODE=true explicitly blocks local auth fallback for LDAP users
  when the LDAP server is unreachable. Without it the fallback is already safe
  (shadow users have a random bcrypt hash the user cannot know), but strict mode
  adds a policy-level control for high-security environments.

  Added safety comment explaining the dummy hash invariant. Verified LDAP ADMIN
  users pass through the same TOTP MFA check as local users — no bypass exists.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3 — #77: GDPR Privacy Notice (página frontend + i18n + login link)

**Files:**
- Create: `frontend/app/privacy/page.tsx`
- Modify: `frontend/app/login/page.tsx`
- Modify: `frontend/locales/es.json`, `en.json`, `de.json`, `pt.json`, `fr.json`, `it.json`

- [ ] **Step 1: Añadir claves i18n de privacy en los 6 locales**

  En cada archivo de locale, añadir una sección `"privacy"` con las claves necesarias.

  **`frontend/locales/es.json`** — añadir dentro del objeto raíz:
  ```json
  "privacy": {
    "page_title": "Aviso de Privacidad",
    "link_text": "Aviso de privacidad",
    "controller_title": "1. Responsable del tratamiento",
    "controller_body": "Los datos personales recogidos en esta plataforma son tratados por [REPLACE: nombre de la organización], con domicilio en [REPLACE: dirección]. Contacto DPD: [REPLACE: email del DPD].",
    "data_title": "2. Datos personales tratados",
    "data_body": "Nombre de usuario, dirección de correo electrónico, marca de tiempo de acceso, registros de auditoría (acción + recurso + email + timestamp), tokens de dispositivos de confianza.",
    "basis_title": "3. Base jurídica",
    "basis_body": "El tratamiento es necesario para la ejecución del contrato de prestación de servicio (Art. 6.1.b RGPD) y para el cumplimiento de obligaciones legales de trazabilidad y auditoría (Art. 6.1.c RGPD).",
    "retention_title": "4. Plazo de conservación",
    "retention_body": "Los registros de auditoría se conservan un mínimo de 730 días (2 años) para cumplir con los requisitos de NIS2. Las cuentas de usuario se eliminan cuando el usuario ejerce su derecho de supresión o finaliza la relación laboral.",
    "rights_title": "5. Sus derechos",
    "rights_body": "Puede ejercer los derechos de acceso, rectificación, supresión, limitación, portabilidad y oposición dirigiéndose a [REPLACE: email de contacto]. Tiene derecho a presentar una reclamación ante la autoridad de control competente.",
    "transfers_title": "6. Transferencias internacionales",
    "transfers_body": "Si se utiliza el inicio de sesión con Microsoft 365, parte del tratamiento de identidad se realiza por Microsoft Corporation (EE.UU.) bajo el Acuerdo de Procesamiento de Datos de Microsoft y las Cláusulas Contractuales Tipo.",
    "back": "← Volver al inicio"
  }
  ```

  **`frontend/locales/en.json`** — añadir:
  ```json
  "privacy": {
    "page_title": "Privacy Notice",
    "link_text": "Privacy notice",
    "controller_title": "1. Data Controller",
    "controller_body": "Personal data collected on this platform is processed by [REPLACE: organisation name], registered at [REPLACE: address]. DPO contact: [REPLACE: DPO email].",
    "data_title": "2. Personal Data Processed",
    "data_body": "Username, email address, access timestamps, audit log entries (action + resource + email + timestamp), trusted device tokens.",
    "basis_title": "3. Legal Basis",
    "basis_body": "Processing is necessary for the performance of a service contract (Art. 6(1)(b) GDPR) and to comply with legal traceability and audit obligations (Art. 6(1)(c) GDPR).",
    "retention_title": "4. Retention Periods",
    "retention_body": "Audit logs are retained for a minimum of 730 days (2 years) to comply with NIS2 requirements. User accounts are deleted upon right-to-erasure request or end of employment.",
    "rights_title": "5. Your Rights",
    "rights_body": "You may exercise your rights of access, rectification, erasure, restriction, portability, and objection by contacting [REPLACE: contact email]. You have the right to lodge a complaint with the competent supervisory authority.",
    "transfers_title": "6. International Transfers",
    "transfers_body": "If Microsoft 365 SSO is used, part of the identity processing is carried out by Microsoft Corporation (USA) under Microsoft's Data Processing Agreement and Standard Contractual Clauses.",
    "back": "← Back to login"
  }
  ```

  **`frontend/locales/de.json`** — añadir:
  ```json
  "privacy": {
    "page_title": "Datenschutzhinweis",
    "link_text": "Datenschutzhinweis",
    "controller_title": "1. Verantwortlicher",
    "controller_body": "Die auf dieser Plattform erhobenen personenbezogenen Daten werden verarbeitet von [REPLACE: Name der Organisation], [REPLACE: Adresse]. DSB-Kontakt: [REPLACE: DSB-E-Mail].",
    "data_title": "2. Verarbeitete personenbezogene Daten",
    "data_body": "Benutzername, E-Mail-Adresse, Zugriffszeitstempel, Audit-Protokolleinträge (Aktion + Ressource + E-Mail + Zeitstempel), vertrauenswürdige Geräte-Token.",
    "basis_title": "3. Rechtsgrundlage",
    "basis_body": "Die Verarbeitung ist erforderlich für die Erfüllung eines Dienstleistungsvertrags (Art. 6 Abs. 1 lit. b DSGVO) und zur Erfüllung gesetzlicher Nachvollziehbarkeits- und Prüfpflichten (Art. 6 Abs. 1 lit. c DSGVO).",
    "retention_title": "4. Speicherdauer",
    "retention_body": "Audit-Protokolle werden mindestens 730 Tage (2 Jahre) aufbewahrt, um die NIS2-Anforderungen zu erfüllen. Benutzerkonten werden auf Antrag auf Löschung oder bei Beendigung des Arbeitsverhältnisses gelöscht.",
    "rights_title": "5. Ihre Rechte",
    "rights_body": "Sie können Ihre Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch unter [REPLACE: Kontakt-E-Mail] geltend machen. Sie haben das Recht, Beschwerde bei der zuständigen Aufsichtsbehörde einzulegen.",
    "transfers_title": "6. Internationale Übermittlungen",
    "transfers_body": "Bei Verwendung von Microsoft 365 SSO wird ein Teil der Identitätsverarbeitung von der Microsoft Corporation (USA) im Rahmen des Microsoft-Datenverarbeitungsvertrags und der Standardvertragsklauseln durchgeführt.",
    "back": "← Zurück zur Anmeldung"
  }
  ```

  **`frontend/locales/pt.json`** — añadir:
  ```json
  "privacy": {
    "page_title": "Aviso de Privacidade",
    "link_text": "Aviso de privacidade",
    "controller_title": "1. Responsável pelo tratamento",
    "controller_body": "Os dados pessoais recolhidos nesta plataforma são tratados por [REPLACE: nome da organização], com sede em [REPLACE: morada]. Contacto do EPD: [REPLACE: email do EPD].",
    "data_title": "2. Dados pessoais tratados",
    "data_body": "Nome de utilizador, endereço de e-mail, marcas temporais de acesso, entradas no registo de auditoria (ação + recurso + e-mail + timestamp), tokens de dispositivos de confiança.",
    "basis_title": "3. Base jurídica",
    "basis_body": "O tratamento é necessário para a execução de um contrato de serviço (Art. 6.º, n.º 1, alínea b) RGPD) e para o cumprimento de obrigações legais de rastreabilidade e auditoria (Art. 6.º, n.º 1, alínea c) RGPD).",
    "retention_title": "4. Prazos de conservação",
    "retention_body": "Os registos de auditoria são conservados por um mínimo de 730 dias (2 anos) para cumprir os requisitos NIS2. As contas de utilizador são eliminadas mediante pedido de apagamento ou fim da relação laboral.",
    "rights_title": "5. Os seus direitos",
    "rights_body": "Pode exercer os seus direitos de acesso, retificação, apagamento, limitação, portabilidade e oposição através de [REPLACE: e-mail de contacto]. Tem o direito de apresentar uma reclamação à autoridade de controlo competente.",
    "transfers_title": "6. Transferências internacionais",
    "transfers_body": "Se for utilizado o início de sessão com Microsoft 365, parte do tratamento de identidade é realizado pela Microsoft Corporation (EUA) ao abrigo do Contrato de Processamento de Dados da Microsoft e das Cláusulas Contratuais-Tipo.",
    "back": "← Voltar ao início de sessão"
  }
  ```

  **`frontend/locales/fr.json`** — añadir:
  ```json
  "privacy": {
    "page_title": "Avis de confidentialité",
    "link_text": "Avis de confidentialité",
    "controller_title": "1. Responsable du traitement",
    "controller_body": "Les données personnelles collectées sur cette plateforme sont traitées par [REPLACE: nom de l'organisation], dont le siège est situé à [REPLACE: adresse]. Contact DPO : [REPLACE: e-mail du DPO].",
    "data_title": "2. Données personnelles traitées",
    "data_body": "Nom d'utilisateur, adresse e-mail, horodatages d'accès, entrées du journal d'audit (action + ressource + e-mail + horodatage), jetons d'appareils de confiance.",
    "basis_title": "3. Base juridique",
    "basis_body": "Le traitement est nécessaire à l'exécution d'un contrat de service (Art. 6(1)(b) RGPD) et au respect d'obligations légales de traçabilité et d'audit (Art. 6(1)(c) RGPD).",
    "retention_title": "4. Durées de conservation",
    "retention_body": "Les journaux d'audit sont conservés pendant au moins 730 jours (2 ans) pour satisfaire aux exigences NIS2. Les comptes utilisateur sont supprimés sur demande d'effacement ou à la fin de la relation de travail.",
    "rights_title": "5. Vos droits",
    "rights_body": "Vous pouvez exercer vos droits d'accès, de rectification, d'effacement, de limitation, de portabilité et d'opposition en contactant [REPLACE: e-mail de contact]. Vous avez le droit d'introduire une réclamation auprès de l'autorité de contrôle compétente.",
    "transfers_title": "6. Transferts internationaux",
    "transfers_body": "Si la connexion Microsoft 365 est utilisée, une partie du traitement d'identité est effectuée par Microsoft Corporation (États-Unis) dans le cadre de l'Accord de traitement des données de Microsoft et des Clauses contractuelles types.",
    "back": "← Retour à la connexion"
  }
  ```

  **`frontend/locales/it.json`** — añadir:
  ```json
  "privacy": {
    "page_title": "Informativa sulla privacy",
    "link_text": "Informativa sulla privacy",
    "controller_title": "1. Titolare del trattamento",
    "controller_body": "I dati personali raccolti su questa piattaforma sono trattati da [REPLACE: nome dell'organizzazione], con sede in [REPLACE: indirizzo]. Contatto DPO: [REPLACE: email del DPO].",
    "data_title": "2. Dati personali trattati",
    "data_body": "Nome utente, indirizzo e-mail, timestamp di accesso, voci del registro di audit (azione + risorsa + e-mail + timestamp), token dei dispositivi attendibili.",
    "basis_title": "3. Base giuridica",
    "basis_body": "Il trattamento è necessario per l'esecuzione di un contratto di servizio (Art. 6(1)(b) GDPR) e per adempiere a obblighi legali di tracciabilità e audit (Art. 6(1)(c) GDPR).",
    "retention_title": "4. Periodi di conservazione",
    "retention_body": "I registri di audit vengono conservati per un minimo di 730 giorni (2 anni) per soddisfare i requisiti NIS2. Gli account utente vengono eliminati su richiesta di cancellazione o alla fine del rapporto di lavoro.",
    "rights_title": "5. I tuoi diritti",
    "rights_body": "Puoi esercitare i diritti di accesso, rettifica, cancellazione, limitazione, portabilità e opposizione contattando [REPLACE: email di contatto]. Hai il diritto di presentare un reclamo all'autorità di controllo competente.",
    "transfers_title": "6. Trasferimenti internazionali",
    "transfers_body": "Se viene utilizzato il login Microsoft 365, parte del trattamento dell'identità viene effettuato da Microsoft Corporation (USA) nell'ambito dell'Accordo sul trattamento dei dati di Microsoft e delle Clausole contrattuali standard.",
    "back": "← Torna al login"
  }
  ```

- [ ] **Step 2: Crear frontend/app/privacy/page.tsx**

  ```typescript
  "use client";

  import { useLanguage } from "@/contexts/LanguageContext";
  import Link from "next/link";

  export default function PrivacyPage() {
    const { t } = useLanguage();

    return (
      <div className="min-h-screen bg-slate-50 py-12 px-4">
        <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-800 mb-2">{t("privacy.page_title")}</h1>
          <p className="text-xs text-slate-400 mb-8">CMDB Enterprise Platform — GDPR Art. 13 / Art. 14</p>

          <section className="mb-6">
            <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.controller_title")}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.controller_body")}</p>
          </section>

          <section className="mb-6">
            <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.data_title")}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.data_body")}</p>
          </section>

          <section className="mb-6">
            <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.basis_title")}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.basis_body")}</p>
          </section>

          <section className="mb-6">
            <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.retention_title")}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.retention_body")}</p>
          </section>

          <section className="mb-6">
            <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.rights_title")}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.rights_body")}</p>
          </section>

          <section className="mb-8">
            <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.transfers_title")}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.transfers_body")}</p>
          </section>

          <Link
            href="/login"
            className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
          >
            {t("privacy.back")}
          </Link>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 3: Añadir enlace de privacy en login/page.tsx**

  En `frontend/app/login/page.tsx`, localizar el cierre `</div>` final del componente (línea ~502, justo antes del `return` que cierra el último `</div>`). Insertar antes de la última `</div>`:

  ```typescript
  // Añadir justo antes del penúltimo </div> de cierre (antes del return final):
  <div className="text-center mt-6">
    <Link href="/privacy" className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
      {t("login.privacy_link")}
    </Link>
  </div>
  ```

  Y añadir la clave en los 6 locales como parte de la sección `"login"`:
  - es: `"privacy_link": "Aviso de privacidad"`
  - en: `"privacy_link": "Privacy notice"`
  - de: `"privacy_link": "Datenschutzhinweis"`
  - pt: `"privacy_link": "Aviso de privacidade"`
  - fr: `"privacy_link": "Avis de confidentialité"`
  - it: `"privacy_link": "Informativa sulla privacy"`

  También verificar que `Link` está importado en `login/page.tsx`. Si no, añadir:
  ```typescript
  import Link from "next/link";
  ```

- [ ] **Step 4: Añadir sección en SYSADMIN_MANUAL.md**

  Añadir al final de `docs/SYSADMIN_MANUAL.md`:

  ```markdown
  ## 17. Aviso de Privacidad y Obligaciones GDPR Art. 13/14

  La plataforma incluye una página de aviso de privacidad en `/privacy`. Los campos marcados como `[REPLACE: ...]` deben ser completados por la organización antes del despliegue en producción:

  - **Nombre y datos del responsable del tratamiento** (Art. 13.1.a RGPD)
  - **Datos de contacto del Delegado de Protección de Datos** (Art. 13.1.b RGPD)
  - **Email de contacto para ejercicio de derechos**

  **Usuarios auto-provisionados (SSO/LDAP):** La plataforma crea cuentas automáticamente para usuarios de Microsoft Azure AD y LDAP sin interacción directa. Esto activa la obligación del Art. 14 RGPD (información indirecta). La organización debe informar a estos usuarios mediante comunicación interna (RRHH, correo corporativo) ya que la aplicación no envía correos de bienvenida.
  ```

  Añadir el equivalente en inglés a `docs/SYSADMIN_MANUAL.en.md`:

  ```markdown
  ## 17. Privacy Notice and GDPR Art. 13/14 Obligations

  The platform includes a privacy notice page at `/privacy`. Fields marked `[REPLACE: ...]` must be completed by the organisation before production deployment:

  - **Name and contact details of the data controller** (Art. 13(1)(a) GDPR)
  - **Data Protection Officer contact details** (Art. 13(1)(b) GDPR)
  - **Contact email for data subject rights requests**

  **Auto-provisioned users (SSO/LDAP):** The platform automatically creates accounts for Microsoft Azure AD and LDAP users without direct interaction. This triggers the Art. 14 GDPR obligation (indirect collection notice). The organisation must inform these users via internal communication (HR, corporate email) as the application does not send welcome emails.
  ```

- [ ] **Step 5: Rebuild y verificar página de privacidad**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 20
  curl -sk https://localhost/privacy | grep -i "privacy\|privacidad" | head -3
  ```

  Expected: respuesta HTML con contenido de la página de privacidad.

- [ ] **Step 6: Commit**

  ```bash
  git add frontend/app/privacy/page.tsx frontend/app/login/page.tsx \
          frontend/locales/es.json frontend/locales/en.json frontend/locales/de.json \
          frontend/locales/pt.json frontend/locales/fr.json frontend/locales/it.json \
          docs/SYSADMIN_MANUAL.md docs/SYSADMIN_MANUAL.en.md
  git commit -m "feat(gdpr): add privacy notice page + login link — closes #77

  Creates /privacy page with GDPR Art.13/14 data processing disclosure
  covering controller identity, data categories, legal bases, retention
  periods, data subject rights, and international transfers (Microsoft SSO).

  Login page now includes a link to the privacy notice. All 6 locales
  updated. Sysadmin manual documents the Art.14 obligation for auto-
  provisioned SSO/LDAP users.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 4 — #79 + #80: Expandir IRP NIS2 + crear DPIA

**Files:**
- Modify: `docs/security/isms/04-incident-response-plan.md`
- Create: `docs/security/isms/06-dpia.md`

- [ ] **Step 1: Expandir 04-incident-response-plan.md con NIS2 Art. 23 y detección**

  Reemplazar el archivo completo `docs/security/isms/04-incident-response-plan.md` con:

  ```markdown
  # Incident Response Plan (IRP)
  **Document ID:** ISMS-IRP-001  
  **Version:** 1.1  
  **Status:** Draft  
  **Owner:** [REPLACE: CISO]  
  **Last tested:** [REPLACE: YYYY-MM-DD — tabletop exercise]  
  **Next review:** [REPLACE: YYYY-MM-DD]  
  **Framework:** NIS2 Art. 21(2)(b), NIS2 Art. 23, ISO 27001 A.6.8

  ---

  ## 1. Incident Severity Tiers

  | Tier | Description | Example | Response SLA |
  |------|-------------|---------|-------------|
  | P1 Critical | Data breach, ransomware, complete outage | JWT cookie stolen via XSS; DB compromise | Immediate (< 1 h) |
  | P2 High | Partial outage, suspected breach | Single container down; suspicious admin login | < 4 h |
  | P3 Medium | Degraded performance, failed security control | Alert emails failing; MFA bypass attempt | < 24 h |
  | P4 Low | Security advisory, minor anomaly | New npm CVE (no exploitation); config drift | < 72 h |

  ### 1.1 Incident Classification Criteria

  An event qualifies as a **security incident** when one or more of the following apply:
  - Unauthorized access to any CMDB platform resource (confirmed or suspected)
  - Any brute-force attack: > 5 failed login attempts for the same email within 10 minutes
  - Any modification to `audit_logs` outside normal INSERT operations
  - Discovery of a vulnerability with CVSS ≥ 7.0 in a deployed dependency
  - Any data exfiltration (confirmed or suspected)
  - Platform unavailability > 15 minutes (potential availability incident)

  ## 2. Incident Response Steps

  ### 2.1 Detection and Reporting

  **Automated detection via audit_logs (SQL query for on-call use):**
  ```sql
  -- Detect brute-force: > 5 LOGIN failures for same email in last 10 minutes
  SELECT user_email, COUNT(*) AS attempts
  FROM audit_logs
  WHERE action = 'LOGIN'
    AND created_at > NOW() - INTERVAL '10 minutes'
  GROUP BY user_email
  HAVING COUNT(*) > 5;
  ```

  **Reporting channels:**
  - All users report suspected incidents to: [REPLACE: security@yourdomain.com]
  - Platform automated alerts (SMTP) fire for EOL/EOS events
  - Monitor: `docker logs cmdb-backend` and `audit_logs` for anomalies

  ### 2.2 Containment

  - **P1**: Immediately deactivate affected accounts (`PATCH /api/users/:id/status`), rotate `JWT_SECRET` and `POSTGRES_PASSWORD`, restart all containers
  - **P2**: Isolate the affected container (`docker stop <name>`); preserve logs before restart
  - All: snapshot PostgreSQL before any remediation:
    ```bash
    docker exec cmdb-postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > incident_$(date +%F_%H%M).sql.gz
    ```

  ### 2.3 Eradication and Recovery

  1. Identify root cause via `audit_logs` and `docker logs`
  2. Apply patch or configuration fix
  3. Rebuild and redeploy: `bash scripts/update.sh`
  4. Verify health: `curl -sk https://<host>/api/health`

  ## 3. NIS2 Art. 23 Notification Obligations

  NIS2 Article 23 applies when the incident has a **significant impact** on the provision of services (>1h unavailability, data breach, or significant financial/reputational damage).

  | Obligation | Deadline | Content | Recipient |
  |------------|----------|---------|-----------|
  | **Early warning** (Art. 23(1)(a)) | Within **24 hours** of awareness | Type of incident, suspected cause, affected services | [REPLACE: National CSIRT / competent authority] |
  | **Incident notification** (Art. 23(1)(b)) | Within **72 hours** of awareness | Updated assessment, initial estimate of impact and severity, indicators of compromise | [REPLACE: National CSIRT / competent authority] |
  | **Intermediate report** (Art. 23(3)) | On request from authority | Current status, response measures taken | [REPLACE: National CSIRT] |
  | **Final report** (Art. 23(4)) | Within **1 month** of notification | Detailed description, severity, impact, root cause, remediation, cross-border impact | [REPLACE: National CSIRT / competent authority] |

  **GDPR Art. 33 (if personal data involved):**
  - Notify supervisory authority within **72 hours** of becoming aware: [REPLACE: national DPA contact]
  - Notify affected data subjects without undue delay if high risk (Art. 34)

  ### 3.1 Notification Templates

  **Early Warning (24h) — Art. 23(1)(a):**
  ```
  To: [REPLACE: CSIRT contact]
  Subject: NIS2 Early Warning — CMDB Enterprise Platform — [DATE]

  Organisation: [REPLACE]
  Platform: CMDB Enterprise Platform
  Incident type: [Authentication anomaly / Data breach / Service outage / Other]
  Time of discovery: [YYYY-MM-DD HH:MM UTC]
  Suspected cause: [Description]
  Affected services: [Description]
  Current status: [Contained / Under investigation / Ongoing]
  Contact: [REPLACE: Incident Lead name and phone]
  ```

  **Full Notification (72h) — Art. 23(1)(b):**
  ```
  To: [REPLACE: CSIRT contact]
  Subject: NIS2 Incident Notification — CMDB Enterprise Platform — [DATE]

  [Include all Early Warning content, plus:]
  Initial severity assessment: [P1/P2/P3/P4]
  Estimated number of affected users: [N]
  Indicators of compromise: [IP addresses, user agents, affected accounts]
  Measures taken: [Containment and eradication steps]
  Estimated restoration time: [YYYY-MM-DD HH:MM UTC]
  Cross-border impact: [Yes/No — if Yes, describe]
  ```

  ## 4. Post-Incident Review

  - Conduct within 5 business days of incident closure
  - Document: timeline, root cause, impact, remediation, lessons learned
  - Update risk register (ISMS-RISK-001) with new or revised risk entries
  - Update this IRP if process gaps were identified
  - Set `AUDIT_RETENTION_DAYS` minimum to 730 days in production

  ## 5. Contacts

  | Role | Name | Contact |
  |------|------|---------|
  | Incident Lead | [REPLACE] | [REPLACE: phone/email] |
  | DPO | [REPLACE] | [REPLACE: phone/email] |
  | National CSIRT | [REPLACE] | [REPLACE: phone/ticket URL] |
  | Supervisory Authority (DPA) | [REPLACE] | [REPLACE: contact URL] |
  | Hosting Provider NOC | [REPLACE] | [REPLACE: phone/ticket URL] |
  | Legal Counsel | [REPLACE] | [REPLACE: phone/email] |
  ```

- [ ] **Step 2: Crear docs/security/isms/06-dpia.md**

  ```markdown
  # Data Protection Impact Assessment (DPIA)
  **Document ID:** ISMS-DPIA-001  
  **Version:** 1.0  
  **Status:** Draft — requires DPO review and sign-off  
  **Owner:** [REPLACE: DPO name]  
  **Reviewed by:** [REPLACE: Legal counsel, CISO]  
  **Approval date:** [REPLACE: YYYY-MM-DD]  
  **Next review:** [REPLACE: YYYY-MM-DD — review annually or after significant change]  
  **Legal basis:** GDPR Art. 35, EDPB Guidelines 09/2022

  ---

  ## 1. DPIA Trigger Assessment

  A DPIA is required when processing is "likely to result in a high risk" (Art. 35). The EDPB guidelines require a DPIA when ≥ 2 criteria apply:

  | Criterion | Present? | Evidence |
  |-----------|----------|---------|
  | Systematic monitoring | ✅ Yes | All user actions logged with email+timestamp in `audit_logs` (insert-only, append-only) |
  | Innovative technology | ✅ Yes | MFA TOTP, Microsoft SSO auto-provisioning, LDAP auto-provisioning |
  | Vulnerable subjects | ⚠️ Partial | Internal employees only — moderate risk |
  | Large scale | ❌ No | Deployment typically < 500 users |
  | Automated decision-making | ❌ No | No algorithmic decisions affecting individuals |

  **Conclusion:** ≥ 2 criteria met → DPIA required.

  ---

  ## 2. Personal Data Inventory

  | Data Category | Where Stored | Purpose | Legal Basis (GDPR Art. 6) | Retention | Risk Level |
  |--------------|-------------|---------|--------------------------|-----------|------------|
  | Email address | `users.email` | Authentication, audit attribution | 6(1)(b) — contract | Duration of employment + 30 days | Medium |
  | Username | `users.username` | Authentication, display | 6(1)(b) — contract | Duration of employment + 30 days | Low |
  | Password hash (bcrypt) | `users.password` | Authentication | 6(1)(b) — contract | Same as user account | Low |
  | MFA secret (TOTP) | `users.mfa_secret` | 2FA authentication | 6(1)(b) — contract | Same as user account | Medium |
  | Email in audit logs | `audit_logs.user_email` | Traceability, compliance | 6(1)(c) — legal obligation | Minimum 730 days (NIS2) | High |
  | Trusted device token | `trusted_devices.token` | Device recognition | 6(1)(b) — contract | 30 days (configurable) |  Low |
  | IP address + User-Agent | `trusted_devices.ip_address/user_agent` | Device binding security | 6(1)(f) — legitimate interest | 30 days | Medium |
  | Password history hashes | `password_history.hash` | Password reuse prevention | 6(1)(c) — legal obligation (security) | Last N passwords (configurable) | Low |
  | DNI (national ID) | `license_users` and `configuration_items` (optional field) | Asset management | [REPLACE: 6(1)(b) or remove if not necessary] | Same as parent record | **High** |
  | Azure OID | `users.sso_external_id` | SSO identity binding | 6(1)(b) — contract | Same as user account | Medium |

  ---

  ## 3. High-Risk Processing Activities

  ### 3.1 Systematic Monitoring via Audit Logs (HIGH RISK)

  **Description:** Every write action by every user is recorded in `audit_logs` with their email, action type, entity, and timestamp. The table is insert-only (RLS blocks DELETE) and UPDATE is only allowed for GDPR pseudonymisation.

  **Risk:** Comprehensive behavioral profile of all users. Retention minimum of 730 days creates a 2-year surveillance dataset.

  **Mitigations:**
  - Access restricted to AUDITOR and ADMIN roles
  - RLS prevents deletion — only pseudonymisation on GDPR erasure request
  - Pseudonymisation replaces email with `[deleted-{hash16}]` on erasure
  - No automated profiling or decision-making based on audit data

  **Residual risk after mitigations:** Medium — acceptable given legal obligation (NIS2 traceability).

  ### 3.2 DNI/National ID Collection (HIGH RISK — REQUIRES ACTION)

  **Description:** The `license_users` and `configuration_items` tables contain optional fields that may store national identification numbers (DNI).

  **Risk:** Processing of national IDs requires explicit legal basis in many jurisdictions. No documented legal basis exists.

  **Required action (choose one):**
  1. **Remove the field** if DNI is not essential for asset management — preferred (data minimisation, Art. 5(1)(c))
  2. **Document legal basis** — explicit legal obligation (e.g., software asset auditing regulation) or explicit consent, documented in this DPIA before processing

  **Status:** [REPLACE: Open — requires decision before production deployment]

  ### 3.3 Microsoft SSO — International Data Transfer (MEDIUM RISK)

  **Description:** Azure AD processes email address and Object ID for identity assertion. Data flows to Microsoft servers (may be USA).

  **Transfer mechanism:** Microsoft DPA + Standard Contractual Clauses (SCCs) — covered by Microsoft's EU Data Boundary commitments.

  **Mitigations:**
  - Only email and OID are transferred — no CMDB asset data
  - Microsoft's ISO 27001 / SOC 2 Type II certification
  - Transfer can be disabled by setting `USE_MICROSOFT_SSO=false`

  **Residual risk:** Low — transfer mechanism documented and covered by Art. 46 SCCs.

  ### 3.4 LDAP Auto-Provisioning — Art. 14 Obligation (MEDIUM RISK)

  **Description:** Users authenticated via LDAP/AD are automatically created in the platform without direct interaction. This triggers Art. 14 (information to data subject when data not collected directly).

  **Mitigation:** Organisation must inform LDAP users via HR/corporate communication. Documented in SYSADMIN_MANUAL.md §17.

  **Residual risk:** Low — mitigated by organisational process.

  ---

  ## 4. GDPR Art. 17 / Audit Log Immutability Conflict

  **Conflict:** GDPR Art. 17 grants users the right to erasure. The audit log RLS policy makes DELETE impossible (ISO 27001 A.8.15 / NIS2 traceability requirement).

  **Resolution:** Pseudonymisation as defined in Art. 4(5) GDPR. The `DELETE /api/admin/users/:id` endpoint:
  1. Replaces `user_email` in all `audit_logs` entries with a stable SHA-256 hash (`[deleted-{hash16}]`)
  2. Permanently deletes the user record and all PII

  **Legal basis for retention after pseudonymisation:** Art. 17(3)(b) — retention necessary for compliance with a legal obligation (NIS2 traceability).

  **This approach is documented and approved by:** [REPLACE: DPO signature and date]

  ---

  ## 5. DPO Consultation

  This DPIA was [REPLACE: submitted to / reviewed by] the Data Protection Officer on [REPLACE: YYYY-MM-DD].

  **DPO opinion:** [REPLACE: Approved / Approved with conditions / Objections raised]

  **Conditions / Objections:** [REPLACE: if any]

  ---

  ## 6. Sign-off

  | Role | Name | Date | Signature |
  |------|------|------|-----------|
  | DPO | [REPLACE] | [REPLACE] | [REPLACE] |
  | CISO | [REPLACE] | [REPLACE] | [REPLACE] |
  | Legal Counsel | [REPLACE] | [REPLACE] | [REPLACE] |
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add docs/security/isms/04-incident-response-plan.md docs/security/isms/06-dpia.md
  git commit -m "docs(compliance): expand IRP with NIS2 Art.23 timelines + create DPIA — closes #79, closes #80

  IRP v1.1: adds incident classification criteria, brute-force detection SQL,
  NIS2 Art.23 notification timeline table (24h/72h/1mo), notification templates
  for early warning and full incident notification, GDPR Art.33/34 obligations.

  DPIA: covers 4 high-risk processing activities (audit log monitoring, DNI
  collection, Microsoft SSO transfer, LDAP auto-provisioning). Documents the
  GDPR Art.17 / audit immutability conflict resolution via pseudonymisation
  (Art.17(3)(b) legal obligation exception). Requires DPO sign-off.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 5 — #81: BCP/RTO/RPO document + mejoras de backup scripts

**Files:**
- Create: `docs/security/isms/07-bcp-rto-rpo.md`
- Modify: `scripts/db-backup.sh`
- Create: `scripts/docs-backup.sh`

- [ ] **Step 1: Crear docs/security/isms/07-bcp-rto-rpo.md**

  ```markdown
  # Business Continuity Plan (BCP) — RTO / RPO / MTPD
  **Document ID:** ISMS-BCP-001  
  **Version:** 1.0  
  **Status:** Draft  
  **Owner:** [REPLACE: CISO / IT Manager]  
  **Last DR test:** [REPLACE: YYYY-MM-DD — not yet conducted]  
  **Next review:** [REPLACE: YYYY-MM-DD — review annually]  
  **Framework:** ISO 22301:2019, NIS2 Art. 21(2)(c)

  ---

  ## 1. Business Impact Analysis (BIA)

  ### 1.1 Dependent Business Processes

  | Process | Depends on CMDB Platform | Impact if unavailable |
  |---------|--------------------------|----------------------|
  | IT asset management | Yes — primary tool | Medium: manual workaround possible |
  | Software license compliance | Yes | High: audit risk if untracked |
  | Contract expiry monitoring | Yes | Medium: email alerts would be missed |
  | Security incident investigation | Yes — audit logs | Critical: no traceability during outage |

  ### 1.2 Impact of Unavailability

  | Duration | Impact |
  |----------|--------|
  | < 1 hour | Negligible — transient outage, no business impact |
  | 1–4 hours | Low — operational inconvenience, ticket backlog |
  | 4–24 hours | Medium — license/contract deadline risk; security monitoring gap |
  | > 24 hours | High — regulatory exposure (NIS2 availability obligation); potential audit finding |
  | > 72 hours | Critical — business continuity breach; mandatory NIS2 notification |

  ---

  ## 2. Continuity Objectives

  | Metric | Target | Rationale |
  |--------|--------|-----------|
  | **RPO** (Recovery Point Objective) | ≤ 24 hours | Daily backup schedule; maximum acceptable data loss = 1 day |
  | **RTO** (Recovery Time Objective) | ≤ 4 hours | Time to rebuild containers + restore from backup on available host |
  | **MTPD** (Maximum Tolerable Period of Disruption) | 72 hours | NIS2 significant incident threshold; >72h triggers Art. 23 notification |

  **Note:** RTO assumes the host server is available. If host reprovisioning is required, add 2–4 hours for OS/Docker setup.

  ---

  ## 3. Recovery Procedures

  ### 3.1 Standard Recovery (host available)

  ```bash
  # 1. Restore database from latest backup
  gunzip -c /opt/cmdb/backups/backup_YYYYMMDD_HHMMSS.sql.gz | \
    docker exec -i cmdb-postgres psql -U admin cmdb_db

  # 2. Restore document store (if docs-backup.sh was used)
  tar -xzf /opt/cmdb/backups/docs_YYYYMMDD_HHMMSS.tar.gz -C /opt/cmdb/documents/

  # 3. Rebuild and start containers
  cd /opt/cmdb
  docker compose -f docker-compose.prod.yml down
  docker compose -f docker-compose.prod.yml up -d --build

  # 4. Apply pending migrations
  docker exec cmdb-backend npx prisma migrate deploy

  # 5. Health check
  curl -sk https://localhost/api/health
  ```

  ### 3.2 Full Host Reprovisioning (host unavailable)

  1. Provision new RHEL 9 / Ubuntu 22.04 host
  2. Follow `docs/SYSADMIN_MANUAL.md` §Install → run `bash scripts/install.sh`
  3. Restore database and document store per §3.1
  4. Update DNS A record to point to new host IP

  ### 3.3 Minimum Viable Service

  During recovery, the following is acceptable as minimum viable operation:
  - Read-only access to exported database backup (CSV/SQL)
  - Manual review of audit logs via `psql` direct connection

  ---

  ## 4. Backup Architecture

  | Component | Script | Schedule | Retention | Off-site? |
  |-----------|--------|----------|-----------|-----------|
  | PostgreSQL database | `scripts/db-backup.sh` | Daily 02:00 | 30 days | [REPLACE: No — add rclone/s3 step] |
  | Document store | `scripts/docs-backup.sh` | Daily 02:30 | 30 days | [REPLACE: No — add rclone/s3 step] |

  **Known gap:** Both backups are stored on the same host as the live platform. A single host failure destroys both live data and all backups. Remediation: [REPLACE: add off-site replication via rclone/aws s3 cp at end of backup scripts].

  ### 4.1 Backup Integrity Verification

  Both backup scripts include automatic integrity verification (`gunzip -t` for PostgreSQL, `tar -tzf` for document store). Verification failure causes the script to exit with status 1 and log an error.

  ---

  ## 5. DR Test Plan

  A DR test must be conducted annually and documented:

  1. Copy latest backup files to a test host
  2. Run full restore procedure (§3.1)
  3. Measure actual RTO (time from start to health check pass)
  4. Compare against target (≤ 4 hours)
  5. Document findings and update this BCP

  **Last DR test:** [REPLACE: Not yet conducted]  
  **Measured RTO:** [REPLACE: N/A]

  ---

  ## 6. Activation Criteria

  This BCP is activated when:
  - Platform unavailability > 30 minutes AND no automated recovery in progress
  - Data corruption or loss detected
  - Security incident classified P1 requiring full platform rebuild

  **Activation authority:** [REPLACE: CISO or IT Manager]

  ---

  ## 7. Contact Tree

  | Priority | Role | Name | Contact |
  |----------|------|------|---------|
  | 1 | Incident Lead | [REPLACE] | [REPLACE] |
  | 2 | IT Infrastructure | [REPLACE] | [REPLACE] |
  | 3 | CISO | [REPLACE] | [REPLACE] |
  | 4 | Business Owner | [REPLACE] | [REPLACE] |
  ```

- [ ] **Step 2: Mejorar scripts/db-backup.sh — añadir verificación de integridad**

  Añadir después de la línea `echo "${LOG_PREFIX} ✅ Backup created: ${BACKUP_FILE} (${BACKUP_SIZE})"` y antes de `# ── Rotate old backups`:

  ```bash
  # ── Verify backup integrity ───────────────────────────────────────────────────
  echo "${LOG_PREFIX} Verifying backup integrity…"
  if ! gunzip -t "${BACKUP_FILE}" 2>/dev/null; then
    echo "${LOG_PREFIX} ❌ INTEGRITY CHECK FAILED: ${BACKUP_FILE} is corrupt." >&2
    rm -f "${BACKUP_FILE}"
    exit 1
  fi
  echo "${LOG_PREFIX} ✅ Integrity check passed."
  ```

- [ ] **Step 3: Crear scripts/docs-backup.sh**

  ```bash
  #!/usr/bin/env bash
  # ─────────────────────────────────────────────────────────────────────────────
  # scripts/docs-backup.sh
  #
  # Backup for CMDB Enterprise Platform document storage (DOCUMENTS_STORAGE_PATH).
  # Creates a compressed tar archive of all uploaded documents.
  #
  # Usage:
  #   bash scripts/docs-backup.sh
  #
  # Crontab example (daily at 02:30 AM, 30 min after db-backup.sh):
  #   30 2 * * * /opt/cmdb/scripts/docs-backup.sh >> /var/log/cmdb-backup.log 2>&1
  #
  # Environment variables (with defaults):
  #   DOCS_SOURCE_DIR     Directory to backup  (default: /opt/cmdb/documents)
  #   BACKUP_DIR          Output directory      (default: /opt/cmdb/backups)
  #   RETENTION_DAYS      Days to keep backups  (default: 30)
  # ─────────────────────────────────────────────────────────────────────────────

  set -euo pipefail

  DOCS_SOURCE_DIR="${DOCS_SOURCE_DIR:-/opt/cmdb/documents}"
  BACKUP_DIR="${BACKUP_DIR:-/opt/cmdb/backups}"
  RETENTION_DAYS="${RETENTION_DAYS:-30}"

  TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
  BACKUP_FILE="${BACKUP_DIR}/docs_${TIMESTAMP}.tar.gz"
  LOG_PREFIX="[CMDB Docs Backup $(date '+%Y-%m-%d %H:%M:%S')]"

  mkdir -p "${BACKUP_DIR}"

  if [ ! -d "${DOCS_SOURCE_DIR}" ]; then
    echo "${LOG_PREFIX} WARNING: DOCS_SOURCE_DIR '${DOCS_SOURCE_DIR}' does not exist. Skipping." >&2
    exit 0
  fi

  echo "${LOG_PREFIX} Starting backup of '${DOCS_SOURCE_DIR}'…"

  tar -czf "${BACKUP_FILE}" -C "$(dirname "${DOCS_SOURCE_DIR}")" "$(basename "${DOCS_SOURCE_DIR}")"

  BACKUP_SIZE="$(du -sh "${BACKUP_FILE}" | cut -f1)"
  echo "${LOG_PREFIX} ✅ Backup created: ${BACKUP_FILE} (${BACKUP_SIZE})"

  # ── Verify integrity ──────────────────────────────────────────────────────────
  echo "${LOG_PREFIX} Verifying backup integrity…"
  if ! tar -tzf "${BACKUP_FILE}" > /dev/null 2>&1; then
    echo "${LOG_PREFIX} ❌ INTEGRITY CHECK FAILED: ${BACKUP_FILE} is corrupt." >&2
    rm -f "${BACKUP_FILE}"
    exit 1
  fi
  echo "${LOG_PREFIX} ✅ Integrity check passed."

  # ── Rotate old backups ────────────────────────────────────────────────────────
  echo "${LOG_PREFIX} Rotating backups older than ${RETENTION_DAYS} days…"
  DELETED_COUNT=0
  while IFS= read -r old_file; do
    rm -f "${old_file}"
    echo "${LOG_PREFIX}   Deleted: ${old_file}"
    DELETED_COUNT=$((DELETED_COUNT + 1))
  done < <(find "${BACKUP_DIR}" -name "docs_*.tar.gz" -mtime "+${RETENTION_DAYS}" 2>/dev/null)

  if [ "${DELETED_COUNT}" -eq 0 ]; then
    echo "${LOG_PREFIX} No old doc backups to rotate."
  else
    echo "${LOG_PREFIX} Rotated ${DELETED_COUNT} old doc backup(s)."
  fi

  TOTAL_BACKUPS="$(find "${BACKUP_DIR}" -name "docs_*.tar.gz" 2>/dev/null | wc -l | tr -d ' ')"
  echo "${LOG_PREFIX} Done. Total doc backups: ${TOTAL_BACKUPS}"
  ```

- [ ] **Step 4: Hacer ejecutable docs-backup.sh**

  ```bash
  chmod +x /home/andres/cmdb-enterprise-platform/scripts/docs-backup.sh
  ```

- [ ] **Step 5: Smoke test de los scripts**

  ```bash
  # Verificar que db-backup.sh puede ejecutarse (sin contenedor running en dev, validamos sintaxis)
  bash -n /home/andres/cmdb-enterprise-platform/scripts/db-backup.sh && echo "db-backup.sh syntax OK"
  bash -n /home/andres/cmdb-enterprise-platform/scripts/docs-backup.sh && echo "docs-backup.sh syntax OK"
  ```

  Expected: ambas líneas muestran "syntax OK".

- [ ] **Step 6: Commit**

  ```bash
  git add docs/security/isms/07-bcp-rto-rpo.md scripts/db-backup.sh scripts/docs-backup.sh
  git commit -m "docs(bcp): add BCP/RTO/RPO document + backup integrity checks — closes #81

  BCP (ISMS-BCP-001): documents RPO ≤ 24h, RTO ≤ 4h, MTPD 72h targets
  with Business Impact Analysis, recovery procedures, DR test plan, and
  activation criteria per ISO 22301:2019 and NIS2 Art.21(2)(c).

  db-backup.sh: adds gunzip -t integrity verification after each backup;
  corrupt archives are deleted and script exits with error.

  docs-backup.sh: new script backs up DOCUMENTS_STORAGE_PATH on same
  schedule as DB backups, with tar integrity check and rotation.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Final Step — Push to develop

- [ ] **Verificar rama**

  ```bash
  git branch --show-current
  ```

  Expected: `develop`

- [ ] **Push**

  ```bash
  git push origin develop
  ```

---

## Self-Review

**Spec coverage:**
- #76 (CSP): ✅ Task 1, Steps 1–7
- #77 (Privacy notice): ✅ Task 3, Steps 1–6
- #78 (LDAP strict mode): ✅ Task 2, Steps 1–7
- #79 (NIS2 IRP): ✅ Task 4, Step 1
- #80 (DPIA): ✅ Task 4, Step 2
- #81 (BCP + scripts): ✅ Task 5, Steps 1–6
- #82 (Prisma v6): ✅ Excluido por decisión del usuario
- #83 (Referrer-Policy + Permissions-Policy): ✅ Task 1, Steps 1–2 (incluidos en el mismo bloque nginx y next.config.ts)

**Placeholder scan:** Código completo en todos los pasos. Campos `[REPLACE: ...]` en documentos de gobernanza son intencionales (requieren datos de la organización). Sin TBD en pasos de código.

**Type consistency:** No hay tipos compartidos entre tareas — cada tarea es autónoma.
