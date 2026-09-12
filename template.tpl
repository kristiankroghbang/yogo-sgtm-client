___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "CLIENT",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "YOGO Booking - sGTM Client",
  "description": "Receives events from a YOGO API poller (purchase, booking, new_customer) and passes all data as-is to the sGTM container.",
  "containerContexts": [
    "SERVER"
  ],
  "brand": {
    "id": "brand_dummy",
    "displayName": "Sementa",
    "thumbnail": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACXUlEQVR42u3cP0oDQRSA8dxAEM8hiGBAtBGEaJ0qqE0aBW3sbHIAGw9hLVgr2GghCGJl6QkEG1FI5YMBkYhxVyck2f3BV2jcXbLz7c6f98bX6PffMUYamoAAAkAAASCAABBAAAggAAQQAAIIAAEEgAACQAABIIAAEEAACCAAEy7g/v5u/2Bvqbk4OzdTAeJG4nbipqZAwMvLc3zXarT7d+LW4gYnV0B8udbGelVbPxE3mNdBTgEVfvYH3oNJFBBdZB1aP5FxPGh4/Mf7EmQTUJk5T8F50cQJqE/rJwggQBdkEDYIm4ZaiFmICUUIxgnGCUdLyEjIgAACQAABIKA41w83x6cnnV53dbc1v7UcxA/xa3wYfyJgVLy9v55dnW8etlOj/0QcEIfFwQTk5PHpsX20PbzpvxIHxykE5OHi9rLZXSve+ok4JU4kIEPrL+yslG39RJw4CgeNWvU8f3j2B96D7H3RtAbjygbIYiAt1e8PGQ/yjslTH44uGCKOycz/Wz8Rl5KQKZ0k+XXGWZy4lL2h5dKEsaTK1fqJjGu06iTlh4wHsazNKyAuaFtKiZeg0+vmFRAXtDGrxGapzzhPLuKCtiaW2C6Yt/UTBBCgCzIIG4RNQy3ELMSEIgTjBOOEoyVkJGSkJAmQlLcthQAbs2xNJMDmXBBAAAggAP5RW91QpQoU61A3VLma6ifl1Q1VsqzeG7PUDVW2kgB1Q3VBBmF1Q01DLcTUDRWKEIxTN1Q4WkJGRgwEEAACCAABBIAAAkAAASCAABBAAAggAAQQQAAIIAAEEAACCAAB9eIDFpvEhWuKzxoAAAAASUVORK5CYII="
  },
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
    "defaultValue": "/yogo-"
  },
  {
    "type": "TEXT",
    "name": "sharedSecret",
    "displayName": "Shared Secret",
    "simpleValueType": true,
    "defaultValue": ""
  }
]


___SANDBOXED_JS_FOR_SERVER___

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

if (getRequestMethod() !== 'POST' || getRequestPath().indexOf(pathPrefix) !== 0) {
  return;
}

claimRequest();

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

logToConsole('[YOGO Client] ' + eventData.event_name);

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
            "string": "any"
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
        },
        {
          "key": "queryParameterAccess",
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
        "publicId": "access_response",
        "versionId": "1"
      },
      "param": [
        {
          "key": "writeResponseAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        },
        {
          "key": "writeHeaderAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        },
        {
          "key": "writeStatusAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        },
        {
          "key": "writeBodyAccess",
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
            "string": "debug"
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
