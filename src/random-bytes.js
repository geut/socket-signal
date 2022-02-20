import nodeCrypto from 'crypto'

const webCrypto = typeof crypto !== 'undefined'
const canUseBuffer = typeof Buffer !== 'undefined'

export default (bytesLength) => {
  if (webCrypto) {
    return crypto.getRandomValues(canUseBuffer ? Buffer.allocUnsafe(bytesLength) : new Uint8Array(bytesLength))
  } else if (nodeCrypto) {
    return nodeCrypto.randomBytes(bytesLength)
  } else {
    throw new Error("The environment doesn't have randomBytes function")
  }
}
