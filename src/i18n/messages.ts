// Feature owners add each key here and in every catalog in the same change.
// Named argument properties match Chrome placeholder names (lowercase).
export interface MessageArgs {
  extension_name: undefined;
  extension_description: undefined;
  extension_action_title: undefined;
}

export type MessageKey = keyof MessageArgs;
export type MessageValues = Readonly<Record<string, string | number>>;
export type MessageCall<K extends MessageKey> = MessageArgs[K] extends undefined
  ? [key: K]
  : [key: K, args: MessageArgs[K]];
export type Translator = <K extends MessageKey>(
  ...call: MessageCall<K>
) => string;
export type LocalizedMessage = {
  [K in MessageKey]: MessageArgs[K] extends undefined
    ? { key: K }
    : { key: K; args: MessageArgs[K] };
}[MessageKey];

export interface CatalogMessage {
  message: string;
  description: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}
export type Catalog = Record<string, CatalogMessage>;
