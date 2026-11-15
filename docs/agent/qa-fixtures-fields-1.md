# Fixture fields 1

Schema reference for qa-fixtures. Edit the corresponding YAML intentionally; validate with rio profile validate or rio qa validate. * means required; extra=false rejects unknown keys. Semantic constraints and prerequisites are in the related guide.

## fields-1
version: value *; const=1
files: array; minItems=0
files[].name: string *; pattern="^[a-z][a-z0-9-]*$"
files[].path: string; pattern="^\\.rio/qa/fixtures/files/(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\]+$"
files[].generate: object; extra=false
files[].generate.kind: enum *; enum=["image","pdf","csv","json","text","binary"]
files[].generate.size: integer; minimum=1
files[].generate.width: integer; minimum=1
files[].generate.height: integer; minimum=1
files[].generate.rows: integer; minimum=1

## fields-2
services: array; minItems=0
services[].name: string *; pattern="^[a-z][a-z0-9-]*$"
services[].kind: enum *; enum=["http-mock","smtp-capture","sms-capture","webhook-sink","oauth-provider","s3","custom"]
services[].env: object *
services[].claims: array; minItems=0; uniqueItems=true
services[].claims[]: string
services[].recordings: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
services[].behaviors: array; minItems=0; uniqueItems=true
services[].behaviors[]: string
services[].default_behavior: string; pattern="^[a-z][a-z0-9-]*$"

## fields-3
services[].start: string; minLength=1
services[].ready: string; minLength=1
capture: object; extra=false
capture.mail: boolean
capture.sms: boolean
capture.webhooks: boolean
defaults: object; extra=false
defaults.time: string; format="date-time"
defaults.timezone: string; minLength=1
defaults.locale: string; minLength=1

## fields-4
defaults.geolocation: object; extra=false
defaults.geolocation.latitude: number *; minimum=-90; maximum=90
defaults.geolocation.longitude: number *; minimum=-180; maximum=180
defaults.geolocation.accuracy: number; minimum=0
defaults.network: enum; enum=["online","slow-3g","offline"]
