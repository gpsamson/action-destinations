import { validate, parseFql, Subscription as SubscriptionAst } from '@segment/fab5-subscriptions'
import { BadRequest } from 'http-errors'
import got, { CancelableRequest, Got, Response } from 'got'
import { flatten } from 'lodash'
import { JSONSchema7 } from 'json-schema'
import { Action, ActionDefinition, Validate } from './action'
import { ExecuteInput, StepResult } from './step'
import { time, duration } from '../time'
import { JSONLikeObject, JSONObject } from '../json-object'
import { SegmentEvent } from '@/lib/segment-event'
import type { RequestExtension } from './types'

export interface SubscriptionStats {
  duration: number
  destination: string
  action: string
  subscribe: string | SubscriptionAst
  input: JSONLikeObject
  output: StepResult[]
}

interface PartnerActions<Settings, Payload extends JSONLikeObject> {
  [key: string]: Action<Settings, Payload>
}

export interface DestinationDefinition<Settings = unknown> {
  /** The name of the destination */
  name: string
  /** The JSON Schema representing the destination settings. When present will be used to validate settings */
  schema?: JSONSchema7
  /** An optional function to extend requests sent from the destination (including all actions) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extendRequest?: RequestExtension<Settings>
  /** Optional authentication configuration */
  authentication?: AuthenticationScheme<Settings>
  /** Actions */
  actions: {
    [key: string]: ActionDefinition<Settings>
  }
}

interface Subscription {
  partnerAction: string
  subscribe: string | SubscriptionAst
  mapping?: JSONObject
}

interface TestAuthSettings<Settings> {
  settings: Settings
}

interface AuthenticationField {
  /** The name of the field */
  key: string
  /** The display name of the field */
  label: string
  /** The datatype of the value */
  type: 'string'
  /** Whether or not the field is required for authentication */
  required: boolean
  /** Help text describing the field and how it is used (or why it is required). */
  description?: string
}

interface Authentication {
  fields?: AuthenticationField[]
}

interface ApiKeyAuthentication<Settings> extends Authentication {
  /** Typically used for "API Key" authentication. */
  type: 'custom'
  testAuthentication: (req: Got, input: TestAuthSettings<Settings>) => CancelableRequest<Response<string>>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthenticationScheme<Settings = any> = ApiKeyAuthentication<Settings>

interface EventInput<Settings> {
  readonly event: SegmentEvent
  readonly mapping: JSONObject
  readonly settings: Settings
}

export class Destination<Settings = JSONObject> {
  readonly definition: DestinationDefinition<Settings>
  readonly name: string
  readonly authentication?: AuthenticationScheme<Settings>
  readonly extendRequest?: RequestExtension<Settings>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly actions: PartnerActions<Settings, any>
  readonly responses: Response[]
  readonly settingsSchema?: JSONSchema7

  constructor(destination: DestinationDefinition<Settings>) {
    this.definition = destination
    this.name = destination.name
    this.settingsSchema = destination.schema
    this.extendRequest = destination.extendRequest
    this.actions = {}
    this.authentication = destination.authentication
    this.responses = []

    for (const action of Object.keys(destination.actions)) {
      this.partnerAction(action, destination.actions[action])
    }
  }

  async testAuthentication(settings: Settings): Promise<void> {
    const context: ExecuteInput<Settings, {}> = { settings, payload: {}, cachedFields: {} }

    if (this.settingsSchema) {
      const step = new Validate('settings', this.settingsSchema)
      await step.executeStep(context)
    }

    if (!this.authentication?.testAuthentication) {
      return
    }

    let request = got.extend({
      retry: 0,
      timeout: 3000,
      headers: {
        'user-agent': undefined
      }
    })

    if (typeof this.extendRequest === 'function') {
      request = request.extend(this.extendRequest(context))
    }

    try {
      await this.authentication.testAuthentication(request, { settings })
    } catch (error) {
      throw new Error('Credentials are invalid')
    }
  }

  private partnerAction(slug: string, definition: ActionDefinition<Settings>): Destination<Settings> {
    const action = new Action<Settings, {}>(definition, this.extendRequest)

    action.on('response', (response) => {
      this.responses.push(response)
    })

    this.actions[slug] = action

    return this
  }

  protected executeAction(
    actionSlug: string,
    { event, mapping, settings }: EventInput<Settings>
  ): Promise<StepResult[]> {
    const action = this.actions[actionSlug]
    if (!action) {
      throw new BadRequest(`"${actionSlug}" is not a valid action`)
    }

    return action.execute({
      cachedFields: {},
      mapping,
      payload: event,
      settings
    })
  }

  private async onSubscription(
    subscription: Subscription,
    event: SegmentEvent,
    settings: Settings,
    onComplete?: (stats: SubscriptionStats) => void
  ): Promise<StepResult[]> {
    const subscriptionAst: SubscriptionAst =
      typeof subscription.subscribe === 'string' ? parseFql(subscription.subscribe) : subscription.subscribe

    const isSubscribed = validate(subscriptionAst, event)
    if (!isSubscribed) {
      return [{ output: 'not subscribed' }]
    }

    const actionSlug = subscription.partnerAction
    const subscriptionStartedAt = time()

    const input = {
      event,
      mapping: subscription.mapping || {},
      settings
    }

    const results = await this.executeAction(actionSlug, input)

    const subscriptionEndedAt = time()
    const subscriptionDuration = duration(subscriptionStartedAt, subscriptionEndedAt)

    onComplete?.({
      duration: subscriptionDuration,
      destination: this.name,
      action: actionSlug,
      subscribe: subscription.subscribe,
      input: {
        event: (input.event as unknown) as JSONLikeObject,
        mapping: input.mapping,
        settings: (input.settings as unknown) as JSONLikeObject
      },
      output: results
    })

    return results
  }

  /**
   * Note: Until we move subscriptions upstream (into int-consumer) we've opted
   * to have failures abort the set of subscriptions and get potentially retried by centrifuge
   */
  public async onEvent(
    event: SegmentEvent,
    settings: JSONObject,
    onComplete?: (stats: SubscriptionStats) => void
  ): Promise<StepResult[]> {
    const subscriptions = this.getSubscriptions(settings)
    const destinationSettings = this.getDestinationSettings(settings)

    const promises = subscriptions.map((subscription) =>
      this.onSubscription(subscription, event, destinationSettings, onComplete)
    )

    const results = await Promise.all(promises)

    return flatten(results)
  }

  private getSubscriptions(settings: JSONObject): Subscription[] {
    const { subscription, subscriptions } = settings
    let parsedSubscriptions

    // TODO remove all `else`s once https://github.com/segmentio/refinery/pull/635 lands
    if (subscription) {
      parsedSubscriptions = [subscription]
    } else if (typeof subscriptions === 'string') {
      parsedSubscriptions = JSON.parse(subscriptions)
    } else if (Array.isArray(subscriptions)) {
      parsedSubscriptions = subscriptions
    } else {
      parsedSubscriptions = []
    }

    return parsedSubscriptions as Subscription[]
  }

  private getDestinationSettings(settings: JSONObject): Settings {
    const { subcription, subscriptions, ...otherSettings } = settings
    return (otherSettings as unknown) as Settings
  }
}
