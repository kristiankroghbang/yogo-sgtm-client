___INFO___

{
  "type": "CLIENT",
  "id": "yogo_sgtm_client",
  "version": 1,
  "securityGroups": [],
  "displayName": "YOGO Booking - sGTM Client",
  "brand": {
    "id": "yogo_sgtm",
    "displayName": "YOGO Booking sGTM"
  },
  "description": "Receives events from a YOGO API poller (purchase, booking, new_customer) and passes all data as-is to the server-side GTM container. Built for the YOGO Booking API (yogobooking.com). Developed by Kristian Krogh Bang and Claude 4.6.",
  "containerContexts": [
    "SERVER"
  ],
  "categories": [
    "ANALYTICS",
    "CONVERSIONS"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "requestPath",
    "displayName": "Request Path Prefix",
    "simpleValueType": true,
    "defaultValue": "/yogo-",
    "help": "URL path prefix this client claims. The poller sends to /yogo-purchase, /yogo-booking, /yogo-new_customer."
  },
  {
    "type": "TEXT",
    "name": "sharedSecret",
    "displayName": "Shared Secret",
    "simpleValueType": true,
    "defaultValue": "",
    "help": "Required. Must match SGTM_SECRET in the poller. Validates the X-SGTM-Secret header on every request."
  }
]


___SANDBOXED_JS_FOR_SERVER___

/**
 * YOGO Booking - sGTM Client
 *
 * Server-side Google Tag Manager client template for receiving
 * events from a YOGO API poller. Claims POST requests on the
 * configured path prefix, validates a shared secret, and passes
 * the full YOGO payload to the container via runContainer.
 *
 * Supported event types:
 *   /yogo-purchase      - New paid order with customer + order items
 *   /yogo-booking       - Class booking with class + customer data
 *   /yogo-new_customer  - New customer with bookings + orders history
 *
 * No data transformation - all YOGO API fields are passed through
 * as event data, available to any tag in the container.
 *
 * Developed by Kristian Krogh Bang and Claude 4.6.
 * https://github.com/kristiankroghbang
 */

var claimRequest = require('claimRequest');
var getRequestBody = require('getRequestBody');
var getRequestHeader = require('getRequestHeader');
var getRequestMethod = require('getRequestMethod');
var getRequestPath = require('getRequestPath');
var returnResponse = require('returnResponse');
var runContainer = require('runContainer');
var setResponseBody = require('setResponseBody');
var setResponseHeader = require('setResponseHeader');
var setResponseStatus = require('setResponseStatus');
var JSON = require('JSON');
var logToConsole = require('logToConsole');

var pathPrefix = data.requestPath || '/yogo-';
var sharedSecret = data.sharedSecret || '';

// Only claim POST requests matching the configured path prefix
if (getRequestMethod() !== 'POST' || getRequestPath().indexOf(pathPrefix) !== 0) {
  return;
}

claimRequest();

// Validate shared secret header
if (sharedSecret) {
  if ((getRequestHeader('X-SGTM-Secret') || '') !== sharedSecret) {
    logToConsole('[YOGO Client] Rejected: invalid X-SGTM-Secret');
    setResponseStatus(403);
    setResponseHeader('Content-Type', 'application/json');
    setResponseBody(JSON.stringify({error: 'Forbidden'}));
    returnResponse();
    return;
  }
}

// Parse the JSON body from the poller
var body = getRequestBody();
var eventData;
if (body) {
  eventData = JSON.parse(body);
}

if (!eventData || !eventData.event_name) {
  setResponseStatus(400);
  setResponseHeader('Content-Type', 'application/json');
  setResponseBody(JSON.stringify({error: 'Missing event_name'}));
  returnResponse();
  return;
}

logToConsole('[YOGO Client] ' + eventData.event_name +
  (eventData.yogo_order_id ? ' order:' + eventData.yogo_order_id : '') +
  (eventData.yogo_booking_id ? ' booking:' + eventData.yogo_booking_id : '') +
  (eventData.yogo_customer_id ? ' customer:' + eventData.yogo_customer_id : ''));

// Pass the entire payload as-is to the container.
// All YOGO fields become event data accessible by tags.
runContainer(eventData, function() {
  setResponseStatus(200);
  setResponseHeader('Content-Type', 'application/json');
  setResponseBody(JSON.stringify({status: 'ok', event_name: eventData.event_name}));
  returnResponse();
});


___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "read_request",
        "versionId": "1"
      },
      "param": [
        {
          "key": "requestAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        },
        {
          "key": "headerAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "headerNames",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "X-SGTM-Secret"
              },
              {
                "type": 1,
                "string": "Content-Type"
              }
            ]
          }
        },
        {
          "key": "bodyAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        },
        {
          "key": "pathAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "return_response",
        "versionId": "1"
      }
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "run_container",
        "versionId": "1"
      }
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "logging",
        "versionId": "1"
      },
      "param": [
        {
          "key": "environments",
          "value": {
            "type": 1,
            "string": "all"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []
