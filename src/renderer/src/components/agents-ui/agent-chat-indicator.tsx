import type { ComponentProps, Ref } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { motion, type MotionProps } from 'motion/react'
import { cn } from '@renderer/lib/utils'

const motionAnimationProps = {
  variants: {
    hidden: {
      opacity: 0,
      scale: 0.1,
      transition: {
        duration: 0.1,
        ease: 'linear' as const
      }
    },
    visible: {
      opacity: [0.5, 1],
      scale: [1, 1.2],
      transition: {
        type: 'spring' as const,
        bounce: 0,
        duration: 0.5,
        repeat: Infinity,
        repeatType: 'mirror' as const
      }
    }
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden'
}

const agentChatIndicatorVariants = cva('bg-muted-foreground inline-block size-2.5 rounded-full', {
  variants: {
    size: {
      xxs: 'size-1',
      xs: 'size-1.5',
      sm: 'size-2.5',
      md: 'size-4',
      lg: 'size-6'
    }
  },
  defaultVariants: {
    size: 'md'
  }
})

export interface AgentChatIndicatorProps extends MotionProps {
  size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg'
  className?: string
  ref?: Ref<HTMLSpanElement>
}

export function AgentChatIndicator({
  size = 'md',
  className,
  ...props
}: AgentChatIndicatorProps &
  ComponentProps<'span'> &
  VariantProps<typeof agentChatIndicatorVariants>) {
  return (
    <motion.span
      {...motionAnimationProps}
      transition={{ duration: 0.1, ease: 'linear' as const }}
      className={cn(agentChatIndicatorVariants({ size }), className)}
      {...props}
    />
  )
}
