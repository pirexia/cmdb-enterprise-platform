// AUTO-GENERADO desde docs/n8n/json/mantenimiento-cmdb.json — plantilla de workflow n8n.
// Placeholders {{ENV:VAR}} se sustituyen en renderWorkflows(). NO bindea credenciales (lo hace el render).
/* eslint-disable */
const mantenimiento_cmdb = {
  "name": "Mantenimiento CMDB",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "0 3 * * *"
            }
          ]
        }
      },
      "id": "1af96c03-feaf-4a49-9018-317470b60d36",
      "name": "Schedule 03:00",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [
        0,
        0
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://backend:3000/api/internal/maintenance/purge-audit-logs",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {}
      },
      "id": "0d45936d-cf77-462e-aad0-419e4f705df4",
      "name": "Purge audit logs",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        260,
        0
      ]
    },
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
      "id": "8e3fab07-6eac-4051-a6a4-427c8494bfd4",
      "name": "Schedule 02:00",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [
        0,
        180
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://backend:3000/api/internal/maintenance/cleanup-trusted-devices",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {}
      },
      "id": "0eb3fc17-30c8-4afa-b281-c7b9b9979697",
      "name": "Cleanup trusted devices",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        260,
        180
      ]
    },
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "0 4 * * *"
            }
          ]
        }
      },
      "id": "d57b854d-ef5f-42ca-b024-8e259bc8079a",
      "name": "Schedule 04:00",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [
        0,
        360
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://backend:3000/api/internal/maintenance/dcim-power-scan",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {}
      },
      "id": "085c0397-6274-48f6-a7ef-38ea82e9c8e2",
      "name": "DCIM power scan",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        260,
        360
      ]
    },
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "0 * * * *"
            }
          ]
        }
      },
      "id": "b39beaa8-7bd5-4499-b5b4-2f1728938639",
      "name": "Schedule hourly",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [
        0,
        540
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://backend:3000/api/internal/maintenance/cleanup-bulk-staging",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {}
      },
      "id": "9e352210-d47b-4285-9ba8-f871afb7db8a",
      "name": "Cleanup bulk staging",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        260,
        540
      ]
    }
  ],
  "connections": {
    "Schedule 03:00": {
      "main": [
        [
          {
            "node": "Purge audit logs",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Schedule 02:00": {
      "main": [
        [
          {
            "node": "Cleanup trusted devices",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Schedule 04:00": {
      "main": [
        [
          {
            "node": "DCIM power scan",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Schedule hourly": {
      "main": [
        [
          {
            "node": "Cleanup bulk staging",
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
export default mantenimiento_cmdb;
