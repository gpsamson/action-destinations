import { AmplitudeClient } from 'amplitude-js'
import type { BrowserActionDefinition } from '../../../lib/browser-destinations'
import type { Settings } from '../generated-types'
import type { Payload } from './generated-types'

const action: BrowserActionDefinition<Settings, AmplitudeClient, Payload> = {
  title: 'Session Plugin',
  description: 'Enables Amplitude Session tracking server-side through a client side enrichment pugin',
  defaultSubscription: 'type = "track" or type = "identify" or type = "group" or type = "page" or type = "alias"',
  fields: {},
  lifecycleHook: 'enrichment',
  perform: (amplitude, { context }) => {
    context.updateEvent('context.amplitude_session_id', amplitude.getSessionId())
    return
  }
}

export default action
