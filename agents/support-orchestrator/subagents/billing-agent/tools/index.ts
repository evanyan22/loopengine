import type { ToolDefinition } from '#agent-config.js'
import { lookupInvoice } from './lookup_invoice.js'

export const tools: ToolDefinition[] = [lookupInvoice]
