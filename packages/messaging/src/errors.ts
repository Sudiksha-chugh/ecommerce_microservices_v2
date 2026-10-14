export class MessagingUnavailableError extends Error {constructor(public readonly reason:'TRANSIENT'|'CONFIGURATION'='TRANSIENT'){super('Messaging unavailable; publication outcome may be uncertain');}}
export class UnroutableMessageError extends Error {constructor(){super('Message has no matching queue');}}
export class PoisonMessageError extends Error {constructor(public readonly code:string){super('Invalid event');}}
export class PermanentHandlerError extends Error {constructor(){super('Permanent handler failure');}}
