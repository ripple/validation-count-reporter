import * as addressCodec from 'ripple-address-codec'
import * as codec from 'ripple-binary-codec'

export function toBytes(hex) {
  return Buffer.from(hex, 'hex').toJSON().data
}

export function hexToBase58(hex) {
  return addressCodec.encodeNodePublic(toBytes(hex))
}

export function remove(array, element) {
  const index = array.indexOf(element)
  if (index !== -1) {
    array.splice(index, 1)
  }
}

export function decodeManifest(manifest) {
  const manifestBuffer = Buffer.from(manifest, 'base64')
  const manifestHex = manifestBuffer.toString('hex').toUpperCase()
  return codec.decode(manifestHex)
}
