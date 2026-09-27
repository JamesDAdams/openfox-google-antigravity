declare module 'openfox/plugin' {
  export type LocalizedString = { en: string; fr: string }
  export type PluginBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  export type PluginActivation =
    | { kind: 'rpc'; method: string; params?: Record<string, unknown> }
    | { kind: 'openPanel'; panelId: string }
    | { kind: 'openUrl'; url: string }
    | { kind: 'openSettings'; tab?: string }

  export type DeclarativeNode =
    | { type: 'text'; text: LocalizedString; muted?: boolean; className?: string }
    | { type: 'keyValue'; items: { key: LocalizedString; value: string }[] }
    | { type: 'table'; columns: LocalizedString[]; rows: string[][] }
    | { type: 'progress'; label: LocalizedString; value: number; max: number; tone?: PluginBadgeTone }
    | { type: 'badge'; label: LocalizedString; tone?: PluginBadgeTone; color?: string; className?: string }
    | {
        type: 'button'
        label: LocalizedString
        title?: LocalizedString
        variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'pill'
        size?: 'sm' | 'md' | 'lg'
        icon?: string
        disabled?: boolean
        className?: string
        onActivate?: PluginActivation
        action?: PluginActivation
      }
    | { type: 'divider' }
    | {
        type: 'stack'
        direction?: 'row' | 'column'
        gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
        align?: 'start' | 'center' | 'end' | 'stretch'
        justify?: 'start' | 'center' | 'end' | 'between'
        className?: string
        children: DeclarativeNode[]
      }
    | {
        type: 'card'
        title?: LocalizedString
        subtitle?: LocalizedString
        tone?: PluginBadgeTone
        className?: string
        children: DeclarativeNode[]
      }
    | {
        type: 'callout'
        tone?: PluginBadgeTone
        title?: LocalizedString
        text: LocalizedString
        icon?: string
      }
    | {
        type: 'icon'
        icon: string
        tone?: PluginBadgeTone
        className?: string
      }
    | {
        type: 'details'
        title: LocalizedString
        defaultOpen?: boolean
        className?: string
        children: DeclarativeNode[]
      }
    | {
        type: 'input'
        id: string
        placeholder?: LocalizedString
        defaultValue?: string
        defaultChecked?: boolean
        label?: LocalizedString
        inputType?: 'text' | 'number' | 'password' | 'checkbox' | 'textarea'
        rows?: number
        disabled?: boolean
        onChange?: PluginActivation
        onBlur?: PluginActivation
      }
    | {
        type: 'select'
        id: string
        label?: LocalizedString
        options: { value: string; label: LocalizedString }[]
        defaultValue?: string
        onChange?: PluginActivation
        onBlur?: PluginActivation
      }
    | {
        type: 'iframe'
        url: string
        height?: string | number
        width?: string | number
      }
}
