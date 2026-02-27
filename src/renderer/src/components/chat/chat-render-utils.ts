import type { UIMessage } from '@tanstack/ai-client'

export const TOOL_TRACE_PREFIX = '[[tool-calls]]\n'
export const CHAT_VIRTUALIZATION_THRESHOLD = 300

export type RenderableChatMessage = {
  id: string
  role: UIMessage['role']
  text: string
  isToolTrace: boolean
}

export function getMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === 'text') {
        return part.content
      }
      if (part.type === 'thinking') {
        return part.content
      }
      return ''
    })
    .join('')
    .trim()
}

export function isToolTraceContent(content: string): boolean {
  return content.startsWith(TOOL_TRACE_PREFIX)
}

export function stripToolTracePrefix(content: string): string {
  return isToolTraceContent(content) ? content.slice(TOOL_TRACE_PREFIX.length) : content
}

export function shouldVirtualizeChatMessages(itemCount: number): boolean {
  return itemCount >= CHAT_VIRTUALIZATION_THRESHOLD
}

export function buildRenderableMessages(messages: UIMessage[]): RenderableChatMessage[] {
  return messages.map((message) => {
    const text = getMessageText(message)
    return {
      id: message.id,
      role: message.role,
      text,
      isToolTrace: isToolTraceContent(text)
    }
  })
}
