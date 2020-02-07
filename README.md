# XRP Ledger Validation Reporter

Reports XRP Ledger validation counts

## Usage

Steps to run this project:

1. Run `npm i` command
2. Setup database settings inside `ormconfig.json` file
3. Run `npm start` command

````
npm install
WEBHOOK_URI=<your-slack-webhook-uri> npm start
````

Or to monitor the [XRP Ledger Test Net](https://ripple.com/build/xrp-test-net/)

````
ALTNET=true WEBHOOK_URI=<your-slack-webhook-uri> npm start
````
