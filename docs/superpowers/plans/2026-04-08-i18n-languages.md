# i18n Language Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add German (DE), Portuguese (PT), French (FR), and Italian (IT) to the existing ES/EN i18n system; replace pill language selector with a dropdown in Sidebar and Login; add language preference UI in Profile.

**Architecture:** Locale dictionaries live in `frontend/locales/*.json` and are statically imported into `LanguageContext.tsx`. Adding a language = 1 new JSON file + update the `DICTS` map + expand the `Locale` type. The selector component in Sidebar renders a `<select>` element; the same component is reused on Login. Profile preference persists to `localStorage` via the existing `setLocale` call.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind CSS, React Context.

---

## Files to Modify / Create

| File | Action |
|------|--------|
| `frontend/locales/de.json` | Create — German translations |
| `frontend/locales/pt.json` | Create — Portuguese translations |
| `frontend/locales/fr.json` | Create — French translations |
| `frontend/locales/it.json` | Create — Italian translations |
| `frontend/locales/es.json` | Modify — add profile.language_* keys |
| `frontend/locales/en.json` | Modify — add profile.language_* keys |
| `frontend/contexts/LanguageContext.tsx` | Modify — expand Locale type + DICTS + browser detection |
| `frontend/components/Sidebar.tsx` | Modify — replace LangSelector pill buttons with `<select>` dropdown |
| `frontend/app/login/page.tsx` | Modify — add language selector to credentials step |
| `frontend/app/profile/page.tsx` | Modify — add Language Preference section |

---

## Task 1 — Create de.json (German)

**Files:**
- Create: `frontend/locales/de.json`

- [ ] **Step 1: Write de.json**

```json
{
  "brand": {
    "name":    "CMDB",
    "tagline": "Enterprise Platform"
  },
  "footer": {
    "copyright": "© {year} CMDB Platform v1.0"
  },
  "sidebar": {
    "dashboard":       "Dashboard",
    "inventory":       "CI-Inventar",
    "vulnerabilities": "Schwachstellen",
    "map":             "Abhängigkeitskarte",
    "integrations":    "Konnektoren",
    "reports":         "Berichte",
    "contracts":       "Verträge & Zusätze",
    "documents":       "Dokumentenablage",
    "licenses":        "Lizenzen",
    "entities":        "Entitäten",
    "profile":         "Mein Profil",
    "masters":         "Stammdaten",
    "certificates":    "SSL-Zertifikate",
    "audit":           "Audit",
    "settings":        "Einstellungen"
  },
  "actions": {
    "logout":           "Abmelden",
    "refresh":          "Aktualisieren",
    "add":              "Hinzufügen",
    "save":             "Speichern",
    "cancel":           "Abbrechen",
    "delete":           "Löschen",
    "edit":             "Bearbeiten",
    "export_csv":       "CSV exportieren",
    "generate_pdf":     "PDF erstellen",
    "retry":            "Erneut versuchen",
    "search":           "Suchen",
    "import":           "Importieren",
    "download_template":"CSV-Vorlage",
    "sync":             "Synchronisieren",
    "send_test_email":  "Test-E-Mail senden",
    "test":             "Testen"
  },
  "common": {
    "loading":          "Laden…",
    "loading_data":     "Daten laden…",
    "no_data":          "Keine Daten",
    "no_results":       "Keine Ergebnisse",
    "error":            "Fehler",
    "unknown_error":    "Unbekannter Fehler",
    "confirm_delete":   "Diesen Eintrag löschen?",
    "admin_only":       "Nur ADMIN",
    "required":         "Pflichtfeld",
    "optional":         "Optional",
    "yes":              "Ja",
    "no":               "Nein",
    "ok":               "OK",
    "close":            "Schließen",
    "name":             "Name",
    "email":            "E-Mail",
    "status":           "Status",
    "date":             "Datum",
    "created_at":       "Erstellt",
    "updated_at":       "Aktualisiert",
    "actions":          "Aktionen"
  },
  "inventory": {
    "title":            "CI-Inventar",
    "subtitle":         "Verwaltung des Technologieparks",
    "search_placeholder":"Nach Name suchen…",
    "total":            "{count} verwaltete Assets",
    "add_ci":           "Neues CI",
    "import_csv":       "CSV importieren",
    "download_template":"CSV-Vorlage",
    "export_csv":       "CSV exportieren",
    "no_cis":           "Kein CI im Inventar.",
    "loading":          "Inventar wird geladen…",
    "import_success":   "{success} CIs erfolgreich importiert, {errors} Fehler",
    "columns": {
      "ci":             "CI / Asset",
      "type":           "Typ",
      "environment":    "Umgebung",
      "criticality":    "Kritikalität",
      "hardware":       "Hardware",
      "software":       "Software",
      "eol":            "EoL / EoS",
      "vulnerabilities":"Schwachstellen",
      "agent":          "CS-Agent",
      "support":        "Support"
    },
    "support_badge": {
      "expired":        "Kein Support",
      "warning":        "EoL in {days}T",
      "ok":             "Aktiv"
    },
    "vuln_badge": {
      "no_data":        "Keine Daten",
      "clean":          "Sauber",
      "all_resolved":   "Alles behoben",
      "open_one":       "{count} offen",
      "open_many":      "{count} offen"
    },
    "agent_badge": {
      "no_agent":       "Kein Agent",
      "protected":      "Geschützt",
      "reduced":        "Reduziert",
      "detection_one":  "{count} Erkennung",
      "detection_many": "{count} Erkennungen"
    },
    "ci_types": {
      "PHYSICAL_SERVER": "Physischer Server",
      "VIRTUAL_SERVER":  "Virtueller Server",
      "DATABASE":        "Datenbank",
      "NETWORK":         "Netzwerk",
      "STORAGE":         "Speicher",
      "BACKUP":          "Backup",
      "HARDWARE":        "Hardware",
      "SOFTWARE":        "Software",
      "OTHER":           "Sonstige",
      "DESKTOP":         "Desktop",
      "LAPTOP":          "Laptop",
      "PRINTER":         "Drucker",
      "SCANNER":         "Scanner",
      "MONITOR":         "Monitor",
      "VIDEOCONFERENCE": "Videokonferenz",
      "SMART_DISPLAY":   "Smart Display",
      "TIME_CLOCK":      "Stempeluhr",
      "IP_PHONE":        "IP-Telefon",
      "SMARTPHONE":      "Smartphone",
      "TABLET":          "Tablet",
      "PDA":             "PDA",
      "BARCODE_SCANNER": "Barcodeleser",
      "IP_CAMERA":       "IP-Kamera",
      "UPS":             "USV / UPS",
      "WIFI_AP":         "WLAN-Zugangspunkt",
      "CLOUD_INSTANCE":  "Cloud-Instanz",
      "CLOUD_STORAGE":   "Cloud-Speicher",
      "BASE_SOFTWARE":   "Basissoftware",
      "LICENSE":         "Lizenz"
    }
  },
  "vulnerabilities": {
    "title":            "Schwachstellen",
    "subtitle":         "CVE- und Sicherheitsrisikomanagement",
    "no_vulns":         "Keine Schwachstellen erfasst.",
    "columns": {
      "ci":             "CI / Server",
      "cve":            "CVE",
      "severity":       "Schweregrad",
      "status":         "Status",
      "description":    "Beschreibung",
      "source":         "Quelle",
      "score":          "CVSS-Bewertung"
    },
    "status": {
      "NUEVO":          "Neu",
      "ASIGNADO":       "Zugewiesen",
      "EN_CURSO":       "In Bearbeitung",
      "PARADO":         "Angehalten",
      "RESUELTO":       "Behoben"
    }
  },
  "contracts": {
    "title":            "Verträge & Zusätze",
    "subtitle":         "Vertragsmanagement mit Anbietern",
    "no_contracts":     "Keine Verträge erfasst.",
    "add_contract":     "Neuer Vertrag",
    "export_csv":       "CSV exportieren",
    "columns": {
      "number":         "Vertr.-Nr.",
      "vendor":         "Anbieter",
      "start_date":     "Beginn",
      "end_date":       "Ende",
      "status":         "Status",
      "cis":            "CIs"
    },
    "status": {
      "active":         "Aktiv",
      "expiring_soon":  "Läuft bald ab",
      "expired":        "Abgelaufen"
    }
  },
  "documents": {
    "title":                  "Dokumentenablage",
    "subtitle":               "Sichere Verwaltung von Unternehmensdokumenten",
    "upload":                 "Dokument hochladen",
    "add_version":            "Neue Version",
    "no_documents":           "Keine Dokumente. Laden Sie das erste hoch.",
    "search_placeholder":     "Nach Titel oder Typ suchen...",
    "doc_title":              "Titel",
    "doc_type":               "Typ",
    "doc_file":               "Datei",
    "doc_size":               "Größe",
    "doc_uploaded_by":        "Hochgeladen von",
    "doc_date":               "Datum",
    "doc_version":            "Version",
    "version_history":        "Versionsverlauf",
    "relations":              "Verwandte Dokumente",
    "associated_cis":         "Zugehörige CIs",
    "associated_contracts":   "Zugehörige Verträge",
    "add_relation":           "Beziehung hinzufügen",
    "relation_type":          "Beziehungstyp",
    "relation_AMENDMENT_OF":  "Zusatz zu",
    "relation_RELATED_TO":    "Verwandt mit",
    "relation_SUPERSEDES":    "Ersetzt",
    "download":               "Herunterladen",
    "delete_confirm":         "Dieses Dokument löschen?",
    "upload_success":         "Dokument erfolgreich hochgeladen",
    "upload_error":           "Fehler beim Hochladen des Dokuments",
    "form_title":             "Dokumententitel",
    "form_description":       "Beschreibung (optional)",
    "form_type":              "Dokumenttyp",
    "form_file":              "Datei",
    "form_associate_cis":     "CIs zuordnen (optional)",
    "form_associate_contracts":"Verträge zuordnen (optional)",
    "filter_title":           "Nach Titel filtern",
    "filter_type":            "Nach Typ filtern",
    "filter_user":            "Nach Benutzer filtern",
    "clear_filters":          "Filter zurücksetzen",
    "preview":                "Vorschau",
    "preview_unavailable":    "Vorschau für diesen Dateityp nicht verfügbar",
    "notes":                  "Notizen",
    "add_note":               "Notiz hinzufügen",
    "no_notes":               "Keine Notizen",
    "note_placeholder":       "Notiz schreiben...",
    "delete_version":         "Version löschen",
    "delete_version_confirm": "Diese Version des Dokuments löschen?",
    "associate_cis":          "CIs hinzufügen",
    "associate_contracts":    "Verträge hinzufügen",
    "associate_documents":    "Dokumente zuordnen",
    "no_cis_to_add":          "Keine CIs zum Hinzufügen verfügbar.",
    "no_contracts_to_add":    "Keine Verträge zum Hinzufügen verfügbar.",
    "no_documents_to_add":    "Keine Dokumente zum Zuordnen verfügbar.",
    "search_cis":             "CI nach Name oder Slug suchen…",
    "search_contracts":       "Vertrag nach Nummer oder Anbieter suchen…",
    "search_documents":       "Dokument nach Titel oder Typ suchen…",
    "associate_selected":     "Auswahl zuordnen"
  },
  "licenses": {
    "title":                "Lizenzrepository",
    "subtitle":             "Lebenszyklusmanagement von Software- und Hardwarelizenzen",
    "add_license":          "Neue Lizenz",
    "no_licenses":          "Keine Lizenzen erfasst.",
    "license_number":       "Lizenz-Nr.",
    "vendor":               "Anbieter",
    "type":                 "Typ",
    "metric":               "Metrik",
    "metric_value":         "Menge",
    "metric_unit":          "Einheit",
    "cost":                 "Kosten",
    "currency":             "Währung",
    "status":               "Status",
    "notes":                "Notizen",
    "start_date":           "Beginn",
    "end_date":             "Ablauf",
    "parent_license":       "Hauptlizenz",
    "addendums":            "Zusätze / Verlängerungen",
    "add_addendum":         "Zusatz hinzufügen",
    "associated_cis":       "Zugehörige CIs",
    "associated_documents": "Zugehörige Dokumente",
    "license_users":        "Lizenznutzer",
    "add_user":             "Benutzer hinzufügen",
    "user_name":            "Name",
    "user_dni":             "Ausweis / ID",
    "user_email":           "E-Mail",
    "no_users":             "Keine Benutzer zugewiesen.",
    "delete_confirm":       "Diese Lizenz und alle zugehörigen Daten löschen?",
    "delete_user_confirm":  "Diesen Benutzer aus der Lizenz entfernen?",
    "associate_cis":        "CIs zuordnen",
    "associate_documents":  "Dokumente zuordnen",
    "no_cis_to_add":        "Keine CIs verfügbar.",
    "no_documents_to_add":  "Keine Dokumente verfügbar.",
    "search_cis":           "CI suchen…",
    "search_documents":     "Dokument suchen…",
    "associate_selected":   "Auswahl zuordnen",
    "form_name":            "Lizenzname",
    "form_number":          "Nummer / Lizenzschlüssel",
    "form_vendor":          "Anbieter (optional)",
    "form_start":           "Startdatum",
    "form_end":             "Ablaufdatum (optional)",
    "form_type":            "Lizenztyp",
    "form_metric":          "Lizenzmetrik",
    "form_metric_value":    "Menge (z.B.: 50)",
    "form_metric_unit":     "Benutzerdefinierte Einheit (optional)",
    "form_cost":            "Kosten",
    "form_currency":        "Währung",
    "form_status":          "Status",
    "form_notes":           "Notizen (optional)",
    "form_parent":          "Hauptlizenz (für Zusätze)",
    "preview":              "Vorschau",
    "download":             "Herunterladen",
    "no_preview":           "Vorschau nicht verfügbar",
    "active":               "Aktiv",
    "expired":              "Abgelaufen",
    "expiring_soon":        "Läuft bald ab"
  },
  "masters": {
    "title":            "Stammdatenverwaltung",
    "subtitle":         "Verwaltung von Stammdaten: Bereiche, Standorte, Hersteller, Modelle, Anbieter",
    "tabs": {
      "support_areas":  "Supportbereiche",
      "branches":       "Standorte",
      "manufacturers":  "Hersteller",
      "models":         "Modelle",
      "providers":      "Anbieter"
    },
    "doc_types":        "Dokumenttypen",
    "license_metrics":  "Lizenzmetriken",
    "license_types":    "Lizenztypen",
    "support_areas": {
      "new":            "Neuer Supportbereich",
      "placeholder":    "z.B.: Zentrum",
      "empty":          "Keine Bereiche erfasst."
    },
    "branches": {
      "new":                 "Neuer Standort",
      "name_placeholder":    "Standortname",
      "code_placeholder":    "Code (3 Stellen, z.B.: BER)",
      "address_placeholder": "Physische Adresse (optional)",
      "support_area_label":  "— Supportbereich —",
      "empty":               "Keine Standorte erfasst.",
      "add":                 "Standort hinzufügen"
    },
    "manufacturers": {
      "new":                "Neuer Hersteller",
      "placeholder":        "z.B.: Dell, HP, Cisco",
      "suggest_popular":    "Beliebte vorschlagen",
      "delete_all":         "Alle löschen",
      "empty":              "Keine Hersteller erfasst.",
      "confirm_delete_all": "30 beliebte IT-Hersteller einfügen? Duplikate werden übersprungen."
    },
    "models": {
      "new":                 "Neues Modell",
      "placeholder":         "z.B.: PowerEdge R740",
      "manufacturer_label":  "— Hersteller —",
      "type_label":          "— Typ —",
      "type_software":       "Software",
      "type_hardware":       "Hardware",
      "suggest_dates":       "Standarddaten vorschlagen",
      "eol_search":          "EOL-Katalog",
      "empty":               "Keine Modelle erfasst.",
      "consult_btn":         "Abfragen",
      "sync_eol":            "EOL",
      "consultation_center": "Lebenszyklusberatungszentrum",
      "suggested_dates":     "Vorgeschlagene Daten"
    },
    "providers": {
      "new":         "Neuer Anbieter",
      "placeholder": "z.B.: Telekom, AWS, Microsoft",
      "empty":       "Keine Anbieter erfasst."
    }
  },
  "settings": {
    "title":    "Einstellungen",
    "subtitle": "Benutzer, Rollen und Systemintegrationen",
    "tabs": {
      "users":        "Benutzerverwaltung",
      "integrations": "Integrationen & System"
    },
    "users": {
      "header":  "Systembenutzer",
      "count":   "{count} Benutzer registriert",
      "columns": {
        "user":   "Benutzer",
        "email":  "E-Mail",
        "origin": "Herkunft",
        "mfa":    "MFA",
        "role":   "Rolle",
        "active": "Aktiv"
      },
      "origin_ldap":        "LDAP",
      "origin_local":       "Lokal",
      "mfa_active":         "Aktiv",
      "mfa_inactive":       "Inaktiv",
      "role_admin":         "ADMIN",
      "role_auditor":       "AUDITOR",
      "role_viewer":        "VIEWER",
      "me_label":           "(ich)",
      "viewer_notice":      "Sie benötigen die Rolle {role} um die Konfiguration zu ändern. Nur-Lese-Modus.",
      "confirm_activate":   "Benutzer \"{name}\" aktivieren?",
      "confirm_deactivate": "Benutzer \"{name}\" deaktivieren?"
    },
    "integrations": {
      "system_status":  "Systemstatus",
      "system_info":    "Systeminformationen",
      "api_status":     "Backend API",
      "api_ok":         "Betriebsbereit",
      "api_fail":       "Antwortet nicht",
      "ldap_title":     "LDAP / Active Directory",
      "ldap_enabled":   "Aktiviert",
      "ldap_disabled":  "Deaktiviert",
      "ldap_help":      "Zum Aktivieren: USE_LDAP=true im Backend.",
      "smtp_title":     "SMTP / Benachrichtigungen",
      "smtp_configured":"Konfiguriert",
      "smtp_schedule":  "Tägliches Benachrichtigungsmodul aktiv. Zeitplan: 08:30 Uhr (Europe/Madrid).",
      "test_email":     "Senden…",
      "sending":        "Senden…"
    }
  },
  "dashboard": {
    "title":              "Dashboard",
    "subtitle":           "Statusübersicht der Infrastruktur",
    "total_cis":          "Gesamt CIs",
    "critical_vulns":     "Kritische Schwachstellen",
    "expiring_contracts": "Ablaufende Verträge",
    "eol_cis":            "CIs ohne Support",
    "cs_coverage":        "CrowdStrike-Abdeckung",
    "agent_ok":           "Aktive Agenten"
  },
  "login": {
    "title":         "Anmelden",
    "subtitle":      "Zugang zu Ihrer CMDB-Plattform",
    "email_label":   "E-Mail-Adresse",
    "password_label":"Passwort",
    "mfa_label":     "MFA-Code (6 Stellen)",
    "submit":        "Anmelden",
    "logging_in":    "Anmelden…",
    "error_invalid": "Ungültige Anmeldedaten",
    "error_mfa":     "Ungültiger MFA-Code"
  },
  "add_ci_modal": {
    "title":              "Neues CI",
    "name_label":         "Name",
    "name_placeholder":   "z.B.: srv-prd-web-01",
    "slug_label":         "Slug",
    "slug_placeholder":   "z.B.: srv-prd-web-01",
    "type_label":         "CI-Typ",
    "env_label":          "Umgebung",
    "crit_label":         "Kritikalität",
    "hardware_section":   "Hardware (optional)",
    "software_section":   "Software (optional)",
    "manufacturer_label": "Hersteller",
    "model_label":        "Modell",
    "serial_label":       "Seriennummer",
    "version_label":      "Version",
    "license_label":      "Lizenztyp",
    "eol_label":          "EoL-Datum",
    "eos_label":          "EoS-Datum",
    "submit":             "CI erstellen",
    "cancel":             "Abbrechen"
  },
  "reports": {
    "title":           "Berichtszentrum",
    "subtitle":        "Berichte der Plattform erstellen und herunterladen",
    "eol_report":      "EoL/EoS-Bericht",
    "contract_report": "Vertragsbericht",
    "security_report": "Sicherheitszusammenfassung",
    "generate":        "Erstellen",
    "download_pdf":    "PDF herunterladen",
    "download_excel":  "Excel herunterladen"
  },
  "audit": {
    "title":    "Audit-Protokolle",
    "subtitle": "Verlauf der Benutzeraktionen",
    "columns": {
      "action": "Aktion",
      "entity": "Entität",
      "user":   "Benutzer",
      "date":   "Datum"
    },
    "no_logs": "Keine Audit-Protokolle."
  },
  "integrations": {
    "title":      "Integrations-Konnektoren",
    "subtitle":   "Greenbone OpenVAS und CrowdStrike Falcon",
    "greenbone":  "Greenbone OpenVAS",
    "crowdstrike":"CrowdStrike Falcon",
    "upload":     "JSON-Bericht hochladen",
    "processing": "Verarbeitung…",
    "success":    "Import abgeschlossen"
  },
  "profile": {
    "title":            "Mein Profil",
    "subtitle":         "Kontoeinstellungen",
    "mfa_section":      "Zwei-Faktor-Authentifizierung (MFA)",
    "mfa_enable":       "MFA aktivieren",
    "mfa_disable":      "MFA deaktivieren",
    "mfa_setup":        "Scannen Sie den QR-Code mit Ihrer Authenticator-App",
    "change_password":  "Passwort ändern",
    "current_password": "Aktuelles Passwort",
    "new_password":     "Neues Passwort",
    "save":             "Änderungen speichern",
    "language_section": "Spracheinstellung",
    "language_label":   "Schnittstellensprache",
    "language_saved":   "Sprache gespeichert"
  }
}
```

- [ ] **Step 2: Verify file was created**

Run:
```bash
node -e "const j=require('./frontend/locales/de.json'); console.log(Object.keys(j).join(', '))"
```
Expected: `brand, footer, sidebar, actions, common, inventory, vulnerabilities, contracts, documents, licenses, masters, settings, dashboard, login, add_ci_modal, reports, audit, integrations, profile`

---

## Task 2 — Create pt.json (Portuguese)

**Files:**
- Create: `frontend/locales/pt.json`

- [ ] **Step 1: Write pt.json**

```json
{
  "brand": {
    "name":    "CMDB",
    "tagline": "Enterprise Platform"
  },
  "footer": {
    "copyright": "© {year} CMDB Platform v1.0"
  },
  "sidebar": {
    "dashboard":       "Dashboard",
    "inventory":       "Inventário de CIs",
    "vulnerabilities": "Vulnerabilidades",
    "map":             "Mapa de Dependências",
    "integrations":    "Conectores",
    "reports":         "Relatórios",
    "contracts":       "Contratos e Adendos",
    "documents":       "Repositório Documental",
    "licenses":        "Licenças",
    "entities":        "Entidades",
    "profile":         "Meu Perfil",
    "masters":         "Dados Mestres",
    "certificates":    "Certificados SSL",
    "audit":           "Auditoria",
    "settings":        "Configurações"
  },
  "actions": {
    "logout":           "Sair",
    "refresh":          "Atualizar",
    "add":              "Adicionar",
    "save":             "Guardar",
    "cancel":           "Cancelar",
    "delete":           "Eliminar",
    "edit":             "Editar",
    "export_csv":       "Exportar CSV",
    "generate_pdf":     "Gerar PDF",
    "retry":            "Tentar novamente",
    "search":           "Pesquisar",
    "import":           "Importar",
    "download_template":"Modelo CSV",
    "sync":             "Sincronizar",
    "send_test_email":  "Enviar E-mail de Teste",
    "test":             "Testar"
  },
  "common": {
    "loading":          "A carregar…",
    "loading_data":     "A carregar dados…",
    "no_data":          "Sem dados",
    "no_results":       "Sem resultados",
    "error":            "Erro",
    "unknown_error":    "Erro desconhecido",
    "confirm_delete":   "Eliminar este registo?",
    "admin_only":       "Apenas ADMIN",
    "required":         "Obrigatório",
    "optional":         "Opcional",
    "yes":              "Sim",
    "no":               "Não",
    "ok":               "OK",
    "close":            "Fechar",
    "name":             "Nome",
    "email":            "E-mail",
    "status":           "Estado",
    "date":             "Data",
    "created_at":       "Criado",
    "updated_at":       "Atualizado",
    "actions":          "Ações"
  },
  "inventory": {
    "title":            "Inventário de CIs",
    "subtitle":         "Gestão do parque tecnológico",
    "search_placeholder":"Pesquisar por nome…",
    "total":            "{count} ativos geridos",
    "add_ci":           "Novo CI",
    "import_csv":       "Importar CSV",
    "download_template":"Modelo CSV",
    "export_csv":       "Exportar CSV",
    "no_cis":           "Sem CIs no inventário.",
    "loading":          "A carregar inventário…",
    "import_success":   "{success} CIs importados com sucesso, {errors} erros",
    "columns": {
      "ci":             "CI / Ativo",
      "type":           "Tipo",
      "environment":    "Ambiente",
      "criticality":    "Criticidade",
      "hardware":       "Hardware",
      "software":       "Software",
      "eol":            "EoL / EoS",
      "vulnerabilities":"Vulnerabilidades",
      "agent":          "Agente CS",
      "support":        "Suporte"
    },
    "support_badge": {
      "expired":        "Sem suporte",
      "warning":        "EoL em {days}d",
      "ok":             "Ativo"
    },
    "vuln_badge": {
      "no_data":        "Sem dados",
      "clean":          "Limpo",
      "all_resolved":   "Tudo resolvido",
      "open_one":       "{count} aberto",
      "open_many":      "{count} abertos"
    },
    "agent_badge": {
      "no_agent":       "Sem agente",
      "protected":      "Protegido",
      "reduced":        "Reduzido",
      "detection_one":  "{count} deteção",
      "detection_many": "{count} deteções"
    },
    "ci_types": {
      "PHYSICAL_SERVER": "Servidor Físico",
      "VIRTUAL_SERVER":  "Servidor Virtual",
      "DATABASE":        "Base de Dados",
      "NETWORK":         "Rede",
      "STORAGE":         "Armazenamento",
      "BACKUP":          "Backup",
      "HARDWARE":        "Hardware",
      "SOFTWARE":        "Software",
      "OTHER":           "Outro",
      "DESKTOP":         "Desktop",
      "LAPTOP":          "Portátil",
      "PRINTER":         "Impressora",
      "SCANNER":         "Scanner",
      "MONITOR":         "Monitor",
      "VIDEOCONFERENCE": "Videoconferência",
      "SMART_DISPLAY":   "Ecrã Inteligente",
      "TIME_CLOCK":      "Relógio de Ponto",
      "IP_PHONE":        "Telefone IP",
      "SMARTPHONE":      "Smartphone",
      "TABLET":          "Tablet",
      "PDA":             "PDA",
      "BARCODE_SCANNER": "Leitor de Código",
      "IP_CAMERA":       "Câmara IP",
      "UPS":             "UPS / SAI",
      "WIFI_AP":         "Ponto de Acesso Wi-Fi",
      "CLOUD_INSTANCE":  "Instância Cloud",
      "CLOUD_STORAGE":   "Armazenamento Cloud",
      "BASE_SOFTWARE":   "Software Base",
      "LICENSE":         "Licença"
    }
  },
  "vulnerabilities": {
    "title":            "Vulnerabilidades",
    "subtitle":         "Gestão de CVEs e riscos de segurança",
    "no_vulns":         "Sem vulnerabilidades registadas.",
    "columns": {
      "ci":             "CI / Servidor",
      "cve":            "CVE",
      "severity":       "Severidade",
      "status":         "Estado",
      "description":    "Descrição",
      "source":         "Fonte",
      "score":          "Pontuação CVSS"
    },
    "status": {
      "NUEVO":          "Novo",
      "ASIGNADO":       "Atribuído",
      "EN_CURSO":       "Em curso",
      "PARADO":         "Parado",
      "RESUELTO":       "Resolvido"
    }
  },
  "contracts": {
    "title":            "Contratos e Adendos",
    "subtitle":         "Gestão de contratos com fornecedores",
    "no_contracts":     "Sem contratos registados.",
    "add_contract":     "Novo Contrato",
    "export_csv":       "Exportar CSV",
    "columns": {
      "number":         "Nº Contrato",
      "vendor":         "Fornecedor",
      "start_date":     "Início",
      "end_date":       "Fim",
      "status":         "Estado",
      "cis":            "CIs"
    },
    "status": {
      "active":         "Vigente",
      "expiring_soon":  "A vencer",
      "expired":        "Vencido"
    }
  },
  "documents": {
    "title":                  "Repositório Documental",
    "subtitle":               "Gestão segura de documentos corporativos",
    "upload":                 "Carregar Documento",
    "add_version":            "Nova Versão",
    "no_documents":           "Sem documentos. Carregue o primeiro.",
    "search_placeholder":     "Pesquisar por título ou tipo...",
    "doc_title":              "Título",
    "doc_type":               "Tipo",
    "doc_file":               "Ficheiro",
    "doc_size":               "Tamanho",
    "doc_uploaded_by":        "Carregado por",
    "doc_date":               "Data",
    "doc_version":            "Versão",
    "version_history":        "Histórico de versões",
    "relations":              "Documentos relacionados",
    "associated_cis":         "CIs associados",
    "associated_contracts":   "Contratos associados",
    "add_relation":           "Adicionar relação",
    "relation_type":          "Tipo de relação",
    "relation_AMENDMENT_OF":  "Adendo de",
    "relation_RELATED_TO":    "Relacionado com",
    "relation_SUPERSEDES":    "Substitui",
    "download":               "Descarregar",
    "delete_confirm":         "Eliminar este documento?",
    "upload_success":         "Documento carregado com sucesso",
    "upload_error":           "Erro ao carregar o documento",
    "form_title":             "Título do documento",
    "form_description":       "Descrição (opcional)",
    "form_type":              "Tipo de documento",
    "form_file":              "Ficheiro",
    "form_associate_cis":     "Associar CIs (opcional)",
    "form_associate_contracts":"Associar contratos (opcional)",
    "filter_title":           "Filtrar por título",
    "filter_type":            "Filtrar por tipo",
    "filter_user":            "Filtrar por utilizador",
    "clear_filters":          "Limpar filtros",
    "preview":                "Pré-visualização",
    "preview_unavailable":    "Pré-visualização não disponível para este tipo de ficheiro",
    "notes":                  "Notas",
    "add_note":               "Adicionar nota",
    "no_notes":               "Sem notas",
    "note_placeholder":       "Escreva uma nota...",
    "delete_version":         "Eliminar versão",
    "delete_version_confirm": "Eliminar esta versão do documento?",
    "associate_cis":          "Adicionar CIs",
    "associate_contracts":    "Adicionar Contratos",
    "associate_documents":    "Associar Documentos",
    "no_cis_to_add":          "Sem CIs disponíveis para adicionar.",
    "no_contracts_to_add":    "Sem contratos disponíveis para adicionar.",
    "no_documents_to_add":    "Sem documentos disponíveis para associar.",
    "search_cis":             "Pesquisar CI por nome ou slug…",
    "search_contracts":       "Pesquisar contrato por número ou fornecedor…",
    "search_documents":       "Pesquisar documento por título ou tipo…",
    "associate_selected":     "Associar selecionados"
  },
  "licenses": {
    "title":                "Repositório de Licenças",
    "subtitle":             "Gestão do ciclo de vida de licenças de software e hardware",
    "add_license":          "Nova Licença",
    "no_licenses":          "Sem licenças registadas.",
    "license_number":       "Nº Licença",
    "vendor":               "Fornecedor",
    "type":                 "Tipo",
    "metric":               "Métrica",
    "metric_value":         "Quantidade",
    "metric_unit":          "Unidade",
    "cost":                 "Custo",
    "currency":             "Moeda",
    "status":               "Estado",
    "notes":                "Notas",
    "start_date":           "Início",
    "end_date":             "Vencimento",
    "parent_license":       "Licença Principal",
    "addendums":            "Adendos / Renovações",
    "add_addendum":         "Adicionar Adendo",
    "associated_cis":       "CIs associados",
    "associated_documents": "Documentos associados",
    "license_users":        "Utilizadores da Licença",
    "add_user":             "Adicionar Utilizador",
    "user_name":            "Nome",
    "user_dni":             "BI / ID",
    "user_email":           "E-mail",
    "no_users":             "Sem utilizadores atribuídos.",
    "delete_confirm":       "Eliminar esta licença e todos os seus dados?",
    "delete_user_confirm":  "Remover este utilizador da licença?",
    "associate_cis":        "Associar CIs",
    "associate_documents":  "Associar Documentos",
    "no_cis_to_add":        "Sem CIs disponíveis.",
    "no_documents_to_add":  "Sem documentos disponíveis.",
    "search_cis":           "Pesquisar CI…",
    "search_documents":     "Pesquisar documento…",
    "associate_selected":   "Associar selecionados",
    "form_name":            "Nome da licença",
    "form_number":          "Número / chave de licença",
    "form_vendor":          "Fornecedor (opcional)",
    "form_start":           "Data de início",
    "form_end":             "Data de vencimento (opcional)",
    "form_type":            "Tipo de licença",
    "form_metric":          "Métrica de licença",
    "form_metric_value":    "Quantidade (ex: 50)",
    "form_metric_unit":     "Unidade personalizada (opcional)",
    "form_cost":            "Custo",
    "form_currency":        "Moeda",
    "form_status":          "Estado",
    "form_notes":           "Notas (opcional)",
    "form_parent":          "Licença principal (para adendos)",
    "preview":              "Pré-visualização",
    "download":             "Descarregar",
    "no_preview":           "Pré-visualização não disponível",
    "active":               "Ativo",
    "expired":              "Vencido",
    "expiring_soon":        "Vence em breve"
  },
  "masters": {
    "title":            "Administração de Dados Mestres",
    "subtitle":         "Gestão de tabelas mestras: Áreas, Sedes, Fabricantes, Modelos, Fornecedores",
    "tabs": {
      "support_areas":  "Áreas de Suporte",
      "branches":       "Sedes",
      "manufacturers":  "Fabricantes",
      "models":         "Modelos",
      "providers":      "Fornecedores"
    },
    "doc_types":        "Tipos de Documento",
    "license_metrics":  "Métricas de Licença",
    "license_types":    "Tipos de Licença",
    "support_areas": {
      "new":            "Nova Área de Suporte",
      "placeholder":    "Ex: Zona Centro",
      "empty":          "Sem áreas registadas."
    },
    "branches": {
      "new":                 "Nova Sede",
      "name_placeholder":    "Nome da sede",
      "code_placeholder":    "Código (3 dígitos, ex: LIS)",
      "address_placeholder": "Endereço físico (opcional)",
      "support_area_label":  "— Área de suporte —",
      "empty":               "Sem sedes registadas.",
      "add":                 "Adicionar Sede"
    },
    "manufacturers": {
      "new":                "Novo Fabricante",
      "placeholder":        "Ex: Dell, HP, Cisco",
      "suggest_popular":    "Sugerir Populares",
      "delete_all":         "Eliminar tudo",
      "empty":              "Sem fabricantes registados.",
      "confirm_delete_all": "Inserir 30 fabricantes de TI populares? Os duplicados serão ignorados."
    },
    "models": {
      "new":                 "Novo Modelo",
      "placeholder":         "Ex: PowerEdge R740",
      "manufacturer_label":  "— Fabricante —",
      "type_label":          "— Tipo —",
      "type_software":       "Software",
      "type_hardware":       "Hardware",
      "suggest_dates":       "Sugerir Datas Padrão",
      "eol_search":          "Catálogo EOL",
      "empty":               "Sem modelos registados.",
      "consult_btn":         "Consultar",
      "sync_eol":            "EOL",
      "consultation_center": "Centro de Consulta do Ciclo de Vida",
      "suggested_dates":     "Datas Sugeridas"
    },
    "providers": {
      "new":         "Novo Fornecedor",
      "placeholder": "Ex: NOS, AWS, Microsoft",
      "empty":       "Sem fornecedores registados."
    }
  },
  "settings": {
    "title":    "Configurações",
    "subtitle": "Utilizadores, funções e integrações do sistema",
    "tabs": {
      "users":        "Gestão de Utilizadores",
      "integrations": "Integrações e Sistema"
    },
    "users": {
      "header":  "Utilizadores do sistema",
      "count":   "{count} utilizador(es) registado(s)",
      "columns": {
        "user":   "Utilizador",
        "email":  "E-mail",
        "origin": "Origem",
        "mfa":    "MFA",
        "role":   "Função",
        "active": "Ativo"
      },
      "origin_ldap":        "LDAP",
      "origin_local":       "Local",
      "mfa_active":         "Ativo",
      "mfa_inactive":       "Inativo",
      "role_admin":         "ADMIN",
      "role_auditor":       "AUDITOR",
      "role_viewer":        "VIEWER",
      "me_label":           "(eu)",
      "viewer_notice":      "Necessita da função {role} para modificar a configuração. Modo só de leitura.",
      "confirm_activate":   "Ativar o utilizador \"{name}\"?",
      "confirm_deactivate": "Desativar o utilizador \"{name}\"?"
    },
    "integrations": {
      "system_status":  "Estado do Sistema",
      "system_info":    "Informações do Sistema",
      "api_status":     "Backend API",
      "api_ok":         "Operacional",
      "api_fail":       "Sem resposta",
      "ldap_title":     "LDAP / Active Directory",
      "ldap_enabled":   "Ativado",
      "ldap_disabled":  "Desativado",
      "ldap_help":      "Para ativar: USE_LDAP=true no backend.",
      "smtp_title":     "SMTP / Alertas",
      "smtp_configured":"Configurado",
      "smtp_schedule":  "Motor de alertas diárias ativo. Horário: 08:30 (Europe/Madrid).",
      "test_email":     "A enviar…",
      "sending":        "A enviar…"
    }
  },
  "dashboard": {
    "title":              "Dashboard",
    "subtitle":           "Resumo do estado da infraestrutura",
    "total_cis":          "Total de CIs",
    "critical_vulns":     "Vulnerabilidades Críticas",
    "expiring_contracts": "Contratos a vencer",
    "eol_cis":            "CIs sem suporte",
    "cs_coverage":        "Cobertura CrowdStrike",
    "agent_ok":           "Agentes ativos"
  },
  "login": {
    "title":         "Iniciar sessão",
    "subtitle":      "Aceda à sua plataforma CMDB",
    "email_label":   "Endereço de e-mail",
    "password_label":"Palavra-passe",
    "mfa_label":     "Código MFA (6 dígitos)",
    "submit":        "Iniciar sessão",
    "logging_in":    "A entrar…",
    "error_invalid": "Credenciais inválidas",
    "error_mfa":     "Código MFA inválido"
  },
  "add_ci_modal": {
    "title":              "Novo CI",
    "name_label":         "Nome",
    "name_placeholder":   "Ex: srv-prd-web-01",
    "slug_label":         "Slug",
    "slug_placeholder":   "Ex: srv-prd-web-01",
    "type_label":         "Tipo de CI",
    "env_label":          "Ambiente",
    "crit_label":         "Criticidade",
    "hardware_section":   "Hardware (opcional)",
    "software_section":   "Software (opcional)",
    "manufacturer_label": "Fabricante",
    "model_label":        "Modelo",
    "serial_label":       "Nº de Série",
    "version_label":      "Versão",
    "license_label":      "Tipo de Licença",
    "eol_label":          "Data EoL",
    "eos_label":          "Data EoS",
    "submit":             "Criar CI",
    "cancel":             "Cancelar"
  },
  "reports": {
    "title":           "Centro de Relatórios",
    "subtitle":        "Gere e descarregue relatórios da plataforma",
    "eol_report":      "Relatório EoL/EoS",
    "contract_report": "Relatório de Contratos",
    "security_report": "Relatório Executivo de Segurança",
    "generate":        "Gerar",
    "download_pdf":    "Descarregar PDF",
    "download_excel":  "Descarregar Excel"
  },
  "audit": {
    "title":    "Registos de Auditoria",
    "subtitle": "Histórico de ações dos utilizadores",
    "columns": {
      "action": "Ação",
      "entity": "Entidade",
      "user":   "Utilizador",
      "date":   "Data"
    },
    "no_logs": "Sem registos de auditoria."
  },
  "integrations": {
    "title":      "Conectores de Integração",
    "subtitle":   "Greenbone OpenVAS e CrowdStrike Falcon",
    "greenbone":  "Greenbone OpenVAS",
    "crowdstrike":"CrowdStrike Falcon",
    "upload":     "Carregar relatório JSON",
    "processing": "A processar…",
    "success":    "Importação concluída"
  },
  "profile": {
    "title":            "Meu Perfil",
    "subtitle":         "Configuração da sua conta",
    "mfa_section":      "Autenticação de Dois Fatores (MFA)",
    "mfa_enable":       "Ativar MFA",
    "mfa_disable":      "Desativar MFA",
    "mfa_setup":        "Digitalize o código QR com a sua app de autenticação",
    "change_password":  "Alterar palavra-passe",
    "current_password": "Palavra-passe atual",
    "new_password":     "Nova palavra-passe",
    "save":             "Guardar alterações",
    "language_section": "Preferência de idioma",
    "language_label":   "Idioma da interface",
    "language_saved":   "Idioma guardado"
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "const j=require('./frontend/locales/pt.json'); console.log(Object.keys(j).join(', '))"
```
Expected: same 19 top-level keys as de.json.

---

## Task 3 — Create fr.json (French)

**Files:**
- Create: `frontend/locales/fr.json`

- [ ] **Step 1: Write fr.json**

```json
{
  "brand": {
    "name":    "CMDB",
    "tagline": "Enterprise Platform"
  },
  "footer": {
    "copyright": "© {year} CMDB Platform v1.0"
  },
  "sidebar": {
    "dashboard":       "Tableau de bord",
    "inventory":       "Inventaire des CI",
    "vulnerabilities": "Vulnérabilités",
    "map":             "Carte des dépendances",
    "integrations":    "Connecteurs",
    "reports":         "Rapports",
    "contracts":       "Contrats et avenants",
    "documents":       "Dépôt documentaire",
    "licenses":        "Licences",
    "entities":        "Entités",
    "profile":         "Mon profil",
    "masters":         "Données de référence",
    "certificates":    "Certificats SSL",
    "audit":           "Audit",
    "settings":        "Paramètres"
  },
  "actions": {
    "logout":           "Se déconnecter",
    "refresh":          "Actualiser",
    "add":              "Ajouter",
    "save":             "Enregistrer",
    "cancel":           "Annuler",
    "delete":           "Supprimer",
    "edit":             "Modifier",
    "export_csv":       "Exporter CSV",
    "generate_pdf":     "Générer PDF",
    "retry":            "Réessayer",
    "search":           "Rechercher",
    "import":           "Importer",
    "download_template":"Modèle CSV",
    "sync":             "Synchroniser",
    "send_test_email":  "Envoyer un e-mail test",
    "test":             "Tester"
  },
  "common": {
    "loading":          "Chargement…",
    "loading_data":     "Chargement des données…",
    "no_data":          "Aucune donnée",
    "no_results":       "Aucun résultat",
    "error":            "Erreur",
    "unknown_error":    "Erreur inconnue",
    "confirm_delete":   "Supprimer cet enregistrement ?",
    "admin_only":       "ADMIN uniquement",
    "required":         "Obligatoire",
    "optional":         "Optionnel",
    "yes":              "Oui",
    "no":               "Non",
    "ok":               "OK",
    "close":            "Fermer",
    "name":             "Nom",
    "email":            "E-mail",
    "status":           "Statut",
    "date":             "Date",
    "created_at":       "Créé",
    "updated_at":       "Mis à jour",
    "actions":          "Actions"
  },
  "inventory": {
    "title":            "Inventaire des CI",
    "subtitle":         "Gestion du parc technologique",
    "search_placeholder":"Rechercher par nom…",
    "total":            "{count} actifs gérés",
    "add_ci":           "Nouveau CI",
    "import_csv":       "Importer CSV",
    "download_template":"Modèle CSV",
    "export_csv":       "Exporter CSV",
    "no_cis":           "Aucun CI dans l'inventaire.",
    "loading":          "Chargement de l'inventaire…",
    "import_success":   "{success} CI importés avec succès, {errors} erreurs",
    "columns": {
      "ci":             "CI / Actif",
      "type":           "Type",
      "environment":    "Environnement",
      "criticality":    "Criticité",
      "hardware":       "Matériel",
      "software":       "Logiciel",
      "eol":            "EoL / EoS",
      "vulnerabilities":"Vulnérabilités",
      "agent":          "Agent CS",
      "support":        "Support"
    },
    "support_badge": {
      "expired":        "Sans support",
      "warning":        "EoL dans {days}j",
      "ok":             "Actif"
    },
    "vuln_badge": {
      "no_data":        "Aucune donnée",
      "clean":          "Propre",
      "all_resolved":   "Tout résolu",
      "open_one":       "{count} ouvert",
      "open_many":      "{count} ouverts"
    },
    "agent_badge": {
      "no_agent":       "Sans agent",
      "protected":      "Protégé",
      "reduced":        "Réduit",
      "detection_one":  "{count} détection",
      "detection_many": "{count} détections"
    },
    "ci_types": {
      "PHYSICAL_SERVER": "Serveur physique",
      "VIRTUAL_SERVER":  "Serveur virtuel",
      "DATABASE":        "Base de données",
      "NETWORK":         "Réseau",
      "STORAGE":         "Stockage",
      "BACKUP":          "Sauvegarde",
      "HARDWARE":        "Matériel",
      "SOFTWARE":        "Logiciel",
      "OTHER":           "Autre",
      "DESKTOP":         "Bureau",
      "LAPTOP":          "Ordinateur portable",
      "PRINTER":         "Imprimante",
      "SCANNER":         "Scanner",
      "MONITOR":         "Moniteur",
      "VIDEOCONFERENCE": "Visioconférence",
      "SMART_DISPLAY":   "Écran intelligent",
      "TIME_CLOCK":      "Pointeuse",
      "IP_PHONE":        "Téléphone IP",
      "SMARTPHONE":      "Smartphone",
      "TABLET":          "Tablette",
      "PDA":             "PDA",
      "BARCODE_SCANNER": "Lecteur de code",
      "IP_CAMERA":       "Caméra IP",
      "UPS":             "Onduleur / UPS",
      "WIFI_AP":         "Point d'accès Wi-Fi",
      "CLOUD_INSTANCE":  "Instance cloud",
      "CLOUD_STORAGE":   "Stockage cloud",
      "BASE_SOFTWARE":   "Logiciel de base",
      "LICENSE":         "Licence"
    }
  },
  "vulnerabilities": {
    "title":            "Vulnérabilités",
    "subtitle":         "Gestion des CVE et des risques de sécurité",
    "no_vulns":         "Aucune vulnérabilité enregistrée.",
    "columns": {
      "ci":             "CI / Serveur",
      "cve":            "CVE",
      "severity":       "Gravité",
      "status":         "Statut",
      "description":    "Description",
      "source":         "Source",
      "score":          "Score CVSS"
    },
    "status": {
      "NUEVO":          "Nouveau",
      "ASIGNADO":       "Assigné",
      "EN_CURSO":       "En cours",
      "PARADO":         "Arrêté",
      "RESUELTO":       "Résolu"
    }
  },
  "contracts": {
    "title":            "Contrats et avenants",
    "subtitle":         "Gestion des contrats fournisseurs",
    "no_contracts":     "Aucun contrat enregistré.",
    "add_contract":     "Nouveau contrat",
    "export_csv":       "Exporter CSV",
    "columns": {
      "number":         "N° Contrat",
      "vendor":         "Fournisseur",
      "start_date":     "Début",
      "end_date":       "Fin",
      "status":         "Statut",
      "cis":            "CI"
    },
    "status": {
      "active":         "Actif",
      "expiring_soon":  "Expire bientôt",
      "expired":        "Expiré"
    }
  },
  "documents": {
    "title":                  "Dépôt documentaire",
    "subtitle":               "Gestion sécurisée des documents d'entreprise",
    "upload":                 "Téléverser un document",
    "add_version":            "Nouvelle version",
    "no_documents":           "Aucun document. Téléversez le premier.",
    "search_placeholder":     "Rechercher par titre ou type...",
    "doc_title":              "Titre",
    "doc_type":               "Type",
    "doc_file":               "Fichier",
    "doc_size":               "Taille",
    "doc_uploaded_by":        "Téléversé par",
    "doc_date":               "Date",
    "doc_version":            "Version",
    "version_history":        "Historique des versions",
    "relations":              "Documents associés",
    "associated_cis":         "CI associés",
    "associated_contracts":   "Contrats associés",
    "add_relation":           "Ajouter une relation",
    "relation_type":          "Type de relation",
    "relation_AMENDMENT_OF":  "Avenant de",
    "relation_RELATED_TO":    "Lié à",
    "relation_SUPERSEDES":    "Remplace",
    "download":               "Télécharger",
    "delete_confirm":         "Supprimer ce document ?",
    "upload_success":         "Document téléversé avec succès",
    "upload_error":           "Erreur lors du téléversement",
    "form_title":             "Titre du document",
    "form_description":       "Description (optionnel)",
    "form_type":              "Type de document",
    "form_file":              "Fichier",
    "form_associate_cis":     "Associer des CI (optionnel)",
    "form_associate_contracts":"Associer des contrats (optionnel)",
    "filter_title":           "Filtrer par titre",
    "filter_type":            "Filtrer par type",
    "filter_user":            "Filtrer par utilisateur",
    "clear_filters":          "Réinitialiser les filtres",
    "preview":                "Aperçu",
    "preview_unavailable":    "Aperçu non disponible pour ce type de fichier",
    "notes":                  "Notes",
    "add_note":               "Ajouter une note",
    "no_notes":               "Aucune note",
    "note_placeholder":       "Écrire une note...",
    "delete_version":         "Supprimer la version",
    "delete_version_confirm": "Supprimer cette version du document ?",
    "associate_cis":          "Ajouter des CI",
    "associate_contracts":    "Ajouter des contrats",
    "associate_documents":    "Associer des documents",
    "no_cis_to_add":          "Aucun CI disponible à ajouter.",
    "no_contracts_to_add":    "Aucun contrat disponible à ajouter.",
    "no_documents_to_add":    "Aucun document disponible à associer.",
    "search_cis":             "Rechercher un CI par nom ou slug…",
    "search_contracts":       "Rechercher un contrat par numéro ou fournisseur…",
    "search_documents":       "Rechercher un document par titre ou type…",
    "associate_selected":     "Associer la sélection"
  },
  "licenses": {
    "title":                "Référentiel de licences",
    "subtitle":             "Gestion du cycle de vie des licences logicielles et matérielles",
    "add_license":          "Nouvelle licence",
    "no_licenses":          "Aucune licence enregistrée.",
    "license_number":       "N° Licence",
    "vendor":               "Fournisseur",
    "type":                 "Type",
    "metric":               "Métrique",
    "metric_value":         "Quantité",
    "metric_unit":          "Unité",
    "cost":                 "Coût",
    "currency":             "Devise",
    "status":               "Statut",
    "notes":                "Notes",
    "start_date":           "Début",
    "end_date":             "Expiration",
    "parent_license":       "Licence principale",
    "addendums":            "Avenants / Renouvellements",
    "add_addendum":         "Ajouter un avenant",
    "associated_cis":       "CI associés",
    "associated_documents": "Documents associés",
    "license_users":        "Utilisateurs de la licence",
    "add_user":             "Ajouter un utilisateur",
    "user_name":            "Nom",
    "user_dni":             "Pièce d'identité",
    "user_email":           "E-mail",
    "no_users":             "Aucun utilisateur assigné.",
    "delete_confirm":       "Supprimer cette licence et toutes ses données ?",
    "delete_user_confirm":  "Retirer cet utilisateur de la licence ?",
    "associate_cis":        "Associer des CI",
    "associate_documents":  "Associer des documents",
    "no_cis_to_add":        "Aucun CI disponible.",
    "no_documents_to_add":  "Aucun document disponible.",
    "search_cis":           "Rechercher un CI…",
    "search_documents":     "Rechercher un document…",
    "associate_selected":   "Associer la sélection",
    "form_name":            "Nom de la licence",
    "form_number":          "Numéro / clé de licence",
    "form_vendor":          "Fournisseur (optionnel)",
    "form_start":           "Date de début",
    "form_end":             "Date d'expiration (optionnel)",
    "form_type":            "Type de licence",
    "form_metric":          "Métrique de licence",
    "form_metric_value":    "Quantité (ex : 50)",
    "form_metric_unit":     "Unité personnalisée (optionnel)",
    "form_cost":            "Coût",
    "form_currency":        "Devise",
    "form_status":          "Statut",
    "form_notes":           "Notes (optionnel)",
    "form_parent":          "Licence principale (pour avenants)",
    "preview":              "Aperçu",
    "download":             "Télécharger",
    "no_preview":           "Aperçu non disponible",
    "active":               "Actif",
    "expired":              "Expiré",
    "expiring_soon":        "Expire bientôt"
  },
  "masters": {
    "title":            "Administration des données de référence",
    "subtitle":         "Gestion des tables de référence : Zones, Sites, Fabricants, Modèles, Fournisseurs",
    "tabs": {
      "support_areas":  "Zones de support",
      "branches":       "Sites",
      "manufacturers":  "Fabricants",
      "models":         "Modèles",
      "providers":      "Fournisseurs"
    },
    "doc_types":        "Types de document",
    "license_metrics":  "Métriques de licence",
    "license_types":    "Types de licence",
    "support_areas": {
      "new":            "Nouvelle zone de support",
      "placeholder":    "Ex : Zone Centre",
      "empty":          "Aucune zone enregistrée."
    },
    "branches": {
      "new":                 "Nouveau site",
      "name_placeholder":    "Nom du site",
      "code_placeholder":    "Code (3 chiffres, ex : PAR)",
      "address_placeholder": "Adresse physique (optionnel)",
      "support_area_label":  "— Zone de support —",
      "empty":               "Aucun site enregistré.",
      "add":                 "Ajouter un site"
    },
    "manufacturers": {
      "new":                "Nouveau fabricant",
      "placeholder":        "Ex : Dell, HP, Cisco",
      "suggest_popular":    "Suggérer les populaires",
      "delete_all":         "Tout supprimer",
      "empty":              "Aucun fabricant enregistré.",
      "confirm_delete_all": "Insérer 30 fabricants IT populaires ? Les doublons seront ignorés."
    },
    "models": {
      "new":                 "Nouveau modèle",
      "placeholder":         "Ex : PowerEdge R740",
      "manufacturer_label":  "— Fabricant —",
      "type_label":          "— Type —",
      "type_software":       "Logiciel",
      "type_hardware":       "Matériel",
      "suggest_dates":       "Suggérer des dates standard",
      "eol_search":          "Catalogue EOL",
      "empty":               "Aucun modèle enregistré.",
      "consult_btn":         "Consulter",
      "sync_eol":            "EOL",
      "consultation_center": "Centre de consultation du cycle de vie",
      "suggested_dates":     "Dates suggérées"
    },
    "providers": {
      "new":         "Nouveau fournisseur",
      "placeholder": "Ex : Orange, AWS, Microsoft",
      "empty":       "Aucun fournisseur enregistré."
    }
  },
  "settings": {
    "title":    "Paramètres",
    "subtitle": "Utilisateurs, rôles et intégrations système",
    "tabs": {
      "users":        "Gestion des utilisateurs",
      "integrations": "Intégrations et système"
    },
    "users": {
      "header":  "Utilisateurs du système",
      "count":   "{count} utilisateur(s) enregistré(s)",
      "columns": {
        "user":   "Utilisateur",
        "email":  "E-mail",
        "origin": "Origine",
        "mfa":    "MFA",
        "role":   "Rôle",
        "active": "Actif"
      },
      "origin_ldap":        "LDAP",
      "origin_local":       "Local",
      "mfa_active":         "Actif",
      "mfa_inactive":       "Inactif",
      "role_admin":         "ADMIN",
      "role_auditor":       "AUDITOR",
      "role_viewer":        "VIEWER",
      "me_label":           "(moi)",
      "viewer_notice":      "Vous avez besoin du rôle {role} pour modifier la configuration. Mode lecture seule.",
      "confirm_activate":   "Activer l'utilisateur \"{name}\" ?",
      "confirm_deactivate": "Désactiver l'utilisateur \"{name}\" ?"
    },
    "integrations": {
      "system_status":  "État du système",
      "system_info":    "Informations système",
      "api_status":     "API backend",
      "api_ok":         "Opérationnel",
      "api_fail":       "Ne répond pas",
      "ldap_title":     "LDAP / Active Directory",
      "ldap_enabled":   "Activé",
      "ldap_disabled":  "Désactivé",
      "ldap_help":      "Pour activer : USE_LDAP=true dans le backend.",
      "smtp_title":     "SMTP / Alertes",
      "smtp_configured":"Configuré",
      "smtp_schedule":  "Moteur d'alertes quotidiennes actif. Horaire : 08h30 (Europe/Madrid).",
      "test_email":     "Envoi…",
      "sending":        "Envoi…"
    }
  },
  "dashboard": {
    "title":              "Tableau de bord",
    "subtitle":           "Résumé de l'état de l'infrastructure",
    "total_cis":          "Total CI",
    "critical_vulns":     "Vulnérabilités critiques",
    "expiring_contracts": "Contrats expirant bientôt",
    "eol_cis":            "CI sans support",
    "cs_coverage":        "Couverture CrowdStrike",
    "agent_ok":           "Agents actifs"
  },
  "login": {
    "title":         "Connexion",
    "subtitle":      "Accédez à votre plateforme CMDB",
    "email_label":   "Adresse e-mail",
    "password_label":"Mot de passe",
    "mfa_label":     "Code MFA (6 chiffres)",
    "submit":        "Se connecter",
    "logging_in":    "Connexion…",
    "error_invalid": "Identifiants invalides",
    "error_mfa":     "Code MFA invalide"
  },
  "add_ci_modal": {
    "title":              "Nouveau CI",
    "name_label":         "Nom",
    "name_placeholder":   "Ex : srv-prd-web-01",
    "slug_label":         "Slug",
    "slug_placeholder":   "Ex : srv-prd-web-01",
    "type_label":         "Type de CI",
    "env_label":          "Environnement",
    "crit_label":         "Criticité",
    "hardware_section":   "Matériel (optionnel)",
    "software_section":   "Logiciel (optionnel)",
    "manufacturer_label": "Fabricant",
    "model_label":        "Modèle",
    "serial_label":       "N° de série",
    "version_label":      "Version",
    "license_label":      "Type de licence",
    "eol_label":          "Date EoL",
    "eos_label":          "Date EoS",
    "submit":             "Créer le CI",
    "cancel":             "Annuler"
  },
  "reports": {
    "title":           "Centre de rapports",
    "subtitle":        "Générez et téléchargez des rapports de la plateforme",
    "eol_report":      "Rapport EoL/EoS",
    "contract_report": "Rapport de contrats",
    "security_report": "Rapport exécutif de sécurité",
    "generate":        "Générer",
    "download_pdf":    "Télécharger PDF",
    "download_excel":  "Télécharger Excel"
  },
  "audit": {
    "title":    "Journaux d'audit",
    "subtitle": "Historique des actions des utilisateurs",
    "columns": {
      "action": "Action",
      "entity": "Entité",
      "user":   "Utilisateur",
      "date":   "Date"
    },
    "no_logs": "Aucun journal d'audit."
  },
  "integrations": {
    "title":      "Connecteurs d'intégration",
    "subtitle":   "Greenbone OpenVAS et CrowdStrike Falcon",
    "greenbone":  "Greenbone OpenVAS",
    "crowdstrike":"CrowdStrike Falcon",
    "upload":     "Téléverser un rapport JSON",
    "processing": "Traitement…",
    "success":    "Importation terminée"
  },
  "profile": {
    "title":            "Mon profil",
    "subtitle":         "Configuration de votre compte",
    "mfa_section":      "Authentification à deux facteurs (MFA)",
    "mfa_enable":       "Activer MFA",
    "mfa_disable":      "Désactiver MFA",
    "mfa_setup":        "Scannez le code QR avec votre application d'authentification",
    "change_password":  "Changer le mot de passe",
    "current_password": "Mot de passe actuel",
    "new_password":     "Nouveau mot de passe",
    "save":             "Enregistrer les modifications",
    "language_section": "Préférence de langue",
    "language_label":   "Langue de l'interface",
    "language_saved":   "Langue enregistrée"
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "const j=require('./frontend/locales/fr.json'); console.log(Object.keys(j).join(', '))"
```

---

## Task 4 — Create it.json (Italian)

**Files:**
- Create: `frontend/locales/it.json`

- [ ] **Step 1: Write it.json**

```json
{
  "brand": {
    "name":    "CMDB",
    "tagline": "Enterprise Platform"
  },
  "footer": {
    "copyright": "© {year} CMDB Platform v1.0"
  },
  "sidebar": {
    "dashboard":       "Dashboard",
    "inventory":       "Inventario CI",
    "vulnerabilities": "Vulnerabilità",
    "map":             "Mappa delle dipendenze",
    "integrations":    "Connettori",
    "reports":         "Report",
    "contracts":       "Contratti e allegati",
    "documents":       "Archivio documenti",
    "licenses":        "Licenze",
    "entities":        "Entità",
    "profile":         "Il mio profilo",
    "masters":         "Dati anagrafici",
    "certificates":    "Certificati SSL",
    "audit":           "Audit",
    "settings":        "Impostazioni"
  },
  "actions": {
    "logout":           "Esci",
    "refresh":          "Aggiorna",
    "add":              "Aggiungi",
    "save":             "Salva",
    "cancel":           "Annulla",
    "delete":           "Elimina",
    "edit":             "Modifica",
    "export_csv":       "Esporta CSV",
    "generate_pdf":     "Genera PDF",
    "retry":            "Riprova",
    "search":           "Cerca",
    "import":           "Importa",
    "download_template":"Modello CSV",
    "sync":             "Sincronizza",
    "send_test_email":  "Invia e-mail di prova",
    "test":             "Testa"
  },
  "common": {
    "loading":          "Caricamento…",
    "loading_data":     "Caricamento dati…",
    "no_data":          "Nessun dato",
    "no_results":       "Nessun risultato",
    "error":            "Errore",
    "unknown_error":    "Errore sconosciuto",
    "confirm_delete":   "Eliminare questo record?",
    "admin_only":       "Solo ADMIN",
    "required":         "Obbligatorio",
    "optional":         "Opzionale",
    "yes":              "Sì",
    "no":               "No",
    "ok":               "OK",
    "close":            "Chiudi",
    "name":             "Nome",
    "email":            "E-mail",
    "status":           "Stato",
    "date":             "Data",
    "created_at":       "Creato",
    "updated_at":       "Aggiornato",
    "actions":          "Azioni"
  },
  "inventory": {
    "title":            "Inventario CI",
    "subtitle":         "Gestione del parco tecnologico",
    "search_placeholder":"Cerca per nome…",
    "total":            "{count} asset gestiti",
    "add_ci":           "Nuovo CI",
    "import_csv":       "Importa CSV",
    "download_template":"Modello CSV",
    "export_csv":       "Esporta CSV",
    "no_cis":           "Nessun CI nell'inventario.",
    "loading":          "Caricamento inventario…",
    "import_success":   "{success} CI importati correttamente, {errors} errori",
    "columns": {
      "ci":             "CI / Asset",
      "type":           "Tipo",
      "environment":    "Ambiente",
      "criticality":    "Criticità",
      "hardware":       "Hardware",
      "software":       "Software",
      "eol":            "EoL / EoS",
      "vulnerabilities":"Vulnerabilità",
      "agent":          "Agente CS",
      "support":        "Supporto"
    },
    "support_badge": {
      "expired":        "Senza supporto",
      "warning":        "EoL in {days}g",
      "ok":             "Attivo"
    },
    "vuln_badge": {
      "no_data":        "Nessun dato",
      "clean":          "Pulito",
      "all_resolved":   "Tutto risolto",
      "open_one":       "{count} aperto",
      "open_many":      "{count} aperti"
    },
    "agent_badge": {
      "no_agent":       "Senza agente",
      "protected":      "Protetto",
      "reduced":        "Ridotto",
      "detection_one":  "{count} rilevamento",
      "detection_many": "{count} rilevamenti"
    },
    "ci_types": {
      "PHYSICAL_SERVER": "Server fisico",
      "VIRTUAL_SERVER":  "Server virtuale",
      "DATABASE":        "Database",
      "NETWORK":         "Rete",
      "STORAGE":         "Storage",
      "BACKUP":          "Backup",
      "HARDWARE":        "Hardware",
      "SOFTWARE":        "Software",
      "OTHER":           "Altro",
      "DESKTOP":         "Desktop",
      "LAPTOP":          "Laptop",
      "PRINTER":         "Stampante",
      "SCANNER":         "Scanner",
      "MONITOR":         "Monitor",
      "VIDEOCONFERENCE": "Videoconferenza",
      "SMART_DISPLAY":   "Display intelligente",
      "TIME_CLOCK":      "Orologio marcatempo",
      "IP_PHONE":        "Telefono IP",
      "SMARTPHONE":      "Smartphone",
      "TABLET":          "Tablet",
      "PDA":             "PDA",
      "BARCODE_SCANNER": "Lettore di codici",
      "IP_CAMERA":       "Telecamera IP",
      "UPS":             "UPS / Gruppo di continuità",
      "WIFI_AP":         "Access point Wi-Fi",
      "CLOUD_INSTANCE":  "Istanza cloud",
      "CLOUD_STORAGE":   "Storage cloud",
      "BASE_SOFTWARE":   "Software di base",
      "LICENSE":         "Licenza"
    }
  },
  "vulnerabilities": {
    "title":            "Vulnerabilità",
    "subtitle":         "Gestione di CVE e rischi di sicurezza",
    "no_vulns":         "Nessuna vulnerabilità registrata.",
    "columns": {
      "ci":             "CI / Server",
      "cve":            "CVE",
      "severity":       "Gravità",
      "status":         "Stato",
      "description":    "Descrizione",
      "source":         "Fonte",
      "score":          "Punteggio CVSS"
    },
    "status": {
      "NUEVO":          "Nuovo",
      "ASIGNADO":       "Assegnato",
      "EN_CURSO":       "In corso",
      "PARADO":         "Sospeso",
      "RESUELTO":       "Risolto"
    }
  },
  "contracts": {
    "title":            "Contratti e allegati",
    "subtitle":         "Gestione contratti con fornitori",
    "no_contracts":     "Nessun contratto registrato.",
    "add_contract":     "Nuovo contratto",
    "export_csv":       "Esporta CSV",
    "columns": {
      "number":         "N° Contratto",
      "vendor":         "Fornitore",
      "start_date":     "Inizio",
      "end_date":       "Fine",
      "status":         "Stato",
      "cis":            "CI"
    },
    "status": {
      "active":         "Attivo",
      "expiring_soon":  "In scadenza",
      "expired":        "Scaduto"
    }
  },
  "documents": {
    "title":                  "Archivio documenti",
    "subtitle":               "Gestione sicura dei documenti aziendali",
    "upload":                 "Carica documento",
    "add_version":            "Nuova versione",
    "no_documents":           "Nessun documento. Carica il primo.",
    "search_placeholder":     "Cerca per titolo o tipo...",
    "doc_title":              "Titolo",
    "doc_type":               "Tipo",
    "doc_file":               "File",
    "doc_size":               "Dimensione",
    "doc_uploaded_by":        "Caricato da",
    "doc_date":               "Data",
    "doc_version":            "Versione",
    "version_history":        "Cronologia versioni",
    "relations":              "Documenti correlati",
    "associated_cis":         "CI associati",
    "associated_contracts":   "Contratti associati",
    "add_relation":           "Aggiungi relazione",
    "relation_type":          "Tipo di relazione",
    "relation_AMENDMENT_OF":  "Allegato di",
    "relation_RELATED_TO":    "Correlato a",
    "relation_SUPERSEDES":    "Sostituisce",
    "download":               "Scarica",
    "delete_confirm":         "Eliminare questo documento?",
    "upload_success":         "Documento caricato correttamente",
    "upload_error":           "Errore durante il caricamento",
    "form_title":             "Titolo del documento",
    "form_description":       "Descrizione (opzionale)",
    "form_type":              "Tipo di documento",
    "form_file":              "File",
    "form_associate_cis":     "Associa CI (opzionale)",
    "form_associate_contracts":"Associa contratti (opzionale)",
    "filter_title":           "Filtra per titolo",
    "filter_type":            "Filtra per tipo",
    "filter_user":            "Filtra per utente",
    "clear_filters":          "Reimposta filtri",
    "preview":                "Anteprima",
    "preview_unavailable":    "Anteprima non disponibile per questo tipo di file",
    "notes":                  "Note",
    "add_note":               "Aggiungi nota",
    "no_notes":               "Nessuna nota",
    "note_placeholder":       "Scrivi una nota...",
    "delete_version":         "Elimina versione",
    "delete_version_confirm": "Eliminare questa versione del documento?",
    "associate_cis":          "Aggiungi CI",
    "associate_contracts":    "Aggiungi contratti",
    "associate_documents":    "Associa documenti",
    "no_cis_to_add":          "Nessun CI disponibile da aggiungere.",
    "no_contracts_to_add":    "Nessun contratto disponibile da aggiungere.",
    "no_documents_to_add":    "Nessun documento disponibile da associare.",
    "search_cis":             "Cerca CI per nome o slug…",
    "search_contracts":       "Cerca contratto per numero o fornitore…",
    "search_documents":       "Cerca documento per titolo o tipo…",
    "associate_selected":     "Associa selezionati"
  },
  "licenses": {
    "title":                "Archivio licenze",
    "subtitle":             "Gestione del ciclo di vita delle licenze software e hardware",
    "add_license":          "Nuova licenza",
    "no_licenses":          "Nessuna licenza registrata.",
    "license_number":       "N° Licenza",
    "vendor":               "Fornitore",
    "type":                 "Tipo",
    "metric":               "Metrica",
    "metric_value":         "Quantità",
    "metric_unit":          "Unità",
    "cost":                 "Costo",
    "currency":             "Valuta",
    "status":               "Stato",
    "notes":                "Note",
    "start_date":           "Inizio",
    "end_date":             "Scadenza",
    "parent_license":       "Licenza principale",
    "addendums":            "Allegati / Rinnovi",
    "add_addendum":         "Aggiungi allegato",
    "associated_cis":       "CI associati",
    "associated_documents": "Documenti associati",
    "license_users":        "Utenti della licenza",
    "add_user":             "Aggiungi utente",
    "user_name":            "Nome",
    "user_dni":             "Documento / ID",
    "user_email":           "E-mail",
    "no_users":             "Nessun utente assegnato.",
    "delete_confirm":       "Eliminare questa licenza e tutti i dati correlati?",
    "delete_user_confirm":  "Rimuovere questo utente dalla licenza?",
    "associate_cis":        "Associa CI",
    "associate_documents":  "Associa documenti",
    "no_cis_to_add":        "Nessun CI disponibile.",
    "no_documents_to_add":  "Nessun documento disponibile.",
    "search_cis":           "Cerca CI…",
    "search_documents":     "Cerca documento…",
    "associate_selected":   "Associa selezionati",
    "form_name":            "Nome della licenza",
    "form_number":          "Numero / chiave di licenza",
    "form_vendor":          "Fornitore (opzionale)",
    "form_start":           "Data di inizio",
    "form_end":             "Data di scadenza (opzionale)",
    "form_type":            "Tipo di licenza",
    "form_metric":          "Metrica di licenza",
    "form_metric_value":    "Quantità (es: 50)",
    "form_metric_unit":     "Unità personalizzata (opzionale)",
    "form_cost":            "Costo",
    "form_currency":        "Valuta",
    "form_status":          "Stato",
    "form_notes":           "Note (opzionale)",
    "form_parent":          "Licenza principale (per allegati)",
    "preview":              "Anteprima",
    "download":             "Scarica",
    "no_preview":           "Anteprima non disponibile",
    "active":               "Attivo",
    "expired":              "Scaduto",
    "expiring_soon":        "In scadenza"
  },
  "masters": {
    "title":            "Amministrazione dati anagrafici",
    "subtitle":         "Gestione tabelle anagrafiche: Aree, Sedi, Produttori, Modelli, Fornitori",
    "tabs": {
      "support_areas":  "Aree di supporto",
      "branches":       "Sedi",
      "manufacturers":  "Produttori",
      "models":         "Modelli",
      "providers":      "Fornitori"
    },
    "doc_types":        "Tipi di documento",
    "license_metrics":  "Metriche di licenza",
    "license_types":    "Tipi di licenza",
    "support_areas": {
      "new":            "Nuova area di supporto",
      "placeholder":    "Es: Zona Centro",
      "empty":          "Nessuna area registrata."
    },
    "branches": {
      "new":                 "Nuova sede",
      "name_placeholder":    "Nome della sede",
      "code_placeholder":    "Codice (3 caratteri, es: MIL)",
      "address_placeholder": "Indirizzo fisico (opzionale)",
      "support_area_label":  "— Area di supporto —",
      "empty":               "Nessuna sede registrata.",
      "add":                 "Aggiungi sede"
    },
    "manufacturers": {
      "new":                "Nuovo produttore",
      "placeholder":        "Es: Dell, HP, Cisco",
      "suggest_popular":    "Suggerisci i più popolari",
      "delete_all":         "Elimina tutto",
      "empty":              "Nessun produttore registrato.",
      "confirm_delete_all": "Inserire 30 produttori IT più popolari? I duplicati verranno ignorati."
    },
    "models": {
      "new":                 "Nuovo modello",
      "placeholder":         "Es: PowerEdge R740",
      "manufacturer_label":  "— Produttore —",
      "type_label":          "— Tipo —",
      "type_software":       "Software",
      "type_hardware":       "Hardware",
      "suggest_dates":       "Suggerisci date standard",
      "eol_search":          "Catalogo EOL",
      "empty":               "Nessun modello registrato.",
      "consult_btn":         "Consulta",
      "sync_eol":            "EOL",
      "consultation_center": "Centro di consultazione del ciclo di vita",
      "suggested_dates":     "Date suggerite"
    },
    "providers": {
      "new":         "Nuovo fornitore",
      "placeholder": "Es: TIM, AWS, Microsoft",
      "empty":       "Nessun fornitore registrato."
    }
  },
  "settings": {
    "title":    "Impostazioni",
    "subtitle": "Utenti, ruoli e integrazioni di sistema",
    "tabs": {
      "users":        "Gestione utenti",
      "integrations": "Integrazioni e sistema"
    },
    "users": {
      "header":  "Utenti del sistema",
      "count":   "{count} utente/i registrato/i",
      "columns": {
        "user":   "Utente",
        "email":  "E-mail",
        "origin": "Origine",
        "mfa":    "MFA",
        "role":   "Ruolo",
        "active": "Attivo"
      },
      "origin_ldap":        "LDAP",
      "origin_local":       "Locale",
      "mfa_active":         "Attivo",
      "mfa_inactive":       "Inattivo",
      "role_admin":         "ADMIN",
      "role_auditor":       "AUDITOR",
      "role_viewer":        "VIEWER",
      "me_label":           "(io)",
      "viewer_notice":      "È necessario il ruolo {role} per modificare la configurazione. Modalità sola lettura.",
      "confirm_activate":   "Attivare l'utente \"{name}\"?",
      "confirm_deactivate": "Disattivare l'utente \"{name}\"?"
    },
    "integrations": {
      "system_status":  "Stato del sistema",
      "system_info":    "Informazioni di sistema",
      "api_status":     "API backend",
      "api_ok":         "Operativo",
      "api_fail":       "Non risponde",
      "ldap_title":     "LDAP / Active Directory",
      "ldap_enabled":   "Abilitato",
      "ldap_disabled":  "Disabilitato",
      "ldap_help":      "Per abilitare: USE_LDAP=true nel backend.",
      "smtp_title":     "SMTP / Notifiche",
      "smtp_configured":"Configurato",
      "smtp_schedule":  "Motore di notifiche giornaliero attivo. Orario: 08:30 (Europe/Madrid).",
      "test_email":     "Invio…",
      "sending":        "Invio…"
    }
  },
  "dashboard": {
    "title":              "Dashboard",
    "subtitle":           "Riepilogo dello stato dell'infrastruttura",
    "total_cis":          "Totale CI",
    "critical_vulns":     "Vulnerabilità critiche",
    "expiring_contracts": "Contratti in scadenza",
    "eol_cis":            "CI senza supporto",
    "cs_coverage":        "Copertura CrowdStrike",
    "agent_ok":           "Agenti attivi"
  },
  "login": {
    "title":         "Accedi",
    "subtitle":      "Accedi alla tua piattaforma CMDB",
    "email_label":   "Indirizzo e-mail",
    "password_label":"Password",
    "mfa_label":     "Codice MFA (6 cifre)",
    "submit":        "Accedi",
    "logging_in":    "Accesso in corso…",
    "error_invalid": "Credenziali non valide",
    "error_mfa":     "Codice MFA non valido"
  },
  "add_ci_modal": {
    "title":              "Nuovo CI",
    "name_label":         "Nome",
    "name_placeholder":   "Es: srv-prd-web-01",
    "slug_label":         "Slug",
    "slug_placeholder":   "Es: srv-prd-web-01",
    "type_label":         "Tipo CI",
    "env_label":          "Ambiente",
    "crit_label":         "Criticità",
    "hardware_section":   "Hardware (opzionale)",
    "software_section":   "Software (opzionale)",
    "manufacturer_label": "Produttore",
    "model_label":        "Modello",
    "serial_label":       "N° di serie",
    "version_label":      "Versione",
    "license_label":      "Tipo di licenza",
    "eol_label":          "Data EoL",
    "eos_label":          "Data EoS",
    "submit":             "Crea CI",
    "cancel":             "Annulla"
  },
  "reports": {
    "title":           "Centro report",
    "subtitle":        "Genera e scarica i report della piattaforma",
    "eol_report":      "Report EoL/EoS",
    "contract_report": "Report contratti",
    "security_report": "Report esecutivo sicurezza",
    "generate":        "Genera",
    "download_pdf":    "Scarica PDF",
    "download_excel":  "Scarica Excel"
  },
  "audit": {
    "title":    "Registri di audit",
    "subtitle": "Cronologia delle azioni degli utenti",
    "columns": {
      "action": "Azione",
      "entity": "Entità",
      "user":   "Utente",
      "date":   "Data"
    },
    "no_logs": "Nessun registro di audit."
  },
  "integrations": {
    "title":      "Connettori di integrazione",
    "subtitle":   "Greenbone OpenVAS e CrowdStrike Falcon",
    "greenbone":  "Greenbone OpenVAS",
    "crowdstrike":"CrowdStrike Falcon",
    "upload":     "Carica report JSON",
    "processing": "Elaborazione…",
    "success":    "Importazione completata"
  },
  "profile": {
    "title":            "Il mio profilo",
    "subtitle":         "Configurazione del tuo account",
    "mfa_section":      "Autenticazione a due fattori (MFA)",
    "mfa_enable":       "Attiva MFA",
    "mfa_disable":      "Disattiva MFA",
    "mfa_setup":        "Scansiona il codice QR con la tua app di autenticazione",
    "change_password":  "Cambia password",
    "current_password": "Password attuale",
    "new_password":     "Nuova password",
    "save":             "Salva modifiche",
    "language_section": "Preferenza lingua",
    "language_label":   "Lingua dell'interfaccia",
    "language_saved":   "Lingua salvata"
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "const j=require('./frontend/locales/it.json'); console.log(Object.keys(j).join(', '))"
```

---

## Task 5 — Add language keys to es.json and en.json

**Files:**
- Modify: `frontend/locales/es.json`
- Modify: `frontend/locales/en.json`

- [ ] **Step 1: Add profile language keys to es.json**

In `frontend/locales/es.json`, find the `"profile"` object and add 3 keys before the closing `}`:

Current last line in profile:
```json
    "save":             "Guardar cambios"
```

Replace with:
```json
    "save":             "Guardar cambios",
    "language_section": "Preferencia de idioma",
    "language_label":   "Idioma de la interfaz",
    "language_saved":   "Idioma guardado"
```

- [ ] **Step 2: Add profile language keys to en.json**

Same edit in `frontend/locales/en.json` — find the `"profile"` object's last key and replace:

Current last line in profile (en.json):
```json
    "save":             "Save changes"
```

Replace with:
```json
    "save":             "Save changes",
    "language_section": "Language Preference",
    "language_label":   "Interface language",
    "language_saved":   "Language saved"
```

- [ ] **Step 3: Verify both files are valid JSON**

```bash
node -e "require('./frontend/locales/es.json'); console.log('es OK')" && \
node -e "require('./frontend/locales/en.json'); console.log('en OK')"
```

---

## Task 6 — Update LanguageContext.tsx

**Files:**
- Modify: `frontend/contexts/LanguageContext.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
"use client";

import {
  createContext, useCallback, useContext,
  useEffect, useState,
} from "react";
import esDict from "@/locales/es.json";
import enDict from "@/locales/en.json";
import deDict from "@/locales/de.json";
import ptDict from "@/locales/pt.json";
import frDict from "@/locales/fr.json";
import itDict from "@/locales/it.json";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Locale = "es" | "en" | "de" | "pt" | "fr" | "it";

export const LOCALE_NAMES: Record<Locale, string> = {
  es: "Español",
  en: "English",
  de: "Deutsch",
  pt: "Português",
  fr: "Français",
  it: "Italiano",
};

type DeepDict = { [k: string]: string | DeepDict };

const DICTS: Record<Locale, DeepDict> = {
  es: esDict,
  en: enDict,
  de: deDict,
  pt: ptDict,
  fr: frDict,
  it: itDict,
};

const VALID_LOCALES = new Set<string>(["es", "en", "de", "pt", "fr", "it"]);

const STORAGE_KEY = "cmdb_locale";

// ─── Context ──────────────────────────────────────────────────────────────────

interface LanguageContextType {
  locale:    Locale;
  setLocale: (l: Locale) => void;
  /** Translate a dot-separated key, e.g. t('sidebar.dashboard') */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("es");

  // Hydrate from localStorage (or browser language) on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_LOCALES.has(stored)) {
      setLocaleState(stored as Locale);
    } else {
      // Infer from browser language
      const browser = navigator.language.split("-")[0];
      if (VALID_LOCALES.has(browser)) {
        setLocaleState(browser as Locale);
      } else {
        setLocaleState("es");
      }
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const parts = key.split(".");
      let node: string | DeepDict = DICTS[locale];
      for (const part of parts) {
        if (typeof node !== "object") return key;
        node = node[part];
        if (node === undefined) return key;
      }
      if (typeof node !== "string") return key;
      // Variable interpolation: {year}, {name}, etc.
      if (vars) {
        return Object.entries(vars).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          node
        );
      }
      return node;
    },
    [locale]
  );

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLanguage(): LanguageContextType {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return ctx;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | head -20
```
Expected: no new errors related to LanguageContext.

---

## Task 7 — Replace LangSelector in Sidebar with dropdown

**Files:**
- Modify: `frontend/components/Sidebar.tsx`

- [ ] **Step 1: Add LOCALE_NAMES import and replace LangSelector**

In `frontend/components/Sidebar.tsx`, make two changes:

**Change 1** — update the import from LanguageContext to include `LOCALE_NAMES`:

Find:
```tsx
import { useLanguage } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";
```

Replace with:
```tsx
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";
```

**Change 2** — replace the entire `LangSelector` function:

Find:
```tsx
function LangSelector() {
  const { locale, setLocale } = useLanguage();
  return (
    <div className="flex items-center gap-1">
      {(["es", "en"] as Locale[]).map((l) => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase transition-colors ${
            locale === l
              ? "bg-indigo-600 text-white"
              : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
```

Replace with:
```tsx
function LangSelector() {
  const { locale, setLocale } = useLanguage();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 cursor-pointer"
    >
      {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
        <option key={code} value={code}>{name}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep "Sidebar" | head -10
```
Expected: no Sidebar errors.

---

## Task 8 — Add language selector to Login page

**Files:**
- Modify: `frontend/app/login/page.tsx`

- [ ] **Step 1: Add imports to login/page.tsx**

Find:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import {
  Server, Loader2, AlertTriangle, Eye, EyeOff,
  ShieldCheck, ShieldAlert, QrCode, CheckCircle2,
} from "lucide-react";
```

Replace with:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";
import {
  Server, Loader2, AlertTriangle, Eye, EyeOff,
  ShieldCheck, ShieldAlert, QrCode, CheckCircle2,
} from "lucide-react";
```

- [ ] **Step 2: Add useLanguage hook call inside LoginPage**

In `frontend/app/login/page.tsx`, find the first line inside `LoginPage` body:

```tsx
  const { login, applySession } = useAuth();
```

Replace with:
```tsx
  const { login, applySession } = useAuth();
  const { locale, setLocale } = useLanguage();
```

- [ ] **Step 3: Add language selector below the header band**

Find in `frontend/app/login/page.tsx` the closing tag of the header band `</div>` followed immediately by `{/* Body */}`:

```tsx
          </div>

          {/* Body */}
          <div className="px-8 py-8">
```

Replace with:
```tsx
          </div>

          {/* Language selector */}
          <div className="flex justify-end px-4 pt-2 pb-0">
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 cursor-pointer"
            >
              {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </div>

          {/* Body */}
          <div className="px-8 py-8">
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep "login" | head -10
```
Expected: no login page errors.

---

## Task 9 — Add Language Preference section to Profile page

**Files:**
- Modify: `frontend/app/profile/page.tsx`

- [ ] **Step 1: Read current imports in profile/page.tsx**

Read `frontend/app/profile/page.tsx` lines 1-15 to confirm current imports.

- [ ] **Step 2: Add language imports**

Find:
```tsx
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
```

Replace with:
```tsx
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";
```

- [ ] **Step 3: Add useLanguage call inside ProfilePage**

Find the line:
```tsx
  const { user, applySession } = useAuth();
```

Replace with:
```tsx
  const { user, applySession } = useAuth();
  const { locale, setLocale, t } = useLanguage();
  const [langSaved, setLangSaved] = useState(false);
```

- [ ] **Step 4: Add handler for language save**

Find the comment `// ── MFA handlers ──` and add before it:

```tsx
  // ── Language handler ──
  const handleLanguageChange = (l: Locale) => {
    setLocale(l);
    setLangSaved(true);
    setTimeout(() => setLangSaved(false), 2000);
  };
```

- [ ] **Step 5: Add Language Preference section to the JSX**

Read the end of the ProfilePage JSX (near `</div>` closing the page) to find a good insertion point. The page renders sections wrapped in a `<div className="max-w-lg ...">` or similar container. Add the Language Preference section after the password section and before the closing container `</div>`.

Find (near the bottom of the JSX, the closing section of password change — look for the save button area):

```tsx
        </section>
      </div>
    </div>
  );
}
```

Replace with:
```tsx
        </section>

        {/* ── Language Preference ──────────────────────────────────────── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
              <svg className="h-4 w-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-slate-700">{t("profile.language_section")}</h2>
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t("profile.language_label")}
            </label>
            <select
              value={locale}
              onChange={(e) => handleLanguageChange(e.target.value as Locale)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
            {langSaved && (
              <p className="text-xs text-emerald-600">{t("profile.language_saved")}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify TypeScript**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep "profile" | head -10
```
Expected: no profile page errors.

---

## Task 10 — Commit all changes

- [ ] **Step 1: Stage all modified/created files**

```bash
git add \
  frontend/locales/de.json \
  frontend/locales/pt.json \
  frontend/locales/fr.json \
  frontend/locales/it.json \
  frontend/locales/es.json \
  frontend/locales/en.json \
  frontend/contexts/LanguageContext.tsx \
  frontend/components/Sidebar.tsx \
  frontend/app/login/page.tsx \
  frontend/app/profile/page.tsx
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(i18n): add DE/PT/FR/IT languages; dropdown selector in Sidebar, Login, Profile"
```

- [ ] **Step 3: Merge to develop**

```bash
git checkout develop 2>/dev/null || git checkout -b develop
git merge main --no-edit
git checkout main
```

---

## Task 11 — Rebuild and verify

- [ ] **Step 1: Rebuild frontend**

```bash
sg docker -c "docker compose up -d --build frontend" 2>&1 | tail -15
```

Expected: build succeeds, no TypeScript errors.

- [ ] **Step 2: Smoke test in browser**

Open `https://localhost:3001`. Verify:
1. Sidebar shows a dropdown with 6 language names (Español, English, Deutsch, Português, Français, Italiano)
2. Selecting Deutsch switches all sidebar labels to German
3. Login page shows the language dropdown below the header band
4. Profile → Language Preference section shows the dropdown; changing it persists across page reloads

- [ ] **Step 3: Commit plan file**

```bash
git add docs/superpowers/plans/2026-04-08-i18n-languages.md
git commit -m "docs: add i18n language expansion implementation plan"
```
