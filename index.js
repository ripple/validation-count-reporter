'use strict';

const codec = require('ripple-binary-codec');
const addressCodec = require('ripple-address-codec');
const request = require('request-promise');
const WebSocket = require('ws');
const moment = require('moment');
const Promise = require('bluebird');
var resolve = Promise.promisify(require("dns").resolve4);

const { RtmClient, CLIENT_EVENTS, WebClient } = require('@slack/client');

// usually starts with xoxb
const token = process.env.SLACK_TOKEN;

// Cache of data
const appData = {};

const rtm = new RtmClient(token, {
  dataStore: false,
  useRtmConnect: true
});

// Use a web client to find channels
const web = new WebClient(token);

const getChannelList = web.channels.list();

// The client will emit an RTM.AUTHENTICATED event when the connection
// data is available, before the connection is open.
rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, connectData => {
  appData.selfId = connectData.self.id;
  console.log(`Logged in as ${appData.selfId} of team ${connectData.team.id}`);
});

let channel;

// The client will emit RTM.RTM_CONNECTION_OPENED when the connection is ready
// to send and receive messages
rtm.on(CLIENT_EVENTS.RTM.RTM_CONNECTION_OPENED, () => {
  console.log('Ready');

  getChannelList.then(res => {
    // Take any channel in which the bot is a member
    channel = res.channels.find(c => c.is_member);

    if (channel) {
      // Use sendMessage() to send a string to a channel
      rtm.sendMessage('Hello world', channel.id)
        .then(x => {
          console.log(`Message sent to channel ${channel.name} - ${JSON.stringify(x, null, 2)}`);
        })
        .catch(console.error);
    }
  });
});

rtm.start();

const connections = {};
const validations = {};
const ledgers = {};

let ledgerCutoff = 0

let validators = {}
let manifestKeys = {}

const valListUrl = process.env['ALTNET'] ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'
let valListSeq = 0

const WS_PORT = '51233';

var trouble = false
var goodLedgerTime = moment()
var badLedger = 0

function messageSlack(message) {
  console.log(`Message: ${message}`);

  if (channel) {
    rtm.sendMessage(message, channel.id)
      .then(x => {
        console.log(`Message sent to channel ${channel.name} - ${JSON.stringify(x, null, 2)}`);
      })
      .catch(console.error);
  } else {
    console.error('No channel found');
  }
}

function saveManifest(manifest) {
  const pubkey = manifest.master_key
  if (validators[pubkey] &&
    validators[pubkey].seq < manifest.seq) {
    delete manifestKeys[validators[pubkey].signing_key]

    validators[pubkey].signing_key = manifest.signing_key
    validators[pubkey].seq = manifest.seq
    manifestKeys[validators[pubkey].signing_key] = pubkey
    messageSlack('<!channel> :scroll: new manifest for: `' + pubkey + '`: #' + validators[pubkey].seq + ', `' + validators[pubkey].signing_key + '`')
  }
}

const reportInterval = moment.duration(10, 'minutes');
let lastReportTimestamp = moment();
let lowestLedgerIndexToReport = Number.MAX_SAFE_INTEGER;
let highestLedgerIndexToReport = 0;
let validationCount = undefined;
setInterval(reportValidations, reportInterval.asMilliseconds());

function saveValidation(validation) {
  if (!manifestKeys[validation.validation_public_key] ||
    parseInt(validation.ledger_index) <= ledgerCutoff)
    return

  validation.validation_public_key = manifestKeys[validation.validation_public_key]

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
  if (ledgers[validation.ledger_index].hashes[validation.ledger_hash].length == Object.keys(validators).length) {
    trouble = false
    goodLedgerTime = moment()

    lowestLedgerIndexToReport = Math.min(validation.ledger_index, lowestLedgerIndexToReport);
    highestLedgerIndexToReport = Math.max(validation.ledger_index, highestLedgerIndexToReport);
    if (validationCount === undefined) validationCount = Object.keys(validators).length;

    if (validationCount !== Object.keys(validators).length) {
      console.log(`WARNING: validationCount changed from ${validationCount} to ${Object.keys(validators).length}`);
      reportValidations();
      messageSlack(`:warning: previous ledgers received ${validationCount} validations, but the next ledger received *${Object.keys(validators).length}* validations!`);
      validationCount = Object.keys(validators).length;
    }

    console.log(validation.ledger_index, validation.ledger_hash, 'received', Object.keys(validators).length, 'validations')
    delete ledgers[validation.ledger_index]
  }
}

function reportValidations() {
  const ledgerCount = highestLedgerIndexToReport - lowestLedgerIndexToReport + 1;
  const secondsPerLedger = ((moment().diff(lastReportTimestamp) / 1000) / ledgerCount).toFixed(3);
  const report = `:white_check_mark: ledgers \`${lowestLedgerIndexToReport}\` to \`${highestLedgerIndexToReport}\` all received *${validationCount}* validations. That's ${ledgerCount} ledgers ${moment().from(lastReportTimestamp)}, or ${secondsPerLedger} seconds per ledger.`;
  messageSlack(report);
  lastReportTimestamp = moment();
  lowestLedgerIndexToReport = Number.MAX_SAFE_INTEGER;
  highestLedgerIndexToReport = 0;
}

function subscribe(ip) {

  // Skip addresses that are already connected
  if (connections[ip]) {
    return;
  }

  const ws = new WebSocket(ip);
  connections[ip] = ws;

  ws.on('error', function (error) {
    if (this.url && connections[this.url]) {
      connections[this.url].close();
      delete connections[this.url];
    }
  });

  ws.on('close', function (error) {
    if (this.url && connections[this.url]) {
      delete connections[this.url];
    }
  });

  ws.on('open', function () {
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

  ws.on('message', function (dataString) {
    const data = JSON.parse(dataString);

    if (data.type === 'validationReceived') {
      const validation = {
        validation_public_key: data.validation_public_key,
        ledger_hash: data.ledger_hash,
        ledger_index: data.ledger_index,
        full: data.full,
        timestamp: moment()
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
  resolve(process.env['ALTNET'] ? 'r.altnet.rippletest.net' : 'r.ripple.com').then(ips => {
    console.log(ips)
    for (const ip of ips) {
      subscribe('ws://' + ip + ':' + WS_PORT);
    }
  })
}

setInterval(purge, 5000);

function purge() {
  const now = moment();

  for (let index in ledgers) {
    if (moment().diff(ledgers[index].timestamp) > 10000) {
      console.log(ledgers[index].hashes)
      if (!trouble &&
        (goodLedgerTime < ledgers[index].timestamp ||
          index - badLedger > Object.keys(ledgers).length)) {
        messageSlack('<!channel> :fire: :rippleguy:')
        console.log('@channel')
        trouble = true
      }
      badLedger = index
      let message = ''
      for (let hash in ledgers[index].hashes) {
        message += '\n:x: `' + index + '` `' + hash + '` received *' + ledgers[index].hashes[hash].length + '* validations from'
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
    if (moment().diff(validations[key].timestamp) > 300000) {
      if (ledgerCutoff < parseInt(validations[key].ledger_index))
        ledgerCutoff = parseInt(validations[key].ledger_index)
      delete validations[key];
    }
  }
}

function parseManifest(data) {
  let buff = new Buffer(data, 'base64');
  let manhex = buff.toString('hex').toUpperCase();
  return codec.decode(manhex)
}

function toBytes(hex) {
  return new Buffer(hex, 'hex').toJSON().data;
}

function hextoBase58(hex) {
  return addressCodec.encodeNodePublic(toBytes(hex))
}

function remove(array, element) {
  const index = array.indexOf(element);

  if (index !== -1) {
    array.splice(index, 1);
  }
}

function getUNL() {
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
          if (!startup)
            messageSlack('<!channel> :tada: new trusted validator: `' + pubkey + '`')
        }
        validators[pubkey].signing_key = hextoBase58(manifest.SigningPubKey)
        validators[pubkey].seq = manifest.Sequence
        manifestKeys[validators[pubkey].signing_key] = pubkey
        if (!startup)
          messageSlack('<!channel> :scroll: new manifest for: `' + pubkey + '`: #' + validators[pubkey].seq + ', `' + validators[pubkey].signing_key + '`')
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
