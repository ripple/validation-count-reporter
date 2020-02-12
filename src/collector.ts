/**
 * ETL
 * - Connects to rippled servers
 * - Subscribes to validation streams
 * - Deduplicates messages
 * - Stores validations
 */

import {hexToBase58, remove, decodeManifest} from './utils'
import * as request from 'request-promise-native'
import * as moment from 'moment'
import * as WebSocket from 'ws'
import * as dns from 'dns'

// Load some pre-cached names
const names = require('../validator-names.json')

// The validations stream sends messages whenever it receives validation messages,
// also called validation votes, from validators it trusts.
export interface ValidationMessage {

  // The value `validationReceived` indicates this is from the validations stream.
  type: 'validationReceived' // do not store

  // (May be omitted) The amendments this server wants to be added to the protocol.
  amendments?: string[] // PK

  // (May be omitted) The unscaled transaction cost (`reference_fee` value) this
  // server wants to set by Fee Voting.
  base_fee?: number // Integer // PK

  // Bit-mask of flags added to this validation message.
  // The flag 0x80000000 indicates that the validation signature is fully-canonical.
  // The flag 0x00000001 indicates that this is a full validation; otherwise it's a partial validation.
  // Partial validations are not meant to vote for any particular ledger.
  // A partial validation indicates that the validator is still online but not keeping up with consensus.
  flags: number // PK

  // If true, this is a full validation. Otherwise, this is a partial validation.
  // Partial validations are not meant to vote for any particular ledger.
  // A partial validation indicates that the validator is still online but not keeping up with consensus.
  full: boolean // PK

  // The identifying hash of the proposed ledger is being validated.
  ledger_hash: string // PK

  // The Ledger Index of the proposed ledger.
  ledger_index: string // Integer // PK

  // (May be omitted) The local load-scaled transaction cost this validator is
  // currently enforcing, in fee units.
  load_fee: number // Integer // PK

  // (May be omitted) The minimum reserve requirement (`account_reserve` value)
  // this validator wants to set by Fee Voting.
  reserve_base: number // Integer // PK

  // (May be omitted) The increment in the reserve requirement (`owner_reserve` value) this validator wants to set by Fee Voting.
  reserve_inc: number // Integer // PK

  // The signature that the validator used to sign its vote for this ledger.
  signature: string // PK

  // When this validation vote was signed, in seconds since the Ripple Epoch.
  signing_time: number // PK

  // The base58 encoded public key from the key-pair that the validator used to sign the message.
  // This identifies the validator sending the message and can also be used to verify the signature.
  // Typically this is a signing key (signing_key). Use manifests to map this to an actual validation_public_key.
  validation_public_key: string // PK

  // The time when the validation message was received.
  timestamp: moment.Moment
}

// Associates a signing_key with a master_key (pubkey).
export interface ManifestMessage {

  // The value `manifestReceived` indicates this is from the manifests stream.
  type: 'manifestReceived'

  // The base58 encoded NodePublic master key.
  master_key: string // PK

  // The base58 encoded NodePublic signing key.
  signing_key: string // PK

  // The sequence number of the manifest.
  seq: number // UInt // PK

  // The signature, in hex, of the manifest.
  signature: string // PK

  // The master signature, in hex, of the manifest.
  master_signature: string // PK
}

interface ValidationStreamOptions {
  address: string,
  onValidationReceived: (validationMessage: ValidationMessage) => void,
  onManifestReceived: (manifestMessage: ManifestMessage) => void,
  onClose: (cause: Error|{code: number, reason: string}) => void,
  useHeartbeat?: boolean,
  serverPingInterval?: number,
  latency?: number
}

class ValidationStream {
  readonly ws: WebSocket
  pingTimeout: NodeJS.Timer
  pingInterval: NodeJS.Timer
  requestSuccessIds: Array<number> = []

  constructor({
    address,
    onValidationReceived,
    onManifestReceived,
    onClose,
    useHeartbeat = false,
    serverPingInterval = 30000,
    latency = 1000
  } : ValidationStreamOptions) {
    this.ws = new WebSocket(address)

    if (useHeartbeat) {
      // Send 'ping' every `serverPingInterval` milliseconds
      this.pingInterval = setInterval(() => {
        this.ws.ping(() => {})
      }, serverPingInterval)

      const heartbeat = () => {
        clearTimeout(this.pingTimeout)

        // Use `WebSocket#terminate()` and not `WebSocket#close()`. Delay should be
        // equal to the interval at which your server sends out pings plus a
        // conservative assumption of the latency.
        this.pingTimeout = setTimeout(() => {
          console.error(`[${address}] WARNING: No heartbeat in ${serverPingInterval + latency} ms. Terminating...`)
          this.ws.terminate()
          // will be duplicated by code 1006 and reason ''
          onClose(new Error('Terminated due to lack of heartbeat'))
        }, serverPingInterval + latency)
      }

      this.ws.on('open', heartbeat)
      this.ws.on('ping', heartbeat)
      this.ws.on('close', (_code: number, _reason: string) => {
        clearTimeout(this.pingInterval)
        clearTimeout(this.pingTimeout)
        // no need here, it's already called:
        //onClose({code, reason})
      })
    }

    // You always get a 'close' event after an 'error' event.
    this.ws.on('error', (error: Error) => {
      console.error(`[${address}] ERROR: ${error}`)
    })

    // If the connection was closed abnormally (with an error), or if the close
    // control frame was malformed or not received then the close code must be
    // 1006.
    this.ws.on('close', (code: number, reason: string) => {
      onClose({code, reason})
    })

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        id: 1,
        command: 'subscribe',
        streams: ['validations']
      }), () => {
        // Subscribe to 'manifests' stream
        this.ws.send(JSON.stringify({
          id: 2,
          command: 'subscribe',
          streams: ['manifests']
        }))
      })
    })

    this.ws.on('message', (data: string|Buffer|ArrayBuffer|Buffer[]) => {
      const dataObj = JSON.parse(data as string)

      if (dataObj.type === 'validationReceived') {
        const validationMessage: ValidationMessage = dataObj
        validationMessage.timestamp = moment()
        onValidationReceived(validationMessage)
      } else if (dataObj.type === 'manifestReceived') {
        const manifestMessage: ManifestMessage = dataObj
        onManifestReceived(manifestMessage)
      } else if (dataObj.type === 'response' && dataObj.status === 'success') {
        // All is well...

        // Successfully subscribed to 'validations':
        // {"id":1,"result":{},"status":"success","type":"response"}

        // Successfully subscribed to 'manifests':
        // {"id":2,"result":{},"status":"success","type":"response"}

        this.requestSuccessIds.push(dataObj.id)
        if (this.requestSuccessIds.length === 2) {
          console.info(`[${address}] Successfully connected and subscribed`)
        }
      } else if (dataObj.error === 'unknownStream') {
        // One or more the members of the `streams` field of the request is not a valid stream name.

        console.error(`[${address}] WARNING: 'unknownStream' message received. Terminating...`)
        this.ws.terminate()
        onClose(new Error('Terminated due "unknownStream" message'))
      } else {
        console.error(`[${address}] WARNING: Unexpected message: ${data}`)
      }
    })
  }

  readyState() {
    switch(this.ws.readyState) {
      case 0: {
        return {
          state: 'CONNECTING',
          value: this.ws.readyState,
          description: 'The connection is not yet open.'
        }
      }
      case 1: {
        return {
          state: 'OPEN',
          value: this.ws.readyState,
          description: 'The connection is open and ready to communicate.'
        }
      }
      case 2: {
        return {
          state: 'CLOSING',
          value: this.ws.readyState,
          description: 'The connection is in the process of closing.'
        }
      }
      case 3: {
        return {
          state: 'CLOSED',
          value: this.ws.readyState,
          description: 'The connection is closed.'
        }
      }
      default: {
        return {
          state: 'UNKNOWN',
          value: this.ws.readyState,
          description: 'The connection is in an unrecognized state.'
        }
      }
    }
  }
}

export type NetworkType = 'testnet' | 'mainnet'
export type OnUnlDataCallback = (data: {
  isDuringStartup: boolean
  isNewValidator: boolean
  isNewManifest: boolean
  validatorName: string
  validation_public_key_base58: string
  signing_key: string
  Sequence: number
  isFromManifestsStream?: boolean
}) => void

export class Network {
  network: NetworkType

  static readonly WS_PORT = '51233'

  validationStreams: {
    // key: The address of the validator ('ws://' + ip + ':' + WS_PORT).
    [key: string]: ValidationStream
  } = {}

  lastValidatorListSequence: number = 0

  validators: {
    // key: The public key of the validator, in base58 (validation_public_key_base58).
    [key: string]: {
      // The base58 encoded NodePublic signing key.
      // Also known as the SigningPubKey (hex), but in base58.
      signing_key: string

      // The sequence number of the latest manifest that informed us about this validator.
      Sequence: number // UInt
    }
  } = {}

  names: {
    // key: The public key of the validator, in base58 (validation_public_key_base58).
    // value: The name (typically the domain name) of the validator.
    [key: string]: string
  } = {}

  // Mapping of validator signing keys to pubkeys (validation_public_key_base58).
  // Used to get the actual `validation_public_key` from the `validation_public_key` (signing key) in the ValidationMessage.
  manifestKeys: {
    // key: The signing_key of the validator (SigningPubKey but in base58).
    // value: The public key of the validator, in base58 (validation_public_key_base58).
    [key: string]: string
  } = {}

  onUnlData: OnUnlDataCallback
  onValidationReceived: (validationMessage: ValidationMessage) => void

  constructor(network: NetworkType) {
    // options: {
    //   network: NetworkType
    //   onUnlData: OnUnlDataCallback
    //   onValidationReceived: (validationMessage: ValidationMessage) => void
    // }
    this.network = network
    // this.onUnlData = options.onUnlData
    // this.onValidationReceived = options.onValidationReceived
    this.names = names
  }

  async connect() {
    const refreshSubscriptions = async () => {
      console.info(`[${this.network}] Refreshing subscriptions...`)
      await this.getUNL()
      await this.subscribeToRippleds()
    }

    // refresh connections
    // every minute
    setInterval(refreshSubscriptions, 60 * 1000)
    refreshSubscriptions()
  }

  async subscribeToRippleds() {

    const onManifestReceived = async ({
      master_key,
      seq,
      signing_key
    }: ManifestMessage) => {
      // master_key === validation_public_key_base58
      if (this.validators[master_key] && this.validators[master_key].Sequence < seq) {
        // Delete old signing_key from manifestKeys
        delete this.manifestKeys[this.validators[master_key].signing_key]

        // Set new signing_key
        this.validators[master_key].signing_key = signing_key

        // Set new Sequence
        this.validators[master_key].Sequence = seq

        // Add new signing_key to manifestKeys
        this.manifestKeys[signing_key] = master_key

        // Call onUnlData callback with new data
        this.onUnlData({
          isDuringStartup: false,
          isNewValidator: false,
          isNewManifest: true,
          validatorName: await this.fetchName(master_key),
          validation_public_key_base58: master_key,
          signing_key,
          Sequence: seq,
          isFromManifestsStream: true
        })
      }
    }

    const onCloseAddress = (address: string, cause: Error|{code: number, reason: string}) => {
      if (this.validationStreams[address]) {
        if (this.validationStreams[address].readyState().state === 'OPEN') {
          console.error(`[${this.network}] [${address}] onClose: UNEXPECTED readyState(): 'OPEN'`)
        } else {
          console.info(`[${this.network}] [${address}] onClose: readyState(): '${this.validationStreams[address].readyState().state}'`)
        }
        console.error(`[${this.network}] [${address}] onClose: Error/reason: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}. Deleting...`)
        delete this.validationStreams[address]
      } else {
        console.info(`[${this.network}] [${address}] onClose: Error/reason: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}. Already deleted!`)
      }
    }

    const hostname = this.network === 'testnet' ? 'r.altnet.rippletest.net' : 'r.ripple.com'

    return new Promise<void>((resolve, reject) => {
      dns.resolve4(hostname, (err, ips) => {
        if (err) {
          console.error(`[${this.network}] ERROR: ${err} (Failed to resolve ${hostname})`)
          return reject()
        }
        for (const ip of ips) {
          const address = 'ws://' + ip + ':' + Network.WS_PORT
          if (!this.validationStreams[address]) {
            this.validationStreams[address] = new ValidationStream({
              address,
              onValidationReceived: this.onValidationReceived,
              onManifestReceived,
              onClose: (cause: Error|{code: number, reason: string}) => { onCloseAddress(address, cause) }
            })
          }
        }
        return resolve()
      })
    })
  }

  async fetchName(validation_public_key_base58: string): Promise<string> {
    if (!this.names[validation_public_key_base58]) {
      console.info(`[${this.network}] Attempting to retrieve name of ${validation_public_key_base58} from the Data API...`)
      return request.get({
        url: 'https://data.ripple.com/v2/network/validators/' + validation_public_key_base58,
        json: true
      }).then(data => {
        if (data.domain) {
          console.info(`[${this.network}] Retrieved name: ${data.domain} (${validation_public_key_base58})`)
          this.names[validation_public_key_base58] = data.domain
          return this.names[validation_public_key_base58]
        } else {
          console.warn(`[${this.network}] [${validation_public_key_base58}] No name available. Data: ${JSON.stringify(data)}`)
        }
        return validation_public_key_base58
      }).catch(() => {
        console.warn(`[${this.network}] [${validation_public_key_base58}] Request failed`)
        return validation_public_key_base58
      })
    }
    return this.names[validation_public_key_base58]
  }

  async getUNL() {
    const validatorListUrl = this.network === 'testnet' ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'

    return new Promise<void>((resolve, reject) => {
      request.get({
        url: validatorListUrl,
        json: true
      }).then(async (data) => {
        const buffer = Buffer.from(data.blob, 'base64')
        const validatorList = JSON.parse(buffer.toString('ascii'))
        if (validatorList.sequence <= this.lastValidatorListSequence) {
          // Nothing new here...
          return resolve()
        }
        this.lastValidatorListSequence = validatorList.sequence
        const validatorsToDelete = Object.keys(this.validators)
        const isDuringStartup = (validatorsToDelete.length === 0)
        for (const validator of validatorList.validators) {
          const validation_public_key_base58 = hexToBase58(validator.validation_public_key)
          remove(validatorsToDelete, validation_public_key_base58)

          const manifest = decodeManifest(validator.manifest)
          if (!this.validators[validation_public_key_base58] ||
              this.validators[validation_public_key_base58].Sequence < manifest.Sequence) {
            let isNewValidator = false
            let isNewManifest = false
            const signing_key = hexToBase58(manifest.SigningPubKey)
            const Sequence = manifest.Sequence
            if (this.validators[validation_public_key_base58]) {
              this.validators[validation_public_key_base58].signing_key = signing_key
              this.validators[validation_public_key_base58].Sequence = Sequence
              isNewManifest = true
            } else {
              this.validators[validation_public_key_base58] = {
                signing_key,
                Sequence
              }
              isNewValidator = true
              isNewManifest = true // always
            }

            const validatorName = await this.fetchName(validation_public_key_base58)
            this.onUnlData({
              isDuringStartup,
              isNewValidator,
              isNewManifest,
              validatorName,
              validation_public_key_base58,
              signing_key,
              Sequence
            })
            this.manifestKeys[signing_key] = validation_public_key_base58
          }
        } // for (const validator of validatorList.validators)
        for (const validator of validatorsToDelete) {
          delete this.validators[validator]
        }
        console.info(`[${this.network}] getUNL: Now have ${Object.keys(this.validators).length} validators and ${Object.keys(this.manifestKeys).length} manifestKeys`)
      }).catch(err => {
        return reject(err)
      })
    })
  }
}
