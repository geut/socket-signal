const assert = require('nanocustomassert')

const { ERR_ARGUMENT_INVALID } = require('./errors')

const isRequired = (data, field, rule) => assert(rule.optional || data[field], ERR_ARGUMENT_INVALID, `${field} is required`)

exports.validate = (data, fields) => {
  for (const field in fields) {
    const rule = fields[field]

    isRequired(data, field, rule)

    const value = data[field]

    switch (rule.type) {
      case 'string':
        assert(typeof value === 'string', ERR_ARGUMENT_INVALID, `${field} must be a string`)
        break
      case 'key':
        assert(Buffer.isBuffer(value) && value.length === 32, ERR_ARGUMENT_INVALID, `${field} must be a buffer of 32 bytes`)
        break
      case 'offer':
        assert(typeof value === 'object' && value.type === 'offer' && typeof value.sdp === 'string', ERR_ARGUMENT_INVALID, `${field} must be a valid webrtc offer`)
        break
      case 'answer':
        assert(typeof value === 'object' && value.type === 'answer' && typeof value.sdp === 'string', ERR_ARGUMENT_INVALID, `${field} must be a valid webrtc answer`)
        break
      case 'candidates':
        assert(Array.isArray(value) && value.length > 0 && value.reduce((prev, curr) => {
          return prev &&
            typeof curr === 'object' &&
            typeof curr.candidate === 'object' &&
            typeof curr.candidate.candidate === 'string' &&
            typeof curr.candidate.sdpMLineIndex === 'number' &&
            typeof curr.candidate.sdpMid === 'string'
        }, true), ERR_ARGUMENT_INVALID, `${field} must be a valid webrtc list of candidates`)
    }
  }
}
