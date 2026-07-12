// Plantilla de workflow n8n — sincronización periódica vCenter → CMDB.
// Placeholders {{ENV:VAR}} se sustituyen en renderWorkflows(). NO bindea credenciales (lo hace el render).
/* eslint-disable */
const vcenter_sync = {
  "name": "vCenter Sync",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "{{ENV:VCENTER_SYNC_CRON}}"
            }
          ]
        }
      },
      "id": "a1b2c3d4-e5f6-47a8-89b0-c1d2e3f4a5b6",
      "name": "Schedule vCenter sync",
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
        "url": "http://backend:3000/api/internal/vcenter/sync",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {
          "response": {
            "response": {
              "fullResponse": true
            }
          }
        }
      },
      "id": "b2c3d4e5-f6a7-48b9-90c1-d2e3f4a5b6c7",
      "name": "Trigger vCenter sync",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        260,
        300
      ],
      "onError": "continueRegularOutput"
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "loose"
          },
          "conditions": [
            {
              "id": "c3d4e5f6-a7b8-49c0-a1d2-e3f4a5b6c7d8",
              "leftValue": "={{ $('Trigger vCenter sync').item.json.statusCode }}",
              "rightValue": 200,
              "operator": {
                "type": "number",
                "operation": "equals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "d4e5f6a7-b8c9-40d1-b2e3-f4a5b6c7d8e9",
      "name": "IF sync ok",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [
        500,
        300
      ]
    },
    {
      "parameters": {},
      "id": "e5f6a7b8-c9d0-41e2-c3f4-a5b6c7d8e9f0",
      "name": "Sync OK",
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        740,
        200
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://n8n-main:5678/webhook/notify",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ {\"severity\":\"critical\",\"subject\":\"vCenter sync failed\",\"message\":\"El workflow vCenter Sync no pudo completar la sincronización con el backend CMDB. Revisar logs de n8n y del backend.\",\"channel\":\"both\"} }}",
        "options": {}
      },
      "id": "f6a7b8c9-d0e1-42f3-d4a5-b6c7d8e9f0a1",
      "name": "Notify sync failure",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        740,
        420
      ],
      "onError": "continueRegularOutput"
    }
  ],
  "connections": {
    "Schedule vCenter sync": {
      "main": [
        [
          {
            "node": "Trigger vCenter sync",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Trigger vCenter sync": {
      "main": [
        [
          {
            "node": "IF sync ok",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "IF sync ok": {
      "main": [
        [
          {
            "node": "Sync OK",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Notify sync failure",
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
export default vcenter_sync;
