// Plantilla de workflow n8n — sincronización diaria del grupo de acceso de AD
// con la BD de CMDB (v3.5.10).
//
// Sustituye a "LDAP/AD Sync", que consultaba el directorio con un nodo LDAP y
// calculaba el diff con un nodo Code. Ahora n8n solo decide CUÁNDO: el backend
// posee la regla completa (una sola implementación, D8), así que el workflow se
// reduce a un disparo HTTP.
//
// Placeholders {{ENV:VAR}} se sustituyen en renderWorkflows(). NO bindea
// credenciales (lo hace el render).
/* eslint-disable */
const ldap_group_sync = {
  "name": "LDAP Group Sync",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "{{ENV:LDAP_SYNC_CRON}}"
            }
          ]
        }
      },
      "id": "3f1a7c22-0d64-4a19-9b3e-71c8a4e5d201",
      "name": "Schedule LDAP sync",
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
        "url": "http://backend:3000/api/internal/ldap/sync",
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
      "id": "4a2b8d33-1e75-4b2a-8c4f-82d9b5f6e312",
      "name": "Trigger LDAP sync",
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
              "id": "5b3c9e44-2f86-4c3b-9d50-93eac6a7f423",
              "leftValue": "={{ $('Trigger LDAP sync').item.json.statusCode }}",
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
      "id": "6c4daf55-3097-4d4c-ae61-a4fbd7b80534",
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
      "id": "7d5eb066-41a8-4e5d-bf72-b50ce8c91645",
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
        "jsonBody": "={{ {\"severity\":\"critical\",\"subject\":\"LDAP group sync failed\",\"message\":\"El workflow LDAP Group Sync no pudo sincronizar los usuarios del grupo de acceso de AD con CMDB. Los usuarios nuevos del grupo no tendran acceso hasta que se resuelva. Revisar logs de n8n y del backend.\",\"channel\":\"both\"} }}",
        "options": {}
      },
      "id": "8e6fc177-52b9-4f6e-a083-c61df9da2756",
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
    "Schedule LDAP sync": {
      "main": [
        [
          {
            "node": "Trigger LDAP sync",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Trigger LDAP sync": {
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
export default ldap_group_sync;
