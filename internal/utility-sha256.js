import { createHash } from 'node:crypto'

export const name = 'fish-hand-utility-sha256'
export const inject = ['tools']
export const PLUGIN_ID = 'utility.sha256'
export const PLUGIN_VERSION = '1.0.0'
export const TOOL_NAME = 'utility_sha256'
export const MAX_TEXT_CHARACTERS = 65536

export function sha256Text(value) {
  if (typeof value !== 'string') throw new Error('text must be a string')
  if (value.length > MAX_TEXT_CHARACTERS) {
    throw new Error('text is too long (max ' + MAX_TEXT_CHARACTERS + ' characters)')
  }
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function toolDefinition() {
  return {
    name: TOOL_NAME,
    description: 'Compute the SHA-256 digest of supplied text locally with Node.js. This L0 tool has no network, account, credential, file-write, memory, persona, or platform side effects.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          maxLength: MAX_TEXT_CHARACTERS,
          description: 'Text to hash as UTF-8.'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pluginId', 'version', 'algorithm', 'digest'],
        properties: {
          pluginId: { type: 'string' },
          version: { type: 'string' },
          algorithm: { type: 'string' },
          digest: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    execute: async (args) => ({
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      algorithm: 'sha256',
      digest: sha256Text(args.text)
    }),
    presentCall: () => ({ card: 'generic', title: 'Compute SHA-256', kind: 'read' }),
    presentResult: () => ({ card: 'generic', title: 'SHA-256 digest' })
  }
}

export function apply(ctx) {
  const dispose = ctx.tools.register(toolDefinition())
  return typeof dispose === 'function' ? dispose : () => {}
}

export default { name, inject, apply }
