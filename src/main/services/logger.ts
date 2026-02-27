type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogRecord = {
  level: LogLevel
  message: string
  timestamp: number
  context?: Record<string, unknown>
}

export class LoggerService {
  private records: LogRecord[] = []
  private readonly maxRecords = 500

  private push(record: LogRecord): void {
    this.records.push(record)
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords)
    }

    const payload = record.context
      ? `${record.message} ${JSON.stringify(record.context)}`
      : record.message
    if (record.level === 'error') {
      console.error(payload)
    } else if (record.level === 'warn') {
      console.warn(payload)
    } else {
      console.log(payload)
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.push({ level: 'debug', message, timestamp: Date.now(), context })
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.push({ level: 'info', message, timestamp: Date.now(), context })
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.push({ level: 'warn', message, timestamp: Date.now(), context })
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.push({ level: 'error', message, timestamp: Date.now(), context })
  }

  latest(limit = 100): LogRecord[] {
    return this.records.slice(Math.max(0, this.records.length - limit))
  }
}
