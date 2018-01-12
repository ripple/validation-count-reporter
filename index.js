'use strict';

const request = require('request-promise');
const WebSocket = require('ws');
const smoment = require('moment');
const Promise = require('bluebird');
var Slack = require('slack-node');
 
const webhookUri = process.env['WEBHOOK_URI']
const peerApi = process.env['PEER_API']

var slack = new Slack();
slack.setWebhook(webhookUri);

const connections = {};
const validations = {};
const ledgers = {};

const mainnet = [
  'n949f75evCHwgyP4fPVgaHqNHxUVN15PsJEZ3B3HnXPcPjcZAoy7',
  'n9MD5h24qrQqiyBC8aeqqCWvpiBiYQ3jxSr91uiDvmrkyHRdYLUj',
  'n9L81uNCaPgtUJfaHh89gmdvXKAmSt5Gdsw2g1iPWaPkAHW5Nm4C',
  'n9KiYM9CgngLvtRCQHZwgC2gjpdaZcCcbt3VboxiNFcKuwFVujzS',
  'n9LdgEtkmGB9E2h3K4Vp7iGUaKuq23Zr32ehxiU8FWY7xoxbWTSA'
]

const altnet = [
  'n9LW6htqEe5whrFHbUgrquiM9PeHBSibHRTM8vXpEqYjLtkcuX25',
  'n9MHdx5biiAajeYysQWzYpmvyzeRGJh4WhUtoQdEoZNUPmRiDUoo',
  'n94sz4c4wEdLgSuKxVtTb6BSWCC4Y4gKCxVjbuFz8f6TSNoDxz53',
  'n9LzA5z2k3ZnbZiGUDdWW3csQ9xYhmvZ95ra5F9pfd1oWcRKKAg4',
  'n9LzeAE3jC9sgE1Uz4dT5QfQfgfu3CspiKCxgLytjEFQyH4u5gKF'
]

const validators = process.env['ALTNET'] ? altnet : mainnet

const numbers = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
]

const WS_PORT = '51233';

var trouble = false
var goodLedgerTime = smoment()
var badLedger = 0

function messageSlack (message) {
  slack.webhook({
    text: message
  }, function(err, response) {
    if (err)
      console.log(err)
  });
}

function saveValidation(validation) {

  if (validators.indexOf(validation.validation_public_key) === -1)
    return

  const rows = [];
  const key = [
    validation.ledger_hash,
    validation.validation_public_key
  ].join('|');

  // already encountered
  if (validations[key]) {
    validations[key].timestamp = validation.timestamp // update timestamp
    return
  }

  validations[key] = validation; // cache

  if (!validation.full) {
    console.log('partial validation from', validation.validation_public_key, validation.ledger_hash)
    if (!trouble) {
      console.log('@channel')
      messageSlack('<!channel> :fire: :rippleguy:')
      trouble = true
    }
    messageSlack(':x: `' + validation.ledger_index + '` *partial validation* from `' + validation.validation_public_key + '` for `' + validation.ledger_hash + '`')
  }

  if (!ledgers[validation.ledger_index]) {
    ledgers[validation.ledger_index] = {
      timestamp: validation.timestamp,
      hashes: {}
    }
  }

  if (!ledgers[validation.ledger_index].hashes[validation.ledger_hash]) {
    ledgers[validation.ledger_index].hashes[validation.ledger_hash] = []
  }

  ledgers[validation.ledger_index].hashes[validation.ledger_hash].push(validation.validation_public_key);
  if (ledgers[validation.ledger_index].hashes[validation.ledger_hash].length == validators.length) {
    trouble = false
    goodLedgerTime = smoment()
    console.log(validation.ledger_index, validation.ledger_hash, 'received', validators.length, 'validations')
    messageSlack(':white_check_mark: `' + validation.ledger_index + '` `' + validation.ledger_hash + '` received :' +((validators.length < numbers.length) ? numbers[validators.length] : validators.length) +  ': validations')
    delete ledgers[validation.ledger_index]
  }
}

function subscribe(ip) {

  // Skip addresses that are already connected
  if (connections[ip]) {
    return;
  }

  const ws = new WebSocket(ip);
  connections[ip] = ws;

  ws.on('error', function(error) {
    if (this.url && connections[this.url]) {
      connections[this.url].close();
      delete connections[this.url];
    }
  });

  ws.on('close', function(error) {
    if (this.url && connections[this.url]) {
      delete connections[this.url];
    }
  });

  ws.on('open', function() {
    if (this.url &&
        connections[this.url]) {
      connections[this.url].send(JSON.stringify({
        id: 1,
        command: 'subscribe',
        streams: [
          'validations'
        ]
      }));
    }
  });

  ws.on('message', function(dataString) {
    const data = JSON.parse(dataString);

    if (data.type === 'validationReceived') {
      const validation = {
        validation_public_key: data.validation_public_key,
        ledger_hash: data.ledger_hash,
        ledger_index: data.ledger_index,
        full: data.full,
        timestamp: smoment()
      };

      saveValidation(validation);
    } else if (data.error === 'unknownStream') {
      delete connections[this.url];
      console.log(data.error);
    }
  });
}

function getRippleds(api_url) {
  return request.get({
    url: `${api_url}`,
    json: true
  });
}

function subscribeToRippleds(rippleds) {

  // Subscribe to validation websocket subscriptions from rippleds
  if (process.env['ALTNET']) {
    subscribe('wss://s1.altnet.rippletest.net:51233');
    subscribe('wss://s2.altnet.rippletest.net:51233');
    subscribe('wss://s3.altnet.rippletest.net:51233');
    subscribe('wss://s4.altnet.rippletest.net:51233');
    subscribe('wss://s5.altnet.rippletest.net:51233');
    subscribe('wss://client.altnet.rippletest.net:51233');
  } else {
    for (const rippled of rippleds['nodes']) {
      if (!rippled.ip) {
        continue;
      }

      subscribe('ws://' + rippled.ip + ':' + WS_PORT);
    }
  }

  return connections;
}

setInterval(purge, 5000);

function purge() {
  const now = smoment();

  for (let index in ledgers) {
    if (smoment().diff(ledgers[index].timestamp) > 10000) {
      console.log(ledgers[index].hashes)
      if (!trouble &&
          (goodLedgerTime < ledgers[index].timestamp ||
            index-badLedger > Object.keys(ledgers).length)) {
        messageSlack('<!channel> :fire: :rippleguy:')
        console.log('@channel')
        trouble = true
      }
      badLedger = index
      for (let hash in ledgers[index].hashes) {
        message += '\n:x: `' + index + '` `' + hash + '` received :' + ((ledgers[index].hashes[hash].length < numbers.length) ? numbers[ledgers[index].hashes[hash].length] : ledgers[index].hashes[hash].length) + ': validations from'
        for (var i = 0; i < ledgers[index].hashes[hash].length; i++) {
          message += ' `' + ledgers[index].hashes[hash][i] + '`,'
        }
        message = message.slice(0, -1)
      }
      messageSlack(message)
      delete ledgers[index];
    }
  }

  for (let key in validations) {
    if (smoment().diff(validations[key].timestamp) > 30000) {
      delete validations[key];
    }
  }
}

function refreshSubscriptions() {
  console.log('refreshing')
  getRippleds(peerApi)
  .then(subscribeToRippleds)
  .catch(e => {
    console.log(e);
  });
}

// refresh connections
// every minute
setInterval(refreshSubscriptions, 60 * 1000);
refreshSubscriptions()
