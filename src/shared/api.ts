/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  OnPostSubmit: 'internal/triggers/on-post-submit',
} as const

export const EndpointMethod = {
  [Endpoint.OnPostSubmit]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
