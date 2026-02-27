import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@tanstack/ai-client'
import {
  buildRenderableMessages,
  CHAT_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeChatMessages
} from './chat-render-utils'

function createMessages(count: number): UIMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'assistant' : 'user',
    parts: [
      {
        type: 'text',
        content: `Message ${index} ${'x'.repeat(32)}`
      }
    ],
    createdAt: new Date(1_700_000_000_000 + index)
  }))
}

function measureMs(run: () => void, samples = 3): number {
  const values: number[] = []
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now()
    run()
    values.push(performance.now() - start)
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

describe('chat render performance guards', () => {
  it('switches to virtualization when message count exceeds threshold', () => {
    expect(shouldVirtualizeChatMessages(CHAT_VIRTUALIZATION_THRESHOLD - 1)).toBe(false)
    expect(shouldVirtualizeChatMessages(CHAT_VIRTUALIZATION_THRESHOLD)).toBe(true)
  })

  it('normalizes 10k chat messages under practical latency budget', () => {
    const messages = createMessages(10_000)
    const start = performance.now()
    const rendered = buildRenderableMessages(messages)
    const elapsedMs = performance.now() - start

    expect(rendered).toHaveLength(10_000)
    expect(rendered[0]?.text).toContain('Message 0')
    expect(elapsedMs).toBeLessThan(1500)
  })

  it('scales near-linearly between 1k and 5k messages', () => {
    const small = createMessages(1_000)
    const large = createMessages(5_000)

    const smallMs = measureMs(() => {
      buildRenderableMessages(small)
    })
    const largeMs = measureMs(() => {
      buildRenderableMessages(large)
    })

    // Guard against accidental quadratic work in list preprocessing.
    const scalingRatio = largeMs / Math.max(smallMs, 0.1)
    expect(scalingRatio).toBeLessThan(12)
  })
})
