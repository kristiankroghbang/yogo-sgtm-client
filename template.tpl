___INFO___

{
  "type": "CLIENT",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "YOGO Booking - sGTM Client",
  "description": "Receives events from a YOGO API poller (purchase, booking, new_customer) and passes all data as-is to the sGTM container. Developed by Kristian Krogh Bang.",
  "containerContexts": [
    "SERVER"
  ],
  "brand": {
    "id": "brand_dummy",
    "displayName": "Kristian Krogh Bang",
    "thumbnail": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAELklEQVR42u2dQWoUQRSGy0yicYwL0QiCEBBEBRExLkSQkL038AB6Ak/gAQQv4NozuBIP4cpTuHBX9mscSUTp6unuqr/qfQMPQhKY7ve+rnpfT01XCAu/1ut1JLaPUMuLYjkEg0I4hYGkOwWBJDsGgcQ6hoCEOoaARDqGgAQ6hoDEOYaAhDmGgEQ5h4AkOQaABDmHgOQ4BoDEOIeApAAAifEKAAlxDgHJAAASAgAEABAAQDgDgEQ4h4AkAACJAAACAAgAIACAAABifXgQL74+irsfHvRhP9vvAMBB7L84jKsvxzHE03Nhv7O/AUDjV/6/in8WgtZGAgA4EzbU/6/4m+inAwBoc27e/fhwEAB735Z6hcDc/DtuHMSdb8+SAWilV6gCgMv3rsWdr08XnZsvvbw1WPx+CnhzNNgr2LHaMQPAHHH1Slx9erT43Lz37u4wAD9O4v7j60m9gh2zHTsATIy99/eTrsxzc/MWsfr8ZLio3f/0vUL3XinHZMcOAFO68rd3khI9FQC7qu3qHixoN0qMAaAfmbpzAIBt5uRXt2P4eZKe6AlTgM3rKe9hfUKqLv6J7hzsXABgzBV5ejNe+P48OclTm8AU/TNDMFNIuWH0d9i52DkBwAwd/+zJTdW/DpIpkKqaQaix459zeB2lfxOnKUUzCDV2/HM2WGP0b2qjqmgGocaOf85EjtE/JXCbAqDUUDpW/5SmrmYAKNlMjdU/qea1BQBKJ220/gnDXB8ApYfNLfVPdTqrDoDSjdMU/VNtaKsBQCFBU/VPHXBZAFSGyDn0rwUzCF46/kX0rwEzCF46/qX0r3YzCC46/oX1r2YzCB46/hz6V6sZBA8dfy79q9EMgoeOP6f+1WYGofWOP7v+VWYGywAgumQql/6pLXnLDoDqosmc+qe06DU7AKrLpnPrn8qydwAoqH8uAVCcAkrqn7spQLEJLKp/3ppARQ0srX++NFDsRpCK/rm6EaR0K1hF/9zdClY5cQX9c/thUPGhT0D/3H8cXLL5Ka1/LAgpnIyS+seSMIHhsJj+sSi0fENUUv9YFi6QoFL6xxdDRIbIEvrHV8NUmqQC+seXQ4WSllv/+Hq42LCZVf94QIRe45RT/3hEjJgZ5NQ/HhIlaAa59I/HxImaQQ7940GRqkumcugfj4rVXTSZQ/94WLTwsukc+sfj4gXNYANADv1jwwhBM7BhOZf+sWWMmBlsmsBsn/6xaVQBM0jYpi1laJ7r0z+2jSsRAxs1pgAw6+JPNo4UswaHW78CwIi5ucXNnwGg0bkZAJzPzQBAAAABAAQAEABAAAABAMQSANiLRDguPgAAAAAAAMkAAAIACKcAAIHz4gMAAACAdwCAwHnxAQAAgMB78QEAAIDAe/GBgOIDAcUHAooPBBQfCCg+EFB8QKDwgEDhgYGiA0aDhf4FNBjxPUEbCkIAAAAASUVORK5CYII="
  },
  "categories": [
    "ANALYTICS",
    "CONVERSIONS"
  ],
  "termsOfServiceAccepted": true
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
