'use strict';

const codec = require('ripple-binary-codec');
const addressCodec = require('ripple-address-codec');
const request = require('request-promise');
const WebSocket = require('ws');
const smoment = require('moment');
var resolve = Promise.promisify(require("dns").resolve4);
var Slack = require('slack-node');
const names = require('./validator-names.json');

const webhookUri = process.env['WEBHOOK_URI']

var slack = new Slack();
slack.setWebhook(webhookUri);

const connections = {};
const validations = {};
const ledgers = {};

let ledgerCutoff = 0

let validators = {}
let manifestKeys = {}

const valListUrl = process.env['testnet'] ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'
let valListSeq = 0

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

function getName (pubkey) {
  return names[pubkey] ? names[pubkey] : pubkey
}

function saveManifest(manifest) {
  const pubkey = manifest.master_key
  if (validators[pubkey] &&
      validators[pubkey].seq < manifest.seq) {
    delete manifestKeys[validators[pubkey].signing_key]

    validators[pubkey].signing_key = manifest.signing_key
    validators[pubkey].seq = manifest.seq
    manifestKeys[validators[pubkey].signing_key] = pubkey
    messageSlack('<!channel> :scroll: new manifest for: `' + getName(pubkey) +'`: #' + validators[pubkey].seq + ', `'+ validators[pubkey].signing_key +'`')
  }
}

function saveValidation(validation) {
  validation.validation_public_key = manifestKeys[validation.validation_public_key]

  if (!validation.validation_public_key ||
      !validators[validation.validation_public_key] ||
      parseInt(validation.ledger_index) <= ledgerCutoff)
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
    console.log('partial validation from', getName(validation.validation_public_key), validation.ledger_hash)
    if (!trouble) {
      console.log('@channel')
      messageSlack('<!channel> :fire: :rippleguy:')
      trouble = true
    }
    messageSlack(':x: `' + validation.ledger_index + '` *partial validation* from `' + getName(validation.validation_public_key) + '` for `' + validation.ledger_hash + '`')
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
  if (ledgers[validation.ledger_index].hashes[validation.ledger_hash].length == Object.keys(validators).length) {
    trouble = false
    goodLedgerTime = smoment()
    console.log(validation.ledger_index, validation.ledger_hash, 'received', Object.keys(validators).length, 'validations')
    messageSlack(':heavy_check_mark: `' + validation.ledger_index + '` `' + validation.ledger_hash + '` received ' + Object.keys(validators).length +  ' validations')
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

      connections[this.url].send(JSON.stringify({
        id: 2,
        command: 'subscribe',
        streams: [
          'manifests'
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
    } else if (data.type === 'manifestReceived') {
      saveManifest(data);
    } else if (data.error === 'unknownStream') {
      delete connections[this.url];
      console.log(data.error);
    }
  });
}

function subscribeToRippleds() {

  // Subscribe to validation websocket subscriptions from rippleds
  resolve(process.env['testnet'] ? 'r.altnet.rippletest.net' : 'r.ripple.com').then(ips => {
    console.log(ips)
    for (const ip of ips) {
      subscribe('ws://' + ip + ':' + WS_PORT);
    }
  })
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
      let message = ''
      for (let hash in ledgers[index].hashes) {
        message += '\n:x: `' + index + '` `' + hash + '` received ' + ledgers[index].hashes[hash].length + ' validations'
        if (ledgers[index].hashes[hash].length < Object.keys(validators).length/2) {
          message += ' from'
          for (var i = 0; i < ledgers[index].hashes[hash].length; i++) {
            message += ' `' + getName(ledgers[index].hashes[hash][i]) + '`,'
          }
          message = message.slice(0, -1)
        } else {
          message += ' (missing:'
          for (const pubkey of Object.keys(validators)) {
            if (ledgers[index].hashes[hash].indexOf(pubkey) === -1)
              message += ' `' + getName(pubkey) + '`,'
          }
          message = message.slice(0, -1)
          message += ')'
        }
      }
      messageSlack(message)
      delete ledgers[index];
    }
  }

  for (let key in validations) {
    if (smoment().diff(validations[key].timestamp) > 300000) {
      if (ledgerCutoff < parseInt(validations[key].ledger_index))
        ledgerCutoff = parseInt(validations[key].ledger_index)
      delete validations[key];
    }
  }
}

function parseManifest (data) {
  let buff = new Buffer(data, 'base64');
  let manhex = buff.toString('hex').toUpperCase();
  return codec.decode(manhex)
}

function toBytes(hex) {
  return new Buffer(hex, 'hex').toJSON().data;
}

function hextoBase58 (hex) {
  return addressCodec.encodeNodePublic(toBytes(hex))
}

function remove(array, element) {
  const index = array.indexOf(element);

  if (index !== -1) {
    array.splice(index, 1);
  }
}

function setName (pubkey) {
  request.get({
    url: 'https://data.ripple.com/v2/network/validators/' + pubkey,
    json: true
  }).then(data => {
    if (data.domain)
      names[pubkey] = data.domain
  })
}

function getUNL () {
  request.get({
    url: valListUrl,
    json: true
  }).then(data => {
    let buff = new Buffer(data.blob, 'base64');
    const valList = JSON.parse(buff.toString('ascii'))

    if (valList.sequence <= valListSeq) {
      return
    }

    valListSeq = valList.sequence

    let oldValidators = Object.keys(validators)

    const startup = !oldValidators.length
    for (const validator of valList.validators) {
      const pubkey = hextoBase58(validator.validation_public_key)
      remove(oldValidators, pubkey)

      const manifest = parseManifest(validator.manifest)

      if (!validators[pubkey] || validators[pubkey].seq < manifest.Sequence) {
        if (validators[pubkey]) {
          delete manifestKeys[validators[pubkey].signing_key]
        } else {
          validators[pubkey] = {}
          if (getName(pubkey)===pubkey)
            setName(pubkey)
          if (!startup)
            messageSlack('<!channel> :tada: new trusted validator: `' + getName(pubkey) +'`')
        }
        validators[pubkey].signing_key = hextoBase58(manifest.SigningPubKey)
        validators[pubkey].seq = manifest.Sequence
        manifestKeys[validators[pubkey].signing_key] = pubkey
        if (!startup)
          messageSlack('<!channel> :scroll: new manifest for: `' + getName(pubkey) +'`: #' + validators[pubkey].seq + ', `'+ validators[pubkey].signing_key +'`')
      }
    }
    for (const validator of oldValidators) {
      delete validators[validator]
    }
    console.log(validators)
    console.log(manifestKeys)
  });
}

function refreshSubscriptions() {
  console.log('refreshing')
  getUNL()
  subscribeToRippleds()
}

// refresh connections
// every minute
setInterval(refreshSubscriptions, 60 * 1000);
refreshSubscriptions()
