// Feature owners add each key here and in every catalog in the same change.
// Named argument properties match Chrome placeholder names (lowercase).
export interface MessageArgs {
  options_title: undefined;
  options_heading: undefined;
  options_intro: undefined;
  options_public_ready: undefined;
  options_no_account: undefined;
  options_private_permission: { permission: string };
  options_settings: undefined;
  options_workspace_heading: undefined;
  options_workspace_description: undefined;
  options_signin_unavailable_description: undefined;
  options_accounts_title: undefined;
  options_accounts_description: undefined;
  options_config_title: undefined;
  options_config_guidance: undefined;
  options_add_account: undefined;
  options_about_title: undefined;
  options_about_subtitle: undefined;
  options_about_description: { app: string; permission: string };
  options_revoke_link: undefined;
  options_metadata_unavailable: undefined;
  options_accounts_load_failed: undefined;
  options_retry: undefined;
  options_accounts_empty: undefined;
  options_accounts_empty_description: undefined;
  options_installed_none: undefined;
  options_installed_on: { accounts: string };
  options_signin_again: undefined;
  options_refresh: undefined;
  options_refreshing: undefined;
  options_remove: undefined;
  options_removing: undefined;
  options_refresh_failed: undefined;
  options_remove_failed: undefined;
  options_token_required: undefined;
  options_display_title: undefined;
  options_display_description: undefined;
  options_display_load_failed: undefined;
  options_display_save_failed: undefined;
  options_display_saving: undefined;
  options_badges: undefined;
  options_badges_description: undefined;
  options_names: undefined;
  options_names_description: undefined;
  options_open_only: undefined;
  options_open_only_description: undefined;
  language_label: undefined;
  language_auto: undefined;
  language_en: undefined;
  language_ko: undefined;
  language_ja: undefined;
  language_zh_cn: undefined;
  language_zh_tw: undefined;
  language_help: undefined;
  language_saving: undefined;
  language_saved: undefined;
  language_save_failed: undefined;
  auth_requesting: undefined;
  auth_enter_code: undefined;
  auth_copy: undefined;
  auth_open_github: undefined;
  auth_waiting: undefined;
  auth_expires_at: { time: string };
  auth_cancel: undefined;
  auth_loading_installations: undefined;
  auth_connected: undefined;
  auth_expired: undefined;
  auth_new_code: undefined;
  auth_denied: undefined;
  auth_try_again: undefined;
  auth_close: undefined;
  auth_error_network: undefined;
  auth_error_invalid_response: undefined;
  auth_error_disabled: undefined;
  auth_error_grant: undefined;
  auth_error_client: undefined;
  auth_error_device_code: undefined;
  auth_error_unknown: undefined;
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
