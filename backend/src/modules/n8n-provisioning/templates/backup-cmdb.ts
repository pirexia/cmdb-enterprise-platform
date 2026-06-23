// AUTO-GENERADO desde docs/n8n/json/backup-cmdb.json — plantilla de workflow n8n.
// Placeholders {{ENV:VAR}} se sustituyen en renderWorkflows(). NO bindea credenciales (lo hace el render).
/* eslint-disable */
const backup_cmdb = {
  "name": "Backup CMDB",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "0 2 * * *"
            }
          ]
        }
      },
      "id": "214612c3-8ef7-44f3-8a91-14b3ff0df2ab",
      "name": "Schedule 02:00",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [
        0,
        300
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://backend:3000/api/internal/backup/trigger",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {
          "timeout": 600000
        }
      },
      "id": "526ebb97-0a67-4e81-83f0-f4af2a80d9c9",
      "name": "Trigger backup",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        240,
        300
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://backend:3000/api/internal/backup/record",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ {\"backupId\":$json.backupId,\"success\":true,\"destination\":\"local\",\"totalMb\":($json.dumpMb || 0)+($json.docsMb || 0)} }}",
        "options": {}
      },
      "id": "5a07a1cf-d80d-4a3b-bccb-56edee6a2483",
      "name": "Record backup",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        480,
        300
      ]
    }
  ],
  "connections": {
    "Schedule 02:00": {
      "main": [
        [
          {
            "node": "Trigger backup",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Trigger backup": {
      "main": [
        [
          {
            "node": "Record backup",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1",
    "timezone": "Europe/Madrid"
  }
} as const;
export default backup_cmdb;
