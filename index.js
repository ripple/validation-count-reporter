'use strict';

const codec = require('ripple-binary-codec');
const addressCodec = require('ripple-address-codec');
const request = require('request-promise');
const WebSocket = require('ws');
const smoment = require('moment');
var resolve = Promise.promisify(require("dns").resolve4);

// var Slack = require('slack-node');

const names = require('./validator-names.json');

const webhookUri = process.env['WEBHOOK_URI']

const { RtmClient, CLIENT_EVENTS, WebClient } = require('@slack/client');

// usually starts with xoxb
const token = process.env.SLACK_TOKEN;

if (!token) {
  console.log('SLACK_TOKEN is required');
  process.exit(1); // 1 = failure code
  return;
}

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

const valListUrl = process.env['testnet'] ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'
let valListSeq = 0

const WS_PORT = '51233';

var trouble = {};
var goodLedgerTime = moment();
var badLedger = 0;

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

// const reportInterval = moment.duration(24, 'hours');
let lastReportTimestamp = moment();
let lowestLedgerIndexToReport = undefined;
let highestLedgerIndexToReport = undefined;
let validationCount = undefined;
// setInterval(reportValidations, reportInterval.asMilliseconds());

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
    let partialValidationMessage = '#' + validation.ledger_hash.slice(0, 6) + ' `' + validation.ledger_index + '` *partial validation* from `' + getName(validation.validation_public_key) + '`';
    trouble[validation.validation_public_key] = partialValidationMessage;
    let trouble_keys = Object.keys(trouble)
    if (trouble_keys.length === 2) { // at least 2 validators having problems
      partialValidationMessage = trouble_keys.reduce((accumulator, currentValue) => {
        return accumulator += '\n' + trouble[currentValue];
      }, '')
      partialValidationMessage = '<!channel> :fire: ' + partialValidationMessage;
    } // ':warning: `' +
    console.log(partialValidationMessage)
    messageSlack(partialValidationMessage)
    return // don't count this as a validation
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
    trouble = {};
    goodLedgerTime = moment();

    if (validationCount === undefined) validationCount = Object.keys(validators).length;

    // Important: Check for validationCount discrepancy before recording the ledger indices to report
    if (validationCount !== Object.keys(validators).length) {
      console.log(`WARNING: validationCount changed from ${validationCount} to ${Object.keys(validators).length}`);
      reportValidations();
      const emoji = validationCount < Object.keys(validators).length ? ':information_desk_person:' : ':warning:';
      messageSlack(`${emoji} previous ledgers received ${validationCount} validations, but the next ledger (\`${validation.ledger_index}\` \`${validation.ledger_hash}\`) received *${Object.keys(validators).length}* validations!`);
      validationCount = Object.keys(validators).length;
    }

    if (highestLedgerIndexToReport === undefined) {
      // OK - first good ledger of this reporting cycle
    } else if (parseInt(highestLedgerIndexToReport) + 1 === parseInt(validation.ledger_index)) {
      // OK - subsequent good ledger of this reporting cycle
    } else {
      const highestSeenLedger = highestLedgerIndexToReport;
      console.log(`WARNING: we skipped from ledger ${highestSeenLedger} to ${validation.ledger_index}`);
      reportValidations();

      // const emoji = ':warning:';
      // const ledgersInBetween = parseInt(validation.ledger_index) - parseInt(highestSeenLedger) - 1;
      // const s = ledgersInBetween === 1 ? '' : 's';
      // messageSlack(`(skipping ${ledgersInBetween} ledger${s} between \`${highestSeenLedger}\` and \`${validation.ledger_index}\`)`);
    }

    highestLedgerIndexToReport = validation.ledger_index;

    if (lowestLedgerIndexToReport === undefined) {
      lowestLedgerIndexToReport = validation.ledger_index;
    }

    // Check for flag ledger
    if (validation.ledger_index % 256 === 0) {
      reportValidations('flag ledger');
    }

    console.log(validation.ledger_index, validation.ledger_hash, 'received', Object.keys(validators).length, 'validations')

    // silenced to reduce verbosity
    // messageSlack(':heavy_check_mark: `' + validation.ledger_index + '` `' + validation.ledger_hash + '` received ' + Object.keys(validators).length +  ' validations')

    delete ledgers[validation.ledger_index]
  }
}

function reportValidations(type) {
  if (highestLedgerIndexToReport === undefined || lowestLedgerIndexToReport === undefined) {
    console.log('WARNING: No good ledgers to report!');
    return;
  }

  const ledgerCount = highestLedgerIndexToReport - lowestLedgerIndexToReport + 1;
  const secondsPerLedger = ((moment().diff(lastReportTimestamp) / 1000) / ledgerCount).toFixed(3);

  let emoji;
  if (validationCount > Object.keys(validators).length) {
    // More validations than expected
    emoji = ':warning:';
  } else if (validationCount === Object.keys(validators).length) {
    emoji = ':white_check_mark:';
  } else {
    // Fewer validations than expected
    emoji = ':x:';
  }

  const flagLedgerNote = (type === 'flag ledger') ? '(flag ledger) ' : '';

  const report = `${emoji} ledgers \`${lowestLedgerIndexToReport}\` to \`${highestLedgerIndexToReport}\` ${flagLedgerNote}all received *${validationCount}* validations. That's ${ledgerCount} ledgers ${moment().from(lastReportTimestamp)}, or ${secondsPerLedger} seconds per ledger.`;
  messageSlack(report);
  lastReportTimestamp = moment();
  lowestLedgerIndexToReport = undefined;
  highestLedgerIndexToReport = undefined;
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

let startTimestamp = moment();

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

// Every 5 seconds
function purge() {
  for (let index in ledgers) {
    if (moment().diff(ledgers[index].timestamp) > 10000) {
      // Ledger is more than 10 seconds old
      console.log(ledgers[index].hashes)

      let ledgerWasLessThan5SecAfterStartup = false;

      if (Object.keys(trouble).length === 0 &&
        (goodLedgerTime < ledgers[index].timestamp ||
          index - badLedger > Object.keys(ledgers).length)) {

        if (ledgers[index].timestamp.diff(startTimestamp) < 5000) {
          ledgerWasLessThan5SecAfterStartup = true;
        } else {

          // (goodLedgerTime < ledgers[index].timestamp ||  index - badLedger > Object.keys(ledgers).length)
          // The last time we saw a good ledger was before this ledger's timestamp,
          // OR the number of ledgers in `ledgers` is less than the difference between this ledger's index and the last bad ledger

          // messageSlack('<!channel> :fire: ');
          // console.log('@channel');
          // trouble = true;

          // only @channel if we are down by 2+ validators
        }
      }
      badLedger = index;
      let message = '';
      let numMissing = 0;
      for (let hash in ledgers[index].hashes) {

        // ----

        if (ledgerWasLessThan5SecAfterStartup) {
          message += `\n:information_desk_person: Since I saw this ledger ${moment.duration(ledgers[index].timestamp.diff(startTimestamp)).asSeconds().toFixed(3)} seconds after starting up, there may be other validations that I did not see: `;
        } else {
          // message += '\n:x: `';
        }

        // message += index + '` `' + hash + '` received *' + ledgers[index].hashes[hash].length + '* validations from'
        // for (var i = 0; i < ledgers[index].hashes[hash].length; i++) {
        //   // message += ' `' + ledgers[index].hashes[hash][i] + '`,'
        //   message += ' `' + getName(ledgers[index].hashes[hash][i]) + '`,'


        message += '#' + hash.slice(0, 6) + ' `' + index + '` received ' + ledgers[index].hashes[hash].length + ' validations';
        if (ledgers[index].hashes[hash].length < Object.keys(validators).length/2) {
          message += ' from'
          for (var i = 0; i < ledgers[index].hashes[hash].length; i++) {
            message += ' `' + getName(ledgers[index].hashes[hash][i]) + '`,'
          }
          message = message.slice(0, -1)
        } else {
          message += ' (missing:'
          for (const pubkey of Object.keys(validators)) {
            if (ledgers[index].hashes[hash].indexOf(pubkey) === -1) {
              message += ' `' + getName(pubkey) + '`,'
              numMissing++;
            }
          }
          message = message.slice(0, -1)
          message += ')'



        // ----

        // message += '\n:x: `' + index + '` `' + hash + '` received ' + ledgers[index].hashes[hash].length + ' validations'
        // if (ledgers[index].hashes[hash].length < Object.keys(validators).length/2) {
        //   message += ' from'
        //   for (var i = 0; i < ledgers[index].hashes[hash].length; i++) {
        //     message += ' `' + getName(ledgers[index].hashes[hash][i]) + '`,'
        //   }
        //   message = message.slice(0, -1)
        // } else {
        //   message += ' (missing:'
        //   for (const pubkey of Object.keys(validators)) {
        //     if (ledgers[index].hashes[hash].indexOf(pubkey) === -1)
        //       message += ' `' + getName(pubkey) + '`,'
        //   }
        //   message = message.slice(0, -1)
        //   message += ')'

        }
      }

      if (numMissing >= 2 && !ledgerWasLessThan5SecAfterStartup) {
        message += ' <!channel> :fire:';
      } else if (numMissing === 1) {
        // message = ':warning: ' + message;
      }
      if (ledgerWasLessThan5SecAfterStartup) {
        console.log('ledgerWasLessThan5SecAfterStartup: ' + message);
      } else {
        messageSlack(message)
      }
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
