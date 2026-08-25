// Aggregates this agent's tools — one file per tool, mirroring how
// skills/<agent-name>/ namespaces each agent's skills. agents/customer-service
// imports only this file, never reaching into individual tool files
// directly, so adding or removing a tool here is the only place that
// needs to change.
import type { ToolDefinition } from '#agent-config.js'
import { lookupOrder } from './lookup_order.js'
import { getShipmentDetails } from './get_shipment_details.js'
import { issueRefund } from './issue_refund.js'
import { sendEmail } from './send_email.js'

export const tools: ToolDefinition[] = [lookupOrder, getShipmentDetails, issueRefund, sendEmail]
