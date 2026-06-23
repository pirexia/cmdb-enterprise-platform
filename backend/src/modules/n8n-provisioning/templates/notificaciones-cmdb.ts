// AUTO-GENERADO desde docs/n8n/json/notificaciones-cmdb.json — plantilla de workflow n8n.
// Placeholders {{ENV:VAR}} se sustituyen en renderWorkflows(). NO bindea credenciales (lo hace el render).
/* eslint-disable */
const notificaciones_cmdb = {
  "name": "Notificaciones CMDB",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "notify",
        "responseMode": "onReceived",
        "options": {}
      },
      "id": "51c2759e-afa4-4097-a30c-1f5a10a61ffa",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [
        0,
        320
      ],
      "webhookId": "51c2759e-afa4-4097-a30c-1f5a10a61ffa"
    },
    {
      "parameters": {
        "url": "http://backend:3000/api/internal/notify/config",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {}
      },
      "id": "8f5bca40-103e-4ea8-aa06-d970d04899de",
      "name": "Get Config",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        240,
        320
      ]
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
              "id": "07922548-fa8a-44c9-9f59-f69d5bae2c82",
              "leftValue": "={{ ['teams','both'].includes($('Webhook').item.json.body.channel) && Boolean($('Get Config').item.json.teamsWebhookUrl) }}",
              "rightValue": "",
              "operator": {
                "type": "boolean",
                "operation": "true",
                "singleValue": true
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "3c461b75-fc4c-4538-a3f8-4ad9f6f2768f",
      "name": "IF Teams?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [
        480,
        320
      ]
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
              "id": "e7bd3eb3-905d-404f-8f75-b5c12646c99a",
              "leftValue": "={{ ['slack','both'].includes($('Webhook').item.json.body.channel) && Boolean($('Get Config').item.json.slackBotToken) }}",
              "rightValue": "",
              "operator": {
                "type": "boolean",
                "operation": "true",
                "singleValue": true
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "bc82420d-1ec5-4c2a-8bee-fffe3426539b",
      "name": "IF Slack?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [
        480,
        520
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('Get Config').item.json.teamsWebhookUrl }}",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ {\"@type\":\"MessageCard\",\"@context\":\"http://schema.org/extensions\",\"themeColor\":(['critical','expired'].includes($('Webhook').item.json.body.severity)?\"D13438\":($('Webhook').item.json.body.severity===\"warning\"?\"F2A900\":\"0078D4\")),\"summary\":String($('Webhook').item.json.body.subject),\"sections\":[{\"activityTitle\":String($('Webhook').item.json.body.subject),\"text\":String($('Webhook').item.json.body.message)}]} }}",
        "options": {}
      },
      "id": "58ac7018-b526-4b3f-9276-3473db33d4bf",
      "name": "Send Teams",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        720,
        240
      ],
      "onError": "continueRegularOutput"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://slack.com/api/chat.postMessage",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "=Bearer {{ $('Get Config').item.json.slackBotToken }}"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ {\"channel\":$('Get Config').item.json.slackChannel,\"text\":\":\"+$('Webhook').item.json.body.severity+\": *\"+$('Webhook').item.json.body.subject+\"*\\n\"+$('Webhook').item.json.body.message} }}",
        "options": {}
      },
      "id": "793443d2-ce98-4908-992a-2f28033cc581",
      "name": "Send Slack",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        720,
        520
      ],
      "onError": "continueRegularOutput"
    }
  ],
  "connections": {
    "Webhook": {
      "main": [
        [
          {
            "node": "Get Config",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Get Config": {
      "main": [
        [
          {
            "node": "IF Teams?",
            "type": "main",
            "index": 0
          },
          {
            "node": "IF Slack?",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "IF Teams?": {
      "main": [
        [
          {
            "node": "Send Teams",
            "type": "main",
            "index": 0
          }
        ],
        []
      ]
    },
    "IF Slack?": {
      "main": [
        [
          {
            "node": "Send Slack",
            "type": "main",
            "index": 0
          }
        ],
        []
      ]
    }
  },
  "settings": {
    "executionOrder": "v1",
    "saveDataSuccessExecution": "none",
    "saveManualExecutions": false,
    "timezone": "Europe/Madrid"
  }
} as const;
export default notificaciones_cmdb;
