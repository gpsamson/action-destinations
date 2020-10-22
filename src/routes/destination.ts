import { Request, Response } from 'express'
import { HttpError, UnprocessableEntity } from 'http-errors'
import { IncomingHttpHeaders } from 'http'
import { getDestinationByIdOrSlug } from '../destinations'
import MIMEType from 'whatwg-mimetype'
import { constructTrace, Span } from './tracing'
import Context from '@/lib/context'
import { JSONArray, JSONObject } from '@/lib/json-object'
import { StepResult } from '@/lib/destination-kit/step'
import getEventTesterData, { EventTesterRequest, RequestToDestination, ResponseFromDestination } from './event-tester'

function parseJsonHeader(
  headers: IncomingHttpHeaders,
  header: string,
  fallback = undefined
): JSONObject | JSONArray | undefined {
  const raw = headers[header]
  if (!raw || Array.isArray(raw)) {
    return fallback
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new UnprocessableEntity(`Invalid header "${header.replace('centrifuge-', '')}": ${error.message}`)
  }
}

function parseContentType(req: Request): MIMEType {
  const contentType = req.headers['content-type']

  if (contentType) {
    const mimeType = MIMEType.parse(contentType)
    if (mimeType) {
      return mimeType
    }
  }

  return new MIMEType('application/octet-stream')
}

async function handleHttp(context: Context, req: Request): Promise<StepResult[]> {
  const idOrSlug = req.params.destinationId
  const event = req.body
  const settings = parseJsonHeader(req.headers, 'centrifuge-settings') as JSONObject
  const privateSettings = parseJsonHeader(req.headers, 'centrifuge-private-settings') as JSONArray

  // Try to map the id param to a slug, or treat it as the slug (easier local testing)
  const destination = getDestinationByIdOrSlug(idOrSlug)

  const results = await destination.onEvent(context, event, settings, privateSettings)

  return results
}

function isCloudEvent(contentType: MIMEType): boolean {
  return contentType.type === 'application' && contentType.subtype.startsWith('cloudevents')
}

function isBatchedCloudEvent(contentType: MIMEType): boolean {
  return contentType.type === 'application' && contentType.subtype === 'cloudevents-batch+json'
}

function isStructuredCloudEvent(contentType: MIMEType): boolean {
  return contentType.type === 'application' && contentType.subtype === 'cloudevents+json'
}

interface CloudEvent {
  id: string
  source: string
  destination: string
  specversion: string
  type: string
  data: JSONObject
  settings: JSONObject
}

interface CloudEventResponse {
  id: string
  source: string
  destination: string
  specversion: string
  type: string
  time: string
  status: number
  data: CloudEventSuccessData | CloudEventErrorData
  errortype?: string
  errormessage?: string
  trace?: Span
}

interface CloudEventSuccessData {
  results: StepResult | StepResult[]
  debugRequests: EventTesterRequest[]
  requestsToDestination: RequestToDestination[]
  responseFromDestination: ResponseFromDestination[]
}

interface CloudEventErrorData {
  status: number
  name: string
  message: string
  debugRequests: EventTesterRequest[]
  requestsToDestination: RequestToDestination[]
  responseFromDestination: ResponseFromDestination[]
}

interface RequestTracing {
  start: Date
}

function constructCloudSuccess(
  cloudEvent: CloudEvent,
  result: StepResult[],
  eventTesterRequests: EventTesterRequest[],
  tracing: RequestTracing
): CloudEventResponse {
  return {
    id: cloudEvent.id,
    source: cloudEvent.source,
    destination: cloudEvent.destination,
    specversion: '1.0',
    type: 'com.segment.event.ack',
    time: new Date().toISOString(),
    status: 201,
    data: {
      results: getSuccessData(result),
      debugRequests: eventTesterRequests,
      requestsToDestination: eventTesterRequests.map(r => r.request),
      responseFromDestination: eventTesterRequests.map(r => r.response)
    },
    trace: constructTrace({
      name: 'invoke',
      start: tracing.start,
      duration: Date.now() - tracing.start.getTime()
    })
  }
}

function getSuccessData(result: StepResult[]): StepResult | StepResult[] {
  // Unwrap first item when it's the only one so `data` maps 1:1 with the request
  if (Array.isArray(result) && result.length === 1) {
    return result[0]
  }

  return result
}

function constructCloudError(
  cloudEvent: CloudEvent,
  error: HttpError,
  eventTesterRequests: EventTesterRequest[],
  tracing: RequestTracing
): CloudEventResponse {
  const statusCode = error?.status ?? error?.response?.statusCode ?? 500
  const message = error?.message ?? 'Unknown error'

  return {
    id: cloudEvent.id,
    source: cloudEvent.source,
    destination: cloudEvent.destination,
    specversion: '1.0',
    type: 'com.segment.event.ack',
    time: new Date().toISOString(),
    status: statusCode,
    data: {
      status: statusCode,
      name: error?.name,
      message,
      debugRequests: eventTesterRequests,
      requestsToDestination: eventTesterRequests.map(r => r.request),
      responseFromDestination: eventTesterRequests.map(r => r.response)
    },
    // TODO support all error types
    errortype: 'MESSAGE_REJECTED',
    errormessage: message,
    trace: constructTrace({
      name: 'invoke',
      start: tracing.start,
      duration: Date.now() - tracing.start.getTime()
    })
  }
}

async function handleCloudEvent(
  context: Context,
  destinationId: string,
  cloudEvent: CloudEvent,
  privateSettings?: JSONArray
): Promise<CloudEventResponse> {
  const start = new Date()

  context.set('req_destination', cloudEvent.destination)
  context.set('req_source', cloudEvent.source)

  const destination = getDestinationByIdOrSlug(destinationId)

  try {
    const results = await destination.onEvent(context, cloudEvent.data, cloudEvent.settings, privateSettings)
    const eventTesterData = getEventTesterData(destination.responses)
    return constructCloudSuccess(cloudEvent, results, eventTesterData, { start })
  } catch (err) {
    const eventTesterData = getEventTesterData(destination.responses)
    return constructCloudError(cloudEvent, err, eventTesterData, { start })
  }
}

async function handleCloudEventBatch(
  context: Context,
  destinationId: string,
  batch: CloudEvent[]
): Promise<CloudEventResponse[]> {
  const promises = batch.map(event => handleCloudEvent(context, destinationId, event))
  const results = await Promise.all(promises)
  return results
}

// TODO support quasar
// TODO support `deadline`/timeout?
// TODO support `attempt` metrics?
// TODO support `debug`?
// TODO support `headers['centrifuge-features']`?
async function destination(req: Request, res: Response): Promise<void> {
  const { context } = req
  const destinationId = req.params.destinationId
  const contentType = parseContentType(req)
  const privateSettings = parseJsonHeader(req.headers, 'centrifuge-private-settings') as JSONArray

  if (isCloudEvent(contentType)) {
    if (isBatchedCloudEvent(contentType)) {
      const result = await handleCloudEventBatch(context, destinationId, req.body)
      res.set('Content-Type', 'application/cloudevents-batch+json; charset=utf-8')
      res.status(201)
      res.send(result)
      return
    }

    if (isStructuredCloudEvent(contentType)) {
      const result = await handleCloudEvent(context, destinationId, req.body, privateSettings)
      res.set('Content-Type', 'application/cloudevent+json; charset=utf-8')
      res.status(result.status)
      res.send(result)
      return
    }
  }

  // This will happen when the cloudevents flagon is disabled or when sending the event
  // via the "Segment Integration" plugin
  const result = await handleHttp(context, req)
  res.status(200)
  res.send(result)
}

export default destination